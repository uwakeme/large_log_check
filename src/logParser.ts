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
    /**
     * 时间范围。start/end 在解析不到任何时间戳的日志中可能仍是 undefined,
     * 但 timeRange 容器本身在 getStatistics() 中始终会被初始化。
     */
    timeRange: {
        start?: Date;
        end?: Date;
    };
    classCounts: Map<string, number>;
    methodCounts: Map<string, number>;
    threadCounts: Map<string, number>;
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

    // 预编译的提取正则(用 \p{L}/\p{N} 支持中文标识符,Java 标识符允许 Unicode 字母)
    private static readonly methodPattern = /\[([\p{L}_][\p{L}\p{N}_]*):\d+\]/u;
    private static readonly classInBrackets = /\]\s+([\p{L}_][\p{L}\p{N}_.]*\p{Lu}[\p{L}\p{N}_]*)/u;
    // 包名段允许任意字母,类名段(最后一段)允许任意字母 — 中文标识符无大小写概念,
    // 用 \p{Lu} 会漏掉纯中文类名(如 "中文.示例类")
    private static readonly classAnywhere = /([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*\.[\p{L}_$][\p{L}\p{N}_$]*)/u;
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
     *
     * 历史 bug:早期实现的"快速路径"只看方括号后面的 token,不看括号本身,
     * 导致 [ERROR] something / [main:42] inside 这样的行被错认为有线程名。
     * 修复后统一走一般路径,扫描所有方括号,逐一排除级别和方法括号。
     */
    static extractThreadName(line: string): string | undefined {
        const matches = line.match(/\[([^\]]+)\]/g);
        if (!matches) {
            return undefined;
        }
        for (const m of matches) {
            const content = m.slice(1, -1);
            // 排除 [方法名:行号](支持 Unicode 标识符)
            if (/^[\p{L}_][\p{L}\p{N}_]*:\d+$/u.test(content)) {
                continue;
            }
            // 排除日志级别
            if (LogParser.logLevelTokens.has(content.toUpperCase())) {
                continue;
            }
            // 线程名规则:字母开头,只含字母数字下划线连字符(Unicode 友好)
            if (/^[\p{L}_][\p{L}\p{N}\-_.]*$/u.test(content)) {
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
