import * as fs from 'fs';
import * as readline from 'readline';
import { pipeline } from 'stream/promises';
import { Transform, Readable } from 'stream';
import { LogParser, LogLine, LogStats } from './logParser';

// 进度回调触发间隔（行数）。processLines 的进度回调在"已读行数"超过这个
// 增量时触发,避免每行都发 postMessage 把 webview 的 message queue 撑爆。
const PROGRESS_REPORT_INTERVAL = 1_000;

// 进度回调触发间隔（毫秒）。即便文件行数少、行很短,也要保证每 100ms 至少
// 触发一次进度回调,这样 UI 上的进度条不会卡在 0% 不动。
const PROGRESS_THROTTLE_MS = 100;

// 统计里 class/method/thread 计数 Map 的上限:兜底类名正则会匹配到 URL/版本号等
// 噪声,无上限时一份脏日志能把宿主内存撑爆。到达上限后只累加已有 key。
const MAX_STATS_KEYS = 10_000;

export class LogProcessor {
    private _filePath: string;
    private _totalLines = 0;
    private _totalLinesMtime = 0;
    private _statsCache: LogStats | null = null;
    private _statsCacheMtime = 0;

    constructor(filePath: string) {
        this._filePath = filePath;
    }

    getFilePath(): string {
        return this._filePath;
    }

    /**
     * 通用流式行处理:对每行调用 fold,返回累积结果。
     * 消除了 14 处相同的 fs.createReadStream + readline 样板。
     * fold 必须是同步的;若需异步逻辑,在外部分批处理。
     *
     * onProgress 同时按"行数阈值"和"时间阈值"双重去重,保证:
     *   - 大量数据时不会因为每行都触发回调而压垮 postMessage
     *   - 数据很少时也不会因为行数不够而沉默很久
     *
     * 第二个参数 bytesRead(可选)用于字节进度反馈,让 UI 进度条能基于真实已读字节
     * 而不是行数推算(行数推算在大小文件上都容易出现"卡 99%"的体验问题)。
     *
     * 错误处理:任意环节(stream / readline)出错时,主动 destroy stream,
     * 避免文件描述符泄漏。Promise 始终会被 resolve 或 reject,不会悬挂。
     */
    private processLines<T>(
        initial: T,
        fold: (acc: T, line: string, lineNumber: number) => T,
        onProgress?: (lineNumber: number, bytesRead?: number) => void,
        shouldStop?: (acc: T, lineNumber: number) => boolean
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            let acc = initial;
            let lineNumber = 0;
            let lastReportedLines = 0;
            let lastReportedAt = 0;
            let settled = false;
            const stream = fs.createReadStream(this._filePath);
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            const settle = (fn: () => void) => {
                if (settled) {return;}
                settled = true;
                stream.destroy();
                fn();
            };
            const reportIfDue = () => {
                if (!onProgress) {return;}
                const now = Date.now();
                if (lineNumber - lastReportedLines >= PROGRESS_REPORT_INTERVAL ||
                    (lineNumber > lastReportedLines && now - lastReportedAt >= PROGRESS_THROTTLE_MS)) {
                    onProgress(lineNumber, stream.bytesRead);
                    lastReportedLines = lineNumber;
                    lastReportedAt = now;
                }
            };
            rl.on('line', (line) => {
                lineNumber++;
                acc = fold(acc, line, lineNumber);
                reportIfDue();
                // 早停:窗口型读取收满目标行后不再扫文件剩余部分
                if (shouldStop && shouldStop(acc, lineNumber)) {
                    settle(() => resolve(acc));
                }
            });
            rl.on('close', () => {
                if (onProgress && lineNumber > lastReportedLines) {
                    onProgress(lineNumber, stream.bytesRead);
                }
                settle(() => resolve(acc));
            });
            rl.on('error', (err) => settle(() => reject(err)));
            // stream 自身错误(EACCES / ENOENT / disk error)也要兜底
            stream.on('error', (err) => settle(() => reject(err)));
        });
    }

    /**
     * 获取文件总行数,带进度回调。
     * 直接把回调透传给 processLines — 它内部已经有"行数+时间"双阈值节流,
     * 不用再写第二份。结束时再补一次终值回调,保证 UI 看到 100%。
     */
    async getTotalLines(progressCallback?: (currentLines: number, bytesRead?: number) => void): Promise<number> {
        // mtime 缓存:文件没变就不再整扫一遍(时间线采样、跳转都靠它省一次全量读)
        const mtime = (await fs.promises.stat(this._filePath)).mtimeMs;
        if (this._totalLines > 0 && this._totalLinesMtime === mtime) {
            if (progressCallback) { progressCallback(this._totalLines); }
            return this._totalLines;
        }
        this._totalLines = await this.processLines(0, (_count, _line, n) => n, progressCallback);
        this._totalLinesMtime = mtime;
        if (progressCallback && this._totalLines > 0) {
            progressCallback(this._totalLines);
        }
        return this._totalLines;
    }

    /**
     * 读取从 startLine(含)开始的 count 行 — 闭区间语义,与 seekAroundLine 一致。
     * 收满即停:目标窗口之后的文件尾部不再白扫。
     */
    async readLines(startLine: number, count: number): Promise<LogLine[]> {
        const endLine = startLine + count - 1;
        return this.processLines<LogLine[]>([], (lines, content, n) => {
            if (n >= startLine && n <= endLine) {
                lines.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return lines;
        }, undefined, (_acc, n) => n >= endLine);
    }

    /**
     * 一次性读取整个文件,带进度回调。
     * 统一大小文件的加载路径:不分预览/全量,UI 看到的就是一条线性进度。
     *
     * 进度按"行数"驱动,辅以"时间节流"保底:
     *   - 大量数据时按 PROGRESS_REPORT_INTERVAL 行触发一次,避免压垮 postMessage
     *   - 数据很少时(单行很长或文件很小)按 PROGRESS_THROTTLE_MS 时间触发,
     *     保证 UI 上的进度条不会卡在 0% 不动
     *
     * 注意:不要在这里再额外 attach stream.on('data') 来追字节数 — readline 已经
     * 内部 attach 了 data listener,多个 listener 共存会让 readline 的内部
     * buffer 状态机进入不一致,表现为"data 事件不触发 / 卡死"。基于行数 +
     * 时间节流已经能提供足够平滑的进度反馈。
     */
    async readAllLines(progressCallback?: (currentLine: number, bytesRead?: number) => void): Promise<LogLine[]> {
        // 读之前记下 mtime:全文件扫完后顺手把总行数缓存好,
        // 后续 getTotalLines(时间线采样等)直接命中,不再二次整扫。
        const mtime = (await fs.promises.stat(this._filePath)).mtimeMs;
        const lines = await this.processLines<LogLine[]>([], (lines, content, n) => {
            lines.push({
                lineNumber: n,
                content,
                timestamp: LogParser.extractTimestamp(content),
                level: LogParser.extractLogLevel(content)
            });
            return lines;
        }, progressCallback);
        this._totalLines = lines.length;
        this._totalLinesMtime = mtime;
        return lines;
    }

    /**
     * 按时间过滤(不修改文件)
     */
    async filterByTime(timeStr: string, mode: string, keep: boolean): Promise<LogLine[]> {
        const targetTime = LogParser.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }
        return this.processLines<LogLine[]>([], (acc, content, n) => {
            const timestamp = LogParser.extractTimestamp(content);
            let shouldKeep: boolean;
            if (!timestamp) {
                shouldKeep = keep; // 无法解析时间戳时按 keep 决定
            } else if (mode === 'before') {
                shouldKeep = keep ? (timestamp >= targetTime) : (timestamp < targetTime);
            } else {
                shouldKeep = keep ? (timestamp <= targetTime) : (timestamp > targetTime);
            }
            if (shouldKeep) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp,
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
    }

    /**
     * 查找第一个大于或等于指定时间的日志行
     *
     * 之前的实现有"早停 + 永不触发 close"的竞态:命中目标行后 stream.destroy()
     * 不一定触发 readline 的 'close' 事件,导致 Promise 永远 pending。
     * 修复:settle() 直接调用 resolve/reject,不再依赖 'close' 事件作为兜底。
     */
    async findLineByTime(timeStr: string): Promise<{ lineNumber: number; line: LogLine } | null> {
        const targetTime = LogParser.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }
        return new Promise((resolve, reject) => {
            let n = 0;
            let settled = false;
            const stream = fs.createReadStream(this._filePath);
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            const settle = (fn: () => void) => {
                if (settled) {return;}
                settled = true;
                stream.destroy();
                fn();
            };
            rl.on('line', (content) => {
                if (settled) {return;}
                n++;
                const timestamp = LogParser.extractTimestamp(content);
                if (timestamp && timestamp >= targetTime) {
                    settle(() => resolve({
                        lineNumber: n,
                        line: {
                            lineNumber: n,
                            content,
                            timestamp,
                            level: LogParser.extractLogLevel(content)
                        }
                    }));
                }
            });
            rl.on('close', () => settle(() => resolve(null)));
            rl.on('error', (err) => settle(() => reject(err)));
            stream.on('error', (err) => settle(() => reject(err)));
        });
    }

    /**
     * 流式 seek 到目标行号,只返回上下文窗口(默认 ±500 行)。
     *
     * 解决 jumpToLineInFullLog 用 readAllLines() 加载整文件的 OOM 风险:
     *   - 内存:只持有 N 行 LogLine 对象(默认 1000 行,~50KB)
     *   - 总行数:通过 getTotalLines 单独统计(流式,内存常数)
     *   - 行为:对超大文件也能秒级响应,UI 显示上下文片段 + "未完全加载"标识
     *
     * 注意:为了避免双重扫描文件的代价,这里仍然走 processLines 一遍到底,
     * 在 fold 里只收集 [startLine, endLine] 区间内的行。性能足够(流式,内存常数)。
     */
    async seekAroundLine(
        targetLine: number,
        contextBefore = 500,
        contextAfter = 500
    ): Promise<{ totalLines: number; startLine: number; lines: LogLine[] }> {
        const safeTarget = Math.max(1, targetLine);
        const startLine = Math.max(1, safeTarget - contextBefore);
        const endLine = safeTarget + contextAfter;
        const mtime = (await fs.promises.stat(this._filePath)).mtimeMs;

        // 单次扫描同时做三件事:数总行数、收集目标窗口、维护尾部环形缓冲。
        // 旧实现是 getTotalLines 整扫一遍 + processLines 再整扫一遍(两遍全文件)。
        // 尾部缓冲只存原始字符串引用(不跑时间戳/级别正则),用于 target 超出
        // 文件末尾时兜底返回最后一屏,等价于旧的"钳到总行数"行为。
        const windowLines: LogLine[] = [];
        const tailCap = endLine - startLine + 1;
        const tail: Array<{ n: number; content: string } | undefined> = new Array(tailCap);
        let tailCount = 0;
        const result = await this.processLines<{ count: number }>({ count: 0 }, (acc, content, n) => {
            acc.count = n;
            if (n >= startLine && n <= endLine) {
                windowLines.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            tail[(n - 1) % tailCap] = { n, content };
            tailCount = n;
            return acc;
        });
        this._totalLines = result.count;
        this._totalLinesMtime = mtime;

        if (windowLines.length === 0 && tailCount > 0) {
            // target 超出文件末尾:退回最后一屏
            const offset = tailCount > tailCap ? tailCount % tailCap : 0;
            const raw: Array<{ n: number; content: string }> = [];
            for (let i = 0; i < Math.min(tailCount, tailCap); i++) {
                const item = tail[(offset + i) % tailCap];
                if (item) { raw.push(item); }
            }
            const lines = raw.map(t => ({
                lineNumber: t.n,
                content: t.content,
                timestamp: LogParser.extractTimestamp(t.content),
                level: LogParser.extractLogLevel(t.content)
            }));
            return { totalLines: result.count, startLine: lines.length > 0 ? lines[0].lineNumber : 1, lines };
        }
        return { totalLines: result.count, startLine, lines: windowLines };
    }

    /**
     * 按行号过滤(不修改文件)
     */
    async filterByLineNumber(lineNumber: number, mode: string, keep: boolean): Promise<LogLine[]> {
        return this.processLines<LogLine[]>([], (acc, content, n) => {
            const shouldKeep = mode === 'before'
                ? (keep ? n >= lineNumber : n < lineNumber)
                : (keep ? n <= lineNumber : n > lineNumber);
            if (shouldKeep) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
    }

    /**
     * 按线程名过滤
     */
    async filterByThreadName(threadName: string): Promise<LogLine[]> {
        const target = threadName.toLowerCase();
        return this.processLines<LogLine[]>([], (acc, content, n) => {
            const thread = LogParser.extractThreadName(content);
            if (thread && thread.toLowerCase() === target) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
    }

    /**
     * 按类名过滤(子串匹配,大小写不敏感)
     */
    async filterByClassName(className: string): Promise<LogLine[]> {
        const target = className.toLowerCase();
        return this.processLines<LogLine[]>([], (acc, content, n) => {
            const classMatch = content.match(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.[A-Z][a-zA-Z0-9_]*)\b/i);
            if (classMatch && classMatch[1].toLowerCase().includes(target)) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
    }

    /**
     * 按方法名过滤
     */
    async filterByMethodName(methodName: string): Promise<LogLine[]> {
        const methodPattern = LogParser.buildMethodPattern(methodName);
        return this.processLines<LogLine[]>([], (acc, content, n) => {
            if (methodPattern.test(content)) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
    }

    /**
     * 统计日志信息(带文件 mtime 缓存,文件没变就不重算)
     *
     * 类型说明:LogStats 中的 Map/timeRange 都是初始化时一定赋值的非空字段,
     * 这里通过 mutable local alias 让 TS 能正确推断非空,避免使用 ! 非空断言
     * (lint 规则 @typescript-eslint/no-non-null-assertion 禁用 !)。
     */
    async getStatistics(): Promise<LogStats> {
        const mtime = (await fs.promises.stat(this._filePath)).mtimeMs;
        if (this._statsCache && this._statsCacheMtime === mtime) {
            return this._statsCache;
        }
        const stats: LogStats = {
            totalLines: 0,
            errorCount: 0,
            warnCount: 0,
            infoCount: 0,
            debugCount: 0,
            otherCount: 0,
            timeRange: { start: undefined, end: undefined },
            classCounts: new Map<string, number>(),
            methodCounts: new Map<string, number>(),
            threadCounts: new Map<string, number>()
        };
        // 用 mutable alias 让 TS 推断为非 undefined,绕开 ! 断言
        const timeRange = stats.timeRange;
        const classCounts = stats.classCounts;
        const methodCounts = stats.methodCounts;
        const threadCounts = stats.threadCounts;
        const result = await this.processLines(stats, (acc, content) => {
            acc.totalLines++;
            const level = LogParser.extractLogLevel(content);
            if (level === 'ERROR') {acc.errorCount++;}
            else if (level === 'WARN') {acc.warnCount++;}
            else if (level === 'INFO') {acc.infoCount++;}
            else if (level === 'DEBUG') {acc.debugCount++;}
            else {acc.otherCount++;}

            const timestamp = LogParser.extractTimestamp(content);
            if (timestamp) {
                if (!timeRange.start || timestamp < timeRange.start) {timeRange.start = timestamp;}
                if (!timeRange.end || timestamp > timeRange.end) {timeRange.end = timestamp;}
            }

            // 三个 Map 兜底 key 数量上限,防止 URL/版本号噪声撑爆内存
            const className = LogParser.extractClassName(content);
            if (className && (classCounts.has(className) || classCounts.size < MAX_STATS_KEYS)) {
                classCounts.set(className, (classCounts.get(className) || 0) + 1);
            }

            const methodName = LogParser.extractMethodName(content);
            if (methodName && (methodCounts.has(methodName) || methodCounts.size < MAX_STATS_KEYS)) {
                methodCounts.set(methodName, (methodCounts.get(methodName) || 0) + 1);
            }

            const threadName = LogParser.extractThreadName(content);
            if (threadName && (threadCounts.has(threadName) || threadCounts.size < MAX_STATS_KEYS)) {
                threadCounts.set(threadName, (threadCounts.get(threadName) || 0) + 1);
            }
            return acc;
        });
        this._statsCache = result;
        this._statsCacheMtime = mtime;
        return result;
    }

    /**
     * 文件被修改后让缓存失效(删除/编辑后调用)
     */
    invalidateCaches(): void {
        this._statsCache = null;
    }

    /**
     * 采样生成时间线数据。两次扫描:第一次数总行数,第二次按 sampleInterval 采样。
     * 返回的总行数 = 实际扫描数。
     */
    async sampleTimeline(sampleCount = 100): Promise<{
        startTime?: Date;
        endTime?: Date;
        samples: Array<{ timestamp?: Date; lineNumber: number; level?: string }>;
        totalLines: number;
    }> {
        const totalLines = await this.getTotalLines();
        if (totalLines === 0) {
            return { samples: [], totalLines: 0 };
        }
        const sampleInterval = Math.max(1, Math.floor(totalLines / sampleCount));
        return this.processLines<{
            startTime?: Date;
            endTime?: Date;
            samples: Array<{ timestamp?: Date; lineNumber: number; level?: string }>;
            totalLines: number;
        }>(
            { samples: [], totalLines: 0 },
            (acc, content, n) => {
                acc.totalLines = n;
                if (n === 1 || n % sampleInterval === 0) {
                    const timestamp = LogParser.extractTimestamp(content);
                    const level = LogParser.extractLogLevel(content);
                    if (timestamp) {
                        acc.samples.push({ timestamp, lineNumber: n, level });
                        if (!acc.startTime || timestamp < acc.startTime) {acc.startTime = timestamp;}
                        if (!acc.endTime || timestamp > acc.endTime) {acc.endTime = timestamp;}
                    }
                }
                return acc;
            }
        );
    }

    /**
     * 导出日志到文件(使用 pipeline 自动处理 backpressure)
     */
    async exportLogs(lines: LogLine[], outputPath: string): Promise<void> {
        // 尊重 push() 的返回值:返回 false 时停下等下一次 _read 再继续,
        // 否则十万行会在第一次 read() 里同步全部压进流缓冲,导出变相全量驻留内存。
        let index = 0;
        const source = new Readable({
            read() {
                while (index < lines.length) {
                    const chunk = lines[index].content + '\n';
                    index++;
                    if (!this.push(chunk)) {
                        return; // 背压:写入侧排空后会再调 _read
                    }
                }
                this.push(null);
            }
        });
        const sink = fs.createWriteStream(outputPath);
        await pipeline(source, sink);
    }

    /**
     * 把流式条件写入临时文件,然后原子替换原文件。
     * 由 shouldKeep 决定每行是否保留;返回删除/保留计数。
     *
     * 显式给 readline 接 error 监听器 — readline 在 input 流错误时会 re-emit,
     * pipeline 会捕获并 reject,但提前 attach 可以让我们做更细的错误分类
     * (比如区分"读源文件失败"和"写临时文件失败")。
     */
    private async rewriteFile(shouldKeep: (line: string, n: number) => boolean): Promise<{ deleted: number; kept: number }> {
        const tempFilePath = `${this._filePath}.tmp`;
        let n = 0;
        let deleted = 0;
        let kept = 0;
        // readline 会吃掉原始行终止符,按检测到的原风格补回,
        // 避免"删几行"顺手把整个 CRLF 文件改写成 LF。
        const eol = await this.detectEol();
        try {
            const source = fs.createReadStream(this._filePath);
            const rl = readline.createInterface({ input: source, crlfDelay: Infinity });
            const sink = fs.createWriteStream(tempFilePath);
            const filter = new Transform({
                writableObjectMode: true,
                transform(chunk: string, _enc, cb) {
                    n++;
                    if (shouldKeep(chunk, n)) {
                        kept++;
                        cb(null, chunk + eol);
                    } else {
                        deleted++;
                        cb();
                    }
                }
            });
            // 显式接 readline 错误:用 once 而不是 on,pipeline 接手后我们就可以放手了
            rl.once('error', (err) => {
                // 让 pipeline reject,但先记一下现场
                console.error(`[rewriteFile] readline error at line ${n}: ${err.message}`);
            });
            try {
                await pipeline(rl, filter, sink);
            } catch (err) {
                // 清理临时文件
                source.destroy();
                sink.destroy();
                await fs.promises.unlink(tempFilePath).catch(() => undefined);
                throw err;
            }
            // 原子替换:直接 rename 覆盖。
            // 之前是"先 unlink 原文件再 rename" — 两步之间存在原文件已删除、
            // 新文件未就位的窗口;若 rename 失败(Windows 文件锁/杀软),外层 catch
            // 还会把写好的 tmp 删掉,原文件与新文件双双丢失。
            // POSIX rename 与 Windows 的 MOVEFILE_REPLACE_EXISTING 都支持直接覆盖,
            // 失败时原文件保持完好,catch 里清理 tmp 即可。
            await fs.promises.rename(tempFilePath, this._filePath);
            this._totalLines = kept;
            this._totalLinesMtime = (await fs.promises.stat(this._filePath)).mtimeMs;
            this.invalidateCaches();
            return { deleted, kept };
        } catch (err) {
            // 兜底清理临时文件(此时原文件完好,删 tmp 不会丢数据)
            await fs.promises.unlink(tempFilePath).catch(() => undefined);
            throw err;
        }
    }

    /**
     * 检测文件换行风格:读开头 64KB 找第一个 \n,其前有 \r 则按 CRLF 补回。
     * 找不到 \n(空文件/单行无换行)时按 LF 处理。
     */
    private async detectEol(): Promise<string> {
        const fd = await fs.promises.open(this._filePath, 'r');
        try {
            const buf = Buffer.alloc(64 * 1024);
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            const idx = buf.subarray(0, bytesRead).indexOf(0x0a);
            if (idx <= 0) { return '\n'; }
            return buf[idx - 1] === 0x0d ? '\r\n' : '\n';
        } finally {
            await fd.close();
        }
    }

    /**
     * 按时间删除日志(修改原文件)
     */
    async deleteByTime(timeStr: string, mode: string): Promise<number> {
        const targetTime = LogParser.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }
        const { deleted } = await this.rewriteFile((content) => {
            const timestamp = LogParser.extractTimestamp(content);
            if (!timestamp) {return true;} // 解析失败默认保留
            return mode === 'before' ? timestamp >= targetTime : timestamp <= targetTime;
        });
        return deleted;
    }

    /**
     * 按行数删除日志
     */
    async deleteByLine(lineNumber: number, mode: string): Promise<number> {
        const { deleted } = await this.rewriteFile((_content, n) =>
            mode === 'before' ? n >= lineNumber : n <= lineNumber
        );
        return deleted;
    }

    /**
     * 保留指定时间范围之内的日志(删除范围外)
     */
    async keepByTimeRange(startTime: string, endTime: string): Promise<number> {
        const start = LogParser.parseTimeString(startTime);
        const end = LogParser.parseTimeString(endTime);
        if (!start || !end) {
            throw new Error('无法解析时间格式');
        }
        const { deleted } = await this.rewriteFile((content) => {
            const timestamp = LogParser.extractTimestamp(content);
            if (!timestamp) {return true;}
            return timestamp >= start && timestamp <= end;
        });
        return deleted;
    }

    /**
     * 保留指定行号范围的日志
     */
    async keepByLineRange(startLine: number, endLine: number): Promise<number> {
        const { deleted } = await this.rewriteFile((_content, n) =>
            n >= startLine && n <= endLine
        );
        return deleted;
    }
}

