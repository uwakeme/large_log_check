// 排查模板功能单元测试(node:test)。
// media/investigationTemplates.js 运行在 webview 浏览器环境里,依赖
// window/document/localStorage/extractLogFields 等 webview.js 提供的全局,
// 这里用桩替身后在 Node 中直接 eval 源码,对纯逻辑(校验/存储/引擎)做回归覆盖。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ---------- 浏览器环境桩 ----------

const style = {};
global.window = { addEventListener: () => {} };
global.document = {
    /** 按 id 返回元素桩;勾选框类控件返回可持久化 checked 的对象,其余返回 null */
    getElementById: (id) => {
        if (/^(filterError|filterWarn|filterInfo|filterDebug|filterOther|filterAll|searchInput|regexMode)$/.test(id)) {
            const key = id;
            if (!style[key]) { style[key] = { id: key, checked: id === 'filterAll' || id.startsWith('filter'), value: '' }; }
            return style[key];
        }
        return null;
    },
    querySelectorAll: () => [],
    querySelector: () => null
};
global.localStorage = {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); }
};
// 桩:模拟 webview.js 的 extractLogFields(取第一个方括号内容作线程名,测试数据只含这一个括号)
global.extractLogFields = (line) => {
    const content = typeof line === 'string' ? line : (line.content || '');
    const m = content.match(/\[([^\]]+)\]/);
    return { threadName: m ? m[1] : '', className: '', methodName: '', content: content };
};

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'investigationTemplates.js'), 'utf8');
// 直接 eval:顶层 function 声明进入本模块作用域,以下测试可直接调用
eval(source);

// ---------- 校验 ----------

test('合法模板通过校验并规整字段', () => {
    const result = validateInvestigationTemplate({
        name: '支付排查',
        params: [{ key: 'orderNo', label: '业务单号' }],
        steps: [
            { type: 'search', keywords: ['支付回调失败', '${orderNo}'], hitPolicy: 'ask', onEmpty: 'skip' },
            { type: 'filter', field: 'threadName', value: 'lastHit', keepKeyword: true },
            { type: 'bookmark', target: 'hits', name: '现场-${orderNo}' },
            { type: 'comment', target: 'hits', content: '排查 ${orderNo}' }
        ],
        unknownTopField: 'should-be-stripped'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.template.steps.length, 4);
    assert.strictEqual(result.template.params[0].key, 'orderNo');
    assert.strictEqual('unknownTopField' in result.template, false, '未知顶层字段应被丢弃');
    assert.strictEqual(result.template.steps[0].keywords[1], '${orderNo}');
});

test('名称为空/动作类型未知/参数名非法/空动作序列均被拒绝', () => {
    assert.strictEqual(validateInvestigationTemplate({ name: '', steps: [{ type: 'search', keywords: ['a'] }] }).ok, false);
    assert.strictEqual(validateInvestigationTemplate({ name: 'x', steps: [{ type: 'hack' }] }).ok, false);
    assert.strictEqual(validateInvestigationTemplate({ name: 'x', params: [{ key: '1bad' }], steps: [{ type: 'search', keywords: ['a'] }] }).ok, false);
    assert.strictEqual(validateInvestigationTemplate({ name: 'x', steps: [] }).ok, false);
});

test('查询动作的 afterLastHit/sameThread 为严格布尔,未知字段丢弃', () => {
    const on = validateTplStep({ type: 'search', keywords: ['k'], afterLastHit: true, sameThread: true, evil: 1 }, 0);
    assert.strictEqual(on.ok, true);
    assert.strictEqual(on.step.afterLastHit, true);
    assert.strictEqual(on.step.sameThread, true);
    assert.strictEqual('evil' in on.step, false);
    const off = validateTplStep({ type: 'search', keywords: ['k'], afterLastHit: 'true' }, 0);
    assert.strictEqual(off.step.afterLastHit, false, '非布尔值应视为 false');
});

test('占位符解析:已声明参数替换,未声明保留原样', () => {
    assert.strictEqual(resolveTplString('订单${orderNo}尾单${missing}', { orderNo: 'A1' }), '订单A1尾单${missing}');
});

test('存储:空/损坏数据降级为空列表,合法数据可往返', () => {
    global.localStorage._s = {};
    assert.deepStrictEqual(loadInvestigationTemplates(), []);

    // 存储 key 是稳定契约(与 media/investigationTemplates.js 的 TPL_STORAGE_KEY 一致);
    // const 不会从 eval 作用域泄漏,这里用字面量
    global.localStorage._s['investigationTemplates'] = '{broken json';
    assert.deepStrictEqual(loadInvestigationTemplates(), []);

    const good = validateInvestigationTemplate({ name: 't', steps: [{ type: 'search', keywords: ['k'] }] });
    assert.strictEqual(saveInvestigationTemplates([good.template]), true);
    const loaded = loadInvestigationTemplates();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].name, 't');
});

test('加载时含未知动作类型的模板被整条过滤', () => {
    global.localStorage._s['investigationTemplates'] = JSON.stringify([
        { id: 'tpl_a', name: 'ok', steps: [{ type: 'search', keywords: ['k'] }] },
        { id: 'tpl_b', name: 'bad', steps: [{ type: 'jump', target: 'lastHit' }] }
    ]);
    const loaded = loadInvestigationTemplates();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'tpl_a');
});

// ---------- 引擎 ----------

function setupEngineData() {
    global.fullDataCache = [
        { lineNumber: 1, content: 'x KEY [t1] a' },
        { lineNumber: 2, content: 'y KEY [t1] b' },
        { lineNumber: 3, content: 'z KEY [t2] c' },
        { lineNumber: 4, content: 'w KEY [t1] d' }
    ];
    global.allLines = global.fullDataCache.slice();
    global.allDataLoaded = true;
    global.unifiedFilters = { keyword: null, isRegex: false, isMultiple: false, threadName: null, className: null, methodName: null, levels: null, timeRange: null };
    global.setFilterAndApply = () => {};
    global.jumpToLine = () => {};
    global.hideFilterStatus = () => {};
    global.showFilterStatus = () => {};
    global.renderLines = () => {};
    global.showToast = () => {};
    global.bookmarks = new Map();
    global.comments = new Map();
}

const SEARCH_DATA_OK = { warnings: [] };

test('hitPolicy=first 时产出集收敛为一条', async () => {
    setupEngineData();
    const ctx = { hits: [], lastHit: null, lastThread: '' };
    await executeTplStep({ type: 'search', keywords: ['KEY'], hitPolicy: 'first', onEmpty: 'stop' }, 0, {}, ctx, { warnings: [], jumpLine: 0 });
    assert.strictEqual(ctx.hits.length, 1);
    assert.strictEqual(ctx.lastHit.lineNumber, 1);
});

test('hitPolicy=all 保留整批,锚点取最后一条', async () => {
    setupEngineData();
    const ctx = { hits: [], lastHit: null, lastThread: '' };
    await executeTplStep({ type: 'search', keywords: ['KEY'], hitPolicy: 'all', onEmpty: 'stop' }, 0, {}, ctx, { warnings: [], jumpLine: 0 });
    assert.strictEqual(ctx.hits.length, 4);
    assert.strictEqual(ctx.lastHit.lineNumber, 4);
});

test('链式约束:上一步命中之后 + 仅同线程,first 取行 2', async () => {
    setupEngineData();
    const ctx = { hits: [], lastHit: { lineNumber: 1, content: 'x KEY [t1] a' }, lastThread: '' };
    await executeTplStep({ type: 'search', keywords: ['KEY'], hitPolicy: 'first', onEmpty: 'stop', afterLastHit: true, sameThread: true }, 0, {}, ctx, { warnings: [], jumpLine: 0 });
    assert.strictEqual(ctx.hits.length, 1);
    assert.strictEqual(ctx.lastHit.lineNumber, 2);
    assert.strictEqual(ctx.lastThread, 't1');
});

test('约束无法满足(无上一步命中)时走 onEmpty=skip 并记警告', async () => {
    setupEngineData();
    const ctx = { hits: [], lastHit: null, lastThread: '' };
    const summary = { warnings: [] };
    await executeTplStep({ type: 'search', keywords: ['KEY'], hitPolicy: 'first', onEmpty: 'skip', afterLastHit: true }, 0, {}, ctx, summary);
    assert.strictEqual(ctx.hits.length, 0);
    assert.strictEqual(summary.warnings.length, 1);
});

test('筛选线程后自动定位到命中行', async () => {
    setupEngineData();
    let jumpedTo = 0;
    global.jumpToLine = (n) => { jumpedTo = n; };
    const ctx = { hits: [], lastHit: { lineNumber: 2, content: 'y KEY [t1] b' }, lastThread: '' };
    const summary = { warnings: [], jumpLine: 0 };
    await executeTplStep({ type: 'filter', field: 'threadName', value: 'lastHit', keepKeyword: true }, 0, {}, ctx, summary);
    assert.strictEqual(ctx.lastThread, 't1');
    assert.strictEqual(jumpedTo, 2);
    assert.strictEqual(summary.jumpLine, 2);
});

// ---------- 界面状态同步 ----------

test('tplSyncFilterUi 同步级别勾选框与全选联动', () => {
    setupEngineData();
    global.unifiedFilters.levels = ['ERROR'];
    tplSyncFilterUi();
    assert.strictEqual(document.getElementById('filterError').checked, true);
    assert.strictEqual(document.getElementById('filterWarn').checked, false);
    assert.strictEqual(document.getElementById('filterAll').checked, false);

    global.unifiedFilters.levels = null;
    tplSyncFilterUi();
    assert.strictEqual(document.getElementById('filterWarn').checked, true);
    assert.strictEqual(document.getElementById('filterAll').checked, true);
});

test('tplSyncFilterUi 回显关键词与正则勾选', () => {
    setupEngineData();
    global.unifiedFilters.keyword = 'abc def';
    global.unifiedFilters.isRegex = false;
    tplSyncFilterUi();
    assert.strictEqual(document.getElementById('searchInput').value, 'abc def');
    assert.strictEqual(document.getElementById('regexMode').checked, false);
});
