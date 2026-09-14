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

// ========== 级别别名（v1.3.3 新增） ==========

/** 归一化后的 4 个标准级别 */
export type CanonicalLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/** 一条「用户配置」级别的别名映射 */
export interface LevelAliasEntry {
    token: string;          // 如 "E" / "ERR"
    canonical: CanonicalLevel;
}

/**
 * 默认别名表。
 * - 单字符 E/F/W/I/D/T/V 覆盖 issue #3 诉求；
 * - 多字符 ERR/WRN/INF/DBG/TRC 兼容常见变体。
 * - 改配置时整体替换（setLevelAliases 内部会全量替换 _activeAliases）。
 */
const DEFAULT_LEVEL_ALIASES: readonly LevelAliasEntry[] = [
    { token: 'E',   canonical: 'ERROR' },
    { token: 'F',   canonical: 'ERROR' },
    { token: 'ERR', canonical: 'ERROR' },
    { token: 'W',   canonical: 'WARN'  },
    { token: 'WRN', canonical: 'WARN'  },
    { token: 'I',   canonical: 'INFO'  },
    { token: 'INF', canonical: 'INFO'  },
    { token: 'D',   canonical: 'DEBUG' },
    { token: 'T',   canonical: 'DEBUG' },
    { token: 'V',   canonical: 'DEBUG' },
    { token: 'DBG', canonical: 'DEBUG' },
    { token: 'TRC', canonical: 'DEBUG' },
];

/** 始终参与匹配的标准 token（不受配置影响） */
const STANDARD_LEVEL_TOKENS: readonly string[] = [
    'ERROR', 'FATAL', 'SEVERE',
    'WARN', 'WARNING',
    'INFO', 'INFORMATION',
    'DEBUG', 'TRACE', 'VERBOSE',
];

// module 级可变状态（v1.3.3：保持 LogParser 全部方法 static 不变，仅引入 module 级 mutator + cache）
let _activeAliases: readonly LevelAliasEntry[] = DEFAULT_LEVEL_ALIASES;
let _quickRegex: RegExp | null = null;
let _bracketRegex: RegExp | null = null;
let _bareRegex: RegExp | null = null;
// 暴露给 extractThreadName 用的合并 token 集合（标准 + 活跃 alias），用大写
let _activeAliasTokensUpper: readonly string[] = [];

/** 把任意字符串里的 regex 元字符转义，用于 alternation 拼接 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 校验 / 归一化用户配置为内部 LevelAliasEntry[]。
 * - 非对象或空 → 默认表
 * - 非法键（不是 ERROR/WARN/INFO/DEBUG）忽略
 * - token 去空白、大写化、去重
 * - 任意键的 tokens 数组为空 → 整体返回默认表
 */
export function parseLevelAliases(raw: unknown): LevelAliasEntry[] {
    if (!raw || typeof raw !== 'object') {
        return [...DEFAULT_LEVEL_ALIASES];
    }
    const validCanonical: Record<CanonicalLevel, true> = {
        ERROR: true, WARN: true, INFO: true, DEBUG: true,
    };
    const out: LevelAliasEntry[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = k.toUpperCase() as CanonicalLevel;
        if (!validCanonical[key]) { continue; }
        if (!Array.isArray(v)) { continue; }
        const seen = new Set<string>();
        for (const t of v) {
            if (typeof t !== 'string') { continue; }
            const tok = t.trim().toUpperCase();
            if (tok === '' || seen.has(tok)) { continue; }
            seen.add(tok);
            out.push({ token: tok, canonical: key });
        }
    }
    return out.length > 0 ? out : [...DEFAULT_LEVEL_ALIASES];
}

/**
 * 替换当前活跃的级别别名表；同时让懒构造的正则缓存失效。
 * 传入空数组视为「重置为默认表」。
 */
export function setLevelAliases(entries: readonly LevelAliasEntry[]): void {
    _activeAliases = entries.length > 0 ? entries : DEFAULT_LEVEL_ALIASES;
    _quickRegex = null;
    _bracketRegex = null;
    _bareRegex = null;
    _activeAliasTokensUpper = _activeAliases.map(a => a.token.toUpperCase());
}

/** 内部：拼 alternation 时「长 token 排前」避免短 token 先匹配命中 */
function buildTokenAlternation(tokens: readonly string[]): string {
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    return sorted.map(escapeRegex).join('|');
}

/** 内部：拼出 quick/bracket/bare 三个正则，按需重建 */
function getQuickMatchRegex(): RegExp {
    if (!_quickRegex) {
        const tokens = buildTokenAlternation([
            ...STANDARD_LEVEL_TOKENS,
            ..._activeAliases.map(a => a.token),
        ]);
        _quickRegex = new RegExp(`\\d{2}:\\d{2}:\\d{2}[^\\w]+(${tokens})\\b`, 'i');
    }
    return _quickRegex;
}

function getBracketMatchRegex(): RegExp {
    if (!_bracketRegex) {
        const tokens = buildTokenAlternation([
            ...STANDARD_LEVEL_TOKENS,
            ..._activeAliases.map(a => a.token),
        ]);
        _bracketRegex = new RegExp(`\\[(${tokens})\\]`, 'i');
    }
    return _bracketRegex;
}

function getBareMatchRegex(): RegExp {
    if (!_bareRegex) {
        // bare 集不含单字符别名（避免误中 I/O、英文 I）；仅放长度 ≥ 2 的 alias token
        const longAliases = _activeAliases.filter(a => a.token.length >= 2).map(a => a.token);
        const tokens = buildTokenAlternation([
            ...STANDARD_LEVEL_TOKENS,
            ...longAliases,
        ]);
        _bareRegex = new RegExp(`\\b(${tokens})\\b`, 'i');
    }
    return _bareRegex;
}

// 初始化 alias token 集合（保证 extractThreadName 在未调用 setLevelAliases 时也能用）
_activeAliasTokensUpper = _activeAliases.map(a => a.token.toUpperCase());

/**
 * 纯函数日志解析工具。
 * 没有任何 I/O、文件副作用;级别相关正则走 module 级懒构造（可由 setLevelAliases 替换）。
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

    // 标准日志级别 token（用于排除线程名匹配中的误报）
    private static readonly logLevelTokens = new Set<string>(STANDARD_LEVEL_TOKENS);

    // 预编译的提取正则(用 \p{L}/\p{N} 支持中文标识符,Java 标识符允许 Unicode 字母)
    private static readonly methodPattern = /\[([\p{L}_][\p{L}\p{N}_]*):\d+\]/u;
    private static readonly classInBrackets = /\]\s+([\p{L}_][\p{L}\p{N}_.]*\p{Lu}[\p{L}\p{N}_]*)/u;
    // 包名段允许任意字母,类名段(最后一段)允许任意字母 — 中文标识符无大小写概念,
    // 用 \p{Lu} 会漏掉纯中文类名(如 "中文.示例类")
    private static readonly classAnywhere = /([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*\.[\p{L}_$][\p{L}\p{N}_$]*)/u;
    // 三个级别正则字段已迁出 class，改为 module 级懒构造（v1.3.3）
    // 历史 static readonly levelQuickMatch / levelBracketForm / levelBareForm 已删除

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
     * v1.3.3 排除集扩展为「标准 token ∪ 活跃 alias token」：用户若给 ERROR 加了别名 "EXC"，
     * 则 [EXC] 也会被排除当作级别括号、不再误识别为线程名。
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
            // 排除日志级别（标准 + 活跃 alias）
            const upper = content.toUpperCase();
            if (LogParser.logLevelTokens.has(upper) || _activeAliasTokensUpper.includes(upper)) {
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
     * v1.3.3 三个候选正则从 module 级懒构造读取（setLevelAliases 替换后立即生效）。
     */
    static extractLogLevel(line: string): string | undefined {
        // 优先匹配时间戳后跟级别的常见格式
        const quickMatch = line.match(getQuickMatchRegex());
        if (quickMatch) {
            return LogParser.normalizeLevel(quickMatch[1]);
        }
        // 兜底：[LEVEL] 形式
        const bracketMatch = line.match(getBracketMatchRegex());
        if (bracketMatch) {
            return LogParser.normalizeLevel(bracketMatch[1]);
        }
        // 兜底：裸 LEVEL 单词
        const bareMatch = line.match(getBareMatchRegex());
        if (bareMatch) {
            return LogParser.normalizeLevel(bareMatch[1]);
        }
        return undefined;
    }

    private static normalizeLevel(raw: string): string {
        const upper = raw.toUpperCase();
        // v1.3.3：先查活跃 aliases 映射（用户自定义覆盖标准）
        for (const a of _activeAliases) {
            if (a.token.toUpperCase() === upper) { return a.canonical; }
        }
        // 兜底走老的 4 桶
        if (upper === 'ERROR' || upper === 'FATAL' || upper === 'SEVERE') { return 'ERROR'; }
        if (upper === 'WARN' || upper === 'WARNING') { return 'WARN'; }
        if (upper === 'INFO' || upper === 'INFORMATION') { return 'INFO'; }
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
