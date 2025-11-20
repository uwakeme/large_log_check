import * as fs from 'fs';
import * as readline from 'readline';

export interface LogLine {
    lineNumber: number;
    content: string;
    timestamp?: Date;
    level?: string;
}

export interface LogStats {
    totalLines: number;
    errorCount: number;
    warnCount: number;
    infoCount: number;
    debugCount: number;
    otherCount: number;
    timeRange?: {
        start?: Date;
        end?: Date;
    };
    // 新增：按类名统计
    classCounts?: Map<string, number>;
    // 新增：按方法名统计
    methodCounts?: Map<string, number>;
    // 新增：按线程名统计
    threadCounts?: Map<string, number>;
}

export class LogProcessor {
    private filePath: string;
    private totalLines: number = 0;
    
    // 常见的日志时间戳格式正则表达式
    private timePatterns = [
        // 2024-01-01 12:00:00
        /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/,
        // 2024/01/01 12:00:00
        /(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/,
        // [2024-01-01 12:00:00]
        /\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/,
        // 01-01-2024 12:00:00
        /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/,
        // ISO 8601: 2024-01-01T12:00:00
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/
    ];

    // 日志级别匹配模式（按优先级从高到低排序）
    private logLevelPatterns = [
        { level: 'ERROR', pattern: /\[(ERROR|FATAL|SEVERE)\]|\b(ERROR|FATAL|SEVERE)\s/i },
        { level: 'WARN', pattern: /\[(WARN|WARNING)\]|\b(WARN|WARNING)\s/i },
        { level: 'INFO', pattern: /\[(INFO|INFORMATION)\]|\b(INFO|INFORMATION)\s/i },
        { level: 'DEBUG', pattern: /\[(DEBUG|TRACE|VERBOSE)\]|\b(DEBUG|TRACE|VERBOSE)\s/i }
    ];

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /**
     * 获取文件总行数
     */
    async getTotalLines(): Promise<number> {
        return new Promise((resolve, reject) => {
            let lineCount = 0;
            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', () => {
                lineCount++;
            });

            rl.on('close', () => {
                this.totalLines = lineCount;
                resolve(lineCount);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 读取指定范围的行
     */
    async readLines(startLine: number, count: number): Promise<LogLine[]> {
        return new Promise((resolve, reject) => {
            const lines: LogLine[] = [];
            let currentLine = 0;
            const endLine = startLine + count;

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (currentLine >= startLine && currentLine < endLine) {
                    const timestamp = this.extractTimestamp(line);
                    const level = this.extractLogLevel(line);
                    lines.push({
                        lineNumber: currentLine + 1,
                        content: line,
                        timestamp: timestamp,
                        level: level
                    });
                }
                currentLine++;
                
                // 如果已经读取了足够的行,关闭流
                if (currentLine >= endLine) {
                    rl.close();
                    stream.destroy();
                }
            });

            rl.on('close', () => {
                resolve(lines);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 搜索包含关键词的行
     */
    async search(keyword: string): Promise<LogLine[]> {
        return new Promise((resolve, reject) => {
            const results: LogLine[] = [];
            let currentLine = 0;
            const searchRegex = new RegExp(keyword, 'i');

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (searchRegex.test(line)) {
                    const timestamp = this.extractTimestamp(line);
                    const level = this.extractLogLevel(line);
                    results.push({
                        lineNumber: currentLine + 1,
                        content: line,
                        timestamp: timestamp,
                        level: level
                    });
                }
                currentLine++;
            });

            rl.on('close', () => {
                resolve(results);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 按时间过滤（不修改文件）
     */
    async filterByTime(timeStr: string, mode: string, keep: boolean): Promise<LogLine[]> {
        const targetTime = this.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }

        return new Promise((resolve, reject) => {
            const results: LogLine[] = [];
            let currentLine = 0;

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                const timestamp = this.extractTimestamp(line);
                let shouldKeep = false;

                if (!timestamp) {
                    // 如果无法提取时间戳，默认保留
                    shouldKeep = keep;
                } else {
                    if (mode === 'before') {
                        // keep=true: 保留指定时间及之后的日志
                        shouldKeep = keep ? (timestamp >= targetTime) : (timestamp < targetTime);
                    } else {
                        // keep=true: 保留指定时间之前的日志
                        shouldKeep = keep ? (timestamp <= targetTime) : (timestamp > targetTime);
                    }
                }

                if (shouldKeep) {
                    const level = this.extractLogLevel(line);
                    results.push({
                        lineNumber: currentLine + 1,
                        content: line,
                        timestamp: timestamp,
                        level: level
                    });
                }
                currentLine++;
            });

            rl.on('close', () => {
                resolve(results);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 查找第一个大于或等于指定时间的日志行
     * 返回: { lineNumber, line, timestamp }
     */
    async findLineByTime(timeStr: string): Promise<{ lineNumber: number; line: LogLine } | null> {
        const targetTime = this.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }

        return new Promise((resolve, reject) => {
            let currentLine = 0;
            let found = false;

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (found) {
                    return; // 已经找到，跳过后续行
                }
                
                const timestamp = this.extractTimestamp(line);
                if (timestamp && timestamp >= targetTime) {
                    found = true;
                    const level = this.extractLogLevel(line);
                    resolve({
                        lineNumber: currentLine + 1,
                        line: {
                            lineNumber: currentLine + 1,
                            content: line,
                            timestamp: timestamp,
                            level: level
                        }
                    });
                    stream.destroy(); // 停止读取
                }
                currentLine++;
            });

            rl.on('close', () => {
                if (!found) {
                    resolve(null); // 未找到
                }
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 按行号过滤（不修改文件）
     */
    async filterByLineNumber(lineNumber: number, mode: string, keep: boolean): Promise<LogLine[]> {
        return new Promise((resolve, reject) => {
            const results: LogLine[] = [];
            let currentLine = 0;

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                currentLine++;
                let shouldKeep = false;

                if (mode === 'before') {
                    // keep=true: 保留指定行及之后的日志
                    shouldKeep = keep ? (currentLine >= lineNumber) : (currentLine < lineNumber);
                } else {
                    // keep=true: 保留指定行之前的日志
                    shouldKeep = keep ? (currentLine <= lineNumber) : (currentLine > lineNumber);
                }

                if (shouldKeep) {
                    const timestamp = this.extractTimestamp(line);
                    const level = this.extractLogLevel(line);
                    results.push({
                        lineNumber: currentLine,
                        content: line,
                        timestamp: timestamp,
                        level: level
                    });
                }
            });

            rl.on('close', () => {
                resolve(results);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 按时间删除日志（修改原文件）
     */
    async deleteByTime(timeStr: string, mode: string): Promise<number> {
        const targetTime = this.parseTimeString(timeStr);
        if (!targetTime) {
            throw new Error('无法解析时间格式');
        }

        return new Promise((resolve, reject) => {
            const tempFilePath = `${this.filePath}.tmp`;
            const writeStream = fs.createWriteStream(tempFilePath);
            const readStream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: readStream,
                crlfDelay: Infinity
            });

            let deletedCount = 0;
            let keptCount = 0;

            rl.on('line', (line) => {
                const timestamp = this.extractTimestamp(line);
                let shouldKeep = false;

                if (!timestamp) {
                    // 如果无法提取时间戳,保留该行
                    shouldKeep = true;
                } else {
                    if (mode === 'before') {
                        // 保留指定时间及之后的日志
                        shouldKeep = timestamp >= targetTime;
                    } else {
                        // 保留指定时间之前的日志
                        shouldKeep = timestamp <= targetTime;
                    }
                }

                if (shouldKeep) {
                    writeStream.write(line + '\n');
                    keptCount++;
                } else {
                    deletedCount++;
                }
            });

            rl.on('close', () => {
                writeStream.end();
                writeStream.on('finish', () => {
                    // 替换原文件
                    fs.unlink(this.filePath, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        fs.rename(tempFilePath, this.filePath, (err) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            this.totalLines = keptCount;
                            resolve(deletedCount);
                        });
                    });
                });
            });

            rl.on('error', (error) => {
                writeStream.end();
                fs.unlink(tempFilePath, () => {});
                reject(error);
            });
        });
    }

    /**
     * 按行数删除日志
     */
    async deleteByLine(lineNumber: number, mode: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const tempFilePath = `${this.filePath}.tmp`;
            const writeStream = fs.createWriteStream(tempFilePath);
            const readStream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: readStream,
                crlfDelay: Infinity
            });

            let currentLine = 0;
            let deletedCount = 0;
            let keptCount = 0;

            rl.on('line', (line) => {
                currentLine++;
                let shouldKeep = false;

                if (mode === 'before') {
                    // 保留指定行及之后的日志
                    shouldKeep = currentLine >= lineNumber;
                } else {
                    // 保留指定行之前的日志
                    shouldKeep = currentLine <= lineNumber;
                }

                if (shouldKeep) {
                    writeStream.write(line + '\n');
                    keptCount++;
                } else {
                    deletedCount++;
                }
            });

            rl.on('close', () => {
                writeStream.end();
                writeStream.on('finish', () => {
                    // 替换原文件
                    fs.unlink(this.filePath, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        fs.rename(tempFilePath, this.filePath, (err) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            this.totalLines = keptCount;
                            resolve(deletedCount);
                        });
                    });
                });
            });

            rl.on('error', (error) => {
                writeStream.end();
                fs.unlink(tempFilePath, () => {});
                reject(error);
            });
        });
    }

    /**
     * 从日志行中提取时间戳
     */
    private extractTimestamp(line: string): Date | undefined {
        for (const pattern of this.timePatterns) {
            const match = line.match(pattern);
            if (match) {
                const timeStr = match[1];
                const date = this.parseTimeString(timeStr);
                if (date) {
                    return date;
                }
            }
        }
        return undefined;
    }

    /**
     * 从日志行中提取类名
     * 格式：2025-11-14 09:27:02.820  INFO 3262876 [http-nio-16710-exec-8] data.access.filter.DataAccessFilter
     */
    private extractClassName(line: string): string | undefined {
        // 匹配 Java 包名.类名 格式
        const match = line.match(/\]\s+([a-z][a-z0-9_.]*[A-Z][a-zA-Z0-9_]*)/);
        if (match) {
            const fullClassName = match[1];
            // 返回完整类名
            return fullClassName;
        }
        return undefined;
    }

    /**
     * 从日志行中提取方法名
     * 格式：<objStatusSelect> 或 queryClassObjectsFun接口
     */
    private extractMethodName(line: string): string | undefined {
        // 匹配 <方法名> 格式
        let match = line.match(/<([a-zA-Z_][a-zA-Z0-9_]*)>/);
        if (match) {
            return match[1];
        }
        // 匹配方法名接口 格式
        match = line.match(/([a-zA-Z_][a-zA-Z0-9_]*)接口/);
        if (match) {
            return match[1];
        }
        return undefined;
    }

    /**
     * 从日志行中提取线程名
     * 格式：[scheduling-1] 或 [http-nio-16710-exec-8]
     */
    private extractThreadName(line: string): string | undefined {
        const match = line.match(/\[([a-zA-Z0-9-_]+)\]/);
        if (match) {
            return match[1];
        }
        return undefined;
    }

    /**
     * 从日志行中提取日志级别
     */
    private extractLogLevel(line: string): string | undefined {
        // 优先匹配常见的日志格式：时间戳后跟级别
        // 例如：2025-11-14 08:48:39.308  INFO 3261008 [main]
        const quickMatch = line.match(/\d{2}:\d{2}:\d{2}[^\w]+(ERROR|FATAL|SEVERE|WARN|WARNING|INFO|INFORMATION|DEBUG|TRACE|VERBOSE)\s/i);
        if (quickMatch) {
            const level = quickMatch[1].toUpperCase();
            if (level === 'ERROR' || level === 'FATAL' || level === 'SEVERE') return 'ERROR';
            if (level === 'WARN' || level === 'WARNING') return 'WARN';
            if (level === 'INFO' || level === 'INFORMATION') return 'INFO';
            if (level === 'DEBUG' || level === 'TRACE' || level === 'VERBOSE') return 'DEBUG';
        }
        
        // 使用原有的模式匹配作为后备
        for (const levelPattern of this.logLevelPatterns) {
            if (levelPattern.pattern.test(line)) {
                return levelPattern.level;
            }
        }
        return undefined;
    }

    /**
     * 统计日志信息
     */
    async getStatistics(): Promise<LogStats> {
        return new Promise((resolve, reject) => {
            const stats: LogStats = {
                totalLines: 0,
                errorCount: 0,
                warnCount: 0,
                infoCount: 0,
                debugCount: 0,
                otherCount: 0,
                timeRange: {},
                classCounts: new Map<string, number>(),
                methodCounts: new Map<string, number>(),
                threadCounts: new Map<string, number>()
            };

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                stats.totalLines++;
                
                // 统计日志级别
                const level = this.extractLogLevel(line);
                if (level === 'ERROR') {
                    stats.errorCount++;
                } else if (level === 'WARN') {
                    stats.warnCount++;
                } else if (level === 'INFO') {
                    stats.infoCount++;
                } else if (level === 'DEBUG') {
                    stats.debugCount++;
                } else {
                    stats.otherCount++;
                }

                // 统计时间范围
                const timestamp = this.extractTimestamp(line);
                if (timestamp) {
                    if (!stats.timeRange!.start || timestamp < stats.timeRange!.start) {
                        stats.timeRange!.start = timestamp;
                    }
                    if (!stats.timeRange!.end || timestamp > stats.timeRange!.end) {
                        stats.timeRange!.end = timestamp;
                    }
                }

                // 统计类名
                const className = this.extractClassName(line);
                if (className) {
                    const count = stats.classCounts!.get(className) || 0;
                    stats.classCounts!.set(className, count + 1);
                }

                // 统计方法名
                const methodName = this.extractMethodName(line);
                if (methodName) {
                    const count = stats.methodCounts!.get(methodName) || 0;
                    stats.methodCounts!.set(methodName, count + 1);
                }

                // 统计线程名
                const threadName = this.extractThreadName(line);
                if (threadName) {
                    const count = stats.threadCounts!.get(threadName) || 0;
                    stats.threadCounts!.set(threadName, count + 1);
                }
            });

            rl.on('close', () => {
                resolve(stats);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 按日志级别过滤
     */
    async filterByLevel(levels: string[]): Promise<LogLine[]> {
        return new Promise((resolve, reject) => {
            const results: LogLine[] = [];
            let currentLine = 0;
            const levelsSet = new Set(levels.map(l => l.toUpperCase()));
            console.log('🔍 正在查找的级别:', Array.from(levelsSet));

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            let matchCount = 0;
            let sampleLines = 0;
            rl.on('line', (line) => {
                const level = this.extractLogLevel(line);
                
                // 输出前5条日志的级别提取结果
                if (sampleLines < 5) {
                    console.log(`第 ${currentLine + 1} 行: 提取到的级别='${level}' 内容:`, line.substring(0, 100));
                    sampleLines++;
                }
                
                if (level && levelsSet.has(level)) {
                    const timestamp = this.extractTimestamp(line);
                    results.push({
                        lineNumber: currentLine + 1,
                        content: line,
                        timestamp: timestamp,
                        level: level
                    });
                    matchCount++;
                    if (matchCount <= 3) {
                        console.log(`✅ 匹配 ${matchCount}: 级别='${level}'`);
                    }
                }
                currentLine++;
            });

            rl.on('close', () => {
                console.log(`📊 过滤完成 - 总共匹配: ${results.length} 条`);
                resolve(results);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 正则表达式搜索
     */
    async regexSearch(pattern: string, flags: string = 'i'): Promise<LogLine[]> {
        return new Promise((resolve, reject) => {
            const results: LogLine[] = [];
            let currentLine = 0;
            
            let searchRegex: RegExp;
            try {
                searchRegex = new RegExp(pattern, flags);
            } catch (error) {
                reject(new Error('无效的正则表达式'));
                return;
            }

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (searchRegex.test(line)) {
                    const timestamp = this.extractTimestamp(line);
                    const level = this.extractLogLevel(line);
                    results.push({
                        lineNumber: currentLine + 1,
                        content: line,
                        timestamp: timestamp,
                        level: level
                    });
                }
                currentLine++;
            });

            rl.on('close', () => {
                resolve(results);
            });

            rl.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 导出日志到文件
     */
    async exportLogs(lines: LogLine[], outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(outputPath);
            
            for (const line of lines) {
                writeStream.write(line.content + '\n');
            }
            
            writeStream.end();
            writeStream.on('finish', () => {
                resolve();
            });
            
            writeStream.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * 解析时间字符串
     */
    private parseTimeString(timeStr: string): Date | undefined {
        // 标准化时间字符串
        let normalized = timeStr.trim();
        
        // 替换 / 为 -
        normalized = normalized.replace(/\//g, '-');
        
        // 处理 T 分隔符
        normalized = normalized.replace('T', ' ');
        
        // 尝试解析
        const date = new Date(normalized);
        
        if (!isNaN(date.getTime())) {
            return date;
        }
        
        // 尝试其他格式 DD-MM-YYYY
        const ddmmyyyy = /^(\d{2})-(\d{2})-(\d{4})(.*)$/;
        const match = normalized.match(ddmmyyyy);
        if (match) {
            const reformatted = `${match[3]}-${match[2]}-${match[1]}${match[4]}`;
            const date2 = new Date(reformatted);
            if (!isNaN(date2.getTime())) {
                return date2;
            }
        }
        
        return undefined;
    }
}
