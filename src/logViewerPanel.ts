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
                        await this.searchLogs(message.keyword);
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
                        await this.regexSearch(message.pattern, message.flags);
                        break;
                    case 'exportLogs':
                        await this.exportCurrentView(message.lines);
                        break;
                    case 'deleteByTime':
                        await this.deleteByTime(message.timeStr, message.mode);
                        break;
                    case 'deleteByLine':
                        await this.deleteByLine(message.lineNumber, message.mode);
                        break;
                }
            },
            null,
            this._disposables
        );

        // 初始加载文件
        this.loadFile(fileUri);
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

    private async searchLogs(keyword: string) {
        try {
            const results = await this._logProcessor.search(keyword);
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

    public async deleteByTime(timeStr: string, mode: string) {
        const result = await vscode.window.showWarningMessage(
            `确定要删除${mode === 'before' ? '之前' : '之后'}的日志吗？此操作会修改原文件！`,
            { modal: true },
            '确定', '取消'
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

    public async deleteByLine(lineNumber: number, mode: string) {
        const result = await vscode.window.showWarningMessage(
            `确定要删除第${lineNumber}行${mode === 'before' ? '之前' : '之后'}的日志吗？此操作会修改原文件！`,
            { modal: true },
            '确定', '取消'
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

    private async filterByLevel(levels: string[]) {
        try {
            console.log('Filtering by levels:', levels);
            const results = await this._logProcessor.filterByLevel(levels);
            console.log('Filter results count:', results.length);
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
            this._panel.webview.postMessage({
                command: 'statisticsResults',
                data: stats
            });
        } catch (error) {
            vscode.window.showErrorMessage(`统计失败: ${error}`);
        }
    }

    private async regexSearch(pattern: string, flags: string) {
        try {
            const results = await this._logProcessor.regexSearch(pattern, flags);
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
