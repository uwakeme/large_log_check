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
    classCounts?: Map<string, number>;
    methodCounts?: Map<string, number>;
    threadCounts?: Map<string, number>;
}

/**
 * 纯函数日志解析工具。
 * 没有任何 I/O、状态或副作用,所有方法可独立单测。
 */
export class LogParser {
    // 常见的日志时间戳格式正则表达式（按优先级从高到低）
    private static readonly timePatterns: RegExp[] = [
        // 2024-01-01 12:00:00.123
        /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
        // 2024/01/01 12:00:00
        /(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
        // [2024-01-01 12:00:00]
        /\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/,
        // 01-01-2024 12:00:00
        /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
        // ISO 8601: 2024-01-01T12:00:00[.123][Z]
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/
    ];

    // 日志级别 token（用于排除线程名匹配中的误报）
    private static readonly logLevelTokens = new Set([
        'ERROR', 'FATAL', 'SEVERE',
        'WARN', 'WARNING',
        'INFO', 'INFORMATION',
        'DEBUG', 'TRACE', 'VERBOSE'
    ]);

    // 预编译的提取正则
    private static readonly threadAfterBracket = /^\[[^\]]+\]\s+([a-zA-Z][a-zA-Z0-9-_.]*)/;
    private static readonly methodPattern = /\[([a-zA-Z_][a-zA-Z0-9_]*):\d+\]/;
    private static readonly classInBrackets = /\]\s+([a-z][a-z0-9_.]*[A-Z][a-zA-Z0-9_]*)/;
    private static readonly classAnywhere = /\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.[A-Z][a-zA-Z0-9_]*)\b/;
    private static readonly levelQuickMatch = /\d{2}:\d{2}:\d{2}[^\w]+(ERROR|FATAL|SEVERE|WARN|WARNING|INFO|INFORMATION|DEBUG|TRACE|VERBOSE)\b/i;
    private static readonly levelBracketForm = /\[(ERROR|FATAL|SEVERE|WARN|WARNING|INFO|INFORMATION|DEBUG|TRACE|VERBOSE)\]/i;
    private static readonly levelBareForm = /\b(ERROR|FATAL|SEVERE|WARN|WARNING|INFO|INFORMATION|DEBUG|TRACE|VERBOSE)\b/i;

    /**
     * 从日志行中提取时间戳
     */
    static extractTimestamp(line: string): Date | undefined {
        for (const pattern of LogParser.timePatterns) {
            const match = line.match(pattern);
            if (match) {
                const date = LogParser.parseTimeString(match[1]);
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
    static extractClassName(line: string): string | undefined {
        const match = line.match(LogParser.classInBrackets);
        if (match) {
            return match[1];
        }
        // 后备：行中任意位置的全限定类名
        const anyMatch = line.match(LogParser.classAnywhere);
        return anyMatch ? anyMatch[1] : undefined;
    }

    /**
     * 从日志行中提取方法名
     * 格式：[catalogueSave:479] 或 [methodName:123]
     */
    static extractMethodName(line: string): string | undefined {
        const match = line.match(LogParser.methodPattern);
        return match ? match[1] : undefined;
    }

    /**
     * 从日志行中提取线程名。
     * 排除 [方法名:行号] 格式和日志级别 token。
     * 取第一个像线程名的方括号内容（不再全量扫描所有方括号）。
     */
    static extractThreadName(line: string): string | undefined {
        // 快速路径：行首第一个 [...] 后跟字母开头的 token 往往是线程名
        const afterBracket = line.match(LogParser.threadAfterBracket);
        if (afterBracket) {
            const candidate = afterBracket[1];
            if (!LogParser.logLevelTokens.has(candidate.toUpperCase())) {
                return candidate;
            }
        }

        // 一般路径：扫所有方括号,取第一个不像方法名/级别且像线程名的
        const matches = line.match(/\[([^\]]+)\]/g);
        if (!matches) {
            return undefined;
        }
        for (const m of matches) {
            const content = m.slice(1, -1);
            // 排除 [方法名:行号]
            if (/^[a-zA-Z_][a-zA-Z0-9_]*:\d+$/.test(content)) {
                continue;
            }
            // 排除日志级别
            if (LogParser.logLevelTokens.has(content.toUpperCase())) {
                continue;
            }
            // 线程名规则:字母开头,只含字母数字下划线连字符
            if (/^[a-zA-Z][a-zA-Z0-9-_]*$/.test(content)) {
                return content;
            }
        }
        return undefined;
    }

    /**
     * 从日志行中提取日志级别。归一化为 ERROR / WARN / INFO / DEBUG 之一。
     */
    static extractLogLevel(line: string): string | undefined {
        // 优先匹配时间戳后跟级别的常见格式
        const quickMatch = line.match(LogParser.levelQuickMatch);
        if (quickMatch) {
            return LogParser.normalizeLevel(quickMatch[1]);
        }
        // 兜底：[LEVEL] 形式
        const bracketMatch = line.match(LogParser.levelBracketForm);
        if (bracketMatch) {
            return LogParser.normalizeLevel(bracketMatch[1]);
        }
        // 兜底：裸 LEVEL 单词
        const bareMatch = line.match(LogParser.levelBareForm);
        if (bareMatch) {
            return LogParser.normalizeLevel(bareMatch[1]);
        }
        return undefined;
    }

    private static normalizeLevel(raw: string): string {
        const upper = raw.toUpperCase();
        if (upper === 'ERROR' || upper === 'FATAL' || upper === 'SEVERE') {return 'ERROR';}
        if (upper === 'WARN' || upper === 'WARNING') {return 'WARN';}
        if (upper === 'INFO' || upper === 'INFORMATION') {return 'INFO';}
        return 'DEBUG'; // DEBUG / TRACE / VERBOSE
    }

    /**
     * 解析时间字符串为 Date。
     * 显式按格式拆分,避免 new Date() 的 locale 歧义。
     */
    static parseTimeString(timeStr: string): Date | undefined {
        const normalized = timeStr.trim().replace(/\//g, '-');
        // 标准 ISO 形式 YYYY-MM-DD HH:mm:ss[.sss][Z|±HH:mm]
        const isoLike = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
        let m = normalized.match(isoLike);
        if (m) {
            const [, y, mo, d, h, mi, s, ms, tz] = m;
            if (tz) {
                return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${ms ? '.' + ms : ''}${tz}`);
            }
            return new Date(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.slice(0, 3) : 0);
        }
        // DD-MM-YYYY HH:mm:ss — 显式翻转避免 locale 歧义
        const dmy = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
        m = normalized.match(dmy);
        if (m) {
            const [, d, mo, y, h, mi, s, ms] = m;
            return new Date(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.slice(0, 3) : 0);
        }
        // 最后的兜底:交给原生 Date
        const fallback = new Date(normalized);
        return isNaN(fallback.getTime()) ? undefined : fallback;
    }

    /**
     * 构造 [methodName:lineNumber] 匹配正则,转义用户输入。
     */
    static buildMethodPattern(methodName: string): RegExp {
        const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\[${escaped}:\\d+\\]`, 'i');
    }
}
