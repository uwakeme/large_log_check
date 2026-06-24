import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogProcessor } from './logProcessor';
import { LogLine } from './logParser';

let cachedWebviewHtml: string | null = null;

export class LogViewerPanel {
    // 使用 Map 来管理多个面板实例，key 为文件路径
    private static _panels: Map<string, LogViewerPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _fileUri: vscode.Uri;
    private _logProcessor: LogProcessor;
    private _timelineSampleCount: number;
    /**
     * webviewReady 握手:webview 的内联早期脚本会先于 webview.js 监听器注册,
     * 它一加载完就 postMessage 'webviewReady'。在这之前 host 端不要发任何消息,
     * 否则会被 VSCode 丢弃(未就绪 webview 的 postMessage 不是缓存,是丢弃)。
     * 也防止在用户首次打开时"工具栏先出现一下,再变加载层"的闪烁。
     */
    private _isWebviewReady = false;
    private _hasLoadedFile = false;

    public static createOrShow(extensionUri: vscode.Uri, fileUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const filePath = fileUri.fsPath;
        
        // 如果该文件已经有面板打开，则显示它
        const existingPanel = LogViewerPanel._panels.get(filePath);
        if (existingPanel) {
            existingPanel._panel.reveal(column);
            return existingPanel;
        }

        // 否则，创建新面板
        const panel = vscode.window.createWebviewPanel(
            'logViewer',
            `日志查看器 - ${path.basename(filePath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        const newPanel = new LogViewerPanel(panel, extensionUri, fileUri);
        LogViewerPanel._panels.set(filePath, newPanel);
        return newPanel;
    }

    // 获取当前活动的面板
    public static getActivePanel(): LogViewerPanel | undefined {
        // 返回当前可见的面板
        for (const panel of LogViewerPanel._panels.values()) {
            if (panel._panel.visible) {
                return panel;
            }
        }
        // 如果没有可见的面板，返回任意一个
        return LogViewerPanel._panels.values().next().value;
    }

    // 获取所有面板
    public static getAllPanels(): LogViewerPanel[] {
        return Array.from(LogViewerPanel._panels.values());
    }

    /**
     * 公共消息发送方法。取代外部直接访问 _panel.webview。
     */
    public postMessage(message: unknown): void {
        this._panel.webview.postMessage(message);
    }

    /**
     * 获取文件 URI(供命令面板操作使用)
     */
    public getFileUri(): vscode.Uri {
        return this._fileUri;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, fileUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._fileUri = fileUri;
        this._logProcessor = new LogProcessor(fileUri.fsPath);

        // 读取用户配置
        const config = vscode.workspace.getConfiguration('big-log-viewer');
        this._timelineSampleCount = config.get<number>('timeline.samplePoints', 200);

        // 设置WebView内容(HTML 同步设置,加载层在 CSS 默认就是 flex 可见)
        this._update();
        // 注意:此时不能 postMessage 任何东西 — webview 内联早期脚本还没执行,
        // VSCode 对未就绪 webview 的 postMessage 是直接丢弃的。
        // 等待 webviewReady 后再做 sendConfigToWebview + loadFile。

        // 监听面板关闭事件
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 处理来自WebView的消息
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'webviewReady':
                        // webview 已经把内联早期脚本里的 message listener 注册好了,
                        // 缓存的消息(若有)能正常被主脚本消费;现在才安全地开始
                        // 发送"配置"和"loadingProgress"以及"fileLoaded"等。
                        if (this._isWebviewReady) {return;}
                        this._isWebviewReady = true;
                        this.sendConfigToWebview();
                        // 只在还没加载过时启动初次加载;防止 webview 因 hot-reload
                        // 重新发 ready 而把已加载的数据再 load 一遍。
                        if (!this._hasLoadedFile) {
                            this._hasLoadedFile = true;
                            await this.loadFile(this._fileUri);
                        }
                        break;
                    case 'refresh':
                        await this.loadFile(this._fileUri);
                        break;
                    case 'filterByThread':
                        await this.filterByThreadName(message.threadName);
                        break;
                    case 'filterByClass':
                        await this.filterByClassName(message.className);
                        break;
                    case 'filterByMethod':
                        await this.filterByMethodName(message.methodName);
                        break;
                    case 'getStatistics':
                        await this.getStatistics();
                        break;
                    case 'sampleTimeline':
                        await this.sampleTimeline(message.sampleCount ?? this._timelineSampleCount);
                        break;
                    case 'exportLogs':
                        await this.exportCurrentView(message.lines, message.exportType);
                        break;
                    case 'deleteByTime':
                        await this.deleteByTimeOptions(message.timeStr, message.mode);
                        break;
                    case 'deleteByLine':
                        await this.deleteByLineOptions(message.lineNumber, message.mode);
                        break;
                    case 'keepByTimeRange':
                        await this.keepByTimeRange(message.startTime, message.endTime);
                        break;
                    case 'keepByLineRange':
                        await this.keepByLineRange(message.startLine, message.endLine);
                        break;
                    case 'jumpToTime':
                        await this.jumpToTime(message.timeStr);
                        break;
                    case 'jumpToLineInFullLog':
                        await this.jumpToLineInFullLog(message.lineNumber);
                        break;
                    case 'showMessage':
                        if (message.type === 'warning') {
                            vscode.window.showWarningMessage(message.message);
                        } else if (message.type === 'info') {
                            vscode.window.showInformationMessage(message.message);
                        }
                        break;
                    case 'getSettings':
                        this.sendConfigToWebview();
                        break;
                    case 'updateSettings':
                        await this.updateSettings(message.data);
                        break;
                    case 'updateTheme':
                        // 用户在工具栏切换主题 — 同步到 VSCode user-level 配置
                        // 用 Global 作用域,而不是 Workspace,这样主题跟随用户
                        // 而不是跟随项目(每个人的眼睛偏好不同)。
                        if (message.data && typeof message.data.theme === 'string') {
                            const allowed = ['default', 'neon', 'aurora', 'holo'];
                            if (allowed.includes(message.data.theme)) {
                                const config = vscode.workspace.getConfiguration('big-log-viewer');
                                await config.update('theme', message.data.theme, vscode.ConfigurationTarget.Global);
                            }
                        }
                        break;
                }
            },
            null,
            this._disposables
        );

        // 不在这里直接 loadFile:等 webview 报到 ready 之后再发命令。
        // 旧逻辑:在 panel 构造时立刻 postMessage 'loadingProgress: 0%'。
        // 问题:此时 webview.js 还没执行到第 387 行的 listener 注册,
        // VSCode 对未就绪 webview 的 postMessage 是直接丢弃的,导致
        // webview 永远收不到 0% 消息,进度条一直停在 HTML 默认状态。
    }

    // 公共方法：刷新当前文件
    public async refresh() {
        await this.loadFile(this._fileUri);
    }

    private async loadFile(fileUri: vscode.Uri) {
        this._fileUri = fileUri;
        this._logProcessor = new LogProcessor(fileUri.fsPath);

        try {
            const fileStats = await fs.promises.stat(fileUri.fsPath);
            const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
            const fileSizeBytes = fileStats.size;

            // 单一加载流程:进度 0% → 99% 在读取阶段实时推进 → 100%
            // 进度按真实字节已读量 / 文件总大小 归一化,替换之前"行数/10万"的
            // 行数 hack — 后者在大文件上永远卡 99%(100万行读完已经显示99%但实际只读了10%)。
            // 字节进度是真实进度,小文件秒到 100%,大文件平滑推进,用户体验一致。
            this._panel.webview.postMessage({
                command: 'loadingProgress',
                data: {
                    stage: '正在加载日志文件...',
                    progress: 0
                }
            });

            const lines = await this._logProcessor.readAllLines((currentLine, bytesRead) => {
                // 字节进度优先;bytesRead 不可用时退化到行数估算
                const bytes = bytesRead ?? 0;
                const progress = fileSizeBytes > 0
                    ? Math.min(99, (bytes / fileSizeBytes) * 99)
                    : Math.min(99, (currentLine / 100_000) * 99);
                this._panel.webview.postMessage({
                    command: 'loadingProgress',
                    data: {
                        stage: `正在加载日志... (${currentLine.toLocaleString()} 行)`,
                        progress,
                        current: currentLine
                    }
                });
            });

            const totalLines = lines.length;

            this._panel.title = `日志查看器 - ${path.basename(fileUri.fsPath)}`;

            // 发送最终进度,随即发送 fileLoaded — 不再人为加 300ms 假延迟。
            this._panel.webview.postMessage({
                command: 'loadingProgress',
                data: {
                    stage: '加载完成！',
                    progress: 100,
                    current: totalLines,
                    total: totalLines
                }
            });

            this._panel.webview.postMessage({
                command: 'fileLoaded',
                data: {
                    fileName: path.basename(fileUri.fsPath),
                    filePath: fileUri.fsPath,
                    fileSize: fileSizeMB,
                    totalLines: totalLines,
                    lines: lines,
                    allLoaded: true
                }
            });

            // 请求时间线采样
            this.sampleTimeline(this._timelineSampleCount);
        } catch (error) {
            vscode.window.showErrorMessage(`加载文件失败: ${error}`);
        }
    }

    private async loadMoreLines(_startLine: number, _count: number) {
        // 已废弃:webview 在新协议下不再发送 loadMore 命令(改用 refresh 全量重载)。
        // 保留为空实现仅为防御性兼容,避免遗漏的调用点触发未定义行为。
        return;
    }

    /**
     * 危险操作三选一通用助手:仅隐藏 / 导出到新文件 / 修改原文件。
     *
     * 之前 deleteByTimeOptions / deleteByLineOptions 各有 ~55 行几乎相同的实现。
     * 抽出来后,新加 deleteByXxx 只需要提供 computeResults 和 deleteFromFile 两个回调。
     *
     * @param promptTitle 用户确认时看到的问句,例如 "如何处理 X 之前的日志?"
     * @param mode "before" | "after",用于显示文案
     * @param computeResults 复用逻辑:返回过滤后的日志行(用于"仅隐藏"和"导出到新文件")
     * @param deleteFromFile 真正修改文件的操作,返回删除行数
     */
    private async confirmDestructiveAction(options: {
        promptTitle: string;
        mode: 'before' | 'after';
        computeResults: () => Promise<LogLine[]>;
        deleteFromFile: () => Promise<number>;
    }): Promise<void> {
        const action = await vscode.window.showWarningMessage(
            options.promptTitle,
            { modal: true },
            '仅隐藏（不修改文件）',
            '导出到新文件',
            '修改原文件（危险）'
        );

        if (!action) {
            return; // 用户取消
        }

        try {
            if (action === '仅隐藏（不修改文件）') {
                const results = await options.computeResults();
                this._panel.webview.postMessage({
                    command: 'filterResults',
                    data: { levels: [], results }
                });
                vscode.window.showInformationMessage(
                    `已隐藏 ${options.mode === 'before' ? '之前' : '之后'} 的日志,显示 ${results.length} 行`
                );
            } else if (action === '导出到新文件') {
                const results = await options.computeResults();
                const uri = await vscode.window.showSaveDialog({
                    filters: {
                        '日志文件': ['log', 'txt'],
                        '所有文件': ['*']
                    },
                    defaultUri: vscode.Uri.file(
                        path.join(path.dirname(this._fileUri.fsPath), `filtered_${path.basename(this._fileUri.fsPath)}`)
                    )
                });
                if (uri) {
                    await this._logProcessor.exportLogs(results, uri.fsPath);
                    vscode.window.showInformationMessage(`成功导出 ${results.length} 行日志到: ${uri.fsPath}`);
                }
            } else if (action === '修改原文件（危险）') {
                // 操作已在 modal 中确认,此处直接执行
                try {
                    const deletedLines = await options.deleteFromFile();
                    vscode.window.showInformationMessage(`成功删除 ${deletedLines} 行日志`);
                    await this.loadFile(this._fileUri);
                } catch (error) {
                    vscode.window.showErrorMessage(`删除失败: ${error}`);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`操作失败: ${error}`);
        }
    }

    public async deleteByTimeOptions(timeStr: string, mode: string) {
        await this.confirmDestructiveAction({
            promptTitle: `如何处理${mode === 'before' ? '之前' : '之后'}的日志?`,
            mode: mode as 'before' | 'after',
            computeResults: () => this._logProcessor.filterByTime(timeStr, mode, true),
            deleteFromFile: () => this._logProcessor.deleteByTime(timeStr, mode)
        });
    }

    public async deleteByLineOptions(lineNumber: number, mode: string) {
        await this.confirmDestructiveAction({
            promptTitle: `如何处理第 ${lineNumber} 行${mode === 'before' ? '之前' : '之后'}的日志?`,
            mode: mode as 'before' | 'after',
            computeResults: () => this._logProcessor.filterByLineNumber(lineNumber, mode, true),
            deleteFromFile: () => this._logProcessor.deleteByLine(lineNumber, mode)
        });
    }

    private async jumpToTime(timeStr: string) {
        try {
            vscode.window.showInformationMessage(`正在查找时间 ${timeStr} 的日志...`);
            const result = await this._logProcessor.findLineByTime(timeStr);

            if (result) {
                // 找到了，加载该行及周围的日志
                const startLine = Math.max(0, result.lineNumber - 500);
                const count = 1000; // 加载1000行
                const lines = await this._logProcessor.readLines(startLine, count);

                this._panel.webview.postMessage({
                    command: 'jumpToTimeResult',
                    data: {
                        success: true,
                        targetLineNumber: result.lineNumber,
                        lines: lines,
                        startLine: startLine
                    }
                });

                vscode.window.showInformationMessage(`已定位到第 ${result.lineNumber} 行`);
            } else {
                this._panel.webview.postMessage({
                    command: 'jumpToTimeResult',
                    data: {
                        success: false,
                        message: `未找到大于或等于 ${timeStr} 的日志`
                    }
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`定位失败: ${error}`);
            this._panel.webview.postMessage({
                command: 'jumpToTimeResult',
                data: {
                    success: false,
                    message: `定位失败: ${error}`
                }
            });
        }
    }

    private async jumpToLineInFullLog(lineNumber: number) {
        try {
            vscode.window.showInformationMessage(`正在跳转到第 ${lineNumber} 行...`);

            // 流式 seek:只读取目标行 ±500 行的上下文窗口,不再 readAllLines 加载整个文件。
            // 解决大文件 OOM 问题 — 内存常数(~50KB),无论文件多大。
            // webview 端 handleJumpToLineInFullLogResult 已经支持 partial 模式
            // (allLoaded=false + baseLineOffset),UI 会显示上下文片段 + "未完全加载"标识。
            const seek = await this._logProcessor.seekAroundLine(lineNumber, 500, 500);

            // 获取文件信息
            const fileStats = await fs.promises.stat(this._fileUri.fsPath);
            const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

            // 发送上下文数据和跳转指令
            this._panel.webview.postMessage({
                command: 'jumpToLineInFullLogResult',
                data: {
                    fileName: path.basename(this._fileUri.fsPath),
                    filePath: this._fileUri.fsPath,
                    fileSize: fileSizeMB,
                    totalLines: seek.totalLines,
                    lines: seek.lines,
                    // 关键:不再声称"全部加载",让 webview 知道这只是上下文片段
                    allLoaded: false,
                    startLine: seek.startLine,
                    targetLineNumber: lineNumber
                }
            });

            vscode.window.showInformationMessage(
                seek.totalLines > seek.lines.length
                    ? `已定位到第 ${lineNumber} 行(显示 ±500 行上下文,共 ${seek.totalLines} 行)`
                    : `已跳转到第 ${lineNumber} 行`
            );
        } catch (error) {
            vscode.window.showErrorMessage(`跳转失败: ${error}`);
        }
    }

    private async filterByThreadName(threadName: string) {
        try {
            const results = await this._logProcessor.filterByThreadName(threadName);
            this._panel.webview.postMessage({
                command: 'filterResults',
                data: {
                    threadName: threadName,
                    results: results
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`线程过滤失败: ${error}`);
        }
    }

    private async filterByClassName(className: string) {
        try {
            const results = await this._logProcessor.filterByClassName(className);
            this._panel.webview.postMessage({
                command: 'filterResults',
                data: {
                    className: className,
                    results: results
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`类名过滤失败: ${error}`);
        }
    }

    private async filterByMethodName(methodName: string) {
        try {
            const results = await this._logProcessor.filterByMethodName(methodName);
            this._panel.webview.postMessage({
                command: 'filterResults',
                data: {
                    methodName: methodName,
                    results: results
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`方法名过滤失败: ${error}`);
        }
    }
    
    private async getStatistics() {
        try {
            const stats = await this._logProcessor.getStatistics();

            // 将 Map 转换为普通对象，以便通过 postMessage 传输
            const serializedStats = {
                ...stats,
                classCounts: stats.classCounts ? Object.fromEntries(stats.classCounts) : {},
                methodCounts: stats.methodCounts ? Object.fromEntries(stats.methodCounts) : {},
                threadCounts: stats.threadCounts ? Object.fromEntries(stats.threadCounts) : {}
            };

            this._panel.webview.postMessage({
                command: 'statisticsResults',
                data: serializedStats
            });
        } catch (error) {
            vscode.window.showErrorMessage(`统计失败: ${error}`);
        }
    }

    private async sampleTimeline(sampleCount = 100) {
        try {
            const timelineData = await this._logProcessor.sampleTimeline(sampleCount);
            this._panel.webview.postMessage({
                command: 'timelineData',
                data: timelineData
            });
        } catch (error) {
            vscode.window.showErrorMessage(`时间线采样失败: ${error}`);
        }
    }

    private sendConfigToWebview() {
        const config = vscode.workspace.getConfiguration('big-log-viewer');
        const searchDebounceMs = config.get<number>('search.debounceMs', 400);
        const collapseMinRepeatCount = config.get<number>('collapse.minRepeatCount', 2);
        const timelineSamplePoints = config.get<number>('timeline.samplePoints', 200);
        // 主题是字符串 enum,host 端唯一来源是 VSCode 配置;
        // webview 端的 localStorage 只是"未收到 config 前的占位值"。
        const theme = config.get<string>('theme', 'default');

        this._timelineSampleCount = timelineSamplePoints;

        this._panel.webview.postMessage({
            command: 'config',
            data: {
                searchDebounceMs,
                collapseMinRepeatCount,
                timelineSamplePoints,
                theme
            }
        });
    }

    private async updateSettings(newSettings: { searchDebounceMs?: number; collapseMinRepeatCount?: number; timelineSamplePoints?: number }) {
        const config = vscode.workspace.getConfiguration('big-log-viewer');

        try {
            if (typeof newSettings.searchDebounceMs === 'number') {
                await config.update('search.debounceMs', newSettings.searchDebounceMs, vscode.ConfigurationTarget.Workspace);
            }
            if (typeof newSettings.collapseMinRepeatCount === 'number') {
                await config.update('collapse.minRepeatCount', newSettings.collapseMinRepeatCount, vscode.ConfigurationTarget.Workspace);
            }
            if (typeof newSettings.timelineSamplePoints === 'number') {
                await config.update('timeline.samplePoints', newSettings.timelineSamplePoints, vscode.ConfigurationTarget.Workspace);
            }

            vscode.window.showInformationMessage('大日志文件查看器设置已保存');

            // 保存后重新同步配置到 WebView
            this.sendConfigToWebview();
        } catch (error) {
            vscode.window.showErrorMessage(`保存设置失败: ${error}`);
        }
    }

    private async exportCurrentView(lines: LogLine[], exportType?: string) {
        try {
            // 根据导出类型生成默认文件名
            let defaultFileName = 'exported.log';
            let successMessage = `成功导出 ${lines.length} 行日志`;
            
            if (exportType === 'bookmarked') {
                defaultFileName = 'bookmarked.log';
                successMessage = `成功导出 ${lines.length} 条带书签的日志`;
            }
            
            const uri = await vscode.window.showSaveDialog({
                filters: {
                    '日志文件': ['log', 'txt'],
                    '所有文件': ['*']
                },
                defaultUri: vscode.Uri.file(path.join(path.dirname(this._fileUri.fsPath), defaultFileName))
            });

            if (uri) {
                await this._logProcessor.exportLogs(lines, uri.fsPath);
                vscode.window.showInformationMessage(`${successMessage}到: ${uri.fsPath}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`导出失败: ${error}`);
        }
    }


    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // 模板内容在模块加载后只读一次,后续只做占位符替换
        if (!cachedWebviewHtml) {
            const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'webview.html');
            cachedWebviewHtml = fs.readFileSync(htmlPath, 'utf8');
        }
        const html = cachedWebviewHtml;

        // 生成样式和脚本在 Webview 中可访问的 URI
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.css')
        );
        const themesUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'themes.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js')
        );

        // Get codicons URI
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        // 用占位符替换为真实路径
        return html
            .replace(/%%WEBVIEW_CSS%%/g, styleUri.toString())
            .replace(/%%THEMES_CSS%%/g, themesUri.toString())
            .replace(/%%WEBVIEW_JS%%/g, scriptUri.toString())
            .replace(/%%CODICONS_CSS%%/g, codiconsUri.toString());
    }

    public dispose() {
        // 从面板集合中移除
        LogViewerPanel._panels.delete(this._fileUri.fsPath);

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async keepByTimeRange(startTime: string, endTime: string) {
        const result = await vscode.window.showWarningMessage(
            `确定只保留 ${startTime} 到 ${endTime} 时间范围内的日志吗？此操作会删除该范围外的所有日志！`,
            { modal: true },
            '确定'
        );

        if (result !== '确定') {
            return;
        }

        try {
            const deletedLines = await this._logProcessor.keepByTimeRange(startTime, endTime);
            vscode.window.showInformationMessage(`成功删除 ${deletedLines} 行日志，只保留时间范围内的日志`);
            await this.loadFile(this._fileUri);
        } catch (error) {
            vscode.window.showErrorMessage(`操作失败: ${error}`);
        }
    }

    private async keepByLineRange(startLine: number, endLine: number) {
        const result = await vscode.window.showWarningMessage(
            `确定只保留第 ${startLine} 到 ${endLine} 行的日志吗？此操作会删除该范围外的所有日志！`,
            { modal: true },
            '确定'
        );

        if (result !== '确定') {
            return;
        }

        try {
            const deletedLines = await this._logProcessor.keepByLineRange(startLine, endLine);
            vscode.window.showInformationMessage(`成功删除 ${deletedLines} 行日志，只保留指定行范围内的日志`);
            await this.loadFile(this._fileUri);
        } catch (error) {
            vscode.window.showErrorMessage(`操作失败: ${error}`);
        }
    }
}
