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

    public static createOrShow(extensionUri: vscode.Uri, fileUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const filePath = fileUri.fsPath;
        
        // 如果该文件已经有面板打开，则显示它
        if (LogViewerPanel._panels.has(filePath)) {
            const existingPanel = LogViewerPanel._panels.get(filePath)!;
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

        // 设置WebView内容
        this._update();
        // 将当前配置发送给 WebView
        this.sendConfigToWebview();

        // 监听面板关闭事件
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 处理来自WebView的消息
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'loadMore':
                        await this.loadMoreLines(message.startLine, message.count);
                        break;
                    case 'search':
                        await this.searchLogs(message.keyword, message.reverse, message.isMultiple);
                        break;
                    case 'refresh':
                        await this.loadFile(this._fileUri);
                        break;
                    case 'filterByLevel':
                        await this.filterByLevel(message.levels);
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
                    case 'regexSearch':
                        await this.regexSearch(message.pattern, message.flags, message.reverse);
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
                }
            },
            null,
            this._disposables
        );

        // 初始加载文件
        this.loadFile(fileUri);
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

            // 发送初始加载进度
            this._panel.webview.postMessage({
                command: 'loadingProgress',
                data: {
                    stage: '正在加载日志文件...',
                    progress: 0
                }
            });

            // 单一加载流程:进度 0% → 50% 在读取阶段实时推进 → 100%
            // 不再分"预览+后台"两阶段,大文件小文件走同一条路径
            const lines = await this._logProcessor.readAllLines((currentLine) => {
                const progress = Math.min(99, (currentLine / 100_000) * 99);
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

            // 发送最终进度
            this._panel.webview.postMessage({
                command: 'loadingProgress',
                data: {
                    stage: '加载完成！',
                    progress: 100,
                    current: totalLines,
                    total: totalLines
                }
            });

            // 短暂延迟后再发送 fileLoaded,让用户看到 100%
            await new Promise(resolve => setTimeout(resolve, 300));

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

    private async loadMoreLines(startLine: number, count: number) {
        // 统一加载策略:webview 不会主动请求分块了,但保留此函数以防遗漏。
        // 行为是"小心的部分读" + 标记"全部加载完成",让 webview 不再请求后续。
        try {
            const lines = await this._logProcessor.readLines(startLine, count);
            this._panel.webview.postMessage({
                command: 'moreLines',
                data: {
                    startLine: startLine,
                    lines: lines
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`加载日志行失败: ${error}`);
        }
    }

    private async searchLogs(keyword: string, reverse = false, isMultiple = false) {
        try {
            const results = await this._logProcessor.search(keyword, reverse, isMultiple);
            this._panel.webview.postMessage({
                command: 'searchResults',
                data: {
                    keyword: keyword,
                    results: results,
                    isMultiple: isMultiple
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`搜索失败: ${error}`);
        }
    }

    public async deleteByTimeOptions(timeStr: string, mode: string) {
        // 让用户选择操作方式
        const action = await vscode.window.showWarningMessage(
            `如何处理${mode === 'before' ? '之前' : '之后'}的日志？`,
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
                // 过滤显示
                const results = await this._logProcessor.filterByTime(timeStr, mode, true);
                this._panel.webview.postMessage({
                    command: 'filterResults',
                    data: {
                        levels: [],
                        results: results
                    }
                });
                vscode.window.showInformationMessage(`已隐藏 ${mode === 'before' ? '之前' : '之后'} 的日志，显示 ${results.length} 行`);
            } else if (action === '导出到新文件') {
                // 导出到新文件
                const results = await this._logProcessor.filterByTime(timeStr, mode, true);
                const uri = await vscode.window.showSaveDialog({
                    filters: {
                        '日志文件': ['log', 'txt'],
                        '所有文件': ['*']
                    },
                    defaultUri: vscode.Uri.file(path.join(path.dirname(this._fileUri.fsPath), `filtered_${path.basename(this._fileUri.fsPath)}`))
                });

                if (uri) {
                    await this._logProcessor.exportLogs(results, uri.fsPath);
                    vscode.window.showInformationMessage(`成功导出 ${results.length} 行日志到: ${uri.fsPath}`);
                }
            } else if (action === '修改原文件（危险）') {
                // 修改原文件(操作已在 modal 中确认,此处直接执行)
                try {
                    const deletedLines = await this._logProcessor.deleteByTime(timeStr, mode);
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

    public async deleteByLineOptions(lineNumber: number, mode: string) {
        // 让用户选择操作方式
        const action = await vscode.window.showWarningMessage(
            `如何处理第${lineNumber}行${mode === 'before' ? '之前' : '之后'}的日志？`,
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
                // 过滤显示
                const results = await this._logProcessor.filterByLineNumber(lineNumber, mode, true);
                this._panel.webview.postMessage({
                    command: 'filterResults',
                    data: {
                        levels: [],
                        results: results
                    }
                });
                vscode.window.showInformationMessage(`已隐藏 ${mode === 'before' ? '之前' : '之后'} 的日志，显示 ${results.length} 行`);
            } else if (action === '导出到新文件') {
                // 导出到新文件
                const results = await this._logProcessor.filterByLineNumber(lineNumber, mode, true);
                const uri = await vscode.window.showSaveDialog({
                    filters: {
                        '日志文件': ['log', 'txt'],
                        '所有文件': ['*']
                    },
                    defaultUri: vscode.Uri.file(path.join(path.dirname(this._fileUri.fsPath), `filtered_${path.basename(this._fileUri.fsPath)}`))
                });

                if (uri) {
                    await this._logProcessor.exportLogs(results, uri.fsPath);
                    vscode.window.showInformationMessage(`成功导出 ${results.length} 行日志到: ${uri.fsPath}`);
                }
            } else if (action === '修改原文件（危险）') {
                // 修改原文件(操作已在 modal 中确认,此处直接执行)
                try {
                    const deletedLines = await this._logProcessor.deleteByLine(lineNumber, mode);
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
            vscode.window.showInformationMessage(`正在加载完整日志并跳转到第 ${lineNumber} 行...`);

            // 统一路径:一次性加载整个文件(与 loadFile 一致),不再分大小文件
            const lines = await this._logProcessor.readAllLines();
            const totalLines = lines.length;

            // 获取文件信息
            const fileStats = await fs.promises.stat(this._fileUri.fsPath);
            const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

            // 发送完整日志数据和跳转指令
            this._panel.webview.postMessage({
                command: 'jumpToLineInFullLogResult',
                data: {
                    fileName: path.basename(this._fileUri.fsPath),
                    filePath: this._fileUri.fsPath,
                    fileSize: fileSizeMB,
                    totalLines: totalLines,
                    lines: lines,
                    allLoaded: true,
                    startLine: 0,
                    targetLineNumber: lineNumber
                }
            });

            vscode.window.showInformationMessage(`已跳转到第 ${lineNumber} 行`);
        } catch (error) {
            vscode.window.showErrorMessage(`跳转失败: ${error}`);
        }
    }

private async filterByLevel(levels: string[]) {
        try {
            const results = await this._logProcessor.filterByLevel(levels);
            this._panel.webview.postMessage({
                command: 'filterResults',
                data: {
                    levels: levels,
                    results: results
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`过滤失败: ${error}`);
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
            vscode.window.showErrorMessage(`方法名过���失败: ${error}`);
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

        this._timelineSampleCount = timelineSamplePoints;

        this._panel.webview.postMessage({
            command: 'config',
            data: {
                searchDebounceMs,
                collapseMinRepeatCount,
                timelineSamplePoints
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

    private async regexSearch(pattern: string, flags: string, reverse = false) {
        try {
            const results = await this._logProcessor.regexSearch(pattern, flags, reverse);
            this._panel.webview.postMessage({
                command: 'searchResults',
                data: {
                    keyword: pattern,
                    results: results,
                    isRegex: true
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`正则搜索失败: ${error}`);
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
