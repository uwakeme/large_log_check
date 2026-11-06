'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// investigationTemplates.js 是浏览器全局脚本(依赖 webview.js 提供的全局环境),
// 按 AGENTS.md 约定打桩浏览器全局后用 vm 加载;这里测导入校验与模板流水线执行体。
const src = readFileSync(join(__dirname, '..', 'media', 'investigationTemplates.js'), 'utf8');
// setRange 执行体依赖 lineRange.js 的真实纯函数(setLineRangeBound/formatLineRangeText)
const rangeSrc = readFileSync(join(__dirname, '..', 'media', 'lineRange.js'), 'utf8');

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
        },
        // —— executeTplStep 运行时依赖(webview.js 全局打桩) ——
        unifiedFilters: {
            keyword: null, isRegex: false, isMultiple: false, threadName: null,
            className: null, methodName: null, levels: null, timeRange: null, lineRange: null
        },
        totalLinesInFile: 1000,
        extractLogFields: () => ({ threadName: '', className: '', methodName: '' }),
        jumpToLine: (n) => { sandbox.jumpedTo = n; },
        hideFilterStatus: () => {},
        showFilterStatus: () => {},
        renderLines: () => {},
        bookmarks: new Map(),
        comments: new Map(),
        allLines: [],
        setFilterAndApply: (filters, options) => {
            sandbox.appliedFilters = sandbox.appliedFilters || [];
            sandbox.appliedFilters.push({ filters, options });
        },
        // webview.js 的 applyLineRange 打桩: 语义对齐真身(写 unifiedFilters + 触发 setFilterAndApply)
        applyLineRange: (range) => {
            sandbox.unifiedFilters.lineRange = range;
            sandbox.setFilterAndApply({}, { resetPage: true });
        },
        clearFilter: (name) => { sandbox.clearedFilters = sandbox.clearedFilters || []; sandbox.clearedFilters.push(name); }
    };
    vm.createContext(sandbox);
    vm.runInContext(rangeSrc, sandbox, { filename: 'lineRange.js' });
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

// vm 沙箱与宿主是不同 realm(原型不同),deepStrictEqual 不可用,改比 JSON
const jsonOfSteps = (steps) => JSON.stringify(steps);

// =====================================================================
// 6. setRange(限定范围)动作校验
// =====================================================================

test('validate: setRange 起点/最近命中 合法且字段收敛', () => {
    const sandbox = loadSandbox();
    const result = sandbox.validateInvestigationTemplate({
        name: 't',
        steps: [{ type: 'setRange', apply: 'start', source: 'lastHit', line: '随便填也会被清掉' }]
    });
    assert.equal(result.ok, true);
    // source=lastHit 时行号表达式无意义,校验层归一为空串
    assert.equal(jsonOfSteps([result.template.steps[0]]), jsonOfSteps([{ type: 'setRange', apply: 'start', source: 'lastHit', line: '' }]));
});

test('validate: setRange 指定行号来源要求行号非空', () => {
    const sandbox = loadSandbox();
    const ok = sandbox.validateInvestigationTemplate({
        name: 't',
        steps: [{ type: 'setRange', apply: 'end', source: 'line', line: '${endLine}' }]
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.template.steps[0].line, '${endLine}');

    const empty = sandbox.validateInvestigationTemplate({
        name: 't',
        steps: [{ type: 'setRange', apply: 'end', source: 'line', line: '  ' }]
    });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /行号/);
});

test('validate: setRange 清除范围不保留 source/line', () => {
    const sandbox = loadSandbox();
    const result = sandbox.validateInvestigationTemplate({
        name: 't',
        steps: [{ type: 'setRange', apply: 'clear', source: 'line', line: '999' }]
    });
    assert.equal(result.ok, true);
    assert.equal(jsonOfSteps([result.template.steps[0]]), jsonOfSteps([{ type: 'setRange', apply: 'clear' }]));
});

test('validate: setRange 非法 apply 拒绝,未知 source 收敛默认', () => {
    const sandbox = loadSandbox();
    const badApply = sandbox.validateInvestigationTemplate({
        name: 't', steps: [{ type: 'setRange', apply: 'middle' }]
    });
    assert.equal(badApply.ok, false);
    const badSource = sandbox.validateInvestigationTemplate({
        name: 't', steps: [{ type: 'setRange', apply: 'start', source: 'unknown' }]
    });
    // source 容错口径与 hitPolicy/onEmpty 一致: 未知值收敛默认 lastHit,不拒绝
    assert.equal(badSource.ok, true);
    assert.equal(badSource.template.steps[0].source, 'lastHit');
});

test('validate: 旧版扩展语义下含 setRange 的模板按无效跳过(决策 8 兼容回归)', () => {
    // 新版导出: schemaVersion 保持 1,含 setRange 步骤
    const sandbox = loadSandbox();
    const exported = sandbox.tplExportPayload([sandbox.validateInvestigationTemplate({
        name: 'range-flow',
        steps: [{ type: 'search', keywords: ['任务开始'] }, { type: 'setRange', apply: 'start', source: 'lastHit' }]
    }).template]);
    const payload = JSON.parse(exported);
    assert.equal(payload.schemaVersion, 1);
    // 模拟旧版校验: 白名单里没有 setRange -> validateTplStep 报「类型未知」-> 整个模板 invalid。
    // TPL_ACTION_TYPES 是 const 声明的对象,绑定不可重赋值但属性可 delete,沙箱里可直接复现旧版白名单。
    const oldSandbox = loadSandbox();
    vm.runInContext('delete TPL_ACTION_TYPES.setRange;', oldSandbox);
    const reimport = oldSandbox.validateInvestigationTemplate(payload.templates[0]);
    assert.equal(reimport.ok, false);
    assert.match(reimport.error, /类型未知/);
});

// =====================================================================
// 7. setRange 执行体 + 查询动作范围内叠加
// =====================================================================

function makeLine(n, text) {
    return { lineNumber: n, content: text, timestamp: null };
}

function loadPipelineSandbox() {
    const sandbox = loadSandbox();
    sandbox.fullDataCache = [];
    sandbox.context = { hits: [], lastHit: null, lastThread: '' };
    sandbox.summary = { bookmarks: 0, comments: 0, thread: '', jumpLine: 0, filtered: false, warnings: [], stopped: false };
    return sandbox;
}

test('执行: setRange 起点/最近命中 写入范围并触发重算', async () => {
    const sandbox = loadPipelineSandbox();
    sandbox.context.lastHit = makeLine(120, '任务开始');
    await sandbox.executeTplStep(
        { type: 'setRange', apply: 'start', source: 'lastHit' }, 1, {}, sandbox.context, sandbox.summary);
    assert.equal(jsonOfSteps([sandbox.unifiedFilters.lineRange]), jsonOfSteps([{ start: 120, end: null }]));
    assert.equal(sandbox.appliedFilters.length, 1);
    assert.equal(sandbox.summary.filtered, true);
});

test('执行: setRange 指定行号支持 ${参数}', async () => {
    const sandbox = loadPipelineSandbox();
    await sandbox.executeTplStep(
        { type: 'setRange', apply: 'end', source: 'line', line: '${endLine}' }, 1, { endLine: '300' }, sandbox.context, sandbox.summary);
    assert.equal(jsonOfSteps([sandbox.unifiedFilters.lineRange]), jsonOfSteps([{ start: null, end: 300 }]));
});

test('执行: setRange 行号非法 -> 警告跳过,范围不变', async () => {
    const sandbox = loadPipelineSandbox();
    sandbox.unifiedFilters.lineRange = { start: 100, end: null };
    await sandbox.executeTplStep(
        { type: 'setRange', apply: 'end', source: 'line', line: 'abc' }, 1, {}, sandbox.context, sandbox.summary);
    assert.equal(sandbox.summary.warnings.length, 1);
    assert.equal(jsonOfSteps([sandbox.unifiedFilters.lineRange]), jsonOfSteps([{ start: 100, end: null }]));
});

test('执行: setRange 构成空范围 -> 警告跳过', async () => {
    const sandbox = loadPipelineSandbox();
    sandbox.unifiedFilters.lineRange = { start: null, end: 200 };
    sandbox.context.lastHit = makeLine(300, '任务开始');
    await sandbox.executeTplStep(
        { type: 'setRange', apply: 'start', source: 'lastHit' }, 1, {}, sandbox.context, sandbox.summary);
    assert.equal(sandbox.summary.warnings.length, 1);
    assert.equal(jsonOfSteps([sandbox.unifiedFilters.lineRange]), jsonOfSteps([{ start: null, end: 200 }]));
});

test('执行: setRange 无最近命中 -> 警告跳过; clear 走 clearFilter', async () => {
    const sandbox = loadPipelineSandbox();
    await sandbox.executeTplStep(
        { type: 'setRange', apply: 'start', source: 'lastHit' }, 1, {}, sandbox.context, sandbox.summary);
    assert.equal(sandbox.summary.warnings.length, 1);
    await sandbox.executeTplStep({ type: 'setRange', apply: 'clear' }, 2, {}, sandbox.context, sandbox.summary);
    assert.deepEqual(sandbox.clearedFilters, ['lineRange']);
});

test('执行: 查询动作命中被范围边界截断', async () => {
    const sandbox = loadPipelineSandbox();
    for (let n = 1; n <= 300; n++) {
        sandbox.fullDataCache.push(makeLine(n, `hit target line ${n}`));
    }
    sandbox.unifiedFilters.lineRange = { start: 100, end: 200 };
    await sandbox.executeTplStep(
        { type: 'search', keywords: ['target'], hitPolicy: 'all', onEmpty: 'stop' }, 1, {}, sandbox.context, sandbox.summary);
    assert.equal(sandbox.context.hits.length, 101); // 100 ~ 200 闭区间
    assert.ok(sandbox.context.hits.every(l => l.lineNumber >= 100 && l.lineNumber <= 200));
});

test('执行(决策 7 回归): 查询动作的 setFilterAndApply 参数不含 lineRange 键', async () => {
    const sandbox = loadPipelineSandbox();
    sandbox.fullDataCache = [makeLine(150, '任务结束 ok')];
    sandbox.unifiedFilters.lineRange = { start: 100, end: 200 };
    await sandbox.executeTplStep(
        { type: 'search', keywords: ['任务结束'], hitPolicy: 'first', onEmpty: 'stop' }, 1, {}, sandbox.context, sandbox.summary);
    assert.equal(sandbox.appliedFilters.length, 1);
    const keys = Object.keys(sandbox.appliedFilters[0].filters);
    assert.equal(keys.includes('lineRange'), false);
});

test('执行: afterLastHit 与范围起点并存时双约束生效', async () => {
    const sandbox = loadPipelineSandbox();
    for (let n = 1; n <= 300; n++) {
        sandbox.fullDataCache.push(makeLine(n, `hit target line ${n}`));
    }
    sandbox.unifiedFilters.lineRange = { start: 100, end: 200 };
    sandbox.context.lastHit = makeLine(150, 'anchor');
    await sandbox.executeTplStep(
        { type: 'search', keywords: ['target'], hitPolicy: 'all', onEmpty: 'stop', afterLastHit: true }, 1, {}, sandbox.context, sandbox.summary);
    assert.ok(sandbox.context.hits.every(l => l.lineNumber > 150 && l.lineNumber <= 200));
});

test('执行: 查询 0 命中文案携带范围信息', async () => {
    const sandbox = loadPipelineSandbox();
    sandbox.fullDataCache = [makeLine(5, 'unrelated')];
    sandbox.unifiedFilters.lineRange = { start: 100, end: 200 };
    await sandbox.executeTplStep(
        { type: 'search', keywords: ['target'], hitPolicy: 'all', onEmpty: 'skip' }, 1, {}, sandbox.context, sandbox.summary);
    assert.match(sandbox.summary.warnings[0], /第 100 ~ 200 行/);
});
