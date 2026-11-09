// ========== 长行折叠(纯逻辑) ==========
// 「折叠长行」功能的判定与文案纯函数。超长日志行(一行几千字符的 JSON 请求体)
// 换行后会把页面撑成几千个视觉行,滚轮掠过一页要滚几百格 —— 默认把长行钳制在
// N 个视觉行内,点击展开全文,会话内记住已展开集合。
//
// 本文件不持有状态、不碰 DOM;折叠状态(开关/已展开集合)与 DOM 胶水在 webview.js,
// 视觉钳制交给 CSS(.log-line.folded-long 的 max-height)。
// 依赖: 仅函数声明 + 常量,加载期无副作用,须在 webview.js 之前加载。

/** 超过该字符数的行才可能是长行(粗筛,最终以实际渲染高度为准) */
const FOLD_CHAR_THRESHOLD = 200;

/** 折叠保留行数的合法区间(与 package.json schema 一致) */
const FOLD_MAX_ROWS_MIN = 1;
const FOLD_MAX_ROWS_MAX = 50;

/** 长行粗筛:非字符串内容(行对象/数字)按字符串化处理,空内容不算长行 */
function isLongLine(text) {
    if (text == null) { return false; }
    return String(text).length > FOLD_CHAR_THRESHOLD;
}

/**
 * 折叠状态判定。
 * foldable: 参与长行折叠(开关开 + 是长行)—— 决定交互与样式是否挂载;
 * folded:   当前是否处于折叠态 —— 已展开的行保持展开。
 *
 * @param {string} text          行内容
 * @param {boolean} isExpanded   该行是否已展开(手动展开或搜索命中自动展开)
 * @param {boolean} foldEnabled  折叠开关是否开启
 */
function resolveLongLineFold(text, isExpanded, foldEnabled) {
    const foldable = !!foldEnabled && isLongLine(text);
    return { foldable: foldable, folded: foldable && !isExpanded };
}

/** 行内交互提示文案(挂在行容器的 title 上) */
function longLineToggleTitle(folded) {
    return folded ? '点击展开完整内容' : '点击折叠该行';
}

/**
 * 真实截断判定(渲染后测量用)。
 * 字符数阈值与「实际有没有被裁掉」无关 —— 200 字符的行在宽面板上只有 2 个视觉行,
 * 挂上「⋯」和可点击的指针就是骗用户。真正决定要不要折叠的是:内容渲染高度
 * 是否超过了保留行数允许的高度。
 *
 * @param {number} contentHeight  内容实际渲染高度(px)
 * @param {number} allowedHeight  保留 N 行允许的高度(px)
 * @returns {boolean} true = 真的被截断,值得折叠
 */
function isActuallyTruncated(contentHeight, allowedHeight) {
    if (!Number.isFinite(contentHeight) || !Number.isFinite(allowedHeight)) { return false; }
    // 留 1px 容差:亚像素舍入不该把刚好 3 行的行判成超长
    return contentHeight > allowedHeight + 1;
}

/**
 * 点击归属判定:这次点击属于哪种长行交互。
 * 单击展开/收起与双击加书签共用同一个行容器 —— 双击会先收到一次 click,
 * 如果 click 立即展开,双击书签前行就先「轰」地跳高。解法:
 * 正文单击延迟判定(给双击取消的窗口),显式按钮立即生效。
 *
 * @param {EventTarget|null} target 点击目标
 * @returns {'none'|'immediate'|'delayed'}
 *   none      解析树/注释块等自带交互的元素,不触发整行折叠;
 *   immediate 「⋯ 展开」/「收起」按钮,显式操作立即执行;
 *   delayed   正文区域,延迟判定(双击书签会在窗口期内取消)。
 */
function resolveLongLineClickMode(target) {
    const NONE = 'none';
    if (!target || typeof target.closest !== 'function') { return 'delayed'; }
    if (target.closest('.json-tree, .xml-tree, .log-comment')) { return NONE; }
    if (target.closest('.fold-toggle, .fold-expand-btn')) { return 'immediate'; }
    return 'delayed';
}

/** 正文单击的延迟判定窗口(ms):200ms 兼顾响应速度与双击误触;间隔更长的慢双击
 * 由 dblclick 时的回退机制兜底(见 webview.js 的 lastDelayedToggle) */
const LONG_LINE_CLICK_DELAY_MS = 200;

/**
 * 搜索命中是否被折叠区裁掉(渲染后按几何位置判定)。
 * 「搜索就是用来快速定位」—— 命中藏在看不见的地方,搜索就失去了意义。
 * 用几何位置而不是字符偏移估算:字符偏移在正则/多关键词模式下算不准,
 * 高亮 span 的实际位置才是真的。
 *
 * @param {number} highlightTop    高亮块顶边相对钳制容器的偏移(px)
 * @param {number} highlightBottom 高亮块底边相对钳制容器的偏移(px)
 * @param {number} visibleHeight   钳制后可见的高度(px)
 * @returns {boolean} true = 高亮被裁掉(至少一部分不可见),应自动展开
 */
function isHighlightClipped(highlightTop, highlightBottom, visibleHeight) {
    if (!Number.isFinite(highlightTop) || !Number.isFinite(visibleHeight)) { return false; }
    // 完全在可见区内 → 不需要展开
    if (highlightBottom <= visibleHeight) { return false; }
    // 完全在可见区外(下方)→ 被裁掉
    return true;
}

/** 折叠保留行数钳制到合法区间 */
function clampFoldMaxRows(value, fallback) {
    const base = (typeof fallback === 'number' && Number.isFinite(fallback)) ? fallback : 3;
    if (!Number.isFinite(value)) { return base; }
    return Math.min(FOLD_MAX_ROWS_MAX, Math.max(FOLD_MAX_ROWS_MIN, Math.floor(value)));
}
