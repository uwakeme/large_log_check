// ========== 排查模板功能 ==========
// 设计文档: docs/2026-08-31-quick-locate-design.md
//
// 模板 = 参数(params) + 线性动作序列(steps)。运行时按顺序执行动作,
// 动作之间通过执行上下文(context)传递数据(命中集/选中命中/线程名)。
// 动作全部复用 webview.js 的现有能力,本文件不重新实现任何匹配/过滤逻辑。
//
// 依赖(必须在 webview.js 之后加载,共用同一全局词法环境):
//   vscode / fullDataCache / allLines / allDataLoaded / unifiedFilters /
//   bookmarks / comments / setFilterAndApply / clearCustomFilter /
//   jumpToLine / extractLogFields / renderLines / showToast /
//   showCustomConfirm / escapeHtml / escapeAttr / showFilterStatus / hideFilterStatus

// ---------- 常量 ----------

const TPL_STORAGE_KEY = 'investigationTemplates';
const TPL_SCHEMA_VERSION = 1;
const TPL_MAX_COUNT = 100;        // 模板总数上限
const TPL_MAX_STEPS = 50;         // 单模板动作数上限
const TPL_MAX_PARAMS = 10;        // 单模板参数数上限
const TPL_MAX_KEYWORDS = 10;      // 单个查询动作关键词数上限
const TPL_MAX_KEYWORD_LEN = 200;  // 单个关键词长度上限
const TPL_HIT_LIST_MAX = 200;     // 命中选择列表最多渲染条数
const TPL_PREVIEW_LEN = 120;      // 命中内容预览截断长度
const TPL_MAX_GROUP_LEN = 50;     // 分组名长度上限

// 动作类型白名单: type -> 中文名。
// jump(跳转)已整体移除:可复用模板里写死行号/时间没有意义,定位到命中行
// 由查询/筛选动作自动完成(设计文档决策 13)。功能未发布,无兼容负担。
const TPL_ACTION_TYPES = {
    search: '查询日志',
    filter: '筛选',
    bookmark: '打书签',
    comment: '加注释'
};

const TPL_HIT_POLICIES = { ask: '命中多条时让我选择', first: '自动选第一条(仅这一条)', all: '保留全部命中' };
const TPL_EMPTY_POLICIES = { stop: '终止流程', skip: '跳过本步继续' };
const TPL_FILTER_FIELDS = {
    threadName: '线程名',
    className: '类名',
    methodName: '方法名',
    levels: '日志级别',
    timeRange: '时间范围'
};
const TPL_LEVEL_TOKENS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'OTHER'];
const TPL_LEVEL_LABELS = { ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO', DEBUG: 'DEBUG', OTHER: '其他' };

// 输入控件内联样式(与 webview.html 旧弹窗写法一致,走 --vscode-* 变量保证 4 套主题兼容)
const TPL_INPUT_STYLE = 'width: 100%; padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; box-sizing: border-box;';
const TPL_SMALL_BTN_STYLE = 'padding: 2px 8px; font-size: 12px;';
const TPL_LABEL_STYLE = 'display: block; font-size: 12px; margin-bottom: 5px;';

// ---------- 运行时状态 ----------

let tplEditingTemplate = null;   // 编辑器当前编辑的模板(未校验的原始对象,含 id/createdAt)
let tplEditorMode = 'visual';    // 编辑器当前视图: 'visual' | 'json'
let tplExpandedStep = null;      // 流程轨道上当前展开编辑的步骤下标(null=全部收起)
let tplParamAdding = false;      // 参数芯片是否处于"新增"内联编辑状态
let tplPipelineRunning = false;  // 流水线执行中标志
let tplPipelineAbort = false;    // 「停止」按钮置位,步骤间检查
let tplRunningTemplate = null;   // 当前正在执行的模板
let tplHitResolver = null;       // 命中选择弹窗的 Promise resolve
let tplCurrentHits = null;       // 命中选择弹窗当前展示的命中数组
let tplLastParamTarget = null;   // 编辑器里最后聚焦的动作输入框(参数芯片点击插入的目标)
let tplListGroupFilter = 'all';  // 模板列表的分组过滤: 'all'=全部, ''=未分组, 其他=分组名

// ---------- 小工具 ----------

/**
 * 解析字符串中的 ${key} 占位符。已声明但运行时没填值的参数按空串处理;
 * 未声明的占位符(如模板里写错参数名)原样保留,方便用户看出"这个位置需要填参数"。
 */
function resolveTplString(str, paramValues) {
    return String(str == null ? '' : str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) => {
        if (paramValues && Object.prototype.hasOwnProperty.call(paramValues, key)) {
            return String(paramValues[key] == null ? '' : paramValues[key]).trim();
        }
        return m;
    });
}

/** Date -> 'HH:mm:ss.SSS'(命中列表预览用) */
function tplFormatTime(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) { return ''; }
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}

/** 截断内容预览(按字符数,不追加省略号以保持可复制) */
function tplTruncate(text, max) {
    const s = String(text || '').trim();
    return s.length > max ? s.slice(0, max) : s;
}

// ---------- 存储层 ----------

function loadInvestigationTemplates() {
    try {
        const raw = localStorage.getItem(TPL_STORAGE_KEY);
        if (!raw) { return []; }
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.templates) ? parsed.templates : []);
        const valid = [];
        for (const item of list) {
            const result = validateInvestigationTemplate(item);
            if (result.ok) { valid.push(result.template); }
        }
        return valid;
    } catch (e) {
        // 数据损坏时降级为空列表,绝不阻塞打开;首次写入会覆盖坏数据
        console.warn('[排查模板] 本地模板数据损坏,已按空列表处理:', e);
        return [];
    }
}

function saveInvestigationTemplates(list) {
    try {
        localStorage.setItem(TPL_STORAGE_KEY, JSON.stringify(list.slice(0, TPL_MAX_COUNT)));
        return true;
    } catch (e) {
        showToast('保存排查模板失败: ' + (e && e.message ? e.message : e), 'error');
        return false;
    }
}

// ---------- 校验(白名单制,导入安全的第一道防线) ----------

/**
 * 校验并规整一个模板对象。返回 { ok, template?, error? }。
 * 未知字段一律丢弃;非法结构直接拒绝。
 */
function validateInvestigationTemplate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: '模板不是有效对象' };
    }
    const name = String(input.name || '').trim();
    if (!name) { return { ok: false, error: '模板名称不能为空' }; }
    if (name.length > 100) { return { ok: false, error: '模板名称过长(最多 100 字符)' }; }

    let params = [];
    if (input.params != null) {
        if (!Array.isArray(input.params)) { return { ok: false, error: 'params 必须是数组' }; }
        if (input.params.length > TPL_MAX_PARAMS) { return { ok: false, error: `参数数量超过上限(最多 ${TPL_MAX_PARAMS} 个)` }; }
        const seen = new Set();
        for (const p of input.params) {
            const key = String((p && p.key) || '').trim();
            const label = String((p && p.label) || '').trim() || key;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                return { ok: false, error: `参数名不合法: "${key}"(字母开头,仅含字母数字下划线)` };
            }
            if (seen.has(key)) { return { ok: false, error: `参数名重复: ${key}` }; }
            seen.add(key);
            params.push({ key: key, label: label.slice(0, 50) });
        }
    }

    if (!Array.isArray(input.steps)) { return { ok: false, error: 'steps 必须是数组' }; }
    if (input.steps.length === 0) { return { ok: false, error: '至少需要配置一个动作' }; }
    if (input.steps.length > TPL_MAX_STEPS) { return { ok: false, error: `动作数量超过上限(最多 ${TPL_MAX_STEPS} 个)` }; }

    const steps = [];
    for (let i = 0; i < input.steps.length; i++) {
        const result = validateTplStep(input.steps[i], i);
        if (!result.ok) { return result; }
        steps.push(result.step);
    }

    // id 会拼进 onclick 与元素 id,只接受安全字符集;非法 id(如导入的恶意构造)直接重新生成
    const rawId = (typeof input.id === 'string' && input.id) ? input.id : '';
    const template = {
        id: /^[A-Za-z0-9_.:-]+$/.test(rawId) ? rawId : ('tpl_' + Date.now()),
        schemaVersion: TPL_SCHEMA_VERSION,
        name: name,
        description: String(input.description || '').trim().slice(0, 200),
        group: String(input.group || '').trim().slice(0, TPL_MAX_GROUP_LEN),
        params: params,
        steps: steps,
        createdAt: Number(input.createdAt) || Date.now(),
        updatedAt: Date.now()
    };
    return { ok: true, template: template };
}

/** 校验单个动作,按 type 走字段白名单 */
function validateTplStep(raw, index) {
    const at = `第 ${index + 1} 个动作`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: `${at}不是有效对象` };
    }
    const type = raw.type;
    if (!TPL_ACTION_TYPES[type]) {
        return { ok: false, error: `${at}类型未知: ${type}(支持: ${Object.keys(TPL_ACTION_TYPES).join('/')})` };
    }

    if (type === 'search') {
        // UI 按「空格分隔」编辑关键词,存储也统一拆成单词,避免保存时被 split 静默改写
        const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
            .map(k => String(k || '').trim())
            .flatMap(k => k.split(/\s+/))
            .filter(Boolean);
        if (keywords.length === 0) { return { ok: false, error: `${at}: 查询至少需要一个关键词` }; }
        if (keywords.length > TPL_MAX_KEYWORDS) { return { ok: false, error: `${at}: 关键词超过 ${TPL_MAX_KEYWORDS} 个` }; }
        for (const k of keywords) {
            if (k.length > TPL_MAX_KEYWORD_LEN) { return { ok: false, error: `${at}: 关键词超过 ${TPL_MAX_KEYWORD_LEN} 字符` }; }
        }
        return {
            ok: true,
            step: {
                type: type,
                keywords: keywords,
                hitPolicy: TPL_HIT_POLICIES[raw.hitPolicy] ? raw.hitPolicy : 'ask',
                onEmpty: TPL_EMPTY_POLICIES[raw.onEmpty] ? raw.onEmpty : 'stop',
                afterLastHit: raw.afterLastHit === true,
                sameThread: raw.sameThread === true
            }
        };
    }

    if (type === 'filter') {
        const field = raw.field;
        if (!TPL_FILTER_FIELDS[field]) {
            return { ok: false, error: `${at}: 筛选字段未知: ${field}` };
        }
        const keepKeyword = raw.keepKeyword !== false;
        if (field === 'levels') {
            const levels = (Array.isArray(raw.value) ? raw.value : [])
                .map(l => String(l || '').toUpperCase()).filter(l => TPL_LEVEL_TOKENS.includes(l));
            if (levels.length === 0) { return { ok: false, error: `${at}: 至少勾选一个日志级别` }; }
            return { ok: true, step: { type: type, field: field, value: levels, keepKeyword: keepKeyword } };
        }
        if (field === 'timeRange') {
            const v = (raw.value && typeof raw.value === 'object') ? raw.value : {};
            const start = String(v.start || '').trim();
            const end = String(v.end || '').trim();
            if (!start && !end) { return { ok: false, error: `${at}: 时间范围不能同时为空` }; }
            return { ok: true, step: { type: type, field: field, value: { start: start, end: end }, keepKeyword: keepKeyword } };
        }
        // threadName / className / methodName: 字面量(可含 ${param})或 'lastHit'
        const value = String(raw.value || '').trim();
        if (!value) { return { ok: false, error: `${at}: 筛选值不能为空` }; }
        if (value.length > TPL_MAX_KEYWORD_LEN) { return { ok: false, error: `${at}: 筛选值过长` }; }
        return { ok: true, step: { type: type, field: field, value: value, keepKeyword: keepKeyword } };
    }

    if (type === 'bookmark') {
        const target = raw.target === 'view' ? 'view' : 'hits';
        const name = String(raw.name || '').trim().slice(0, 200);
        return { ok: true, step: { type: type, target: target, name: name } };
    }

    if (type === 'comment') {
        const target = raw.target === 'view' ? 'view' : 'hits';
        const content = String(raw.content || '').trim().slice(0, 500);
        if (!content) { return { ok: false, error: `${at}: 注释内容不能为空` }; }
        return { ok: true, step: { type: type, target: target, content: content } };
    }

    return { ok: false, error: `${at}类型未知: ${type}` };
}

// ---------- 共享: 导入 / 导出 ----------

/** 生成导出 JSON(单个或多个模板统一走这个包装格式) */
function tplExportPayload(templates) {
    return JSON.stringify({
        schemaVersion: TPL_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        templates: templates
    }, null, 2);
}

/**
 * 把一段 JSON 文本导入模板库。
 * 只接受本扩展导出的格式: { schemaVersion, exportedAt, templates: [...] },
 * 其余形状(裸数组/单个对象/旧松散格式)一律拒绝。按 id 去重覆盖;非法条目跳过并计数。
 */
function importTemplatesFromText(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        showToast('导入失败: 内容不是合法的 JSON', 'error');
        return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Array.isArray(parsed.templates) || parsed.schemaVersion !== TPL_SCHEMA_VERSION) {
        showToast('导入失败: 只支持本扩展导出的模板 JSON 格式', 'error');
        return;
    }
    const list = parsed.templates;

    const store = loadInvestigationTemplates();
    let added = 0;
    let updated = 0;
    let invalid = 0;
    for (const raw of list) {
        const result = validateInvestigationTemplate(raw);
        if (!result.ok) { invalid++; continue; }
        const idx = store.findIndex(t => t.id === result.template.id);
        if (idx >= 0) { store[idx] = result.template; updated++; }
        else { store.push(result.template); added++; }
    }
    if (added + updated === 0) {
        showToast(`导入失败: 没有有效的模板` + (invalid ? `(无效条目 ${invalid} 个)` : ''), 'error');
        return;
    }
    if (saveInvestigationTemplates(store)) {
        renderTemplateList();
        showToast(`导入完成: 新增 ${added} · 更新 ${updated}` + (invalid ? ` · 跳过无效 ${invalid} 条` : ''));
    }
}

/** 宿主端选完文件回传内容(webview.js 的消息分发不感知本文件,这里自挂监听) */
window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.command === 'importTemplatesResult' && msg.data && typeof msg.data.content === 'string') {
        importTemplatesFromText(msg.data.content);
    }
});

// ---------- 剪贴板(写/读,失败降级为手动弹窗) ----------

async function tplCopyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        showTplCopyFallbackModal(text);
        return false;
    }
}

/** 剪贴板写入失败时的兜底: 弹出文本框让用户手动复制 */
function showTplCopyFallbackModal(text) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.style.maxWidth = '520px';
    dialog.style.width = '520px';
    const title = document.createElement('div');
    title.className = 'confirm-title';
    title.textContent = '请手动复制模板 JSON';
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'width: 100%; height: 200px; margin: 8px 0; font-family: monospace; font-size: 11px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);';
    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '选中全部';
    copyBtn.addEventListener('click', () => { area.focus(); area.select(); });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => { document.body.removeChild(overlay); });
    buttons.appendChild(copyBtn);
    buttons.appendChild(closeBtn);
    dialog.appendChild(title);
    dialog.appendChild(area);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

/** 读剪贴板;权限不可用时降级为粘贴弹窗,返回文本或 null(取消) */
async function tplReadClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) { return text; }
    } catch (e) { /* 走降级 */ }
    return await showTplPasteModal();
}

/** 粘贴弹窗: 返回 Promise<string|null> */
function showTplPasteModal() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'confirm-dialog';
        dialog.style.maxWidth = '520px';
        dialog.style.width = '520px';
        const title = document.createElement('div');
        title.className = 'confirm-title';
        title.textContent = '粘贴模板 JSON';
        const area = document.createElement('textarea');
        area.placeholder = '把模板 JSON 粘贴到这里…';
        area.style.cssText = 'width: 100%; height: 200px; margin: 8px 0; font-family: monospace; font-size: 11px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);';
        const buttons = document.createElement('div');
        buttons.className = 'confirm-buttons';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
        const okBtn = document.createElement('button');
        okBtn.textContent = '导入';
        okBtn.addEventListener('click', () => {
            const v = area.value;
            document.body.removeChild(overlay);
            resolve(v && v.trim() ? v : null);
        });
        buttons.appendChild(cancelBtn);
        buttons.appendChild(okBtn);
        dialog.appendChild(title);
        dialog.appendChild(area);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        area.focus();
    });
}

// ---------- 模板列表弹窗 ----------

function showTemplatesModal() {
    renderTemplateList();
    document.getElementById('templatesModal').style.display = 'block';
}

function closeTemplatesModal() {
    document.getElementById('templatesModal').style.display = 'none';
}

function renderTemplateList() {
    const container = document.getElementById('tplListContainer');
    const list = loadInvestigationTemplates();

    let html = '<div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">';
    html += '<button onclick="openTemplateEditor()"><i class="codicon codicon-add"></i> 新建模板</button>';
    html += '<button onclick="importTemplatesFromClipboard()"><i class="codicon codicon-clipboard"></i> 导入(剪贴板)</button>';
    html += '<button onclick="importTemplatesFromFile()"><i class="codicon codicon-folder-opened"></i> 导入(文件)</button>';
    html += '</div>';

    if (list.length === 0) {
        html += '<div style="text-align: center; color: var(--vscode-descriptionForeground); padding: 30px 0;">';
        html += '还没有排查模板。<br>点击「新建模板」创建第一个,把你的固定排查流程保存下来。';
        html += '</div>';
        container.innerHTML = html;
        return;
    }

    // 分组由模板派生(按首次出现顺序),不单独管理;空组随最后一个成员离开自动消失
    const groups = [];
    for (const t of list) {
        if (t.group && groups.indexOf(t.group) < 0) { groups.push(t.group); }
    }
    const ungroupedCount = list.reduce((n, t) => n + (t.group ? 0 : 1), 0);

    // 过滤状态失效(组被删光/未分组清空)时回落到「全部」,不展示空视图
    if (tplListGroupFilter !== 'all' && tplListGroupFilter !== '' &&
        groups.indexOf(tplListGroupFilter) < 0) {
        tplListGroupFilter = 'all';
    }
    if (tplListGroupFilter === '' && ungroupedCount === 0) { tplListGroupFilter = 'all'; }

    const shown = tplListGroupFilter === 'all'
        ? list
        : list.filter(t => (t.group || '') === tplListGroupFilter);

    html += '<div class="tplg-wrap">';
    html += '<div class="tplg-rail">';
    html += tplRenderRailItem('all', '全部', list.length, 'codicon-list-flat');
    for (const g of groups) {
        const cnt = list.reduce((n, t) => n + (t.group === g ? 1 : 0), 0);
        html += tplRenderRailItem(g, g, cnt, 'codicon-folder');
    }
    if (ungroupedCount > 0) {
        html += tplRenderRailItem('', '未分组', ungroupedCount, 'codicon-circle-large-outline');
    }
    html += '</div>';
    html += '<div class="tplg-list">';
    if (tplListGroupFilter !== 'all') {
        const label = tplListGroupFilter === '' ? '未分组' : tplListGroupFilter;
        html += `<div class="tplg-list-title">${escapeHtml(label)} · ${shown.length} 个模板</div>`;
    }
    for (const t of shown) {
        const meta = [];
        if (t.params.length > 0) { meta.push(`参数 ${t.params.length} 个`); }
        meta.push(`${t.steps.length} 个动作`);
        // 「全部」视图下卡片标注所属分组,避免混在一起认不出服务
        if (tplListGroupFilter === 'all' && t.group) { meta.push(`分组: ${t.group}`); }
        const flow = (t.steps || []).map(s => TPL_ACTION_TYPES[s.type] || s.type).join(' → ');
        html += '<div style="border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; margin-bottom: 8px;">';
        html += '<div style="display: flex; align-items: center; gap: 8px;">';
        html += '<div style="flex: 1; min-width: 0;">';
        html += `<div style="font-weight: bold;">${escapeHtml(t.name)}</div>`;
        if (t.description) {
            html += `<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">${escapeHtml(tplTruncate(t.description, 80))}</div>`;
        }
        html += `<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">${escapeHtml(meta.join(' · '))}</div>`;
        if (flow) {
            html += `<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">${escapeHtml(flow)}</div>`;
        }
        html += '</div>';
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="runInvestigationTemplate(${tplJsArg(t.id)})" title="运行模板"><i class="codicon codicon-play"></i> 运行</button>`;
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="openTemplateEditor(${tplJsArg(t.id)})" title="编辑模板"><i class="codicon codicon-edit"></i> 编辑</button>`;
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="tplToggleRowActions(${tplJsArg(t.id)})" title="更多操作"><i class="codicon codicon-ellipsis"></i></button>`;
        html += '</div>';
        html += `<div id="tplRowActions_${escapeAttr(t.id)}" style="display: none; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--vscode-panel-border); gap: 8px;">`;
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="duplicateTemplate(${tplJsArg(t.id)})"><i class="codicon codicon-copy"></i> 复制模板</button>`;
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="exportTemplateToClipboard(${tplJsArg(t.id)})"><i class="codicon codicon-clipboard"></i> 导出到剪贴板</button>`;
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="exportTemplateToFile(${tplJsArg(t.id)})"><i class="codicon codicon-save"></i> 导出为文件</button>`;
        html += `<button style="${TPL_SMALL_BTN_STYLE}" onclick="removeTemplateById(${tplJsArg(t.id)})"><i class="codicon codicon-trash"></i> 删除</button>`;
        html += '</div></div>';
    }
    html += '</div></div>';

    container.innerHTML = html;
}

/** 左侧分组导航的单个条目;key: 'all'=全部 / ''=未分组 / 分组名 */
function tplRenderRailItem(key, label, count, icon) {
    const active = tplListGroupFilter === key ? ' tplg-item-active' : '';
    return `<div class="tplg-item${active}" onclick="tplSetGroupFilter(${tplJsArg(key)})" title="${escapeAttr(label)}">` +
        `<i class="codicon ${icon}"></i>` +
        `<span class="tplg-name">${escapeHtml(label)}</span>` +
        `<span class="tplg-cnt">${count}</span></div>`;
}

function tplSetGroupFilter(key) {
    tplListGroupFilter = key;
    renderTemplateList();
}

/** 把动态字符串安全嵌入 onclick:JSON.stringify 防 JS 断言,escapeAttr 防 HTML 属性逃逸 */
function tplJsArg(value) {
    return escapeAttr(JSON.stringify(String(value)));
}

function tplToggleRowActions(id) {
    const el = document.getElementById('tplRowActions_' + id);
    if (el) { el.style.display = el.style.display === 'none' ? 'flex' : 'none'; }
}

// ---------- 列表行操作 ----------

function duplicateTemplate(id) {
    const store = loadInvestigationTemplates();
    const source = store.find(t => t.id === id);
    if (!source) { return; }
    const copy = validateInvestigationTemplate({
        ...source,
        id: 'tpl_' + Date.now(),
        name: source.name + ' 副本',
        createdAt: Date.now()
    });
    if (!copy.ok) { showToast('复制失败: ' + copy.error, 'error'); return; }
    store.push(copy.template);
    if (saveInvestigationTemplates(store)) {
        renderTemplateList();
        showToast('已复制模板');
    }
}

async function removeTemplateById(id) {
    const store = loadInvestigationTemplates();
    const target = store.find(t => t.id === id);
    if (!target) { return; }
    const yes = await showCustomConfirm(`确定删除模板「${target.name}」吗?`, '删除模板');
    if (!yes) { return; }
    saveInvestigationTemplates(store.filter(t => t.id !== id));
    renderTemplateList();
    showToast('模板已删除');
}

async function exportTemplateToClipboard(id) {
    const store = loadInvestigationTemplates();
    const target = store.find(t => t.id === id);
    if (!target) { return; }
    const ok = await tplCopyText(tplExportPayload([target]));
    if (ok) { showToast('模板 JSON 已复制到剪贴板,可直接粘贴分享'); }
}

function exportTemplateToFile(id) {
    const store = loadInvestigationTemplates();
    const target = store.find(t => t.id === id);
    if (!target) { return; }
    vscode.postMessage({ command: 'exportTemplates', templates: [target] });
}

function importTemplatesFromFile() {
    vscode.postMessage({ command: 'importTemplates' });
}

async function importTemplatesFromClipboard() {
    const text = await tplReadClipboard();
    if (!text) { return; }
    importTemplatesFromText(text);
}

// ---------- 模板编辑器 ----------

function openTemplateEditor(id) {
    if (id) {
        const source = loadInvestigationTemplates().find(t => t.id === id);
        if (!source) { return; }
        tplEditingTemplate = JSON.parse(JSON.stringify(source));
        tplExpandedStep = null;          // 已有模板默认全部收起,先"读"整条流程
    } else {
        tplEditingTemplate = {
            id: 'tpl_' + Date.now(),
            createdAt: Date.now(),
            name: '',
            description: '',
            group: (tplListGroupFilter !== 'all' && tplListGroupFilter !== '') ? tplListGroupFilter : '',
            params: [],
            steps: [{ type: 'search', keywords: [''], hitPolicy: 'ask', onEmpty: 'stop', afterLastHit: false, sameThread: false }]
        };
        tplExpandedStep = 0;             // 新模板直接展开第一步,从填关键词开始
    }
    tplEditorMode = 'visual';
    tplParamAdding = false;
    document.getElementById('tplEditorTitle').textContent = id ? '编辑排查模板' : '新建排查模板';
    renderTemplateEditor();
    closeTemplatesModal();
    document.getElementById('templateEditorModal').style.display = 'block';
}

function closeTemplateEditor() {
    tplRemoveCopyHooks();
    const bar = document.getElementById('tplEditorRestoreBar');
    if (bar) { bar.style.display = 'none'; }
    document.getElementById('templateEditorModal').style.display = 'none';
    tplEditingTemplate = null;
    tplExpandedStep = null;
    tplParamAdding = false;
}

// ---------- 编辑器收起/恢复(边看日志边填模板) ----------
//
// 痛点:编辑弹窗是全屏遮罩,编辑时无法选中/复制下面的日志内容。
// 方案:标题栏「─」收起编辑器为右上角悬浮条,日志视图恢复可交互;
// 用户复制日志(选中后 Ctrl+C,或右键「复制整行/复制选中内容」)时编辑器自动弹回,
// 直接粘贴即可。两条复制路径的感知方式不同:
//   - Ctrl+C 走原生 'copy' 事件
//   - 右键菜单复制走 copyToClipboard() -> Clipboard API(不触发原生 copy 事件),
//     因此 webview.js 的 copyToClipboard 手动派发 'tpl-log-copied' 自定义事件

let tplCopyEventListener = null;   // 原生 copy 事件监听
let tplCustomCopyListener = null;  // tpl-log-copied 自定义事件监听

function tplMinimizeEditor() {
    if (!tplEditingTemplate) { return; }
    document.getElementById('templateEditorModal').style.display = 'none';
    const bar = document.getElementById('tplEditorRestoreBar');
    if (bar) { bar.style.display = 'flex'; }
    tplArmCopyHooks();
    showToast('编辑器已收起:复制日志后会自动恢复,也可点右上角悬浮条手动恢复');
}

function tplRestoreEditor() {
    tplRemoveCopyHooks();
    const bar = document.getElementById('tplEditorRestoreBar');
    if (bar) { bar.style.display = 'none'; }
    if (tplEditingTemplate) {
        document.getElementById('templateEditorModal').style.display = 'block';
    }
}

function tplCloseFromRestoreBar() {
    tplRestoreEditor();
    closeTemplateEditor();
}

function tplArmCopyHooks() {
    tplRemoveCopyHooks();
    tplCopyEventListener = () => { tplRestoreEditor(); };
    tplCustomCopyListener = () => { tplRestoreEditor(); };
    document.addEventListener('copy', tplCopyEventListener, true);
    document.addEventListener('tpl-log-copied', tplCustomCopyListener, true);
}

function tplRemoveCopyHooks() {
    if (tplCopyEventListener) {
        document.removeEventListener('copy', tplCopyEventListener, true);
        tplCopyEventListener = null;
    }
    if (tplCustomCopyListener) {
        document.removeEventListener('tpl-log-copied', tplCustomCopyListener, true);
        tplCustomCopyListener = null;
    }
}

/** 整体渲染编辑器(打开/结构性变化/JSON 切回时调用;文本输入不触发重渲染) */
function renderTemplateEditor() {
    const t = tplEditingTemplate;
    const body = document.getElementById('tplEditorBody');
    let html = '';

    // —— 模板信息 ——
    html += '<div class="tpl-sec" id="tplEditorVisual">';
    html += '<div class="tpl-sec-label">模板信息</div>';
    html += `<div class="tpl-field"><label for="tplEditName">名称</label>`;
    html += `<input id="tplEditName" placeholder="例如: 支付回调失败排查" value="${escapeAttr(t.name || '')}" style="${TPL_INPUT_STYLE}"></div>`;
    html += `<div class="tpl-field"><label for="tplEditGroup">分组 <span style="color: var(--vscode-descriptionForeground); font-weight: normal;">(可选,留空 = 未分组)</span></label>`;
    html += `<input id="tplEditGroup" list="tplGroupSuggestions" placeholder="例如: 支付服务" value="${escapeAttr(t.group || '')}" style="${TPL_INPUT_STYLE}">`;
    html += `<datalist id="tplGroupSuggestions">`;
    const seenGroups = [];
    for (const t2 of loadInvestigationTemplates()) {
        if (t2.group && t2.group !== t.group && seenGroups.indexOf(t2.group) < 0) { seenGroups.push(t2.group); }
    }
    for (const g of seenGroups) { html += `<option value="${escapeAttr(g)}"></option>`; }
    html += `</datalist></div>`;
    html += `<div class="tpl-field"><label for="tplEditDesc">描述 <span style="color: var(--vscode-descriptionForeground); font-weight: normal;">(可选)</span></label>`;
    html += `<input id="tplEditDesc" placeholder="这个模板用来排查什么问题" value="${escapeAttr(t.description || '')}" style="${TPL_INPUT_STYLE}"></div>`;
    html += `<div class="tpl-field"><label>运行参数 <span style="color: var(--vscode-descriptionForeground); font-weight: normal;">(可选)</span> <button type="button" onclick="tplBeginAddParam()" style="background: transparent; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 0;">＋ 添加参数</button></label>`;
    html += '<div id="tplEditParams"></div>';
    html += `<div class="hint" style="margin-top: 5px;">动作配置里用 <code class="tpl-mono">\${参数名}</code> 引用运行时输入的值——点参数芯片可直接插入到光标处,同一套流程,换个单号就能重跑。</div>`;
    html += '</div></div>';

    // —— 排查流程(流水线轨道) ——
    html += '<div class="tpl-sec" id="tplStepsSec">';
    html += '<div class="tpl-sec-label">排查流程 <span class="tpl-sec-sub">自上而下依次执行</span></div>';
    html += '<div id="tplEditSteps" class="tpl-steps"></div>';
    html += '<div class="tpl-add-row">';
    html += '<button type="button" onclick="tplAddStep(\'search\')">＋ 查询日志</button>';
    html += '<button type="button" onclick="tplAddStep(\'filter\')">＋ 筛选</button>';
    html += '<button type="button" onclick="tplAddStep(\'bookmark\')">＋ 打书签</button>';
    html += '<button type="button" onclick="tplAddStep(\'comment\')">＋ 加注释</button>';
    html += '</div></div>';

    // —— JSON 面板(高级逃生门,默认隐藏) ——
    html += '<div id="tplEditorJson" style="display: none;">';
    html += '<textarea id="tplEditJson" rows="18" spellcheck="false" style="width: 100%; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; box-sizing: border-box;"></textarea>';
    html += '<div id="tplJsonError" style="display: none; color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px;"></div>';
    html += '<div class="hint" style="margin-top: 5px;">格式与导入/导出完全一致。改完点下方「返回表单编辑」或直接保存。</div>';
    html += '</div>';

    html += '<div id="tplEditorError" style="display: none; color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px;"></div>';

    body.innerHTML = html;
    renderTplParams();
    renderTplSteps();
    tplSyncEditorTabs();
    tplHideEditorError();
}

/** 参数以芯片形式展示,新增走内联小表单;参数数据直接落在 tplEditingTemplate.params */
function renderTplParams() {
    const container = document.getElementById('tplEditParams');
    if (!container) { return; }
    const params = (tplEditingTemplate && Array.isArray(tplEditingTemplate.params)) ? tplEditingTemplate.params : [];
    let html = '';
    params.forEach((p, i) => {
        html += '<span class="tpl-param-chip">';
        html += `<code class="tpl-param-insert" title="点击插入到下方输入框光标处" onclick="tplInsertParam(${tplJsArg(p.key)})">${escapeHtml('${' + p.key + '}')}</code>`;
        if (p.label && p.label !== p.key) { html += `<small>${escapeHtml(p.label)}</small>`; }
        html += `<button type="button" title="删除参数" onclick="tplRemoveParam(${i})">×</button>`;
        html += '</span>';
    });
    if (tplParamAdding) {
        html += '<div class="tpl-param-add-form">';
        html += `<input id="tplNewParamKey" placeholder="参数名,如 orderNo" style="${TPL_INPUT_STYLE} width: 170px;" onkeydown="if(event.key==='Enter'){tplConfirmAddParam();}">`;
        html += `<input id="tplNewParamLabel" placeholder="显示名(可选),如 业务单号" style="${TPL_INPUT_STYLE} width: 170px;" onkeydown="if(event.key==='Enter'){tplConfirmAddParam();}">`;
        html += `<button type="button" style="${TPL_SMALL_BTN_STYLE}" onclick="tplConfirmAddParam()">确定</button>`;
        html += `<button type="button" style="${TPL_SMALL_BTN_STYLE}" onclick="tplCancelAddParam()">取消</button>`;
        html += '</div>';
    }
    if (params.length === 0 && !tplParamAdding) {
        html += '<div class="hint">点上方「＋ 添加参数」——比如定义一个 orderNo,每次运行填不同单号。</div>';
    }
    container.innerHTML = html;
    if (tplParamAdding) {
        const keyEl = document.getElementById('tplNewParamKey');
        if (keyEl) { keyEl.focus(); }
    }
}

function tplBeginAddParam() {
    tplParamAdding = true;
    renderTplParams();
}

function tplCancelAddParam() {
    tplParamAdding = false;
    renderTplParams();
}

function tplConfirmAddParam() {
    const keyEl = document.getElementById('tplNewParamKey');
    const labelEl = document.getElementById('tplNewParamLabel');
    const key = (keyEl ? keyEl.value : '').trim();
    const label = (labelEl ? labelEl.value : '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        showToast('参数名不合法: 字母开头,仅含字母数字下划线', 'error');
        return;
    }
    const params = (tplEditingTemplate && tplEditingTemplate.params) || [];
    if (params.some(p => p.key === key)) { showToast(`参数名重复: ${key}`, 'error'); return; }
    if (params.length >= TPL_MAX_PARAMS) { showToast(`参数最多 ${TPL_MAX_PARAMS} 个`, 'error'); return; }
    tplEditingTemplate.params = params.concat([{ key: key, label: label || key }]);
    tplParamAdding = false;
    renderTplParams();
}

function tplRemoveParam(i) {
    if (!tplEditingTemplate) { return; }
    tplEditingTemplate.params.splice(i, 1);
    renderTplParams();
}

// 记录编辑器里最后聚焦的动作输入框/JSON 文本域,供参数芯片点击插入。
// 模板名称/描述、运行弹窗等其余输入框不记录——${参数} 只在动作配置里有意义。
document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) { return; }
    if (t.type === 'checkbox' || t.type === 'radio') { return; }
    tplLastParamTarget = (t.id === 'tplEditJson' || (t.closest && t.closest('#tplEditSteps'))) ? t : null;
});

/**
 * 参数芯片点击:把 ${key} 插入最后聚焦的动作输入框光标处;
 * 没有正在编辑的动作输入框时退化为复制到剪贴板。
 */
async function tplInsertParam(key) {
    const token = '${' + key + '}';
    const el = tplLastParamTarget;
    if (el && document.contains(el) && !el.disabled && !el.readOnly) {
        const pos = (typeof el.selectionStart === 'number') ? el.selectionStart : el.value.length;
        const end = (typeof el.selectionEnd === 'number') ? el.selectionEnd : pos;
        el.value = el.value.slice(0, pos) + token + el.value.slice(end);
        el.focus();
        try { el.setSelectionRange(pos + token.length, pos + token.length); } catch (e) { /* 该类型控件不支持选区,忽略 */ }
        return;
    }
    const ok = await tplCopyText(token);
    if (ok) { showToast(`已复制 ${token},粘贴到要用的输入框即可`); }
}

function renderTplSteps() {
    const container = document.getElementById('tplEditSteps');
    if (!container) { return; }
    const steps = (tplEditingTemplate && Array.isArray(tplEditingTemplate.steps)) ? tplEditingTemplate.steps : [];
    if (steps.length === 0) {
        container.innerHTML = '<div class="tpl-empty">还没有步骤——从下面选一个动作,开始编排你的排查流程。</div>';
        return;
    }
    container.innerHTML = steps.map((step, i) => renderTplStepCard(step, i)).join('');
}

/** 生成步骤的一句可读摘要(收起状态展示,让整条流程可"读") */
function tplStepSummary(step) {
    const parts = [];
    if (step.type === 'search') {
        const kw = (Array.isArray(step.keywords) ? step.keywords : []).join(' ');
        parts.push(`查询含「${kw || '…'}」的日志`);
        const cons = [];
        if (step.afterLastHit === true) { cons.push('上一步命中之后'); }
        if (step.sameThread === true) { cons.push('仅同线程'); }
        if (cons.length > 0) { parts.push(cons.join(' + ')); }
        parts.push(TPL_HIT_POLICIES[step.hitPolicy] || TPL_HIT_POLICIES.ask);
    } else if (step.type === 'filter') {
        const fieldName = TPL_FILTER_FIELDS[step.field] || step.field;
        if (step.value === 'lastHit') {
            parts.push(`按${fieldName}筛选 · 从上一步命中行提取`);
        } else if (step.field === 'levels') {
            parts.push(`按日志级别筛选: ${(Array.isArray(step.value) ? step.value : []).join('/')}`);
        } else if (step.field === 'timeRange' && step.value && typeof step.value === 'object') {
            parts.push(`按时间范围筛选: ${step.value.start || '…'} ~ ${step.value.end || '…'}`);
        } else {
            parts.push(`按${fieldName}「${step.value || '…'}」`);
        }
        if (step.keepKeyword === false) { parts.push('不保留关键词'); }
    } else if (step.type === 'bookmark') {
        parts.push(`给${step.target === 'view' ? '当前视图' : '查询结果'}打书签${step.name ? `「${step.name}」` : ''}`);
    } else if (step.type === 'comment') {
        parts.push(`给${step.target === 'view' ? '当前视图' : '查询结果'}加注释${step.content ? `「${tplTruncate(step.content, 30)}」` : ''}`);
    }
    return parts.join(' · ');
}

function renderTplStepCard(step, i) {
    const typeName = TPL_ACTION_TYPES[step.type] || step.type;
    const open = tplExpandedStep === i;
    const num = String(i + 1).padStart(2, '0');
    let html = `<div class="tpl-step${open ? ' tpl-open' : ''}">`;
    html += `<span class="tpl-step-num">${num}</span>`;
    html += `<div class="tpl-step-head"${open ? '' : ` onclick="tplToggleStep(${i})" title="点击展开编辑"`}>`;
    html += `<span class="tpl-step-title">${escapeHtml(typeName)}</span>`;
    if (!open) {
        html += `<span class="tpl-step-summary">${escapeHtml(tplStepSummary(step))}</span>`;
    }
    html += '<span class="tpl-step-tools">';
    html += `<button type="button" style="${TPL_SMALL_BTN_STYLE}" title="上移" onclick="event.stopPropagation(); tplMoveStep(${i}, -1)">↑</button>`;
    html += `<button type="button" style="${TPL_SMALL_BTN_STYLE}" title="下移" onclick="event.stopPropagation(); tplMoveStep(${i}, 1)">↓</button>`;
    html += `<button type="button" style="${TPL_SMALL_BTN_STYLE}" title="删除动作" onclick="event.stopPropagation(); tplDeleteStep(${i})">×</button>`;
    html += '</span></div>';
    if (open) {
        html += `<div class="tpl-step-body">${renderTplStepFields(step, i)}</div>`;
    }
    html += '</div>';
    return html;
}

/**
 * 把当前展开步骤的表单值写回状态。
 * 收起态的步骤不在 DOM 里,其数据以 tplEditingTemplate.steps 为准。
 */
function tplCommitExpandedStep() {
    if (tplExpandedStep == null || !tplEditingTemplate) { return; }
    const step = tplEditingTemplate.steps[tplExpandedStep];
    if (!step) { tplExpandedStep = null; return; }
    const fields = collectTplStepFields(step.type, tplExpandedStep);
    tplEditingTemplate.steps[tplExpandedStep] = Object.assign({}, step, fields);
}

function tplToggleStep(i) {
    tplCommitExpandedStep();
    tplExpandedStep = (tplExpandedStep === i) ? null : i;
    renderTplSteps();
}

function renderTplStepFields(step, i) {
    const p = i; // 简化引用
    let html = '';

    if (step.type === 'search') {
        const keywords = Array.isArray(step.keywords) ? step.keywords.join(' ') : '';
        const hitPolicy = TPL_HIT_POLICIES[step.hitPolicy] ? step.hitPolicy : 'ask';
        const onEmpty = TPL_EMPTY_POLICIES[step.onEmpty] ? step.onEmpty : 'stop';
        const afterLastHit = step.afterLastHit === true;
        const sameThread = step.sameThread === true;
        html += `<div style="margin-bottom: 10px;"><label style="${TPL_LABEL_STYLE}">关键词(空格分隔,支持 \${参数}):</label>`;
        html += `<input id="tplStep_${p}_keywords" value="${escapeAttr(keywords)}" placeholder="例如: 支付回调失败 \${orderNo}" style="${TPL_INPUT_STYLE}"></div>`;
        html += '<div style="display: flex; gap: 10px;">';
        html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">命中多条时:</label>`;
        html += `<select id="tplStep_${p}_hitPolicy" style="${TPL_INPUT_STYLE}">${tplSelectOptions(TPL_HIT_POLICIES, hitPolicy)}</select></div>`;
        html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">0 条命中时:</label>`;
        html += `<select id="tplStep_${p}_onEmpty" style="${TPL_INPUT_STYLE}">${tplSelectOptions(TPL_EMPTY_POLICIES, onEmpty)}</select></div>`;
        html += '</div>';
        html += '<div style="display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; font-size: 12px;">';
        html += `<label style="display: flex; align-items: center; gap: 5px; cursor: pointer;"><input type="checkbox" id="tplStep_${p}_afterLastHit"${afterLastHit ? ' checked' : ''}> 从上一步命中之后开始查</label>`;
        html += `<label style="display: flex; align-items: center; gap: 5px; cursor: pointer;"><input type="checkbox" id="tplStep_${p}_sameThread"${sameThread ? ' checked' : ''}> 仅同线程日志</label>`;
        html += '</div>';
        html += '<div class="hint" style="margin-top: 5px;">两个勾选项都基于上一步查询的命中行(「保留全部」时以最后一条为基准);配合「自动选第一条」即可实现「找上一条日志之后的下一处匹配」。</div>';
        return html;
    }

    if (step.type === 'filter') {
        const field = TPL_FILTER_FIELDS[step.field] ? step.field : 'threadName';
        const keep = step.keepKeyword !== false;
        html += '<div style="display: flex; gap: 10px; margin-bottom: 10px;">';
        html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">筛选字段:</label>`;
        html += `<select id="tplStep_${p}_field" onchange="tplStepFieldChanged(${p})" style="${TPL_INPUT_STYLE}">`;
        for (const [key, label] of Object.entries(TPL_FILTER_FIELDS)) {
            html += `<option value="${key}"${key === field ? ' selected' : ''}>${label}</option>`;
        }
        html += '</select></div>';
        html += `<div style="flex: 1; display: flex; align-items: flex-end; padding-bottom: 7px;"><label style="font-size: 12px; display: flex; align-items: center; gap: 5px; cursor: pointer;">`;
        html += `<input type="checkbox" id="tplStep_${p}_keepKeyword"${keep ? ' checked' : ''}> 保留关键词叠加</label></div>`;
        html += '</div>';
        html += `<div id="tplStep_${p}_valueArea">${renderTplFilterValueArea(field, step.value, p)}</div>`;
        return html;
    }

    if (step.type === 'bookmark' || step.type === 'comment') {
        const target = step.target === 'view' ? 'view' : 'hits';
        const targetOpts = { hits: '本次查询的命中结果', view: '当前视图的全部日志' };
        if (step.type === 'bookmark') {
            html += '<div style="display: flex; gap: 10px;">';
            html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">打书签对象:</label>`;
            html += `<select id="tplStep_${p}_target" style="${TPL_INPUT_STYLE}">${tplSelectOptions(targetOpts, target)}</select></div>`;
            html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">书签名称(可选,支持 \${参数}):</label>`;
            html += `<input id="tplStep_${p}_name" value="${escapeAttr(step.name || '')}" placeholder="默认「行 N」" style="${TPL_INPUT_STYLE}"></div>`;
            html += '</div>';
        } else {
            html += `<div style="margin-bottom: 10px;"><label style="${TPL_LABEL_STYLE}">注释对象:</label>`;
            html += `<select id="tplStep_${p}_target" style="${TPL_INPUT_STYLE}">${tplSelectOptions(targetOpts, target)}</select></div>`;
            html += `<div><label style="${TPL_LABEL_STYLE}">注释内容(支持 \${参数}):</label>`;
            html += `<input id="tplStep_${p}_content" value="${escapeAttr(step.content || '')}" placeholder="例如: 订单 \${orderNo} 回调异常现场" style="${TPL_INPUT_STYLE}"></div>`;
        }
        return html;
    }

    return html;
}

/** 筛选动作的值区域(按字段类型渲染不同控件) */
function renderTplFilterValueArea(field, value, p) {
    if (field === 'levels') {
        const selected = Array.isArray(value) ? value.map(l => String(l).toUpperCase()) : [];
        let html = '<div style="display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; padding: 2px 0;">';
        for (const token of TPL_LEVEL_TOKENS) {
            const checked = selected.includes(token);
            html += `<label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">`;
            html += `<input type="checkbox" name="tplStep_${p}_level" value="${token}"${checked ? ' checked' : ''}> ${TPL_LEVEL_LABELS[token]}</label>`;
        }
        html += '</div>';
        return html;
    }
    if (field === 'timeRange') {
        const v = (value && typeof value === 'object') ? value : {};
        let html = '<div style="display: flex; gap: 10px;">';
        html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">开始时间:</label>`;
        html += `<input id="tplStep_${p}_start" value="${escapeAttr(v.start || '')}" placeholder="2024-01-01 10:00:00(可空)" style="${TPL_INPUT_STYLE}"></div>`;
        html += `<div style="flex: 1;"><label style="${TPL_LABEL_STYLE}">结束时间:</label>`;
        html += `<input id="tplStep_${p}_end" value="${escapeAttr(v.end || '')}" placeholder="2024-01-01 18:00:00(可空)" style="${TPL_INPUT_STYLE}"></div>`;
        html += '</div>';
        return html;
    }
    const v = typeof value === 'string' ? value : '';
    let html = `<input id="tplStep_${p}_value" value="${escapeAttr(v)}" style="${TPL_INPUT_STYLE}">`;
    html += '<div class="hint" style="margin-top: 5px;">固定值、\${参数} 均可;填 <code>lastHit</code> 表示从上一步命中的日志行自动提取。</div>';
    return html;
}

function tplSelectOptions(options, selected) {
    let html = '';
    for (const [key, label] of Object.entries(options)) {
        html += `<option value="${key}"${key === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }
    return html;
}

// ---------- 编辑器结构操作(先提交展开中的表单值,再变更状态,再重渲染) ----------

function tplAddStep(type) {
    tplCommitExpandedStep();
    const steps = tplEditingTemplate.steps;
    if (steps.length >= TPL_MAX_STEPS) { showToast(`动作最多 ${TPL_MAX_STEPS} 个`, 'error'); return; }
    steps.push(tplDefaultStep(type));
    tplExpandedStep = steps.length - 1;
    renderTplSteps();
    const openCard = document.querySelector('#tplEditSteps .tpl-open');
    if (openCard && openCard.scrollIntoView) { openCard.scrollIntoView({ block: 'nearest' }); }
}

function tplDeleteStep(i) {
    tplCommitExpandedStep();
    tplEditingTemplate.steps.splice(i, 1);
    if (tplExpandedStep === i) { tplExpandedStep = null; }
    else if (tplExpandedStep != null && tplExpandedStep > i) { tplExpandedStep--; }
    renderTplSteps();
}

function tplMoveStep(i, delta) {
    tplCommitExpandedStep();
    const steps = tplEditingTemplate.steps;
    const j = i + delta;
    if (j < 0 || j >= steps.length) { return; }
    const tmp = steps[i];
    steps[i] = steps[j];
    steps[j] = tmp;
    if (tplExpandedStep === i) { tplExpandedStep = j; }
    else if (tplExpandedStep === j) { tplExpandedStep = i; }
    renderTplSteps();
}

/** 筛选字段变化时,重绘该动作的表单(收集-变更-重渲染,保持展开) */
function tplStepFieldChanged(i) {
    tplCommitExpandedStep();
    renderTplSteps();
}

function tplDefaultStep(type) {
    switch (type) {
        case 'search': return { type: 'search', keywords: [''], hitPolicy: 'ask', onEmpty: 'stop', afterLastHit: false, sameThread: false };
        case 'filter': return { type: 'filter', field: 'threadName', value: 'lastHit', keepKeyword: true };
        case 'bookmark': return { type: 'bookmark', target: 'hits', name: '' };
        case 'comment': return { type: 'comment', target: 'hits', content: '' };
        default: return { type: 'search', keywords: [''], hitPolicy: 'ask', onEmpty: 'stop', afterLastHit: false, sameThread: false };
    }
}

/** 汇总当前模板的原始对象(不校验):名称/描述读输入框,参数与步骤读状态 */
function collectVisualTemplate() {
    tplCommitExpandedStep();
    const t = tplEditingTemplate || { id: 'tpl_' + Date.now(), createdAt: Date.now() };
    const nameEl = document.getElementById('tplEditName');
    const descEl = document.getElementById('tplEditDesc');
    const groupEl = document.getElementById('tplEditGroup');
    return {
        id: t.id,
        createdAt: t.createdAt,
        name: nameEl ? nameEl.value : (t.name || ''),
        description: descEl ? descEl.value : (t.description || ''),
        group: groupEl ? groupEl.value : (t.group || ''),
        params: (t.params || []).map(p => ({ key: p.key, label: p.label })),
        steps: JSON.parse(JSON.stringify(t.steps || []))
    };
}

function collectTplStepFields(type, i) {
    const val = (id) => {
        const el = document.getElementById(`tplStep_${i}_${id}`);
        return el ? el.value : '';
    };
    if (type === 'search') {
        const keywords = val('keywords').trim().split(/\s+/).filter(Boolean);
        const afterEl = document.getElementById(`tplStep_${i}_afterLastHit`);
        const threadEl = document.getElementById(`tplStep_${i}_sameThread`);
        return {
            type: type,
            keywords: keywords,
            hitPolicy: val('hitPolicy') || 'ask',
            onEmpty: val('onEmpty') || 'stop',
            afterLastHit: afterEl ? afterEl.checked === true : false,
            sameThread: threadEl ? threadEl.checked === true : false
        };
    }
    if (type === 'filter') {
        const field = val('field') || 'threadName';
        const keepEl = document.getElementById(`tplStep_${i}_keepKeyword`);
        const keepKeyword = keepEl ? keepEl.checked : true;
        if (field === 'levels') {
            const levels = [];
            document.querySelectorAll(`input[name="tplStep_${i}_level"]:checked`).forEach(cb => {
                levels.push(cb.value);
            });
            return { type: type, field: field, value: levels, keepKeyword: keepKeyword };
        }
        if (field === 'timeRange') {
            return {
                type: type, field: field, keepKeyword: keepKeyword,
                value: { start: val('start').trim(), end: val('end').trim() }
            };
        }
        return { type: type, field: field, value: val('value').trim(), keepKeyword: keepKeyword };
    }
    if (type === 'bookmark') {
        return { type: type, target: val('target') || 'hits', name: val('name').trim() };
    }
    if (type === 'comment') {
        return { type: type, target: val('target') || 'hits', content: val('content').trim() };
    }

    return { type: type };
}

// ---------- 编辑器视图切换: 表单 / JSON(高级逃生门,入口在页脚链接) ----------

function tplSwitchEditorMode(mode) {
    if (mode === tplEditorMode) { return; }
    if (mode === 'json') {
        // 表单 -> JSON: 序列化当前状态(收集失败也允许,让用户在 JSON 里修)
        const raw = collectVisualTemplate();
        document.getElementById('tplEditJson').value = JSON.stringify({
            name: raw.name, description: raw.description, group: raw.group, params: raw.params, steps: raw.steps
        }, null, 2);
        tplHideEditorError();
        tplEditorMode = 'json';
    } else {
        // JSON -> 表单: 解析 + 白名单校验都通过才切换,失败留在 JSON 并标错
        const text = document.getElementById('tplEditJson').value;
        try {
            const parsed = JSON.parse(text);
            const merged = Object.assign({}, tplEditingTemplate, parsed);
            const result = validateInvestigationTemplate(merged);
            if (!result.ok) {
                tplShowJsonError('模板校验失败: ' + result.error);
                return;
            }
            tplEditingTemplate = result.template;
            tplExpandedStep = null;
            tplParamAdding = false;
            tplEditorMode = 'visual';
            renderTemplateEditor();
        } catch (e) {
            tplShowJsonError('JSON 解析失败: ' + e.message);
            return;
        }
    }
    tplSyncEditorTabs();
}

function tplSyncEditorTabs() {
    const json = tplEditorMode === 'json';
    const visual = document.getElementById('tplEditorVisual');
    const stepsSec = document.getElementById('tplStepsSec');
    const panel = document.getElementById('tplEditorJson');
    if (visual) { visual.style.display = json ? 'none' : 'block'; }
    if (stepsSec) { stepsSec.style.display = json ? 'none' : 'block'; }
    if (panel) { panel.style.display = json ? 'block' : 'none'; }
    const btn = document.getElementById('tplJsonToggle');
    if (btn) { btn.textContent = json ? '返回表单编辑' : '以 JSON 编辑'; }
}

function tplShowJsonError(msg) {
    const el = document.getElementById('tplJsonError');
    el.textContent = msg;
    el.style.display = 'block';
}

function tplHideEditorError() {
    const el = document.getElementById('tplEditorError');
    el.style.display = 'none';
    el.textContent = '';
    const jsonEl = document.getElementById('tplJsonError');
    jsonEl.style.display = 'none';
    jsonEl.textContent = '';
}

function saveTemplateFromEditor() {
    tplHideEditorError();
    let raw = null;
    if (tplEditorMode === 'json') {
        const text = document.getElementById('tplEditJson').value;
        try {
            raw = JSON.parse(text);
        } catch (e) {
            tplShowJsonError('JSON 解析失败: ' + e.message);
            return;
        }
    } else {
        raw = collectVisualTemplate();
    }
    const result = validateInvestigationTemplate({
        id: tplEditingTemplate.id,
        createdAt: tplEditingTemplate.createdAt,
        name: raw.name,
        description: raw.description,
        group: raw.group,
        params: raw.params,
        steps: raw.steps
    });
    if (!result.ok) {
        if (tplEditorMode === 'json') {
            tplShowJsonError('模板校验失败: ' + result.error);
        } else {
            showToast('保存失败: ' + result.error, 'error');
        }
        return;
    }
    const store = loadInvestigationTemplates();
    const idx = store.findIndex(t => t.id === result.template.id);
    if (idx >= 0) { store[idx] = result.template; }
    else { store.push(result.template); }
    if (saveInvestigationTemplates(store)) {
        closeTemplateEditor();
        renderTemplateList();
        showToast('排查模板已保存');
    }
}

// ---------- 运行模板 ----------

function runInvestigationTemplate(id) {
    if (tplPipelineRunning) {
        showToast('已有模板正在运行,请先等待完成或点击停止', 'error');
        return;
    }
    if (!allDataLoaded) {
        showToast('日志尚未完全加载,请等待加载完成后再运行模板', 'error');
        return;
    }
    const template = loadInvestigationTemplates().find(t => t.id === id);
    if (!template) { return; }
    closeTemplatesModal();
    openRunModal(template);
}

function openRunModal(template) {
    tplRunningTemplate = template;
    const container = document.getElementById('tplRunContainer');
    let html = `<div style="margin-bottom: 10px;"><strong>${escapeHtml(template.name)}</strong>`;
    if (template.description) {
        html += `<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">${escapeHtml(template.description)}</div>`;
    }
    html += `<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">共 ${template.steps.length} 个动作</div></div>`;

    html += '<div id="tplRunForm">';
    if (template.params.length > 0) {
        for (const p of template.params) {
            html += `<div class="form-group"><label for="tplRunParam_${escapeAttr(p.key)}">${escapeHtml(p.label || p.key)}</label>`;
            html += `<input id="tplRunParam_${escapeAttr(p.key)}" placeholder="\${${escapeAttr(p.key)}}" style="${TPL_INPUT_STYLE}"></div>`;
        }
    } else {
        html += '<div class="hint">该模板没有运行参数,点击「开始执行」直接运行。</div>';
    }
    html += '<div class="modal-footer" style="padding: 10px 0 0;">';
    html += '<button onclick="closeRunModal()">取消</button>';
    html += `<button onclick="startPipelineFromRunModal()"><i class="codicon codicon-play"></i> 开始执行</button>`;
    html += '</div></div>';

    html += '<div id="tplRunProgressArea" style="display: none;">';
    html += '<div id="tplRunStatusText" style="margin-bottom: 10px; font-size: 12px;"></div>';
    html += '<div class="modal-footer" style="padding: 0;">';
    html += '<button id="tplRunStopBtn" onclick="stopPipeline()"><i class="codicon codicon-debug-stop"></i> 停止</button>';
    html += '</div></div>';

    html += '<div id="tplRunSummaryArea" style="display: none;"></div>';
    container.innerHTML = html;
    document.getElementById('templateRunModal').style.display = 'block';
}

function closeRunModal() {
    if (tplPipelineRunning) { stopPipeline(); }
    document.getElementById('templateRunModal').style.display = 'none';
    tplRunningTemplate = null;
}

function startPipelineFromRunModal() {
    const template = tplRunningTemplate;
    if (!template || tplPipelineRunning) { return; }
    const paramValues = {};
    for (const p of template.params) {
        const el = document.getElementById('tplRunParam_' + p.key);
        paramValues[p.key] = el ? el.value.trim() : '';
    }
    executePipeline(template, paramValues);
}

function stopPipeline() {
    if (tplPipelineRunning) { tplPipelineAbort = true; }
    const btn = document.getElementById('tplRunStopBtn');
    if (btn) { btn.disabled = true; btn.textContent = '正在停止…'; }
}

// ---------- 动作流水线引擎 ----------

/** 流程控制异常: stop=业务性终止(如 0 命中), abort=用户主动终止 */
function tplFlowStop() { return { __tplFlow: true, reason: 'stop' }; }
function tplFlowAbort() { return { __tplFlow: true, reason: 'abort' }; }

/**
 * 把统一过滤系统的当前状态同步到界面控件,让模板过滤后的界面表达
 * 与手动操作完全一致(设计文档决策 14):
 *   - 关键词回显到搜索框、正则勾选归位
 *   - 日志级别过滤同步到级别勾选框(全选框联动)
 * 具体筛了什么由这些原有控件表达,不再统一覆盖成模板名。
 */
function tplSyncFilterUi() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) { searchInput.value = unifiedFilters.keyword || ''; }
    const regexEl = document.getElementById('regexMode');
    if (regexEl) { regexEl.checked = unifiedFilters.isRegex === true; }
    const tokens = { filterError: 'ERROR', filterWarn: 'WARN', filterInfo: 'INFO', filterDebug: 'DEBUG', filterOther: 'OTHER' };
    const active = Array.isArray(unifiedFilters.levels) ? unifiedFilters.levels.map(l => String(l).toUpperCase()) : null;
    let all = true;
    for (const id of Object.keys(tokens)) {
        const el = document.getElementById(id);
        if (!el) { continue; }
        el.checked = !active || active.includes(tokens[id]);
        if (!el.checked) { all = false; }
    }
    const allEl = document.getElementById('filterAll');
    if (allEl) { allEl.checked = all; }
}

async function executePipeline(template, paramValues) {
    tplPipelineRunning = true;
    tplPipelineAbort = false;
    const context = { hits: [], lastHit: null, lastThread: '' };
    const summary = {
        bookmarks: 0, comments: 0, thread: '', jumpLine: 0,
        filtered: false, warnings: [], stopped: false
    };

    // 切换到进度视图
    document.getElementById('tplRunForm').style.display = 'none';
    document.getElementById('tplRunSummaryArea').style.display = 'none';
    document.getElementById('tplRunProgressArea').style.display = 'block';
    const stopBtn = document.getElementById('tplRunStopBtn');
    if (stopBtn) { stopBtn.disabled = false; stopBtn.innerHTML = '<i class="codicon codicon-debug-stop"></i> 停止'; }

    try {
        for (let i = 0; i < template.steps.length; i++) {
            if (tplPipelineAbort) { summary.stopped = true; break; }
            setRunProgress(i, template.steps.length, template.steps[i]);
            // 让出 UI 帧,长流水线不卡界面
            await new Promise(r => setTimeout(r, 0));
            await executeTplStep(template.steps[i], i, paramValues, context, summary);
        }
    } catch (e) {
        if (e && e.__tplFlow) {
            summary.stopped = true;
        } else {
            summary.warnings.push('执行出错: ' + (e && e.message ? e.message : String(e)));
            console.error('[排查模板] 执行异常:', e);
        }
    }
    tplPipelineRunning = false;
    finishPipeline(summary);
}

function setRunProgress(index, total, step) {
    const el = document.getElementById('tplRunStatusText');
    if (el) {
        el.textContent = `步骤 ${index + 1}/${total}: ${TPL_ACTION_TYPES[step.type] || step.type}…`;
    }
}

/** 执行单个动作。控制流用异常表达: 命中列表「终止」抛 abort,0 命中 stop 策略抛 stop。 */
async function executeTplStep(step, index, paramValues, context, summary) {
    const at = `步骤 ${index + 1}`;

    if (step.type === 'search') {
        const words = step.keywords.map(k => resolveTplString(k, paramValues)).map(w => w.trim()).filter(Boolean);
        if (words.length === 0) {
            return tplHandleEmpty(step, summary, at, '关键词全部为空');
        }
        // 范围/线程约束(依赖上一步选中的命中行;无法满足时走 onEmpty 策略)
        let afterLine = 0;              // 严格大于该行号
        let threadLower = null;         // 小写线程名(用于匹配)
        let threadOriginal = null;      // 原始大小写(用于视图筛选显示)
        if (step.afterLastHit || step.sameThread) {
            if (!context.lastHit) {
                return tplHandleEmpty(step, summary, at, '配置了「从上一步命中后开始查/仅同线程」,但前面没有选中的命中行');
            }
            if (step.afterLastHit) { afterLine = context.lastHit.lineNumber; }
            if (step.sameThread) {
                const lastFields = extractLogFields(context.lastHit);
                threadOriginal = (lastFields.threadName || '').trim();
                if (!threadOriginal) {
                    return tplHandleEmpty(step, summary, at, '上一步命中的行没有线程名,无法按同线程搜索');
                }
                threadLower = threadOriginal.toLowerCase();
            }
        }
        const lowered = words.map(w => w.toLowerCase());
        const hits = fullDataCache.filter(line => {
            if (afterLine && line.lineNumber <= afterLine) { return false; }
            if (threadLower) {
                const fields = extractLogFields(line);
                if (!fields.threadName || fields.threadName.toLowerCase() !== threadLower) { return false; }
            }
            const content = (line.content || '').toLowerCase();
            return lowered.every(w => content.includes(w));
        });
        // 视图同步:查询动作重新定义查询上下文——关键词整体替换,其余过滤器清空;
        // 同线程约束会作为线程筛选呈现,保证「看到的 = 命中的」
        setFilterAndApply({
            keyword: words.join(' '),
            isRegex: false,
            isMultiple: true,
            threadName: threadOriginal,
            className: null,
            methodName: null,
            levels: null,
            timeRange: null
        }, { resetPage: true });
        summary.filtered = true;
        // 界面表达与手动搜索一致:关键词回显搜索框;搜索重新定义了上下文,
        // 之前遗留的筛选说明(状态条)已失效,隐藏
        tplSyncFilterUi();
        hideFilterStatus();
        if (threadOriginal) { context.lastThread = threadOriginal; }
        if (hits.length === 0) {
            return tplHandleEmpty(step, summary, at, `未找到包含「${words.join(' ')}」的日志` +
                (afterLine ? `(第 ${afterLine} 行之后)` : '') +
                (threadLower ? `(线程 ${threadOriginal})` : ''));
        }
        // 命中策略决定本步骤的产出集(context.hits):
        //   first/ask -> 收敛为一条,后续「打书签/加注释」只作用于这一条;
        //   all       -> 整批命中,锚点取最后一条,便于后续继续用 afterLastHit 链式推进。
        // 选中单条时同步定位到该行(保留全部不停留,让用户自己浏览整批)。
        context.hits = hits;
        if (step.hitPolicy === 'all') {
            context.lastHit = hits[hits.length - 1];
            return;
        }
        if (step.hitPolicy === 'first' || hits.length === 1) {
            context.hits = [hits[0]];
            context.lastHit = hits[0];
            jumpToLine(hits[0].lineNumber);
            summary.jumpLine = hits[0].lineNumber;
            return;
        }
        const picked = await pickTplHit(hits);
        if (!picked) { throw tplFlowAbort(); }
        context.hits = [picked];
        context.lastHit = picked;
        jumpToLine(picked.lineNumber);
        summary.jumpLine = picked.lineNumber;
        return;
    }

    if (step.type === 'filter') {
        const filters = {};
        if (step.field === 'levels') {
            filters.levels = step.value.slice();
        } else if (step.field === 'timeRange') {
            filters.timeRange = {
                start: resolveTplString(step.value.start, paramValues),
                end: resolveTplString(step.value.end, paramValues)
            };
        } else {
            let resolved;
            if (step.value === 'lastHit') {
                if (!context.lastHit) {
                    summary.warnings.push(`${at}: 没有可用的命中行,已跳过筛选`);
                    return;
                }
                const fields = extractLogFields(context.lastHit);
                resolved = (fields[step.field] || '').trim();
                if (!resolved) {
                    summary.warnings.push(`${at}: 命中行未提取到${TPL_FILTER_FIELDS[step.field]},已跳过筛选`);
                    return;
                }
            } else {
                resolved = resolveTplString(step.value, paramValues).trim();
                if (!resolved) {
                    summary.warnings.push(`${at}: 筛选值为空,已跳过`);
                    return;
                }
            }
            filters[step.field] = resolved;
            if (step.field === 'threadName') {
                context.lastThread = resolved;
                summary.thread = resolved;
            }
        }
        // keepKeyword=false 时同次调用清掉关键词,避免两次过滤造成中间态闪烁
        filters.keyword = (step.keepKeyword !== false) ? unifiedFilters.keyword : null;
        setFilterAndApply(filters, { resetPage: true });
        summary.filtered = true;
        // 界面表达与手动操作一致:级别过滤同步勾选框;
        // 状态条按手动口径显示具体筛选值(线程名/类名/方法名),级别过滤由勾选框本身表达
        tplSyncFilterUi();
        if (step.field === 'threadName' && filters.threadName) { showFilterStatus(`线程名: ${filters.threadName}`); }
        else if (step.field === 'className' && filters.className) { showFilterStatus(`类名: ${filters.className}`); }
        else if (step.field === 'methodName' && filters.methodName) { showFilterStatus(`方法名: ${filters.methodName}`); }
        // 定位到当前命中行,而不是停在筛选结果的开头
        if (context.lastHit) {
            jumpToLine(context.lastHit.lineNumber);
            summary.jumpLine = context.lastHit.lineNumber;
        }
        return;
    }

    if (step.type === 'bookmark') {
        const targets = tplCollectTargets(step, context, summary, at);
        if (!targets) { return; }
        for (const line of targets) {
            const name = step.name ? resolveTplString(step.name, paramValues).trim() : '';
            bookmarks.set(line.lineNumber, name || `行 ${line.lineNumber}`);
        }
        summary.bookmarks += targets.length;
        renderLines();
        showToast(`已添加 ${targets.length} 个书签`);
        return;
    }

    if (step.type === 'comment') {
        const targets = tplCollectTargets(step, context, summary, at);
        if (!targets) { return; }
        const content = resolveTplString(step.content, paramValues);
        if (!content.trim()) {
            summary.warnings.push(`${at}: 注释内容为空,已跳过`);
            return;
        }
        for (const line of targets) {
            comments.set(line.lineNumber, content);
        }
        summary.comments += targets.length;
        renderLines();
        showToast(`已添加 ${targets.length} 条注释`);
        return;
    }
}

/** 书签/注释动作的目标收集;返回 null 表示已记警告跳过 */
function tplCollectTargets(step, context, summary, at) {
    const targets = step.target === 'view' ? allLines.slice() : context.hits.slice();
    if (targets.length === 0) {
        summary.warnings.push(`${at}: 没有可操作的日志行(请先执行一次查询动作),已跳过`);
        return null;
    }
    return targets;
}

function tplHandleEmpty(step, summary, at, reason) {
    if (step.onEmpty === 'skip') {
        summary.warnings.push(`${at}: ${reason},已按「跳过本步继续」跳过`);
        return;
    }
    showToast(reason);
    summary.warnings.push(`${at}: ${reason},流程已终止(可在模板里把「0 条命中时」改为「跳过本步继续」)`);
    throw tplFlowStop();
}

function finishPipeline(summary) {
    const area = document.getElementById('tplRunSummaryArea');
    const progress = document.getElementById('tplRunProgressArea');
    if (!area) { return; }
    if (progress) { progress.style.display = 'none'; }

    let html = `<div style="font-weight: bold; margin-bottom: 8px;">${summary.stopped ? '⏹ 已停止' : '✅ 执行完成'}</div>`;
    const stats = [];
    if (summary.bookmarks > 0) { stats.push(`书签 ${summary.bookmarks} 个`); }
    if (summary.comments > 0) { stats.push(`注释 ${summary.comments} 条`); }
    if (summary.thread) { stats.push(`筛选线程 ${summary.thread}`); }
    if (summary.jumpLine) { stats.push(`定位到第 ${summary.jumpLine} 行`); }
    html += stats.length ? `<div style="font-size: 12px; margin-bottom: 8px;">${escapeHtml(stats.join(' · '))}</div>` : '';
    if (summary.warnings.length > 0) {
        html += '<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">';
        for (const w of summary.warnings) {
            html += `<div>⚠ ${escapeHtml(w)}</div>`;
        }
        html += '</div>';
    }
    html += '<div class="modal-footer" style="padding: 0;">';
    if (summary.filtered) {
        html += '<button onclick="clearCustomFilter(); finishPipelineHideSummary();"><i class="codicon codicon-close"></i> 取消筛选</button>';
    }
    html += '<button onclick="closeRunModal()">关闭</button>';
    html += '</div>';
    area.innerHTML = html;
    area.style.display = 'block';
}

function finishPipelineHideSummary() {
    const area = document.getElementById('tplRunSummaryArea');
    if (area) { area.style.display = 'none'; }
}

// ---------- 命中选择弹窗 ----------

/**
 * 命中 N 条时让用户选择一条。返回 Promise<命中行对象|null>(null = 用户终止)。
 */
function pickTplHit(hits) {
    return new Promise((resolve) => {
        tplHitResolver = resolve;
        tplCurrentHits = hits;
        const container = document.getElementById('tplHitsContainer');
        const shown = hits.slice(0, TPL_HIT_LIST_MAX);
        let html = `<div style="font-size: 12px; margin-bottom: 8px;">共命中 ${hits.length} 条,请选择用于后续动作的一条${hits.length > TPL_HIT_LIST_MAX ? `(仅显示前 ${TPL_HIT_LIST_MAX} 条,可改用「保留全部命中」策略)` : ''}:</div>`;
        html += '<div style="max-height: 320px; overflow-y: auto;">';
        shown.forEach((line, i) => {
            const time = line.timestamp ? tplFormatTime(line.timestamp instanceof Date ? line.timestamp : new Date(line.timestamp)) : '';
            const preview = escapeHtml(tplTruncate(line.content, TPL_PREVIEW_LEN));
            html += `<label style="display: flex; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; align-items: flex-start;">`;
            html += `<input type="radio" name="tplHitRadio" value="${i}" style="margin-top: 3px;">`;
            html += `<span style="font-size: 12px; word-break: break-all;"><strong>行 ${line.lineNumber}</strong>${time ? ' · ' + time : ''}<br><span style="color: var(--vscode-descriptionForeground);">${preview}</span></span>`;
            html += '</label>';
        });
        html += '</div>';
        html += '<div class="modal-footer" style="padding: 10px 0 0;">';
        html += '<button onclick="tplHitAbort()"><i class="codicon codicon-debug-stop"></i> 终止</button>';
        html += '<button id="tplHitConfirmBtn" onclick="tplHitConfirm()" disabled><i class="codicon codicon-check"></i> 用这一条继续</button>';
        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('input[name="tplHitRadio"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const btn = document.getElementById('tplHitConfirmBtn');
                if (btn) { btn.disabled = false; }
            });
        });

        document.getElementById('templateHitsModal').style.display = 'block';
    });
}

function tplHitConfirm() {
    const checked = document.querySelector('input[name="tplHitRadio"]:checked');
    const modal = document.getElementById('templateHitsModal');
    modal.style.display = 'none';
    const resolver = tplHitResolver;
    tplHitResolver = null;
    if (!resolver) { return; }
    if (!checked || !tplCurrentHits) { resolver(null); return; }
    const idx = parseInt(checked.value, 10);
    const picked = (idx >= 0 && idx < tplCurrentHits.length) ? tplCurrentHits[idx] : null;
    tplCurrentHits = null;
    resolver(picked);
}

function tplHitAbort() {
    const modal = document.getElementById('templateHitsModal');
    modal.style.display = 'none';
    tplCurrentHits = null;
    const resolver = tplHitResolver;
    tplHitResolver = null;
    if (resolver) { resolver(null); }
}
