'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// investigationTemplates.js 是浏览器全局脚本(依赖 webview.js 提供的全局环境),
// 按 AGENTS.md 约定打桩浏览器全局后用 vm 加载;这里只测导入相关的纯逻辑路径。
const src = readFileSync(join(__dirname, '..', 'media', 'investigationTemplates.js'), 'utf8');

function loadSandbox() {
    const backing = new Map();
    const sandbox = {
        console,
        localStorage: {
            getItem: (k) => (backing.has(k) ? backing.get(k) : null),
            setItem: (k, v) => { backing.set(k, String(v)); },
            removeItem: (k) => { backing.delete(k); }
        },
        showToast: (msg) => { sandbox.lastToast = msg; },
        // 脚本里的 function 声明会覆盖这里的同名桩(如 renderTemplateList),
        // 所以 document / escapeHtml / escapeAttr 要给到足够 renderTemplateList
        // 空转完成的程度(escape 系列与 webview.js 实现保持同语义)
        escapeHtml: (text) => String(text == null ? ''
            : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        escapeAttr: (text) => {
            if (text === undefined || text === null) { return ''; }
            return String(text)
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '&#96;');
        },
        window: { addEventListener: () => {} },
        document: {
            addEventListener: () => {},
            getElementById: () => ({ innerHTML: '', style: {} })
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'investigationTemplates.js' });
    return sandbox;
}

/** 与 tplExportPayload 相同的导出包装格式 */
const wrapper = (templates) => JSON.stringify({
    schemaVersion: 1,
    exportedAt: '2026-09-24T00:00:00.000Z',
    templates
});

const validTpl = () => ({
    id: 'tpl_t1',
    name: '导入格式测试',
    group: '支付服务',
    steps: [{ type: 'search', keywords: ['回调'], hitPolicy: 'first', onEmpty: 'stop', afterLastHit: false, sameThread: false }]
});

// =====================================================================
// 1. 只认导出包装格式
// =====================================================================

test('标准导出格式可导入,分组字段保留', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(wrapper([validTpl()]));
    const store = s.loadInvestigationTemplates();
    assert.equal(store.length, 1);
    assert.equal(store[0].group, '支付服务');
    assert.match(s.lastToast, /导入完成: 新增 1/);
});

test('裸数组格式被拒绝', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(JSON.stringify([validTpl()]));
    assert.equal(s.loadInvestigationTemplates().length, 0);
    assert.match(s.lastToast, /只支持本扩展导出的模板 JSON/);
});

test('{template:{...}} 单个包装格式被拒绝', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(JSON.stringify({ template: validTpl() }));
    assert.equal(s.loadInvestigationTemplates().length, 0);
    assert.match(s.lastToast, /只支持本扩展导出的模板 JSON/);
});

test('单个裸模板对象被拒绝', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(JSON.stringify(validTpl()));
    assert.equal(s.loadInvestigationTemplates().length, 0);
    assert.match(s.lastToast, /只支持本扩展导出的模板 JSON/);
});

test('schemaVersion 缺失或不匹配被拒绝', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(JSON.stringify({ templates: [validTpl()] }));
    assert.equal(s.loadInvestigationTemplates().length, 0);
    assert.match(s.lastToast, /只支持本扩展导出的模板 JSON/);

    s.importTemplatesFromText(JSON.stringify({ schemaVersion: 99, templates: [validTpl()] }));
    assert.equal(s.loadInvestigationTemplates().length, 0);
    assert.match(s.lastToast, /只支持本扩展导出的模板 JSON/);
});

test('非法 JSON 被拒绝', () => {
    const s = loadSandbox();
    s.importTemplatesFromText('{broken json');
    assert.equal(s.loadInvestigationTemplates().length, 0);
    assert.match(s.lastToast, /不是合法的 JSON/);
});

// =====================================================================
// 2. 导入行为(去重覆盖 / 导出往返)
// =====================================================================

test('同 id 导入按覆盖更新,不重复新增', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(wrapper([validTpl()]));
    s.importTemplatesFromText(wrapper([{ ...validTpl(), name: '改名后的模板' }]));
    const store = s.loadInvestigationTemplates();
    assert.equal(store.length, 1);
    assert.equal(store[0].name, '改名后的模板');
    assert.match(s.lastToast, /更新 1/);
});

test('tplExportPayload 导出的内容可原样导入(往返一致)', () => {
    const s = loadSandbox();
    s.importTemplatesFromText(wrapper([validTpl()]));
    const exported = s.tplExportPayload(s.loadInvestigationTemplates());
    const s2 = loadSandbox();
    s2.importTemplatesFromText(exported);
    // updatedAt 每次过校验都会重新生成,比较时剔除;
    // 两个沙箱是不同 vm context(原型不同),deepStrictEqual 不可用,改比 JSON
    const stable = (list) => JSON.stringify(list.map(t => {
        const { updatedAt, ...rest } = t;
        return rest;
    }));
    assert.equal(stable(s2.loadInvestigationTemplates()), stable(s.loadInvestigationTemplates()));
});

// =====================================================================
// 3. 分组功能上线前的存量模板:保留,归到未分组
// =====================================================================

test('存量导入(模板无 group 字段):照常导入,group 归空串(未分组)', () => {
    const s = loadSandbox();
    // 分组功能上线前导出的文件:包装格式相同,但模板里没有 group 字段
    s.importTemplatesFromText(wrapper([{ id: 'tpl_old1', name: '历史模板', steps: validTpl().steps }]));
    const store = s.loadInvestigationTemplates();
    assert.equal(store.length, 1);
    assert.equal(store[0].group, '');
    assert.match(s.lastToast, /导入完成: 新增 1/);
});

test('存量 localStorage 数据(无 group 字段):载入不丢,归到未分组', () => {
    const s = loadSandbox();
    // 模拟旧版本写入的 localStorage:模板对象里根本没有 group 键
    s.localStorage.setItem('investigationTemplates', JSON.stringify([
        { id: 'tpl_old2', name: '旧存量模板', steps: validTpl().steps },
        { id: 'tpl_old3', name: '另一条', steps: validTpl().steps }
    ]));
    const store = s.loadInvestigationTemplates();
    assert.equal(store.length, 2);
    assert.equal(store[0].group, '');
    assert.equal(store[1].group, '');
});
