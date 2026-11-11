// ========== 大数组分块传输(纯逻辑) ==========
// 宿主往 webview 发送携带大行数组的消息(fileLoaded / filterResults)时,
// 单条 postMessage 的 payload 会被整体 JSON 序列化成一个字符串 —— 行数组
// 字符总量逼近 V8 单字符串上限(2^29-24 ≈ 5.37 亿字符)时序列化抛 RangeError
// 且被静默吞掉,650MB 日志「加载到 100% 卡住不动」即由此而来。
// 本模块只负责把行数组切成若干块,发送编排在 logViewerPanel.ts。
//
// 无 vscode 依赖,test/*.test.cjs 直接 require 编译产物 out/chunkedTransfer.js。

import { LogLine } from './logParser';

/**
 * 每块的序列化字符预算。
 * 取 8M 字符:单条消息的 JSON 字符串远低于 V8 上限,IPC 传输无压力;
 * 650MB 日志约切 80 块,块数带来的消息开销可忽略。
 */
export const CHUNK_TRANSFER_MAX_CHARS = 8 * 1024 * 1024;

/**
 * 每个 LogLine 除 content 外的序列化开销估算:
 * {"lineNumber":457101,"content":"","timestamp":"2026-11-11T10:00:00.000Z","level":"INFO"}
 * 键名 + 数字 + ISO 时间 + 级别 + 标点 ≈ 100 出头,取 128 留余量。
 * 估算偏大只会让块更小(更安全),不影响正确性。
 */
export const PER_LINE_OVERHEAD_CHARS = 128;

/**
 * 单行内容的安全上限(字符):超预算单行会独占一块,但独占块仍超
 * V8 单字符串上限(2^29-24 ≈ 5.37 亿字符;JSON 转义最坏再翻倍)。
 * 取 2.5 亿字符为安全线,超出直接明确报错,不再静默卡死。
 */
export const SAFE_SINGLE_LINE_CHARS = 250 * 1000 * 1000;

/** 一块的范围,[start, end) 半开区间 */
export interface ChunkPlan {
    start: number;
    end: number;
}

/**
 * 按序列化字符预算把行数组切块。
 * 单行超预算时独占一块(绝不拆行 —— LogLine 是最小传输单元);
 * 空数组返回单块空区间由调用方自行判断(这里返回空数组表示无需发送)。
 */
export function planLineChunks(
    lines: readonly LogLine[],
    maxChars: number = CHUNK_TRANSFER_MAX_CHARS
): ChunkPlan[] {
    const plans: ChunkPlan[] = [];
    let start = 0;
    let budget = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cost = (typeof line?.content === 'string' ? line.content.length : 0) + PER_LINE_OVERHEAD_CHARS;
        // 已有存量且再加这一行会超预算 → 先结算当前块;单行自身超预算则独占一块
        if (budget > 0 && budget + cost > maxChars) {
            plans.push({ start, end: i });
            start = i;
            budget = 0;
        }
        budget += cost;
    }
    if (start < lines.length) {
        plans.push({ start, end: lines.length });
    }
    return plans;
}
