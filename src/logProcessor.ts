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

export class LogProcessor {
    private filePath: string;
    private totalLines = 0;
    private statsCache: LogStats | null = null;
    private statsCacheMtime = 0;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    getFilePath(): string {
        return this.filePath;
    }

    /**
     * 通用流式行处理:对每行调用 fold,返回累积结果。
     * 消除了 14 处相同的 fs.createReadStream + readline 样板。
     * fold 必须是同步的;若需异步逻辑,在外部分批处理。
     *
     * onProgress 同时按"行数阈值"和"时间阈值"双重去重,保证:
     *   - 大量数据时不会因为每行都触发回调而压垮 postMessage
     *   - 数据很少时也不会因为行数不够而沉默很久
     */
    private processLines<T>(
        initial: T,
        fold: (acc: T, line: string, lineNumber: number) => T,
        onProgress?: (lineNumber: number) => void
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            let acc = initial;
            let lineNumber = 0;
            let lastReportedLines = 0;
            let lastReportedAt = 0;
            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            const reportIfDue = () => {
                if (!onProgress) {return;}
                const now = Date.now();
                if (lineNumber - lastReportedLines >= PROGRESS_REPORT_INTERVAL ||
                    (lineNumber > lastReportedLines && now - lastReportedAt >= PROGRESS_THROTTLE_MS)) {
                    onProgress(lineNumber);
                    lastReportedLines = lineNumber;
                    lastReportedAt = now;
                }
            };
            rl.on('line', (line) => {
                lineNumber++;
                acc = fold(acc, line, lineNumber);
                reportIfDue();
            });
            rl.on('close', () => {
                if (onProgress && lineNumber > lastReportedLines) {
                    onProgress(lineNumber);
                }
                resolve(acc);
            });
            rl.on('error', reject);
        });
    }

    /**
     * 获取文件总行数,带进度回调。
     * 复用 processLines 的"行数+时间"双阈值节流,保证数据少时也能持续看到进度推进。
     */
    async getTotalLines(progressCallback?: (currentLines: number) => void): Promise<number> {
        let lastReported = 0;
        let lastReportedAt = 0;
        this.totalLines = await this.processLines(0, (count, _line, n) => {
            if (progressCallback) {
                const now = Date.now();
                if (n - lastReported >= PROGRESS_REPORT_INTERVAL ||
                    (n > lastReported && now - lastReportedAt >= PROGRESS_THROTTLE_MS)) {
                    progressCallback(n);
                    lastReported = n;
                    lastReportedAt = now;
                }
            }
            return n;
        });
        if (progressCallback && this.totalLines > lastReported) {
            progressCallback(this.totalLines);
        }
        return this.totalLines;
    }

    /**
     * 读取指定范围的行
     */
    async readLines(startLine: number, count: number): Promise<LogLine[]> {
        const endLine = startLine + count;
        return this.processLines<LogLine[]>([], (lines, content, n) => {
            if (n > startLine && n <= endLine) {
                lines.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return lines;
        });
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
    async readAllLines(progressCallback?: (currentLine: number) => void): Promise<LogLine[]> {
        return this.processLines<LogLine[]>([], (lines, content, n) => {
            lines.push({
                lineNumber: n,
                content,
                timestamp: LogParser.extractTimestamp(content),
                level: LogParser.extractLogLevel(content)
            });
            return lines;
        }, progressCallback);
    }

    /**
     * 搜索包含关键词的行
     */
    async search(keyword: string, reverse = false, isMultiple = false): Promise<LogLine[]> {
        const keywords = isMultiple
            ? keyword.trim().split(/\s+/).map(k => k.toLowerCase()).filter(Boolean)
            : [];
        const searchRegex = isMultiple ? null : new RegExp(keyword, 'i');
        const results = await this.processLines<LogLine[]>([], (acc, content, n) => {
            let isMatch = false;
            if (isMultiple) {
                if (keywords.length > 0) {
                    const lower = content.toLowerCase();
                    isMatch = keywords.every(k => lower.includes(k));
                }
            } else {
                isMatch = searchRegex!.test(content);
            }
            if (isMatch) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
        return reverse ? results.reverse() : results;
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
     */
    async findLineByTime(timeStr: string): Promise<{ lineNumber: number; line: LogLine } | null> {
        const targetTime = LogParser.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }
        return new Promise((resolve, reject) => {
            let n = 0;
            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            let settled = false;
            const settle = (fn: () => void) => {
                if (settled) {return;}
                settled = true;
                stream.destroy();
                fn();
            };
            rl.on('line', (content) => {
                n++;
                if (settled) {return;}
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
        });
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
     * 按日志级别过滤
     */
    async filterByLevel(levels: string[]): Promise<LogLine[]> {
        const levelsSet = new Set(levels.map(l => l.toUpperCase()));
        return this.processLines<LogLine[]>([], (acc, content, n) => {
            const level = LogParser.extractLogLevel(content);
            if (level && levelsSet.has(level)) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level
                });
            }
            return acc;
        });
    }

    /**
     * 正则表达式搜索
     */
    async regexSearch(pattern: string, flags = 'i', reverse = false): Promise<LogLine[]> {
        let searchRegex: RegExp;
        try {
            searchRegex = new RegExp(pattern, flags);
        } catch {
            throw new Error('无效的正则表达式');
        }
        const results = await this.processLines<LogLine[]>([], (acc, content, n) => {
            if (searchRegex.test(content)) {
                acc.push({
                    lineNumber: n,
                    content,
                    timestamp: LogParser.extractTimestamp(content),
                    level: LogParser.extractLogLevel(content)
                });
            }
            return acc;
        });
        return reverse ? results.reverse() : results;
    }

    /**
     * 统计日志信息(带文件 mtime 缓存,文件没变就不重算)
     */
    async getStatistics(): Promise<LogStats> {
        const mtime = (await fs.promises.stat(this.filePath)).mtimeMs;
        if (this.statsCache && this.statsCacheMtime === mtime) {
            return this.statsCache;
        }
        const stats: LogStats = {
            totalLines: 0,
            errorCount: 0,
            warnCount: 0,
            infoCount: 0,
            debugCount: 0,
            otherCount: 0,
            timeRange: {},
            classCounts: new Map(),
            methodCounts: new Map(),
            threadCounts: new Map()
        };
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
                if (!acc.timeRange!.start || timestamp < acc.timeRange!.start) {acc.timeRange!.start = timestamp;}
                if (!acc.timeRange!.end || timestamp > acc.timeRange!.end) {acc.timeRange!.end = timestamp;}
            }

            const className = LogParser.extractClassName(content);
            if (className) {acc.classCounts!.set(className, (acc.classCounts!.get(className) || 0) + 1);}

            const methodName = LogParser.extractMethodName(content);
            if (methodName) {acc.methodCounts!.set(methodName, (acc.methodCounts!.get(methodName) || 0) + 1);}

            const threadName = LogParser.extractThreadName(content);
            if (threadName) {acc.threadCounts!.set(threadName, (acc.threadCounts!.get(threadName) || 0) + 1);}
            return acc;
        });
        this.statsCache = result;
        this.statsCacheMtime = mtime;
        return result;
    }

    /**
     * 文件被修改后让缓存失效(删除/编辑后调用)
     */
    invalidateCaches(): void {
        this.statsCache = null;
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
        const source = new Readable({
            read() {
                for (const line of lines) {
                    this.push(line.content + '\n');
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
     */
    private async rewriteFile(shouldKeep: (line: string, n: number) => boolean): Promise<{ deleted: number; kept: number }> {
        const tempFilePath = `${this.filePath}.tmp`;
        let n = 0;
        let deleted = 0;
        let kept = 0;
        try {
            const source = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({ input: source, crlfDelay: Infinity });
            const sink = fs.createWriteStream(tempFilePath);
            const filter = new Transform({
                writableObjectMode: true,
                transform(chunk: string, _enc, cb) {
                    n++;
                    if (shouldKeep(chunk, n)) {
                        kept++;
                        cb(null, chunk + '\n');
                    } else {
                        deleted++;
                        cb();
                    }
                }
            });
            try {
                await pipeline(rl, filter, sink);
            } catch (err) {
                // 清理临时文件
                await fs.promises.unlink(tempFilePath).catch(() => undefined);
                throw err;
            }
            // 原子替换
            await fs.promises.unlink(this.filePath);
            await fs.promises.rename(tempFilePath, this.filePath);
            this.totalLines = kept;
            this.invalidateCaches();
            return { deleted, kept };
        } catch (err) {
            // 兜底清理
            await fs.promises.unlink(tempFilePath).catch(() => undefined);
            throw err;
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

