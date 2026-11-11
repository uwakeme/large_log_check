// ========== 分块传输累积器(纯逻辑) ==========
// 宿主往 webview 发送大行数组的消息(fileLoaded / filterResults)时,单条消息
// 的 payload 会超出单条消息能承受的体量(650MB 日志卡在「加载完成！」即由此
// 而来),宿主改为三段式发送:
//   头部          {command:'fileLoaded', data:{...原字段, chunkedTransferId}}
//   数据块 × N    {command:'chunkTransfer', loadId, lines, sent}
//   完成标记      {command:'chunkTransferDone', loadId, chunkCount}
// 本模块负责累积数据块,并在收到完成标记时把头部 data 剥掉 chunkedTransferId、
// 补上 lines 合成回原始消息 —— 对 webview.js 里的既有 handler 完全透明。
//
// 与 foldLongLines.js 不同,本文件持有状态(单槽累积缓冲):同一时刻只认最新
// 一次头部(last-begin-wins),旧代次的块/完成标记按 loadId 不匹配丢弃 ——
// 覆盖「传输中途用户刷新/换筛选」的竞态,新数据集使在途传输作废。
// 不碰 DOM;进度条等 UI 胶水在 webview.js 的消息分发处。
// 依赖: 仅函数声明 + 模块级状态,加载期无副作用,须在 webview.js 之前加载。

/**
 * 各命令合成时行数组写入的字段名 —— 必须与 webview.js 消费方读取的字段一致:
 *   fileLoaded    → handleFileLoaded    读 data.lines    (webview.js「case 'fileLoaded'」)
 *   filterResults → handleFilterResults 读 data.results  (webview.js「case 'filterResults'」)
 * 审查报告(2026-11-11) P0 的教训:一律写 lines 会让 filterResults 的消费方
 * 读到 undefined、视图全空。新命令接入分块传输时,先查消费方读哪个字段,
 * 再加进这张表,并在测试里断言「消费方读取的字段必须存在」。
 */
var CHUNK_PAYLOAD_FIELD = {
    fileLoaded: 'lines',
    filterResults: 'results'
};

// 单槽累积状态:null = 无在途传输
var chunkedLoadState = null;

/**
 * 头部消息到达:重置累积槽,开始新一轮传输。
 * @param {object} message 完整消息,{command, data:{chunkedTransferId, ...原字段}}
 * @returns {{accepted: boolean, command?: string, totalLines?: number}}
 */
function chunkedLoadBegin(message) {
    var id = message && message.data ? message.data.chunkedTransferId : null;
    if (typeof id !== 'number') {
        return { accepted: false };
    }
    chunkedLoadState = {
        loadId: id,
        command: message.command,
        data: message.data,
        received: []
    };
    return {
        accepted: true,
        command: message.command,
        totalLines: typeof message.data.totalLines === 'number' ? message.data.totalLines : undefined
    };
}

/**
 * 数据块到达:loadId 匹配在途传输才收下。
 * @param {object} envelope {command:'chunkTransfer', loadId, lines, sent}
 * @returns {{accepted: boolean, command?: string, sent?: number, totalLines?: number}}
 */
function chunkedLoadAppend(envelope) {
    if (!chunkedLoadState || envelope.loadId !== chunkedLoadState.loadId) {
        return { accepted: false };
    }
    if (Array.isArray(envelope.lines)) {
        // 逐行 push 而非 concat:避免每块额外复制一份整块数组
        for (var i = 0; i < envelope.lines.length; i++) {
            chunkedLoadState.received.push(envelope.lines[i]);
        }
    }
    return {
        accepted: true,
        command: chunkedLoadState.command,
        sent: typeof envelope.sent === 'number' ? envelope.sent : chunkedLoadState.received.length,
        totalLines: typeof chunkedLoadState.data.totalLines === 'number'
            ? chunkedLoadState.data.totalLines
            : undefined
    };
}

/**
 * 完成标记到达:合成原始消息(头部 data + 累积的行),清空累积槽。
 * 行数组写入的字段名按 CHUNK_PAYLOAD_FIELD 查表 —— 与消费方读取的字段对齐。
 * 合成消息不带 chunkedTransferId,重入 webview.js 的消息分发后落到正常 case。
 * @param {object} envelope {command:'chunkTransferDone', loadId, chunkCount}
 * @returns {{accepted: boolean, command?: string, message?: object}}
 */
function chunkedLoadDone(envelope) {
    if (!chunkedLoadState || envelope.loadId !== chunkedLoadState.loadId) {
        return { accepted: false };
    }
    var state = chunkedLoadState;
    chunkedLoadState = null; // 单发:完成后槽立即可被下一轮头部复用
    var data = {};
    for (var key in state.data) {
        if (key !== 'chunkedTransferId') {
            data[key] = state.data[key];
        }
    }
    // 不做未知命令兜底(审查 N1):没登记进 CHUNK_PAYLOAD_FIELD 的命令不写
    // 任何行数组字段 —— 消费方当场读到 undefined 而不是悄悄拿到 lines,
    // 错误立刻暴露;契约用例会遍历本表保证每个登记过的命令都被覆盖。
    var payloadField = CHUNK_PAYLOAD_FIELD[state.command];
    if (payloadField) {
        data[payloadField] = state.received;
    }
    return {
        accepted: true,
        command: state.command,
        message: { command: state.command, data: data }
    };
}

/**
 * 传输中止标记:loadId 匹配在途传输则立刻清空累积槽,释放已累积的行对象。
 * 宿主在传输被打断(刷新/新加载取代,见 postMessageWithLines 的中止分支)时补发;
 * 没有它,1GB 文件传到 90% 被打断后,已累积的几百 MB 行对象要等下一次加载的
 * 头部到达才会被释放,期间既不可见也不可用。
 * @param {object} envelope {command:'chunkTransferAbort', loadId}
 * @returns {{accepted: boolean, command?: string}}
 */
function chunkedLoadAbort(envelope) {
    if (chunkedLoadState && envelope.loadId === chunkedLoadState.loadId) {
        var command = chunkedLoadState.command;
        chunkedLoadState = null;
        return { accepted: true, command: command };
    }
    return { accepted: false };
}

/** 清空累积槽(测试/防御用) */
function chunkedLoadReset() {
    chunkedLoadState = null;
}

// ========== 反向分块(webview → 宿主导出大数组) ==========
// 与 src/chunkedTransfer.ts 的 planLineChunks 同算法同参数(两侧切块边界
// 由 test/chunkedLoad.test.cjs 的契约用例锁一致)。宿主→webview 走三段式
// 头部/块/完成;webview→宿主的导出走 exportLogsBegin/Chunk/Done。

var CHUNK_TRANSFER_MAX_CHARS = 8 * 1024 * 1024;
var PER_LINE_OVERHEAD_CHARS = 128;

/** 单行内容超过该字符数时,独占块也超单条消息上限 → 明确报错而非静默卡死 */
var SAFE_SINGLE_LINE_CHARS = 250 * 1000 * 1000;

/**
 * 按序列化字符预算把行数组切块([start,end) 半开区间)。
 * 单行超预算时独占一块(绝不拆行);返回空数组表示无需发送。
 * 超过 SAFE_SINGLE_LINE_CHARS 的单行会带 oversize 标记,调用方负责提示。
 */
function planLineChunkRanges(lines, maxChars) {
    var budget = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : CHUNK_TRANSFER_MAX_CHARS;
    var plans = [];
    var start = 0;
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
        var content = lines[i] && typeof lines[i].content === 'string' ? lines[i].content : '';
        var cost = content.length + PER_LINE_OVERHEAD_CHARS;
        if (used > 0 && used + cost > budget) {
            plans.push({ start: start, end: i });
            start = i;
            used = 0;
        }
        used += cost;
    }
    if (start < lines.length) {
        plans.push({ start: start, end: lines.length });
    }
    return plans;
}
