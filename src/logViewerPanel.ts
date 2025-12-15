import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogProcessor } from './logProcessor';

export class LogViewerPanel {
    public static currentPanel: LogViewerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _fileUri: vscode.Uri;
    private _logProcessor: LogProcessor;

    public static createOrShow(extensionUri: vscode.Uri, fileUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 如果已经有面板打开,则显示它
        if (LogViewerPanel.currentPanel) {
            LogViewerPanel.currentPanel._panel.reveal(column);
            LogViewerPanel.currentPanel.loadFile(fileUri);
            return;
        }

        // 否则,创建新面板
        const panel = vscode.window.createWebviewPanel(
            'logViewer',
            '日志查看器',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        LogViewerPanel.currentPanel = new LogViewerPanel(panel, extensionUri, fileUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, fileUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._fileUri = fileUri;
        this._logProcessor = new LogProcessor(fileUri.fsPath);

        // 设置WebView内容
        this._update();

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
                        await this.searchLogs(message.keyword, message.reverse);
                        break;
                    case 'refresh':
                        await this.loadFile(this._fileUri);
                        break;
                    case 'filterByLevel':
                        await this.filterByLevel(message.levels);
                        break;
                    case 'getStatistics':
                        await this.getStatistics();
                        break;
                    case 'regexSearch':
                        await this.regexSearch(message.pattern, message.flags, message.reverse);
                        break;
                    case 'exportLogs':
                        await this.exportCurrentView(message.lines);
                        break;
                    case 'deleteByTime':
                        await this.deleteByTimeOptions(message.timeStr, message.mode);
                        break;
                    case 'deleteByLine':
                        await this.deleteByLineOptions(message.lineNumber, message.mode);
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
            
            // 获取总行数
            const totalLines = await this._logProcessor.getTotalLines();
            
            // 根据文件大小决定加载策略
            let initialLines;
            if (totalLines <= 50000) {
                // 小于5万行，一次性加载所有数据
                vscode.window.showInformationMessage(`正在加载 ${totalLines} 行日志，请稍候...`);
                initialLines = await this._logProcessor.readLines(0, totalLines);
            } else {
                // 大于5万行，先加载前10000行
                vscode.window.showInformationMessage(`文件较大，先加载前 10000 行...`);
                initialLines = await this._logProcessor.readLines(0, 10000);
            }
            
            this._panel.title = `日志查看器 - ${path.basename(fileUri.fsPath)}`;
            
            this._panel.webview.postMessage({
                command: 'fileLoaded',
                data: {
                    fileName: path.basename(fileUri.fsPath),
                    filePath: fileUri.fsPath,
                    fileSize: fileSizeMB,
                    totalLines: totalLines,
                    lines: initialLines,
                    allLoaded: totalLines <= 50000
                }
            });
            
            vscode.window.showInformationMessage(`成功加载日志文件: ${path.basename(fileUri.fsPath)} (${fileSizeMB}MB, ${totalLines}行)`);
        } catch (error) {
            vscode.window.showErrorMessage(`加载文件失败: ${error}`);
        }
    }

    private async loadMoreLines(startLine: number, count: number) {
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

    private async searchLogs(keyword: string, reverse: boolean = false) {
        try {
            const results = await this._logProcessor.search(keyword, reverse);
            this._panel.webview.postMessage({
                command: 'searchResults',
                data: {
                    keyword: keyword,
                    results: results
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
                // 修改原文件
                await this.deleteByTime(timeStr, mode);
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
                // 修改原文件
                await this.deleteByLine(lineNumber, mode);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`操作失败: ${error}`);
        }
    }

    private async deleteByTime(timeStr: string, mode: string) {
        const result = await vscode.window.showWarningMessage(
            `确定要删除${mode === 'before' ? '之前' : '之后'}的日志吗？此操作会修改原文件！`,
            { modal: true },
            '确定'
        );

        if (result !== '确定') {
            return;
        }

        try {
            const deletedLines = await this._logProcessor.deleteByTime(timeStr, mode);
            vscode.window.showInformationMessage(`成功删除 ${deletedLines} 行日志`);
            await this.loadFile(this._fileUri);
        } catch (error) {
            vscode.window.showErrorMessage(`删除失败: ${error}`);
        }
    }

    private async deleteByLine(lineNumber: number, mode: string) {
        const result = await vscode.window.showWarningMessage(
            `确定要删除第${lineNumber}行${mode === 'before' ? '之前' : '之后'}的日志吗？此操作会修改原文件！`,
            { modal: true },
            '确定'
        );

        if (result !== '确定') {
            return;
        }

        try {
            const deletedLines = await this._logProcessor.deleteByLine(lineNumber, mode);
            vscode.window.showInformationMessage(`成功删除 ${deletedLines} 行日志`);
            await this.loadFile(this._fileUri);
        } catch (error) {
            vscode.window.showErrorMessage(`删除失败: ${error}`);
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
            
            // 获取总行数
            const totalLines = await this._logProcessor.getTotalLines();
            
            // 根据文件大小决定加载策略
            let lines;
            let allLoaded = false;
            
            if (totalLines <= 50000) {
                // 小文件，一次性加载所有数据
                lines = await this._logProcessor.readLines(0, totalLines);
                allLoaded = true;
            } else {
                // 大文件，加载目标行附近的10000行
                const startLine = Math.max(0, lineNumber - 5000);
                const count = 10000;
                lines = await this._logProcessor.readLines(startLine, count);
            }
            
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
                    allLoaded: allLoaded,
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
            console.log('📤 前端发送过滤请求 - 级别:', levels);
            const results = await this._logProcessor.filterByLevel(levels);
            console.log('📥 后端返回结果数量:', results.length);
            if (results.length > 0) {
                console.log('👀 第一条结果 - 级别:', results[0].level, '内容:', results[0].content.substring(0, 100));
            }
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

    private async regexSearch(pattern: string, flags: string, reverse: boolean = false) {
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

    private async exportCurrentView(lines: any[]) {
        try {
            const uri = await vscode.window.showSaveDialog({
                filters: {
                    '日志文件': ['log', 'txt'],
                    '所有文件': ['*']
                },
                defaultUri: vscode.Uri.file(path.join(path.dirname(this._fileUri.fsPath), 'exported.log'))
            });

            if (uri) {
                await this._logProcessor.exportLogs(lines, uri.fsPath);
                vscode.window.showInformationMessage(`成功导出 ${lines.length} 行日志到: ${uri.fsPath}`);
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
        const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'webview.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        return html;
    }

    public dispose() {
        LogViewerPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
