'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// searchShortcut.js 是浏览器全局脚本(选区→搜索框的纯逻辑 + 少量 DOM 胶水),
// 按 AGENTS.md 约定打桩浏览器全局后用 vm 加载。
// 它复用 clipboard.js 的 getLogSelectionText(),沙箱里直接给桩。
const src = readFileSync(join(__dirname, '..', 'media', 'searchShortcut.js'), 'utf8');

/**
 * 加载一份沙箱。
 * @param {Object} options
 *  - selectionText: 模拟 clipboard.js getLogSelectionText() 的返回值
 *  - searchInput:   搜索输入框桩(默认自动构造,可传入自定义桩)
 */
function loadSandbox(options = {}) {
    const state = {
        searchCalls: 0,
        hideDropdownCalls: 0
    };

    const searchInput = options.searchInput || makeSearchInput();

    const sandbox = {
        console,
        getLogSelectionText: () => (options.selectionText === undefined ? '' : options.selectionText),
        search: () => { state.searchCalls += 1; },
        hideSearchHistoryDropdown: () => { state.hideDropdownCalls += 1; },
        document: {
            getElementById: (id) => (id === 'searchInput' ? searchInput : null)
        }
    };

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'searchShortcut.js' });

    return { sandbox, state, searchInput };
}

/** 构造搜索输入框桩 */
function makeSearchInput() {
    return {
        value: '',
        caret: null,
        focused: false,
        setSelectionRange(start, end) { this.caret = [start, end]; },
        focus() { this.focused = true; }
    };
}

/** 构造 keydown 事件桩 */
function makeKeyEvent(overrides = {}) {
    return Object.assign({
        key: 'f',
        keyCode: 70,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        prevented: false,
        preventDefault() { this.prevented = true; }
    }, overrides);
}

// =====================================================================
// 1. 接管:Ctrl/Cmd+F + 日志区有选区 → 填入搜索框并立即搜索
// =====================================================================

test('Ctrl+F 且日志区有选区:文字进搜索框、立即搜索、焦点与光标到位', () => {
    const { sandbox, state, searchInput } = loadSandbox({ selectionText: 'ERROR 连接超时' });
    const event = makeKeyEvent();
    const handled = sandbox.handleSearchFromSelection(event);
    assert.equal(handled, true);
    assert.equal(searchInput.value, 'ERROR 连接超时');
    assert.deepEqual(searchInput.caret, ['ERROR 连接超时'.length, 'ERROR 连接超时'.length]);
    assert.equal(searchInput.focused, true);
    assert.equal(state.searchCalls, 1);
    assert.equal(state.hideDropdownCalls, 1);
    assert.equal(event.prevented, true);
});

test('Cmd+F(macOS)同样接管', () => {
    const { sandbox, state, searchInput } = loadSandbox({ selectionText: 'timeout' });
    const handled = sandbox.handleSearchFromSelection(makeKeyEvent({ ctrlKey: false, metaKey: true }));
    assert.equal(handled, true);
    assert.equal(searchInput.value, 'timeout');
    assert.equal(state.searchCalls, 1);
});

test('多行选区:换行与连续空白折叠成单个空格,不把行尾行首粘成一个词', () => {
    // <input> 的 value 会剥掉换行,不折叠的话 "at\ncom" 会变成 "atcom"
    const { sandbox, searchInput } = loadSandbox({
        selectionText: 'ERROR  at\ncom.foo.Bar\t\t连接超时'
    });
    sandbox.handleSearchFromSelection(makeKeyEvent());
    assert.equal(searchInput.value, 'ERROR at com.foo.Bar 连接超时');
});

test('e.key 为大写 F(某些键盘布局/大小写锁定)也能接管', () => {
    const { sandbox, state } = loadSandbox({ selectionText: 'foo' });
    const handled = sandbox.handleSearchFromSelection(makeKeyEvent({ key: 'F' }));
    assert.equal(handled, true);
    assert.equal(state.searchCalls, 1);
});

// =====================================================================
// 2. 不接管:交回默认行为
// =====================================================================

test('没有选区:不接管、不搜索、不动搜索框', () => {
    const { sandbox, state, searchInput } = loadSandbox({ selectionText: '' });
    const event = makeKeyEvent();
    const handled = sandbox.handleSearchFromSelection(event);
    assert.equal(handled, false);
    assert.equal(searchInput.value, '');
    assert.equal(state.searchCalls, 0);
    assert.equal(event.prevented, false);
});

test('选区只有空白字符:视同没有选区', () => {
    const { sandbox, state } = loadSandbox({ selectionText: '  \n\t ' });
    const handled = sandbox.handleSearchFromSelection(makeKeyEvent());
    assert.equal(handled, false);
    assert.equal(state.searchCalls, 0);
});

test('纯 F 键(没有 Ctrl/Cmd):不接管', () => {
    const { sandbox, state } = loadSandbox({ selectionText: 'foo' });
    const handled = sandbox.handleSearchFromSelection(makeKeyEvent({ ctrlKey: false }));
    assert.equal(handled, false);
    assert.equal(state.searchCalls, 0);
});

test('Ctrl+C 不是搜索快捷键:不接管', () => {
    const { sandbox } = loadSandbox({ selectionText: 'foo' });
    const handled = sandbox.handleSearchFromSelection(makeKeyEvent({ key: 'c', keyCode: 67 }));
    assert.equal(handled, false);
});

test('Ctrl+Shift+F / Ctrl+Alt+F 组合:不抢,留给系统其它快捷键', () => {
    const { sandbox, state } = loadSandbox({ selectionText: 'foo' });
    assert.equal(sandbox.handleSearchFromSelection(makeKeyEvent({ shiftKey: true })), false);
    assert.equal(sandbox.handleSearchFromSelection(makeKeyEvent({ altKey: true })), false);
    assert.equal(state.searchCalls, 0);
});

// =====================================================================
// 3. 空白折叠工具函数
// =====================================================================

test('collapseWhitespaceForInput:首尾去空、连续空白并一', () => {
    const { sandbox } = loadSandbox({});
    assert.equal(sandbox.collapseWhitespaceForInput('  a \n\t b  '), 'a b');
    assert.equal(sandbox.collapseWhitespaceForInput(null), '');
});
