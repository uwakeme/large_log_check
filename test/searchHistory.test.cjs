// 搜索历史增删逻辑单元测试(node:test)。
// media/searchHistory.js 是会话级内存历史(按文件面板隔离,不落 localStorage),
// 无任何外部依赖,直接 eval 源码对纯逻辑(去重/上限/空白过滤)做回归覆盖。
// 注意:eval 的 let 声明不泄漏到本作用域(只有 function/var 会),
// 因此测试只走公开 API,用 clearSearchHistory() 重置状态。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'searchHistory.js'), 'utf8');
// 直接 eval:顶层 function 声明进入本模块作用域,以下测试可直接调用
eval(source);

test('新增按时间倒序,同(关键词+正则)去重并置顶,不同正则标记算两条', () => {
    clearSearchHistory();
    addSearchHistoryEntry('a', false);
    addSearchHistoryEntry('b', false);
    addSearchHistoryEntry('a', false);
    let list = getSearchHistory();
    assert.deepStrictEqual(list.map(e => e.keyword), ['a', 'b']);

    addSearchHistoryEntry('a', true); // 同关键词、正则模式不同 → 另一条
    list = getSearchHistory();
    assert.deepStrictEqual(list.map(e => e.keyword + (e.isRegex ? '.*' : '')), ['a.*', 'a', 'b']);
});

test('超出上限截断,保留最新', () => {
    clearSearchHistory();
    for (let i = 0; i < 55; i++) {
        addSearchHistoryEntry('kw' + i, false);
    }
    const list = getSearchHistory();
    assert.strictEqual(list.length, 50);
    assert.strictEqual(list[0].keyword, 'kw54');
    assert.strictEqual(list[49].keyword, 'kw5');
});

test('空白关键词不记录,关键词按首尾去空白归一,isRegex 严格按布尔解读', () => {
    clearSearchHistory();
    addSearchHistoryEntry('   ', false);
    assert.deepStrictEqual(getSearchHistory(), []);

    addSearchHistoryEntry('  abc  ', 'yes');
    assert.deepStrictEqual(getSearchHistory(), [{ keyword: 'abc', isRegex: false }]);

    addSearchHistoryEntry('re', 1);   // 非布尔 truthy 也归一为 false,只有 true 是真
    assert.deepStrictEqual(getSearchHistory()[0], { keyword: 're', isRegex: false });

    addSearchHistoryEntry('rx', true);
    assert.deepStrictEqual(getSearchHistory()[0], { keyword: 'rx', isRegex: true });
});

test('删除单条与清空全部', () => {
    clearSearchHistory();
    addSearchHistoryEntry('a', false);
    addSearchHistoryEntry('b', true);
    removeSearchHistoryEntry('a', false);
    assert.deepStrictEqual(getSearchHistory(), [{ keyword: 'b', isRegex: true }]);

    clearSearchHistory();
    assert.deepStrictEqual(getSearchHistory(), []);
});

test('前缀合并:打字中间态与回退缩小原地替换,不同关键词/不同模式不合并', () => {
    clearSearchHistory();
    // 打字停顿逐步触发搜索:payment → payment callback 只留最终一条
    addSearchHistoryEntry('payment', false);
    addSearchHistoryEntry('payment callback', false);
    assert.deepStrictEqual(getSearchHistory(), [{ keyword: 'payment callback', isRegex: false }]);

    // 回退缩小关键词同样合并
    addSearchHistoryEntry('payment callback failed', false);
    addSearchHistoryEntry('payment callback', false);
    assert.deepStrictEqual(getSearchHistory(), [{ keyword: 'payment callback', isRegex: false }]);

    // 无前缀关系的两次搜索各自保留
    addSearchHistoryEntry('timeout', false);
    addSearchHistoryEntry('error', false);
    assert.deepStrictEqual(getSearchHistory().map(e => e.keyword), ['error', 'timeout', 'payment callback']);

    // 同前缀但正则模式不同,视为两次不同搜索
    addSearchHistoryEntry('pay', true);
    assert.strictEqual(getSearchHistory().length, 4);
    assert.deepStrictEqual(getSearchHistory()[0], { keyword: 'pay', isRegex: true });

    // 同模式下继续输入:前缀比较不区分大小写(搜索本身大小写不敏感)
    addSearchHistoryEntry('PAY LINE', true);
    assert.strictEqual(getSearchHistory().length, 4, 'PAY LINE 应与正则的 pay 合并为一条');
    assert.deepStrictEqual(getSearchHistory()[0], { keyword: 'PAY LINE', isRegex: true });
});

test('getSearchHistory 返回副本,外部修改不影响内部状态', () => {
    clearSearchHistory();
    addSearchHistoryEntry('a', false);
    const copy = getSearchHistory();
    copy.push({ keyword: 'hack', isRegex: false });
    assert.deepStrictEqual(getSearchHistory(), [{ keyword: 'a', isRegex: false }]);
});
