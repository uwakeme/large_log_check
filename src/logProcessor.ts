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

    // 日志级别匹配模式
    private logLevelPatterns = [
        { level: 'ERROR', pattern: /\b(ERROR|FATAL|SEVERE)\b/i },
        { level: 'WARN', pattern: /\b(WARN|WARNING)\b/i },
        { level: 'INFO', pattern: /\b(INFO|INFORMATION)\b/i },
        { level: 'DEBUG', pattern: /\b(DEBUG|TRACE|VERBOSE)\b/i }
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
     * 按时间删除日志
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
     * 从日志行中提取日志级别
     */
    private extractLogLevel(line: string): string | undefined {
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
                timeRange: {}
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

            const stream = fs.createReadStream(this.filePath);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                const level = this.extractLogLevel(line);
                if (level && levelsSet.has(level)) {
                    const timestamp = this.extractTimestamp(line);
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
