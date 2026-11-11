'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// chunkedLoad.js 是浏览器全局脚本(纯逻辑,不碰 DOM),
// 按 AGENTS.md 约定用 vm 加载后从沙箱取全局函数。
const src = readFileSync(join(__dirname, '..', 'media', 'chunkedLoad.js'), 'utf8');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const {
    chunkedLoadBegin, chunkedLoadAppend, chunkedLoadDone, chunkedLoadAbort, chunkedLoadReset,
    planLineChunkRanges
} = sandbox;
// var 声明挂沙箱对象;const 语义的常量按 foldLongLines.test.cjs 的约定用 eval 取
const SAFE_SINGLE_LINE_CHARS = vm.runInContext('SAFE_SINGLE_LINE_CHARS', sandbox);

// 每个用例独立开局,避免单槽状态在用例间串扰
function freshBegin(loadId, extraData) {
    chunkedLoadReset();
    return chunkedLoadBegin({
        command: 'fileLoaded',
        data: { fileName: 'a.log', totalLines: 10, chunkedTransferId: loadId, ...extraData }
    });
}

function line(n) {
    return { lineNumber: n, content: `line-${n}` };
}

// ---- chunkedLoadBegin:头部到达 ----

test('begin: 合法头部(数字 chunkedTransferId)被接受,返回命令与总行数', () => {
    const r = freshBegin(7);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), {
        accepted: true, command: 'fileLoaded', totalLines: 10
    });
});

test('begin: 缺少/非法 chunkedTransferId 的头部被拒绝', () => {
    assert.equal(chunkedLoadBegin(null).accepted, false);
    assert.equal(chunkedLoadBegin({ command: 'x' }).accepted, false);
    assert.equal(chunkedLoadBegin({ command: 'x', data: {} }).accepted, false);
    assert.equal(chunkedLoadBegin({ command: 'x', data: { chunkedTransferId: '7' } }).accepted, false);
});

// ---- chunkedLoadAppend:数据块累积 ----

test('append: loadId 匹配的块被累积,返回进度信息', () => {
    freshBegin(7);
    const r1 = chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1), line(2)], sent: 2 });
    assert.equal(r1.accepted, true);
    assert.equal(r1.command, 'fileLoaded');
    assert.equal(r1.sent, 2);
    assert.equal(r1.totalLines, 10);

    const r2 = chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(3)], sent: 3 });
    assert.equal(r2.accepted, true);
    assert.equal(r2.sent, 3);
});

test('append: 无在途传输或 loadId 不匹配的块被丢弃', () => {
    chunkedLoadReset();
    assert.equal(chunkedLoadAppend({ command: 'chunkTransfer', loadId: 1, lines: [line(1)] }).accepted, false);

    freshBegin(7);
    const stale = chunkedLoadAppend({ command: 'chunkTransfer', loadId: 6, lines: [line(1)], sent: 1 });
    assert.equal(stale.accepted, false);
});

test('append: lines 缺失时不抛异常,进度回退为已收行数', () => {
    freshBegin(7);
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1), line(2)], sent: 2 });
    const r = chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7 });
    assert.equal(r.accepted, true);
    assert.equal(r.sent, 2);
});

// ---- chunkedLoadDone:完成合成 ----

test('done: 合成原始消息 —— 头部字段保留、chunkedTransferId 剥除、lines 为累积结果', () => {
    freshBegin(7, { loadReason: 'reload', fileEncoding: 'utf-8' });
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1), line(2)], sent: 2 });
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(3)], sent: 3 });

    const r = chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7, chunkCount: 2 });
    assert.equal(r.accepted, true);
    assert.equal(r.command, 'fileLoaded');
    const m = r.message;
    assert.equal(m.command, 'fileLoaded');
    assert.equal(m.data.loadReason, 'reload');
    assert.equal(m.data.fileEncoding, 'utf-8');
    assert.equal(m.data.totalLines, 10);
    assert.equal('chunkedTransferId' in m.data, false);
    assert.equal(m.data.lines.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(m.data.lines)), [
        { lineNumber: 1, content: 'line-1' },
        { lineNumber: 2, content: 'line-2' },
        { lineNumber: 3, content: 'line-3' }
    ]);
});

test('done: 完成后清空累积槽,后续同 id 的块不再被接受(单发语义)', () => {
    freshBegin(7);
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1)], sent: 1 });
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7 }).accepted, true);
    assert.equal(chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(2)], sent: 2 }).accepted, false);
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7 }).accepted, false);
});

test('done: loadId 不匹配的完成标记被丢弃(在途传输不受影响)', () => {
    freshBegin(7);
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1)], sent: 1 });
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 99 }).accepted, false);
    // 原传输仍在途,可继续收块并正常完成
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(2)], sent: 2 });
    const r = chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7 });
    assert.equal(r.accepted, true);
    assert.equal(r.message.data.lines.length, 2);
});

// ---- last-begin-wins:传输中途来了新一轮头部 ----

test('竞态: 新头部直接重置累积槽,旧代次的块与完成标记全部作废', () => {
    freshBegin(7);
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1)], sent: 1 });

    // 新一轮头部(loadId=8)到达 —— 刷新/换筛选场景
    const begin = chunkedLoadBegin({
        command: 'fileLoaded',
        data: { fileName: 'b.log', totalLines: 2, chunkedTransferId: 8 }
    });
    assert.equal(begin.accepted, true);

    // 旧代次的块被丢弃
    assert.equal(chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(2)], sent: 2 }).accepted, false);
    // 旧代次的完成标记被丢弃
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7 }).accepted, false);

    // 新代次正常走完
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 8, lines: [line(10), line(11)], sent: 2 });
    const r = chunkedLoadDone({ command: 'chunkTransferDone', loadId: 8 });
    assert.equal(r.accepted, true);
    assert.equal(r.message.data.fileName, 'b.log');
    assert.equal(r.message.data.lines.length, 2); // 旧代次的 line-1 不在新结果里
});

// ---- filterResults 命令复用同一累积器(消费方契约) ----

test('filterResults: 合成消息的行数组必须写在 data.results —— handleFilterResults 读的就是这个字段', () => {
    chunkedLoadReset();
    chunkedLoadBegin({
        command: 'filterResults',
        data: { threadName: 'main', filterSeq: 42, chunkedTransferId: 3 }
    });
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 3, lines: [line(5)], sent: 1 });
    const r = chunkedLoadDone({ command: 'chunkTransferDone', loadId: 3 });
    assert.equal(r.message.command, 'filterResults');
    assert.equal(r.message.data.threadName, 'main');
    assert.equal(r.message.data.filterSeq, 42);
    // 消费方契约:webview.js 的 handleFilterResults 执行 allLines = data.results || []
    // —— 断言的是它读取的字段,不是合成器自己写出的字段(审查 P0 的教训)
    assert.ok(Array.isArray(r.message.data.results), 'data.results 必须是数组');
    assert.equal(r.message.data.results.length, 1);
    assert.equal(r.message.data.results[0].lineNumber, 5);
});

test('端到端契约: 遍历协议表本身,每个登记命令的合成产物都能被消费方直接读取', () => {
    // 消费方真实读取的字段(来源:webview.js 的 handler,与源码逐条对齐):
    //   handleFileLoaded    → allLines = data.lines
    //   handleFilterResults → allLines = data.results
    const consumerField = { fileLoaded: 'lines', filterResults: 'results' };
    // 遍历协议表(单一事实源,第二轮审查 N1):表里登记了、消费方清单却没有的
    // 命令必须让测试失败 —— 而不是悄悄落到某个兜底字段静默漏网
    const table = vm.runInContext('CHUNK_PAYLOAD_FIELD', sandbox);
    const registered = Object.keys(table);
    assert.ok(registered.length > 0, '协议表不应为空');
    for (const command of registered) {
        const field = consumerField[command];
        assert.ok(field, `命令 ${command} 已登记进 CHUNK_PAYLOAD_FIELD,但消费方字段清单没有它 —— 先查 webview.js 消费方实际读哪个字段,再补进本用例`);
        chunkedLoadReset();
        chunkedLoadBegin({ command, data: { chunkedTransferId: 99 } });
        chunkedLoadAppend({ command: 'chunkTransfer', loadId: 99, lines: [line(1), line(2)], sent: 2 });
        const r = chunkedLoadDone({ command: 'chunkTransferDone', loadId: 99 });
        assert.equal(r.accepted, true, `${command} 应完成合成`);
        assert.ok(Array.isArray(r.message.data[field]),
            `${command} 的合成产物必须带 data.${field}(消费方读取的字段)`);
        assert.equal(r.message.data[field].length, 2, `${command} 行数应完整`);
    }
});

test('未登记进协议表的命令不做任何兜底合成(N1)', () => {
    chunkedLoadReset();
    chunkedLoadBegin({ command: 'someUnregisteredCommand', data: { someKey: 1, chunkedTransferId: 8 } });
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 8, lines: [line(1)], sent: 1 });
    const r = chunkedLoadDone({ command: 'chunkTransferDone', loadId: 8 });
    assert.equal(r.accepted, true);
    // 未登记命令:合成产物里既没有 lines 兜底,也没有任何行数组字段 —— 错误当场暴露
    assert.equal('lines' in r.message.data, false, '不得静默落到 lines 兜底');
    const payloadFields = Object.keys(r.message.data).filter(k => Array.isArray(r.message.data[k]));
    assert.equal(payloadFields.length, 0, '未登记命令不应合成任何行数组字段');
});

// ---- chunkedLoadAbort:传输中止清槽(P1-b) ----

test('abort: loadId 匹配时清空累积槽,后续同 id 的块/完成标记全被拒绝', () => {
    freshBegin(7);
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1), line(2)], sent: 2 });
    const r = chunkedLoadAbort({ command: 'chunkTransferAbort', loadId: 7 });
    assert.equal(r.accepted, true);
    assert.equal(r.command, 'fileLoaded');
    // 槽已清:同 id 的一切后续消息都进不来
    assert.equal(chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(3)], sent: 3 }).accepted, false);
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7 }).accepted, false);
    // 但新一轮传输可以正常开始(槽可复用)
    freshBegin(8);
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 8, lines: [line(9)], sent: 1 });
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 8 }).message.data.lines.length, 1);
});

test('abort: 无在途传输或 loadId 不匹配时拒绝,不影响在途传输', () => {
    chunkedLoadReset();
    assert.equal(chunkedLoadAbort({ command: 'chunkTransferAbort', loadId: 1 }).accepted, false);

    freshBegin(7);
    assert.equal(chunkedLoadAbort({ command: 'chunkTransferAbort', loadId: 6 }).accepted, false);
    // 在途传输未被误伤,仍可正常收块并完成
    chunkedLoadAppend({ command: 'chunkTransfer', loadId: 7, lines: [line(1)], sent: 1 });
    assert.equal(chunkedLoadDone({ command: 'chunkTransferDone', loadId: 7 }).accepted, true);
});

// ---- planLineChunkRanges:反向分块(webview→宿主导出) ----

test('反向切块: 空数组返回空列表', () => {
    chunkedLoadReset();
    // vm 沙箱与宿主是不同 realm,deepEqual 不可用,改比 JSON(同 lineRange.test.cjs 约定)
    assert.equal(JSON.stringify(planLineChunkRanges([])), '[]');
});

test('反向切块: 按预算切块,区间连续无缝且覆盖全部行', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ lineNumber: i + 1, content: 'x'.repeat(1000) }));
    const plans = planLineChunkRanges(lines, 5000); // 每行 1128 字符 → 每块 4 行
    assert.ok(plans.length > 1);
    assert.equal(plans[0].start, 0);
    assert.equal(plans[plans.length - 1].end, 100);
    for (let i = 1; i < plans.length; i++) {
        assert.equal(plans[i].start, plans[i - 1].end);
    }
});

test('反向切块: 单行超预算独占一块,绝不拆行', () => {
    const lines = [
        { lineNumber: 1, content: 'x'.repeat(100) },
        { lineNumber: 2, content: 'y'.repeat(10000) },
        { lineNumber: 3, content: 'x'.repeat(100) }
    ];
    // 同上:跨 realm 改比 JSON
    assert.equal(JSON.stringify(planLineChunkRanges(lines, 500)),
        JSON.stringify([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]));
});

test('反向切块契约: 与宿主侧 planLineChunks 同输入必产出相同边界', () => {
    // webview→宿主的导出分块 与 宿主→webview 的载入分块 是同一算法的两侧实现
    // (TS 一份、浏览器脚本一份),边界不一致说明有一侧被单独改动过 —— 用例锁死。
    const { planLineChunks } = require('../out/chunkedTransfer.js');
    const cases = [
        [],
        Array.from({ length: 3 }, (_, i) => ({ lineNumber: i + 1, content: 'a'.repeat(10) })),
        Array.from({ length: 1000 }, (_, i) => ({ lineNumber: i + 1, content: 'b'.repeat(i * 37) })),
        [{ lineNumber: 1, content: 'z'.repeat(5000000) }]
    ];
    for (const lines of cases) {
        assert.deepEqual(
            JSON.parse(JSON.stringify(planLineChunkRanges(lines, 4096))),
            JSON.parse(JSON.stringify(planLineChunks(lines, 4096))),
            '两侧切块边界必须一致'
        );
    }
    // 不传预算时走各自默认值 —— 默认预算也必须一致(N5)
    const defaults = Array.from({ length: 2000 }, (_, i) => ({ lineNumber: i + 1, content: 'c'.repeat(9000) }));
    assert.deepEqual(
        JSON.parse(JSON.stringify(planLineChunkRanges(defaults))),
        JSON.parse(JSON.stringify(planLineChunks(defaults))),
        '两侧默认预算下的切块边界必须一致'
    );
});

test('两侧分块常量严格相等(N5): 默认块预算/单行开销/单行安全上限', () => {
    const {
        CHUNK_TRANSFER_MAX_CHARS, PER_LINE_OVERHEAD_CHARS, SAFE_SINGLE_LINE_CHARS
    } = require('../out/chunkedTransfer.js');
    assert.equal(vm.runInContext('CHUNK_TRANSFER_MAX_CHARS', sandbox), CHUNK_TRANSFER_MAX_CHARS,
        '默认块字符预算两侧必须相等');
    assert.equal(vm.runInContext('PER_LINE_OVERHEAD_CHARS', sandbox), PER_LINE_OVERHEAD_CHARS,
        '单行序列化开销估算两侧必须相等');
    assert.equal(vm.runInContext('SAFE_SINGLE_LINE_CHARS', sandbox), SAFE_SINGLE_LINE_CHARS,
        '单行安全上限两侧必须相等');
});

test('单行安全上限常量导出(超限单行独占块也装不下,两侧都按它报错)', () => {
    assert.equal(typeof SAFE_SINGLE_LINE_CHARS, 'number');
    assert.ok(SAFE_SINGLE_LINE_CHARS > 100 * 1000 * 1000 && SAFE_SINGLE_LINE_CHARS < 536 * 1000 * 1000);
});
