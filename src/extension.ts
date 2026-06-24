import * as vscode from 'vscode';
import { LogViewerPanel } from './logViewerPanel';

/**
 * 获取当前活动的日志面板,如果没有则提示用户并返回 undefined。
 * 用于消除命令注册中重复的样板代码。
 */
function requireActivePanel(): LogViewerPanel | undefined {
    const panel = LogViewerPanel.getActivePanel();
    if (!panel) {
        vscode.window.showWarningMessage('请先打开一个日志文件');
    }
    return panel;
}

export function activate(context: vscode.ExtensionContext) {
    // 打开日志文件
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.openLogFile', async (uri?: vscode.Uri) => {
        let fileUri: vscode.Uri | undefined = uri;
        if (!fileUri) {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { '日志文件': ['log', 'txt'], '所有文件': ['*'] },
                title: '选择要打开的日志文件'
            });
            if (uris && uris.length > 0) {
                fileUri = uris[0];
            }
        }
        if (fileUri) {
            LogViewerPanel.createOrShow(context.extensionUri, fileUri);
        }
    }));

    // 按时间删除日志
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.deleteByTime', async () => {
        const panel = requireActivePanel();
        if (!panel) {return;}

        const options = await vscode.window.showQuickPick([
            { label: '删除指定时间之前的日志', value: 'before' },
            { label: '删除指定时间之后的日志', value: 'after' }
        ], { placeHolder: '选择删除方式' });
        if (!options) {return;}

        const timeInput = await vscode.window.showInputBox({
            prompt: '输入时间（支持格式：2024-01-01 12:00:00 或 2024-01-01）',
            placeHolder: 'YYYY-MM-DD HH:mm:ss',
            validateInput: (value) => {
                if (!value) {return '时间不能为空';}
                if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {return '时间格式不正确';}
                return null;
            }
        });
        if (timeInput) {
            await panel.deleteByTimeOptions(timeInput, options.value);
        }
    }));

    // 按行数删除日志
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.deleteByLine', async () => {
        const panel = requireActivePanel();
        if (!panel) {return;}

        const options = await vscode.window.showQuickPick([
            { label: '删除指定行之前的日志', value: 'before' },
            { label: '删除指定行之后的日志', value: 'after' }
        ], { placeHolder: '选择删除方式' });
        if (!options) {return;}

        const lineInput = await vscode.window.showInputBox({
            prompt: '输入行号（从1开始）',
            placeHolder: '例如：100',
            validateInput: (value) => {
                if (!value) {return '行号不能为空';}
                const num = parseInt(value);
                if (isNaN(num) || num < 1) {return '请输入有效的行号（大于0的整数）';}
                return null;
            }
        });
        if (lineInput) {
            await panel.deleteByLineOptions(parseInt(lineInput), options.value);
        }
    }));

    // 刷新
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.refresh', async () => {
        const panel = requireActivePanel();
        if (panel) {await panel.refresh();}
    }));

    // 显示统计
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.showStatistics', async () => {
        const panel = requireActivePanel();
        if (panel) {panel.postMessage({ command: 'getStatistics' });}
    }));

    // 书签管理
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.toggleBookmarks', async () => {
        const panel = requireActivePanel();
        if (panel) {panel.postMessage({ command: 'toggleBookmarks' });}
    }));

    // 注释管理
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.toggleComments', async () => {
        const panel = requireActivePanel();
        if (panel) {panel.postMessage({ command: 'toggleComments' });}
    }));

    // 跳转到行号
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.jumpToLine', async () => {
        const panel = requireActivePanel();
        if (!panel) {return;}

        const lineInput = await vscode.window.showInputBox({
            prompt: '输入行号(从1开始)',
            placeHolder: '例如：100',
            validateInput: (value) => {
                if (!value) {return '行号不能为空';}
                const num = parseInt(value);
                if (isNaN(num) || num < 1) {return '请输入有效的行号(大于0的整数)';}
                return null;
            }
        });
        if (!lineInput) {return;}

        // 直接执行 — 流式 seek 已保证任何文件大小都是秒级响应,无需二次确认。
        panel.postMessage({ command: 'jumpToLineInFullLog', lineNumber: parseInt(lineInput) });
    }));

    // 高级搜索
    context.subscriptions.push(vscode.commands.registerCommand('big-log-viewer.showAdvancedSearch', async () => {
        const panel = requireActivePanel();
        if (panel) {panel.postMessage({ command: 'showAdvancedSearch' });}
    }));
}

export function deactivate() {
    // 扩展停用钩子。VSCode 要求导出此符号,即使无清理逻辑也要保留。
}
