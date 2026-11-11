import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogProcessor } from './logProcessor';
import { LogLine } from './logParser';
import { FileEncoding, isFileEncoding } from './encoding';
import { planLineChunks, SAFE_SINGLE_LINE_CHARS } from './chunkedTransfer';

let cachedWebviewHtml: string | null = null;

export class LogViewerPanel {
    // 使用 Map 来管理多个面板实例，key 为文件路径
    private static _panels: Map<string, LogViewerPanel> = new Map();
    // 最近激活过的面板:分屏多开时,破坏性命令必须跟着用户最后聚焦的那个走,
    // 而不是 Map 插入顺序里的第一个(否则可能删错文件)。
    private static _lastActivePanel: LogViewerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _fileUri: vscode.Uri;
    private _logProcessor: LogProcessor;
    private _timelineSampleCount: number;
    // 会话级编码手动切换(编码徽章)。放面板不放 processor:doLoadFile 每次重建
    // LogProcessor,状态在面板里才能在「刷新/重载」后继续生效;null = 未手动切过。
    private _encodingOverride: FileEncoding | null = null;
    /**
     * webviewReady 握手:webview 的内联早期脚本会先于 webview.js 监听器注册,
     * 它一加载完就 postMessage 'webviewReady'。在这之前 host 端不要发任何消息,
     * 否则会被 VSCode 丢弃(未就绪 webview 的 postMessage 不是缓存,是丢弃)。
     * 也防止在用户首次打开时"工具栏先出现一下,再变加载层"的闪烁。
     */
    private _isWebviewReady = false;
    private _hasLoadedFile = false;
    // 加载代次:刷新连点/删除后重载会并发触发 loadFile,只有最新代次的结果算数;
    // 串行链保证同一时间只有一个全文件扫描在跑。
    private _loadSeq = 0;
    private _loadChain: Promise<void> = Promise.resolve();
    // 分块传输代次:postMessageWithLines 每次发送自增,webview 侧按它丢弃过期块
    private _transferSeq = 0;
    // 导出反向分块(webview→宿主)的累积槽:null = 无在途导出传输
    private _exportTransfer: { lines: LogLine[]; exportType?: string; expectedTotal?: number } | null = null;
    private _disposed = false;

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
            `Open Log Viewer - ${path.basename(filePath)}`,
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

    // 获取当前活动的面板:最近激活 > 可见 > 最近激活(全不可见时兜底)
    public static getActivePanel(): LogViewerPanel | undefined {
        const last = LogViewerPanel._lastActivePanel;
        if (last && LogViewerPanel._panels.has(last._fileUri.fsPath) &&
            (last._panel.active || last._panel.visible)) {
            return last;
        }
        for (const panel of LogViewerPanel._panels.values()) {
            if (panel._panel.visible) {
                LogViewerPanel._lastActivePanel = panel;
                return panel;
            }
        }
        // 没有可见面板时退回最近激活的那个(仍在打开状态),比 Map 首元素更贴近用户意图
        if (last && LogViewerPanel._panels.has(last._fileUri.fsPath)) {
            return last;
        }
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
     * 分块发送携带大行数组的消息(fileLoaded / filterResults)。
     *
     * 单条 postMessage 的 payload 会被整体 JSON 序列化成一个字符串,行数组的
     * 字符总量逼近 V8 单字符串上限(2^29-24 ≈ 5.37 亿字符,约 500MB 文本)时
     * 序列化抛 RangeError 且被静默吞掉 —— 650MB 日志「加载到 100% 卡住不动」
     * 即由此而来。这里拆成三段:
     *   头部(带 chunkedTransferId) → chunkTransfer × N → chunkTransferDone
     * webview 侧(media/chunkedLoad.js)累积完成后合成原始消息分发给既有
     * handler,对其完全透明。
     *
     * 每块 await:串行发送避免宿主侧堆起全量待发缓冲;面板关闭时 postMessage
     * 返回 false 可以及时中止。
     *
     * @returns false = 传输被中止(面板关闭/代次过期),调用方应停止后续动作
     */
    private async postMessageWithLines(
        command: string,
        data: Record<string, unknown>,
        lines: LogLine[],
        options?: {
            /** 每块发送前检查,返回 true 则中止传输 */
            isCancelled?: () => boolean;
            /** 每块发送后的进度回调(sent = 已发行数);单块传输收尾即回调 100%,让小文件也见「加载完成」 */
            onProgress?: (sent: number, total: number) => void;
        }
    ): Promise<boolean> {
        const loadId = ++this._transferSeq;
        const headerSent = await this._panel.webview.postMessage({
            command,
            data: { ...data, chunkedTransferId: loadId }
        });
        if (!headerSent) {
            return false;
        }

        const plans = planLineChunks(lines);
        for (const plan of plans) {
            if (this._disposed || options?.isCancelled?.()) {
                // P1-b:中止时通知 webview 立刻清空累积槽,不等下一次头部到达 ——
                // 否则 1GB 文件传到 90% 被打断,已累积的几百 MB 行对象要滞留到
                // 下一次加载读完文件才释放。面板已关闭则 webview 也不在了,免发。
                if (!this._disposed) {
                    await this._panel.webview.postMessage({ command: 'chunkTransferAbort', loadId });
                }
                return false;
            }
            // P3-1:超长单行独占一块,但独占块仍可能超 V8 单字符串上限 → 明确报错,
            // 不再静默卡死(调用方的 catch 会转为用户可见的错误提示)。
            // N4:抛错前补发 abort 清掉 webview 已累积的行,与取消分支同收口。
            if (plan.end - plan.start === 1) {
                const content = lines[plan.start]?.content;
                if (typeof content === 'string' && content.length > SAFE_SINGLE_LINE_CHARS) {
                    if (!this._disposed) {
                        await this._panel.webview.postMessage({ command: 'chunkTransferAbort', loadId });
                    }
                    throw new Error(`第 ${lines[plan.start]?.lineNumber ?? plan.start + 1} 行超过 ${Math.floor(SAFE_SINGLE_LINE_CHARS / 10000) / 10000} 亿字符,单条消息无法承载,已停止载入`);
                }
            }
            const chunkSent = await this._panel.webview.postMessage({
                command: 'chunkTransfer',
                loadId,
                lines: lines.slice(plan.start, plan.end),
                sent: plan.end
            });
            if (!chunkSent) {
                return false;
            }
            options?.onProgress?.(plan.end, lines.length);
        }

        const doneSent = await this._panel.webview.postMessage({
            command: 'chunkTransferDone',
            loadId,
            chunkCount: plans.length
        });
        return doneSent;
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
        this._logProcessor = new LogProcessor(fileUri.fsPath, this._readEncodingPreference());

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

        // 跟踪最近激活的面板(分屏时命令要落到用户正在看的那个文件)
        this._panel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) {
                LogViewerPanel._lastActivePanel = this;
            }
        }, null, this._disposables);

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
                        // 刷新时重新下发配置 —— 用户在 VS Code 设置里改了长行折叠
                        // 相关项后点「刷新」就该生效(README/设置项描述都这么承诺)
                        this.sendConfigToWebview();
                        await this.loadFile(this._fileUri, 'reload');
                        break;
                    case 'filterByThread':
                        await this.filterByThreadName(message.threadName, message.filterSeq);
                        break;
                    case 'filterByClass':
                        await this.filterByClassName(message.className, message.filterSeq);
                        break;
                    case 'filterByMethod':
                        await this.filterByMethodName(message.methodName, message.filterSeq);
                        break;
                    case 'getStatistics':
                        await this.getStatistics();
                        break;
                    case 'sampleTimeline':
                        await this.sampleTimeline(LogViewerPanel.clampInt(message.sampleCount, 1, 10000, this._timelineSampleCount));
                        break;
                    case 'exportLogsBegin':
                        // 导出反向分块(P1-a):webview 把当前视图/书签行按 ~8M 字符/块
                        // 拆开发送,宿主累积完毕再走原保存对话框流程。单槽 last-begin-wins,
                        // 重复点导出时新一轮 Begin 直接覆盖旧累积。
                        this._exportTransfer = {
                            lines: [],
                            exportType: typeof message.exportType === 'string' ? message.exportType : undefined,
                            // 完整性校验(N2):Done 时比对应收行数,丢块/中断不允许静默写出残缺文件
                            expectedTotal: typeof message.totalLines === 'number' ? message.totalLines : undefined
                        };
                        break;
                    case 'exportLogsChunk':
                        if (this._exportTransfer && Array.isArray(message.lines)) {
                            for (const line of message.lines) {
                                this._exportTransfer.lines.push(line);
                            }
                        }
                        break;
                    case 'exportLogsDone':
                        if (this._exportTransfer) {
                            const transfer = this._exportTransfer;
                            this._exportTransfer = null;
                            if (transfer.expectedTotal !== undefined && transfer.lines.length !== transfer.expectedTotal) {
                                vscode.window.showErrorMessage(
                                    `导出数据不完整(收到 ${transfer.lines.length} / ${transfer.expectedTotal} 行),已取消导出,请重试`
                                );
                                break;
                            }
                            await this.exportCurrentView(transfer.lines, transfer.exportType);
                        }
                        break;
                    case 'exportTemplates':
                        await this.exportTemplates(message.templates);
                        break;
                    case 'importTemplates':
                        await this.importTemplates();
                        break;
                    case 'deleteByTime':
                        // 破坏性操作:宿主端自校验,不信任 webview 传参
                        if (typeof message.timeStr !== 'string' || !message.timeStr.trim() ||
                            (message.mode !== 'before' && message.mode !== 'after')) {
                            vscode.window.showErrorMessage('删除参数无效,已取消操作');
                            break;
                        }
                        await this.deleteByTimeOptions(message.timeStr, message.mode);
                        break;
                    case 'deleteByLine': {
                        const lineNumber = Number(message.lineNumber);
                        if (!Number.isInteger(lineNumber) || lineNumber < 1 ||
                            (message.mode !== 'before' && message.mode !== 'after')) {
                            vscode.window.showErrorMessage('删除参数无效,已取消操作');
                            break;
                        }
                        await this.deleteByLineOptions(lineNumber, message.mode);
                        break;
                    }
                    case 'keepByTimeRange':
                        if (typeof message.startTime !== 'string' || typeof message.endTime !== 'string' ||
                            !message.startTime.trim() || !message.endTime.trim()) {
                            vscode.window.showErrorMessage('保留范围参数无效,已取消操作');
                            break;
                        }
                        await this.keepByTimeRange(message.startTime, message.endTime);
                        break;
                    case 'keepByLineRange': {
                        const startLine = Number(message.startLine);
                        const endLine = Number(message.endLine);
                        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) ||
                            startLine < 1 || endLine < startLine) {
                            vscode.window.showErrorMessage('行号范围无效,已取消操作');
                            break;
                        }
                        await this.keepByLineRange(startLine, endLine);
                        break;
                    }
                    case 'jumpToTime':
                        if (typeof message.timeStr !== 'string' || !message.timeStr.trim()) {
                            break;
                        }
                        await this.jumpToTime(message.timeStr, message.jumpSeq);
                        break;
                    case 'jumpToLineInFullLog': {
                        const target = Number(message.lineNumber);
                        if (!Number.isInteger(target) || target < 1) {
                            break;
                        }
                        await this.jumpToLineInFullLog(target, message.jumpSeq);
                        break;
                    }
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
                                try {
                                    const config = vscode.workspace.getConfiguration('big-log-viewer');
                                    await config.update('theme', message.data.theme, vscode.ConfigurationTarget.Global);
                                } catch (error) {
                                    // 只读配置/Settings Sync 冲突时给出反馈,而不是抛未处理 rejection
                                    vscode.window.showErrorMessage(`切换主题失败: ${error}`);
                                }
                            }
                        }
                        break;
                    case 'setEncoding': {
                        // 编码徽章手动切换:面板会话级覆盖('auto' 回到设置项/自动检测),
                        // 之后整个重载 — 行数/时间线/统计都是旧解码下的产物,全部要重算。
                        // 非法值直接忽略:非破坏性操作,不值得弹错误打扰。
                        if (message.encoding === 'auto') {
                            this._encodingOverride = null;
                        } else if (isFileEncoding(message.encoding)) {
                            this._encodingOverride = message.encoding;
                        } else {
                            break;
                        }
                        await this.loadFile(this._fileUri);
                        break;
                    }
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

    /**
     * 编码偏好:会话级手动切换 > 设置项 file.encoding(auto/非法值 → null 走自动检测)。
     * doLoadFile 每次重建 LogProcessor 都从这里取,保证刷新/重载后选择不丢。
     */
    private _readEncodingPreference(): FileEncoding | null {
        if (this._encodingOverride) { return this._encodingOverride; }
        const raw = vscode.workspace.getConfiguration('big-log-viewer').get<string>('file.encoding', 'auto');
        return isFileEncoding(raw) ? raw : null;
    }

    /** 命令面板「显示统计」直达宿主统计(与工具栏「统计」同一链路) */
    public async showStatistics(): Promise<void> {
        await this.getStatistics();
    }

    /** 命令面板「跳转到行」直达宿主流式 seek(不再经 webview 中转) */
    public async jumpToLine(lineNumber: number): Promise<void> {
        await this.jumpToLineInFullLog(lineNumber);
    }

    /** 整数钳制:非有限数回退默认值,再夹到 [min, max] */
    private static clampInt(value: unknown, min: number, max: number, fallback: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, Math.round(value)));
    }

    /**
     * 加载文件(串行化 + 代次防护):
     * - 同一时间只跑一个全文件扫描,排队中的过期任务直接跳过
     * - 面板关闭或被更新的加载取代后,不再往 webview 发消息
     */
    private loadFile(fileUri: vscode.Uri, loadReason: 'load' | 'reload' = 'load'): Promise<void> {
        const seq = ++this._loadSeq;
        this._loadChain = this._loadChain
            .catch(() => undefined)   // 前一次失败不阻塞后续
            .then(() => {
                if (this._disposed || seq !== this._loadSeq) {
                    return; // 已被更新的加载取代
                }
                return this.doLoadFile(fileUri, seq, loadReason);
            });
        return this._loadChain;
    }

    private async doLoadFile(fileUri: vscode.Uri, seq: number, loadReason: 'load' | 'reload') {
        this._fileUri = fileUri;
        // v1.3.3：在替换 _logProcessor 之前先让旧对象释放缓存。alias 变更后用户可能
        // 调到 refresh() 重新打开同一文件（不切换 filePath），旧 _logProcessor 里的
        // statsCache 是 mtime 键控的旧口径统计，必须清掉让重新加载走新别名。
        this._logProcessor.invalidateCaches();
        this._logProcessor = new LogProcessor(fileUri.fsPath, this._readEncodingPreference());

        try {
            const fileStats = await fs.promises.stat(fileUri.fsPath);
            const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
            const fileSizeBytes = fileStats.size;

            // 大小护栏:载入的行数组全量驻留内存(宿主 + webview 双份),无上限
            // 地放开只会换来 OOM 或长时间假死 —— 超过上限直接明确报错并收起
            // 加载遮罩,不再无声卡死。0 = 不限制。
            const maxFileSizeMB = LogViewerPanel.clampInt(
                vscode.workspace.getConfiguration('big-log-viewer').get<number>('load.maxFileSizeMB', 1024),
                0, 32768, 1024
            );
            if (maxFileSizeMB > 0 && fileSizeBytes > maxFileSizeMB * 1024 * 1024) {
                const message = `文件 ${path.basename(fileUri.fsPath)}(${fileSizeMB}MB)超过大小上限 ${maxFileSizeMB}MB,已停止加载。` +
                    '可在设置「Open Log Viewer → Load: Max File Size Mb」调大上限(0 = 不限制),或先拆分文件后再打开';
                vscode.window.showErrorMessage(message);
                this._panel.webview.postMessage({
                    command: 'fileLoadError',
                    data: { message }
                });
                return;
            }

            // 单条连续进度条:读取阶段占 0–70%(按真实字节已读量/文件总大小归一化),
            // 分块送入查看器占 70–100% —— 两段真实工作合成一条不归零的进度,
            // 阶段文字(「正在加载日志...」→「正在载入日志数据...」)负责区分当前在干嘛。
            // 替换之前"行数/10万"的行数 hack — 后者在大文件上永远卡着不动。
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
                    ? Math.min(70, (bytes / fileSizeBytes) * 70)
                    : Math.min(70, (currentLine / 100_000) * 70);
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
            if (this._disposed || seq !== this._loadSeq) {
                return; // 读取期间面板被关闭/被新加载取代,丢弃本次结果
            }

            this._panel.title = `Open Log Viewer - ${path.basename(fileUri.fsPath)}`;

            // 读取结束 → 进入送数据阶段:阶段文字即刻切换、进度条从 70% 起步。
            // 之后的推进由下面每块的 onProgress 负责 —— 进度映射只在这一个文件里,
            // webview 侧分块拦截只累积不刷进度,避免两边映射不一致的来回跳。
            this._panel.webview.postMessage({
                command: 'loadingProgress',
                data: {
                    stage: '正在载入日志数据...',
                    progress: 70,
                    current: 0,
                    total: totalLines
                }
            });

            // 分块发送:lines 数组按 ~8M 字符/块拆开发送,webview 累积完成后合成
            // 原始 fileLoaded 消息分发 —— 单条消息发全量会超 V8 单字符串上限,
            // 650MB 日志即卡死在这(详见 postMessageWithLines 注释)。
            const delivered = await this.postMessageWithLines(
                'fileLoaded',
                {
                    fileName: path.basename(fileUri.fsPath),
                    filePath: fileUri.fsPath,
                    fileSize: fileSizeMB,
                    totalLines: totalLines,
                    allLoaded: true,
                    // 加载来源:'reload' = webview 的 refresh 命令(含筛选触发的整文件重载),
                    // 'load' = 打开面板/命令面板刷新/删除后重载/编码切换等其它路径。
                    // webview 的筛选快照只认 'reload' 回填(R1: 命令面板刷新不带此标记,不回填)
                    loadReason,
                    fileEncoding: await this._logProcessor.getEncoding(),
                    // true = 自动检测(既没手动切换,设置项也是 auto);webview 据此决定
                    // 下拉停在「自动检测(当前: XX)」还是直接选中具体编码
                    fileEncodingAuto: this._encodingOverride === null &&
                        !isFileEncoding(vscode.workspace.getConfiguration('big-log-viewer').get<string>('file.encoding', 'auto'))
                },
                lines,
                {
                    // 读取期间面板被关闭/被新加载取代 → 中止剩余块的发送
                    isCancelled: () => seq !== this._loadSeq,
                    // 传输进度映射到加载遮罩:接在读取段的 70% 之后走到 100%,
                    // 与读取阶段合成同一条连续进度条(current/total 行数字段同构)。
                    // 收尾一块把阶段文字切成「加载完成！」,小文件也能看到完成反馈
                    onProgress: (sent, total) => {
                        this._panel.webview.postMessage({
                            command: 'loadingProgress',
                            data: {
                                stage: total > 0 && sent >= total ? '加载完成！' : '正在载入日志数据...',
                                progress: total > 0 ? 70 + (sent / total) * 30 : 100,
                                current: sent,
                                total
                            }
                        });
                    }
                }
            );
            if (!delivered || this._disposed || seq !== this._loadSeq) {
                // P3-2:传输失败且没有被新加载接管时,收起遮罩并提示 ——
                // 否则加载遮罩会一直盖住工具栏,只能关面板重开。
                // 被新加载取代(seq 过期)或面板已关闭时保持沉默,新加载自己接管 UI。
                if (!this._disposed && seq === this._loadSeq) {
                    vscode.window.showErrorMessage('日志数据载入查看器失败,请刷新重试');
                    this._panel.webview.postMessage({
                        command: 'fileLoadError',
                        data: { message: '日志数据载入查看器失败,请刷新重试' }
                    });
                }
                return;
            }

            // 请求时间线采样
            this.sampleTimeline(this._timelineSampleCount);
        } catch (error) {
            vscode.window.showErrorMessage(`加载文件失败: ${error}`);
            if (!this._disposed && seq === this._loadSeq) {
                // 通知 webview 收起加载遮罩 — 否则读取失败后全屏 loading-overlay
                // 永远盖住工具栏(连刷新都点不到),只能关面板重开。
                this._panel.webview.postMessage({
                    command: 'fileLoadError',
                    data: { message: `加载文件失败: ${error}` }
                });
            }
        }
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
                // 「保留某点之后/之前」在大文件上可等价全文件,同样走分块发送
                await this.postMessageWithLines('filterResults', { levels: [] }, results);
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

    public async deleteByTimeOptions(timeStr: string, mode: 'before' | 'after') {
        await this.confirmDestructiveAction({
            promptTitle: `如何处理${mode === 'before' ? '之前' : '之后'}的日志?`,
            mode: mode,
            computeResults: () => this._logProcessor.filterByTime(timeStr, mode, true),
            deleteFromFile: () => this._logProcessor.deleteByTime(timeStr, mode)
        });
    }

    public async deleteByLineOptions(lineNumber: number, mode: 'before' | 'after') {
        await this.confirmDestructiveAction({
            promptTitle: `如何处理第 ${lineNumber} 行${mode === 'before' ? '之前' : '之后'}的日志?`,
            mode: mode,
            computeResults: () => this._logProcessor.filterByLineNumber(lineNumber, mode, true),
            deleteFromFile: () => this._logProcessor.deleteByLine(lineNumber, mode)
        });
    }

    private async jumpToTime(timeStr: string, seq?: number) {
        try {
            vscode.window.showInformationMessage(`正在查找时间 ${timeStr} 的日志...`);
            const result = await this._logProcessor.findLineByTime(timeStr);

            if (result) {
                // 找到了，加载该行及周围的日志(闭区间 readLines:start 含、共 count 行)
                const startLine = Math.max(1, result.lineNumber - 500);
                const endLine = result.lineNumber + 500;
                const lines = await this._logProcessor.readLines(startLine, endLine - startLine + 1);

                this._panel.webview.postMessage({
                    command: 'jumpToTimeResult',
                    data: {
                        success: true,
                        targetLineNumber: result.lineNumber,
                        lines: lines,
                        startLine: startLine,
                        // 回传请求代次:webview 用来丢弃过期响应,避免旧跳转覆盖新状态
                        jumpSeq: seq
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

    private async jumpToLineInFullLog(lineNumber: number, seq?: number) {
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
                    targetLineNumber: lineNumber,
                    // 回传请求代次:webview 用来丢弃过期响应
                    jumpSeq: seq
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

    private async filterByThreadName(threadName: string, seq?: number) {
        try {
            const results = await this._logProcessor.filterByThreadName(threadName);
            // 匹配行占比高时可接近全文件,走分块发送
            await this.postMessageWithLines('filterResults', {
                threadName: threadName,
                // 回传请求代次:webview 用来丢弃过期响应
                filterSeq: seq
            }, results);
        } catch (error) {
            vscode.window.showErrorMessage(`线程过滤失败: ${error}`);
        }
    }

    private async filterByClassName(className: string, seq?: number) {
        try {
            const results = await this._logProcessor.filterByClassName(className);
            await this.postMessageWithLines('filterResults', {
                className: className,
                filterSeq: seq
            }, results);
        } catch (error) {
            vscode.window.showErrorMessage(`类名过滤失败: ${error}`);
        }
    }

    private async filterByMethodName(methodName: string, seq?: number) {
        try {
            const results = await this._logProcessor.filterByMethodName(methodName);
            await this.postMessageWithLines('filterResults', {
                methodName: methodName,
                filterSeq: seq
            }, results);
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
        // 长行折叠:开关默认开,保留行数钳制到 schema 声明的区间(1~50)
        const foldLongLines = config.get<boolean>('view.foldLongLines', true);
        const foldMaxRows = LogViewerPanel.clampInt(config.get<number>('view.foldMaxRows', 3), 1, 50, 3);
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
                foldLongLines,
                foldMaxRows,
                theme
            }
        });
    }

    private async updateSettings(newSettings: { searchDebounceMs?: number; collapseMinRepeatCount?: number; timelineSamplePoints?: number }) {
        const config = vscode.workspace.getConfiguration('big-log-viewer');

        try {
            // 宿主端钳制:NaN/越界值经 config.update 写入后 schema 不一定拦截
            if (typeof newSettings.searchDebounceMs === 'number') {
                await config.update('search.debounceMs', LogViewerPanel.clampInt(newSettings.searchDebounceMs, 0, 5000, 400), vscode.ConfigurationTarget.Workspace);
            }
            if (typeof newSettings.collapseMinRepeatCount === 'number') {
                await config.update('collapse.minRepeatCount', LogViewerPanel.clampInt(newSettings.collapseMinRepeatCount, 2, 100, 2), vscode.ConfigurationTarget.Workspace);
            }
            if (typeof newSettings.timelineSamplePoints === 'number') {
                await config.update('timeline.samplePoints', LogViewerPanel.clampInt(newSettings.timelineSamplePoints, 10, 10000, 200), vscode.ConfigurationTarget.Workspace);
            }

            vscode.window.showInformationMessage('Open Log Viewer 设置已保存');

            // 保存后重新同步配置到 WebView
            this.sendConfigToWebview();
        } catch (error) {
            vscode.window.showErrorMessage(`保存设置失败: ${error}`);
        }
    }

    private async exportCurrentView(lines: LogLine[], exportType?: string) {
        if (!Array.isArray(lines)) {
            return; // 防御:webview 侧数据异常时不进保存对话框
        }
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


    /**
     * 导出排查模板到 JSON 文件。内容由 webview 侧生成并校验,
     * 宿主端只负责保存对话框与写文件(实现模式同 exportCurrentView)。
     */
    private async exportTemplates(templates: unknown[]) {
        try {
            const list = Array.isArray(templates) ? templates : [];
            const uri = await vscode.window.showSaveDialog({
                filters: {
                    '模板文件': ['json'],
                    '所有文件': ['*']
                },
                defaultUri: vscode.Uri.file(
                    path.join(path.dirname(this._fileUri.fsPath), 'troubleshootTemplates.json')
                )
            });
            if (!uri) {
                return; // 用户取消
            }
            const payload = {
                schemaVersion: 1,
                exportedAt: new Date().toISOString(),
                templates: list
            };
            await fs.promises.writeFile(uri.fsPath, JSON.stringify(payload, null, 2), 'utf8');
            vscode.window.showInformationMessage(`成功导出 ${list.length} 个排查模板到: ${uri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`导出排查模板失败: ${error}`);
        }
    }

    /**
     * 从 JSON 文件导入排查模板:宿主端负责打开对话框与读文件,
     * 内容回传 webview 侧做白名单校验与按 id 合并。
     */
    private async importTemplates() {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    '模板文件': ['json'],
                    '所有文件': ['*']
                }
            });
            if (!uris || uris.length === 0) {
                return; // 用户取消
            }
            const content = await fs.promises.readFile(uris[0].fsPath, 'utf8');
            this._panel.webview.postMessage({
                command: 'importTemplatesResult',
                data: { content }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`导入排查模板失败: ${error}`);
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
        // 排查模板功能脚本(依赖 webview.js 的全局函数,必须后加载)
        const templatesScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'investigationTemplates.js')
        );
        // 搜索历史存储脚本(纯存储逻辑,webview.js 运行时调用其全局函数)
        const searchHistoryScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'searchHistory.js')
        );
        // 日志选区复制脚本(接管 Ctrl+C,必须先于 webview.js 加载——webview.js 末尾会调 initLogClipboard)
        const clipboardScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'clipboard.js')
        );
        // 选中日志文字 Ctrl+F 直接搜索(复用 clipboard.js 的 getLogSelectionText,须在其后加载)
        const searchShortcutScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'searchShortcut.js')
        );
        // 行号范围限定纯逻辑脚本(解析/校验/chip 文案,webview.js 过滤链运行时调用,须先于其加载)
        const lineRangeScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'lineRange.js')
        );
        // 长行折叠纯逻辑脚本(判定/文案,webview.js 渲染链运行时调用,须先于其加载)
        const foldLongLinesScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'foldLongLines.js')
        );
        // 分块传输累积器纯逻辑脚本(宿主大数组分块消息的累积/合成,webview.js 消息分发调用,须先于其加载)
        const chunkedLoadScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'chunkedLoad.js')
        );

        // Get codicons URI
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        // 用占位符替换为真实路径
        return html
            .replace(/%%CSP_SOURCE%%/g, webview.cspSource)
            .replace(/%%WEBVIEW_CSS%%/g, styleUri.toString())
            .replace(/%%THEMES_CSS%%/g, themesUri.toString())
            .replace(/%%WEBVIEW_JS%%/g, scriptUri.toString())
            .replace(/%%TEMPLATES_JS%%/g, templatesScriptUri.toString())
            .replace(/%%SEARCH_HISTORY_JS%%/g, searchHistoryScriptUri.toString())
            .replace(/%%CLIPBOARD_JS%%/g, clipboardScriptUri.toString())
            .replace(/%%SEARCH_SHORTCUT_JS%%/g, searchShortcutScriptUri.toString())
            .replace(/%%LINE_RANGE_JS%%/g, lineRangeScriptUri.toString())
            .replace(/%%FOLD_LONG_LINES_JS%%/g, foldLongLinesScriptUri.toString())
            .replace(/%%CHUNKED_LOAD_JS%%/g, chunkedLoadScriptUri.toString())
            .replace(/%%CODICONS_CSS%%/g, codiconsUri.toString());
    }

    public dispose() {
        this._disposed = true;
        // 从面板集合中移除
        LogViewerPanel._panels.delete(this._fileUri.fsPath);
        if (LogViewerPanel._lastActivePanel === this) {
            LogViewerPanel._lastActivePanel = undefined;
        }

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
