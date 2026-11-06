// ========== 行号范围限定(纯逻辑) ==========
// 「范围筛选」功能的解析/校验/文案纯函数 + chip DOM 胶水。
// 设计文档: docs/2026-11-05-line-range-filter-design.md
//
// 范围 = 统一过滤新维度(webview.js 的 unifiedFilters.lineRange),
// 本文件不持有过滤状态,只提供无副作用的换算与校验;
// 写入/应用统一走 webview.js 的 applyLineRange / clearFilter。
//
// 依赖: 运行时读 webview.js 的 unifiedFilters(共享全局词法环境),
// 必须在 webview.js 之前加载(仅函数声明,加载期无副作用)。

/**
 * 解析「设置行号范围」弹窗的两个输入框。
 * 双侧可独立留空(半开区间),但不能同时为空;
 * 每侧必须是 1 ~ totalLines 的正整数;双侧都有时 start 不得大于 end。
 */
function parseLineRangeInput(startText, endText, totalLines) {
    const rawStart = String(startText == null ? '' : startText).trim();
    const rawEnd = String(endText == null ? '' : endText).trim();
    if (!rawStart && !rawEnd) {
        return { ok: false, error: '起点和终点不能同时为空' };
    }
    const parseSide = (text, label) => {
        if (!text) { return { ok: true, value: null }; }
        if (!/^\d+$/.test(text)) { return { ok: false, error: `${label}必须是正整数` }; }
        const n = parseInt(text, 10);
        if (n < 1 || n > totalLines) {
            return { ok: false, error: `${label}超出文件行数(1 ~ ${totalLines})` };
        }
        return { ok: true, value: n };
    };
    const s = parseSide(rawStart, '起点');
    if (!s.ok) { return s; }
    const e = parseSide(rawEnd, '终点');
    if (!e.ok) { return e; }
    if (s.value != null && e.value != null && s.value > e.value) {
        return { ok: false, error: `起点(${s.value})不能大于终点(${e.value})` };
    }
    return { ok: true, start: s.value, end: e.value };
}

/**
 * 右键单边界写入: 在保留另一侧已有值的前提下写入一侧,
 * 与另一侧构成空范围(start > end)时拒绝并给出对方边界提示。
 * 返回新范围对象,不改传入的 currentRange。
 */
function setLineRangeBound(currentRange, side, lineNumber, totalLines) {
    if (side !== 'start' && side !== 'end') {
        return { ok: false, error: `未知的范围边界: ${side}` };
    }
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > totalLines) {
        return { ok: false, error: `行号 ${lineNumber} 不是有效行号(1 ~ ${totalLines})` };
    }
    const range = {
        start: (currentRange && currentRange.start != null) ? currentRange.start : null,
        end: (currentRange && currentRange.end != null) ? currentRange.end : null
    };
    range[side] = lineNumber;
    if (range.start != null && range.end != null && range.start > range.end) {
        return side === 'start'
            ? { ok: false, error: `起点需不大于已设的终点(第 ${range.end} 行)` }
            : { ok: false, error: `终点需不小于已设的起点(第 ${range.start} 行)` };
    }
    return { ok: true, range: range };
}

/** 范围 chip 文案: 双侧区间 / 单行 / 仅起点 / 仅终点 / 未激活 */
function formatLineRangeText(range) {
    if (!range) { return ''; }
    const hasStart = range.start != null;
    const hasEnd = range.end != null;
    if (hasStart && hasEnd) {
        return range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start} ~ ${range.end} 行`;
    }
    if (hasStart) { return `第 ${range.start} 行起`; }
    if (hasEnd) { return `至第 ${range.end} 行`; }
    return '';
}

/** 刷新分页区旁的范围 chip(常驻显隐,不占用筛选状态条——设计决策 4) */
function refreshLineRangeChip() {
    const chip = document.getElementById('rangeFilterChip');
    if (!chip) { return; }
    const range = (typeof unifiedFilters !== 'undefined') ? unifiedFilters.lineRange : null;
    const active = !!(range && (range.start != null || range.end != null));
    chip.style.display = active ? 'flex' : 'none';
    if (active) {
        const textEl = document.getElementById('rangeFilterChipText');
        if (textEl) { textEl.textContent = '范围: ' + formatLineRangeText(range); }
    }
}
