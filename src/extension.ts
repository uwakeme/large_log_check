import * as vscode from 'vscode';
import { LogViewerPanel } from './logViewerPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('大日志文件查看器已激活');

    // 注册打开日志文件命令
    let openLogFileCommand = vscode.commands.registerCommand('big-log-viewer.openLogFile', async (uri?: vscode.Uri) => {
        let fileUri: vscode.Uri | undefined = uri;
        
        if (!fileUri) {
            // 如果没有传入URI,则显示文件选择对话框
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    '日志文件': ['log', 'txt'],
                    '所有文件': ['*']
                },
                title: '选择要打开的日志文件'
            });
            
            if (uris && uris.length > 0) {
                fileUri = uris[0];
            }
        }
        
        if (fileUri) {
            LogViewerPanel.createOrShow(context.extensionUri, fileUri);
        }
    });

    // 注册按时间删除日志命令
    let deleteByTimeCommand = vscode.commands.registerCommand('big-log-viewer.deleteByTime', async () => {
        const panel = LogViewerPanel.currentPanel;
        if (!panel) {
            vscode.window.showWarningMessage('请先打开一个日志文件');
            return;
        }

        const options = await vscode.window.showQuickPick([
            { label: '删除指定时间之前的日志', value: 'before' },
            { label: '删除指定时间之后的日志', value: 'after' }
        ], {
            placeHolder: '选择删除方式'
        });

        if (!options) {
            return;
        }

        const timeInput = await vscode.window.showInputBox({
            prompt: '输入时间（支持格式：2024-01-01 12:00:00 或 2024-01-01）',
            placeHolder: 'YYYY-MM-DD HH:mm:ss',
            validateInput: (value) => {
                if (!value) {
                    return '时间不能为空';
                }
                // 简单验证时间格式
                if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
                    return '时间格式不正确';
                }
                return null;
            }
        });

        if (timeInput) {
            panel.deleteByTimeOptions(timeInput, options.value);
        }
    });

    // 注册按行数删除日志命令
    let deleteByLineCommand = vscode.commands.registerCommand('big-log-viewer.deleteByLine', async () => {
        const panel = LogViewerPanel.currentPanel;
        if (!panel) {
            vscode.window.showWarningMessage('请先打开一个日志文件');
            return;
        }

        const options = await vscode.window.showQuickPick([
            { label: '删除指定行之前的日志', value: 'before' },
            { label: '删除指定行之后的日志', value: 'after' }
        ], {
            placeHolder: '选择删除方式'
        });

        if (!options) {
            return;
        }

        const lineInput = await vscode.window.showInputBox({
            prompt: '输入行号（从1开始）',
            placeHolder: '例如：100',
            validateInput: (value) => {
                if (!value) {
                    return '行号不能为空';
                }
                const num = parseInt(value);
                if (isNaN(num) || num < 1) {
                    return '请输入有效的行号（大于0的整数）';
                }
                return null;
            }
        });

        if (lineInput) {
            panel.deleteByLineOptions(parseInt(lineInput), options.value);
        }
    });

    context.subscriptions.push(openLogFileCommand, deleteByTimeCommand, deleteByLineCommand);
}

export function deactivate() {}
