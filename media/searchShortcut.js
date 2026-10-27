// ========== 选中日志文字后 Ctrl+F 直接搜索 ==========
//
// 痛点:看到日志里的可疑字段想搜一下,要复制 → 点进搜索框 → 粘贴 → 回车四步。
// 方案:日志区有选区时按 Ctrl/Cmd+F,选中的文字直接填进搜索框并立即执行搜索;
// 没有选区(或按了 Shift/Alt 组合)时不接管,交回默认行为。
//
// 取日志区选区复用 clipboard.js 的 getLogSelectionText(),本文件须在其后加载。
// 注意:<input> 的 value 会剥掉换行,多行选区直接塞会把行尾和下一行行首粘成一个词,
// 所以先把换行/连续空白折叠成单个空格再填。

/** 是否为接管目标:Ctrl/Cmd + F(不带 Shift/Alt,避免劫持 Ctrl+Shift+F 等组合) */
function isSearchShortcutEvent(event) {
    if (!event || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
        return false;
    }
    return event.key === 'f' || event.key === 'F' || event.keyCode === 70;
}

/** 换行/连续空白折叠为单个空格并去首尾(input 装不下换行,直接塞会粘词) */
function collapseWhitespaceForInput(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Ctrl+F 且日志区有选区:选区文字填进搜索框,立即执行搜索,焦点落到搜索框。
 * 接管了返回 true(调用方据此短路后续按键处理);条件不满足返回 false,交回默认行为。
 */
function handleSearchFromSelection(event) {
    if (!isSearchShortcutEvent(event)) {
        return false;
    }
    const raw = typeof getLogSelectionText === 'function' ? getLogSelectionText() : '';
    const text = collapseWhitespaceForInput(raw);
    if (!text) {
        return false;
    }
    const input = document.getElementById('searchInput');
    if (!input) {
        return false;
    }
    input.value = text;
    if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(text.length, text.length); // 光标停到末尾,方便接着改
    }
    if (typeof input.focus === 'function') {
        input.focus();
    }
    // 程序赋值不会触发 input 事件,这里和回车搜索一样:立即搜,收起历史下拉
    if (typeof hideSearchHistoryDropdown === 'function') {
        hideSearchHistoryDropdown();
    }
    search();
    if (event.preventDefault) {
        event.preventDefault();
    }
    return true;
}
