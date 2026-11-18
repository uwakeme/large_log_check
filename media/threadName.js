// ========== 线程名识别(纯逻辑) ==========
// 内置「线程名」高亮规则的匹配式,以及从高亮命中片段里提取线程名。
//
// 为什么单独成文件:这两处正则以前是各写各的(手抄两份),正则一漂移就出 bug ——
// 内置规则当时只允许 [a-zA-Z0-9-_],漏了点号,于是 Spring Boot 最常见的
// http-nio-127.0.0.1-16600-exec-4 这类线程名既不高亮、也点不出「按此线程筛选」。
//
// 口径对齐后端(src/logParser.ts 的 LogParser.extractThreadName):
// 线程名 = 字母/下划线开头,后接字母数字、下划线、连字符、点号。
// 高亮规则命中后提取出的名字,必须与后端算出的名字一致 ——
// 否则点「按此线程筛选」会拿一个后端永远算不出来的名字去过滤,结果恒为空。
//
// 依赖:无(纯函数,加载期无副作用),须在 webview.js 之前加载。

/** 内置高亮规则里排除的日志级别 token(与后端 logLevelTokens 一致) */
var THREAD_EXCLUDED_LEVELS = ['ERROR', 'FATAL', 'SEVERE', 'WARN', 'WARNING', 'INFO', 'INFORMATION', 'DEBUG', 'TRACE', 'VERBOSE'];

/**
 * 内置「线程名」高亮规则的匹配式(字符串形式,规则编辑器里可见可改)。
 * 点号必须允许:http-nio-127.0.0.1-16600-exec-4 是最常见的线程名形态。
 * 注意:规则正则按无 u 标志编译,只能用 ASCII 字符集。
 */
var THREAD_HIGHLIGHT_PATTERN = '\\[(?!' + THREAD_EXCLUDED_LEVELS.join('|') + ')([a-zA-Z][a-zA-Z0-9._-]*)\\]';

/**
 * 线程名形状:字母或下划线开头,后接字母数字、下划线、连字符、点号。
 * 与后端 LogParser.extractThreadName 的判定一致(Unicode 友好)。
 */
var THREAD_NAME_SHAPE = /^[\p{L}_][\p{L}\p{N}\-_.]*$/u;

/**
 * 从高亮命中片段里提取线程名。
 * - 带方括号:[http-nio-127.0.0.1-16600-exec-4] → http-nio-127.0.0.1-16600-exec-4
 * - 不带方括号(自定义规则可能这么写):http-nio-8080-exec-1 → http-nio-8080-exec-1
 * 提取不出来返回空串 —— 调用方据此跳过,不给假线程名挂筛选入口。
 *
 * @param {string} matchText 高亮规则命中的那段文本
 * @returns {string} 线程名;识别不出时为空串
 */
function extractThreadNameFromHighlight(matchText) {
    if (!matchText || typeof matchText !== 'string') { return ''; }
    const trimmed = matchText.trim();
    const bracketed = trimmed.match(/\[([^\]]+)\]/);
    const candidate = bracketed ? bracketed[1].trim() : trimmed;
    return THREAD_NAME_SHAPE.test(candidate) ? candidate : '';
}
