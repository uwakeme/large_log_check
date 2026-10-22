'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// clipboard.js 是浏览器全局脚本(纯 DOM 逻辑,不依赖 webview.js),
// 按 AGENTS.md 约定打桩浏览器全局后用 vm 加载。
const src = readFileSync(join(__dirname, '..', 'media', 'clipboard.js'), 'utf8');

/**
 * 加载一份沙箱。
 * @param {Object} options
 *  - selection: 模拟 window.getSelection() 的返回值
 *  - activeElement: 模拟 document.activeElement
 *  - containsInLog: 日志容器 contains() 的判定结果(默认 true)
 */
function loadSandbox(options = {}) {
    const state = {
        documentListeners: {},
        containerListeners: {},
        clipboard: null,       // { type, text } —— 实际写进剪贴板的内容
        prevented: false,      // 是否调用了 preventDefault
        blurCount: 0
    };

    const logContainer = {
        addEventListener: (type, handler) => { state.containerListeners[type] = handler; },
        contains: () => (options.containsInLog === undefined ? true : options.containsInLog)
    };

    const body = {};

    const sandbox = {
        console,
        window: {
            getSelection: () => (options.selection === undefined ? null : options.selection)
        },
        document: {
            body,
            activeElement: options.activeElement === undefined ? null : options.activeElement,
            addEventListener: (type, handler) => { state.documentListeners[type] = handler; },
            getElementById: (id) => (id === 'logContainer' ? logContainer : null)
        }
    };

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'clipboard.js' });
    sandbox.initLogClipboard();

    // 触发一次 copy 事件,返回这次复制的结果
    state.fireCopy = () => {
        const handler = state.documentListeners['copy'];
        assert.ok(handler, 'copy 监听器应已注册');
        handler({
            clipboardData: {
                setData: (type, text) => { state.clipboard = { type, text }; }
            },
            preventDefault: () => { state.prevented = true; }
        });
    };

    // 模拟在日志区按下鼠标
    state.fireMouseDown = (target) => {
        const handler = state.containerListeners['mousedown'];
        assert.ok(handler, 'mousedown 监听器应已注册');
        handler({ target });
    };

    return { sandbox, state };
}

/** 构造一个"日志区里有选区"的 selection 桩 */
function makeSelection(text, commonAncestorContainer = {}) {
    return {
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => ({ commonAncestorContainer }),
        toString: () => text
    };
}

/** 构造一个输入框元素桩 */
function makeInput(tagName = 'INPUT') {
    return { tagName, blur() { this.blurred = true; } };
}

// =====================================================================
// 1. Ctrl+C 复制:日志区有选区时,选区文本进剪贴板
// =====================================================================

test('日志区有选区:复制的是选中的日志文本,并阻止原生复制', () => {
    const { state } = loadSandbox({ selection: makeSelection('ERROR 连接超时') });
    state.fireCopy();
    assert.deepEqual(state.clipboard, { type: 'text/plain', text: 'ERROR 连接超时' });
    assert.equal(state.prevented, true);
});

test('焦点停在搜索框时也复制日志选区(复现光标卡在搜索框的故障场景)', () => {
    // 关键前提:焦点在搜索输入框上,但用户在日志区拖出了选区
    const searchInput = makeInput();
    const { state } = loadSandbox({
        selection: makeSelection('NPE at com.foo.Bar.run(Bar.java:42)'),
        activeElement: searchInput
    });
    state.fireCopy();
    assert.equal(state.clipboard.text, 'NPE at com.foo.Bar.run(Bar.java:42)');
    assert.equal(state.prevented, true);
});

test('多行选区连换行一起复制', () => {
    const { state } = loadSandbox({ selection: makeSelection('第一行\n第二行\n第三行') });
    state.fireCopy();
    assert.equal(state.clipboard.text, '第一行\n第二行\n第三行');
});

// =====================================================================
// 2. 不该抢的复制:一律交回原生行为
// =====================================================================

test('没有选区:不写剪贴板、不阻止默认(复制输入框内容走原生逻辑)', () => {
    const { state } = loadSandbox({ selection: null });
    state.fireCopy();
    assert.equal(state.clipboard, null);
    assert.equal(state.prevented, false);
});

test('选区是折叠的(只有光标没有选中):不接管', () => {
    const { state } = loadSandbox({
        selection: { rangeCount: 1, isCollapsed: true, getRangeAt: () => ({}), toString: () => '' }
    });
    state.fireCopy();
    assert.equal(state.clipboard, null);
    assert.equal(state.prevented, false);
});

test('选区不在日志区(比如弹窗里的内容):不接管', () => {
    const { state } = loadSandbox({
        selection: makeSelection('弹窗里的文字', { nodeName: 'DIV' }),
        containsInLog: false
    });
    state.fireCopy();
    assert.equal(state.clipboard, null);
    assert.equal(state.prevented, false);
});

// =====================================================================
// 3. 焦点让位:在日志区点选时,输入框不再留着焦点
// =====================================================================

test('在日志区点选:搜索框让出焦点', () => {
    const searchInput = makeInput();
    const { state } = loadSandbox({ activeElement: searchInput });
    state.fireMouseDown({ tagName: 'SPAN' });
    assert.equal(searchInput.blurred, true);
    assert.equal(state.blurCount, 0);
});

test('在日志区点选:文本域同样让出焦点', () => {
    const textarea = makeInput('TEXTAREA');
    const { state } = loadSandbox({ activeElement: textarea });
    state.fireMouseDown({ tagName: 'DIV' });
    assert.equal(textarea.blurred, true);
});

test('焦点本来就不在输入框上:不乱动', () => {
    const button = { tagName: 'BUTTON' };
    const { state } = loadSandbox({ activeElement: button });
    state.fireMouseDown({ tagName: 'SPAN' });
    assert.equal(button.blurred, undefined);
});

test('点的是输入框自己:不抢焦点', () => {
    const searchInput = makeInput();
    const { state } = loadSandbox({ activeElement: searchInput });
    state.fireMouseDown({ tagName: 'INPUT' });
    assert.equal(searchInput.blurred, undefined);
});
