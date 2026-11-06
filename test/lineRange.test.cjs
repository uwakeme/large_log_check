'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// lineRange.js 是浏览器全局脚本(纯逻辑 + 一处 DOM 胶水),
// 按 AGENTS.md 约定打桩浏览器全局后用 vm 加载。
const src = readFileSync(join(__dirname, '..', 'media', 'lineRange.js'), 'utf8');

// vm 沙箱与宿主是不同 realm(原型不同),deepStrictEqual 不可用,改比 JSON
// (写法沿用 templateImport.test.cjs 的既有注释约定)
const jsonOf = (value) => JSON.stringify(value);

function loadSandbox(chipState) {
    const elements = {}; // 按 id 记忆化,保证测试与被测函数拿到同一个 DOM 对象
    const sandbox = {
        console,
        unifiedFilters: { lineRange: null },
        document: {
            getElementById: (id) => {
                if (id === 'rangeFilterChip') {
                    if (!elements[id]) { elements[id] = { style: {} }; }
                    return elements[id];
                }
                if (id === 'rangeFilterChipText') {
                    if (!elements[id]) {
                        elements[id] = {
                            set textContent(v) { chipState.text = v; },
                            get textContent() { return chipState.text; }
                        };
                    }
                    return elements[id];
                }
                return null;
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox;
}

test('parseLineRangeInput: 双侧有效时返回闭区间', () => {
    const sandbox = loadSandbox({});
    assert.equal(jsonOf(sandbox.parseLineRangeInput('100', '200', 1000)), jsonOf({ ok: true, start: 100, end: 200 }));
});

test('parseLineRangeInput: 双侧留空拒绝(范围不能同时为空)', () => {
    const sandbox = loadSandbox({});
    const result = sandbox.parseLineRangeInput('', '  ', 1000);
    assert.equal(result.ok, false);
    assert.match(result.error, /同时为空/);
});

test('parseLineRangeInput: 单侧留空得到半开区间', () => {
    const sandbox = loadSandbox({});
    assert.equal(jsonOf(sandbox.parseLineRangeInput('100', '', 1000)), jsonOf({ ok: true, start: 100, end: null }));
    assert.equal(jsonOf(sandbox.parseLineRangeInput('', '200', 1000)), jsonOf({ ok: true, start: null, end: 200 }));
});

test('parseLineRangeInput: 非正整数拒绝', () => {
    const sandbox = loadSandbox({});
    assert.equal(sandbox.parseLineRangeInput('abc', '', 1000).ok, false);
    assert.equal(sandbox.parseLineRangeInput('1.5', '', 1000).ok, false);
    assert.equal(sandbox.parseLineRangeInput('-3', '', 1000).ok, false);
    assert.equal(sandbox.parseLineRangeInput('0', '', 1000).ok, false);
});

test('parseLineRangeInput: 超出文件行数拒绝', () => {
    const sandbox = loadSandbox({});
    assert.equal(sandbox.parseLineRangeInput('1001', '', 1000).ok, false);
});

test('parseLineRangeInput: start > end 拒绝', () => {
    const sandbox = loadSandbox({});
    const result = sandbox.parseLineRangeInput('200', '100', 1000);
    assert.equal(result.ok, false);
    assert.match(result.error, /不能大于/);
});

test('setLineRangeBound: 空范围设起点得到半开区间', () => {
    const sandbox = loadSandbox({});
    const result = sandbox.setLineRangeBound(null, 'start', 100, 1000);
    assert.equal(jsonOf(result), jsonOf({ ok: true, range: { start: 100, end: null } }));
});

test('setLineRangeBound: 保留另一侧已有值并做交叉校验', () => {
    const sandbox = loadSandbox({});
    const ok = sandbox.setLineRangeBound({ start: null, end: 200 }, 'start', 100, 1000);
    assert.equal(jsonOf(ok), jsonOf({ ok: true, range: { start: 100, end: 200 } }));
    const bad = sandbox.setLineRangeBound({ start: null, end: 200 }, 'start', 300, 1000);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /终点/);
    const badEnd = sandbox.setLineRangeBound({ start: 100, end: null }, 'end', 50, 1000);
    assert.equal(badEnd.ok, false);
    assert.match(badEnd.error, /起点/);
});

test('setLineRangeBound: 非法行号拒绝', () => {
    const sandbox = loadSandbox({});
    assert.equal(sandbox.setLineRangeBound(null, 'start', 0, 1000).ok, false);
    assert.equal(sandbox.setLineRangeBound(null, 'end', 1001, 1000).ok, false);
    assert.equal(sandbox.setLineRangeBound(null, 'start', 1.5, 1000).ok, false);
    assert.equal(sandbox.setLineRangeBound(null, 'middle', 5, 1000).ok, false);
});

test('setLineRangeBound: 同侧覆盖', () => {
    const sandbox = loadSandbox({});
    const result = sandbox.setLineRangeBound({ start: 100, end: 200 }, 'start', 150, 1000);
    assert.equal(jsonOf(result), jsonOf({ ok: true, range: { start: 150, end: 200 } }));
});

test('formatLineRangeText: 三形态 + 单行区间 + 空范围', () => {
    const sandbox = loadSandbox({});
    assert.equal(sandbox.formatLineRangeText({ start: 100, end: 200 }), '第 100 ~ 200 行');
    assert.equal(sandbox.formatLineRangeText({ start: 100, end: 100 }), '第 100 行');
    assert.equal(sandbox.formatLineRangeText({ start: 100, end: null }), '第 100 行起');
    assert.equal(sandbox.formatLineRangeText({ start: null, end: 200 }), '至第 200 行');
    assert.equal(sandbox.formatLineRangeText(null), '');
    assert.equal(sandbox.formatLineRangeText({ start: null, end: null }), '');
});

test('refreshLineRangeChip: 激活时显示 flex 并带文案,清空时隐藏', () => {
    const chipState = { text: '' };
    const sandbox = loadSandbox(chipState);
    sandbox.unifiedFilters.lineRange = { start: 100, end: 200 };
    const chip = sandbox.document.getElementById('rangeFilterChip');
    sandbox.refreshLineRangeChip();
    assert.equal(chip.style.display, 'flex');
    assert.equal(chipState.text, '范围: 第 100 ~ 200 行');
    sandbox.unifiedFilters.lineRange = null;
    sandbox.refreshLineRangeChip();
    assert.equal(chip.style.display, 'none');
});
