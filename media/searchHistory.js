// ========== 搜索历史 ==========
// 会话级、按日志文件隔离:每个文件有独立的查看面板(webview),历史存在面板
// 内存里,关闭面板即清空——不写 localStorage、不跨文件、不跨会话。
//
// 收录工具栏实际执行过的全局搜索(包括输入停顿后自动触发的即时搜索)
// 与高级搜索里实际执行的关键词条件值;两者写入同一份历史,任一处输入框
// 弹出的下拉都能看到另一处搜过的关键词。高级搜索没有正则概念,统一以
// 非正则形式写入。「当前页」搜索不记录。打字过程中产生的中间前缀会被
// 最新条目原地合并(见 addSearchHistoryEntry),历史不会被半截关键词塞满。
// 本文件只管历史数据的增删查,下拉的渲染与交互在 webview.js。

const SEARCH_HISTORY_MAX = 50;    // 历史条数上限

let searchHistoryEntries = [];    // 当前文件的历史,最新在前

/** 获取当前文件的历史列表(最新在前,返回副本) */
function getSearchHistory() {
    return searchHistoryEntries.slice();
}

/**
 * 新增一条历史:同(关键词+正则)去重并置顶,超出上限截断。返回更新后的列表。
 * 前缀合并:即时搜索会随打字逐步触发,若新关键词与最新一条同模式且互为前缀
 * (含回退缩小关键词的情形),视为同一次输入的中间状态,替换而非新增,
 * 例如依次搜索 payment → payment callback 只留 payment callback 一条。
 */
function addSearchHistoryEntry(keyword, isRegex) {
    const kw = String(keyword == null ? '' : keyword).trim();
    if (!kw) { return getSearchHistory(); }
    const flag = isRegex === true;
    searchHistoryEntries = searchHistoryEntries.filter(entry =>
        !(entry.keyword === kw && entry.isRegex === flag));
    const newest = searchHistoryEntries[0];
    if (newest && newest.isRegex === flag) {
        const n = newest.keyword.toLowerCase();
        const k = kw.toLowerCase();
        if (n.startsWith(k) || k.startsWith(n)) {
            searchHistoryEntries = searchHistoryEntries.slice(1);
        }
    }
    searchHistoryEntries.unshift({ keyword: kw, isRegex: flag });
    searchHistoryEntries = searchHistoryEntries.slice(0, SEARCH_HISTORY_MAX);
    return getSearchHistory();
}

/** 删除单条历史,返回更新后的列表。 */
function removeSearchHistoryEntry(keyword, isRegex) {
    searchHistoryEntries = searchHistoryEntries.filter(entry =>
        !(entry.keyword === keyword && entry.isRegex === (isRegex === true)));
    return getSearchHistory();
}

/** 清空全部历史,返回空列表。 */
function clearSearchHistory() {
    searchHistoryEntries = [];
    return [];
}
