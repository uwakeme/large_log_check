'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// foldLongLines.js 是浏览器全局脚本(纯逻辑,不碰 DOM),
// 按 AGENTS.md 约定用 vm 加载后从沙箱取全局函数。
const src = readFileSync(join(__dirname, '..', 'media', 'foldLongLines.js'), 'utf8');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const {
    isLongLine,
    resolveLongLineFold,
    longLineToggleTitle,
    isActuallyTruncated,
    resolveLongLineClickMode,
    isHighlightClipped,
    clampFoldMaxRows
} = sandbox;
// const 声明不挂沙箱对象,但在同一 context 的后续脚本里可见 —— 用 eval 取
const LONG_LINE_CLICK_DELAY_MS = vm.runInContext('LONG_LINE_CLICK_DELAY_MS', sandbox);

// ---- isLongLine:长行粗筛 ----

test('isLongLine: 空内容不算长行', () => {
    assert.equal(isLongLine(''), false);
    assert.equal(isLongLine(null), false);
    assert.equal(isLongLine(undefined), false);
});

test('isLongLine: 短行不算长行', () => {
    assert.equal(isLongLine('2026-11-06 17:56:08.701 INFO server started'), false);
    assert.equal(isLongLine('x'.repeat(199)), false);
});

test('isLongLine: 超过 200 字符视为长行候选(200 不算,201 算)', () => {
    assert.equal(isLongLine('x'.repeat(200)), false);
    assert.equal(isLongLine('x'.repeat(201)), true);
});

test('isLongLine: 非字符串内容(行对象/数字)按字符串化处理', () => {
    assert.equal(isLongLine(12345), false);
    assert.equal(isLongLine({ content: 'x'.repeat(300) }), false); // [object Object] 只有 16 字符
    assert.equal(isLongLine('x'.repeat(300)), true);
});

// ---- resolveLongLineFold:折叠状态判定 ----

test('resolveLongLineFold: 开关关闭时任何行都不参与折叠', () => {
    const r = resolveLongLineFold('x'.repeat(500), false, false);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { foldable: false, folded: false });
});

test('resolveLongLineFold: 开关开 + 长行 + 未展开 → 折叠', () => {
    const r = resolveLongLineFold('x'.repeat(500), false, true);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { foldable: true, folded: true });
});

test('resolveLongLineFold: 已展开的长行保持展开', () => {
    const r = resolveLongLineFold('x'.repeat(500), true, true);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { foldable: true, folded: false });
});

test('resolveLongLineFold: 短行不参与折叠(无交互无样式)', () => {
    const r = resolveLongLineFold('short log line', false, true);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { foldable: false, folded: false });
});

test('resolveLongLineFold: 短行即使已展开也不参与折叠', () => {
    const r = resolveLongLineFold('short log line', true, true);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { foldable: false, folded: false });
});

// ---- longLineToggleTitle:行内交互提示文案 ----

test('longLineToggleTitle: 折叠态/展开态文案', () => {
    assert.equal(longLineToggleTitle(true), '点击展开完整内容');
    assert.equal(longLineToggleTitle(false), '点击折叠该行');
});

// ---- isActuallyTruncated:真实截断判定(审查 P2:阈值与是否真裁掉无关) ----

test('isActuallyTruncated: 内容高度超过允许高度 → 真被截断', () => {
    assert.equal(isActuallyTruncated(100, 54), true);
});

test('isActuallyTruncated: 内容高度不超过允许高度 → 没被裁掉,不假装折叠', () => {
    assert.equal(isActuallyTruncated(36, 54), false);  // 201 字符在宽面板上只有 2 行
    assert.equal(isActuallyTruncated(54, 54), false);  // 刚好 3 行
});

test('isActuallyTruncated: 1px 容差(亚像素舍入不该误判)', () => {
    assert.equal(isActuallyTruncated(55, 54), false);
    assert.equal(isActuallyTruncated(56, 54), true);
});

test('isActuallyTruncated: 非有限值一律判为未截断', () => {
    assert.equal(isActuallyTruncated(NaN, 54), false);
    assert.equal(isActuallyTruncated(100, NaN), false);
    assert.equal(isActuallyTruncated(undefined, undefined), false);
});

// ---- resolveLongLineClickMode:点击归属三态判定(单击/双击冲突解法) ----

function fakeTarget(closestMap) {
    return {
        closest(selector) {
            return closestMap[selector] || null;
        }
    };
}

test('resolveLongLineClickMode: JSON/XML 解析树内的点击不触发整行折叠', () => {
    const tree = {};
    assert.equal(resolveLongLineClickMode(fakeTarget({ '.json-tree, .xml-tree, .log-comment': tree })), 'none');
});

test('resolveLongLineClickMode: 注释块内的点击不触发整行折叠', () => {
    const comment = {};
    assert.equal(resolveLongLineClickMode(fakeTarget({ '.json-tree, .xml-tree, .log-comment': comment })), 'none');
});

test('resolveLongLineClickMode: 点「⋯ 展开」/「收起」按钮 → 立即执行', () => {
    assert.equal(resolveLongLineClickMode(fakeTarget({ '.fold-toggle, .fold-expand-btn': {} })), 'immediate');
});

test('resolveLongLineClickMode: 正文区域 → 延迟判定(给双击书签取消的窗口)', () => {
    assert.equal(resolveLongLineClickMode(fakeTarget({})), 'delayed');
    assert.equal(resolveLongLineClickMode(null), 'delayed');
    assert.equal(resolveLongLineClickMode({}), 'delayed');
});

test('resolveLongLineClickMode: 按钮优先于其它归属', () => {
    // 两个 closest 都命中时(按钮不会出现在解析树里,防御性断言优先级)
    const both = fakeTarget({
        '.json-tree, .xml-tree, .log-comment': {},
        '.fold-toggle, .fold-expand-btn': {}
    });
    assert.equal(resolveLongLineClickMode(both), 'none');
});

test('LONG_LINE_CLICK_DELAY_MS: 延迟窗口常量存在且足够快(接近即时感知)', () => {
    assert.equal(typeof LONG_LINE_CLICK_DELAY_MS, 'number');
    assert.ok(LONG_LINE_CLICK_DELAY_MS >= 100 && LONG_LINE_CLICK_DELAY_MS <= 200);
});

// ---- isHighlightClipped:搜索命中是否被折叠区裁掉(审查 P2) ----

test('isHighlightClipped: 高亮完全在可见区内 → 不需要展开', () => {
    assert.equal(isHighlightClipped(10, 30, 54), false);
    assert.equal(isHighlightClipped(0, 54, 54), false);
});

test('isHighlightClipped: 高亮底边超出可见高度 → 被裁掉,应展开', () => {
    assert.equal(isHighlightClipped(40, 70, 54), true);
    assert.equal(isHighlightClipped(200, 220, 54), true);
});

test('isHighlightClipped: 非有限值不触发展开', () => {
    assert.equal(isHighlightClipped(NaN, 70, 54), false);
    assert.equal(isHighlightClipped(10, 30, NaN), false);
});

// ---- clampFoldMaxRows:保留行数钳制 ----

test('clampFoldMaxRows: 越界值夹到 [1,50]', () => {
    assert.equal(clampFoldMaxRows(0, 3), 1);
    assert.equal(clampFoldMaxRows(-5, 3), 1);
    assert.equal(clampFoldMaxRows(500, 3), 50);
    assert.equal(clampFoldMaxRows(3, 3), 3);
});

test('clampFoldMaxRows: 非数值回退到 fallback', () => {
    assert.equal(clampFoldMaxRows(NaN, 3), 3);
    assert.equal(clampFoldMaxRows(undefined, 5), 5);
    assert.equal(clampFoldMaxRows('4', 3), 3);
});
