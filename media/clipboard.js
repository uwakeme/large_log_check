// ========== 日志选区复制(Ctrl+C) ==========
//
// 痛点:在日志区选中文本后按 Ctrl+C,内容没有进剪贴板,光标反而像"跳进了搜索框"。
// 原因:浏览器和 VS Code 的复制动作取的都是「当前焦点所在控件」的选区——
// 焦点还留在顶部搜索输入框时,复制到的是输入框自己的选区(通常是空的),
// 日志里选中的那段被直接忽略;输入框里没内容时,表现就是"什么都没复制"。
// 方案:接管 copy 事件——日志区有选区就把选区文本直接写进剪贴板,
// 焦点落在输入框、文本域还是日志区都不影响复制结果。
//
// VS Code 1.143 追加的坑:webview 里的 Ctrl+C 会被宿主拦下并转发给工作台,
// 再由宿主派发一条复制命令回来;派发前只要焦点在 body 上,宿主就会把焦点
// 还给"最后聚焦过的输入框"(点过一次搜索框就永久记住)——焦点跳回搜索框,
// 日志选区被吞掉,复制到的是空。对策:日志容器加 tabindex="-1"(见 webview.html),
// 在日志区按下鼠标时让容器自己持有焦点,焦点不落在 body 上,宿主的
// "焦点恢复"条件不成立,选区得以存活。
//
// 独立成文件的原因:这段逻辑要有单测覆盖(node:test + vm 打桩浏览器全局),
// webview.js 体量太大,整体塞进沙箱跑不起来。

/** 取日志区当前选中的纯文本;没有选区、或选区不在日志区,返回空串 */
function getLogSelectionText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return '';
    }
    const container = document.getElementById('logContainer');
    if (!container) {
        return '';
    }
    const range = selection.getRangeAt(0);
    // 选区必须落在日志区里才接管,避免抢走弹窗、下拉等其它区域的复制
    if (!container.contains(range.commonAncestorContainer)) {
        return '';
    }
    return selection.toString();
}

/**
 * copy 事件处理:日志区有选区 → 用选区文本覆盖剪贴板内容;
 * 没有选区 → 交回原生行为(复制输入框/文本域里的内容等)。
 */
function handleLogCopy(event) {
    const text = getLogSelectionText();
    if (!text) {
        return;
    }
    if (event.clipboardData) {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault(); // 用日志选区覆盖默认复制内容
    }
}

/**
 * 在日志区点选/拖选时,把焦点从工具栏输入框挪走并收拢到日志容器。
 * 输入框留着焦点会有两个副作用:按 Ctrl+C 复制到的是输入框内容,
 * 光标也停在搜索框里,后面顺手打的字全跑进搜索框。
 * 焦点也不能空落在 body 上(见文件头 VS Code 1.143 的"焦点恢复"坑),
 * 所以让日志容器(tabindex="-1")承接焦点。
 * 这里只做 blur/focus,不做 preventDefault —— 阻止默认行为会连带破坏文本选区。
 */
function releaseFocusFromLogInputs(event) {
    // 点在输入框自己身上时不要抢焦点
    const target = event && event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
    }
    const active = document.activeElement;
    if (active && active !== document.body
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        active.blur();
    }
    const container = document.getElementById('logContainer');
    if (container && active !== container) {
        container.focus({ preventScroll: true });
    }
}

/** 注册日志选区复制相关监听 */
function initLogClipboard() {
    document.addEventListener('copy', handleLogCopy);
    const container = document.getElementById('logContainer');
    if (container) {
        container.addEventListener('mousedown', releaseFocusFromLogInputs);
    }
}
