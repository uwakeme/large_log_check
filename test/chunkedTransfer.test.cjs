'use strict';

// chunkedTransfer 是被 tsc 编到 out/ 下的;npm test 脚本会先 compile 再 node --test
const { planLineChunks, CHUNK_TRANSFER_MAX_CHARS, PER_LINE_OVERHEAD_CHARS, SAFE_SINGLE_LINE_CHARS } = require('../out/chunkedTransfer.js');

const test = require('node:test');
const assert = require('node:assert/strict');

/** 造 n 行、每行 content 长度为 len 的行数组 */
function makeLines(count, len) {
    return Array.from({ length: count }, (_, i) => ({
        lineNumber: i + 1,
        content: 'x'.repeat(len)
    }));
}

// ===== 1. 常量 =====

test('每块字符预算与单行开销常量导出且为正整数', () => {
    assert.equal(typeof CHUNK_TRANSFER_MAX_CHARS, 'number');
    assert.ok(Number.isInteger(CHUNK_TRANSFER_MAX_CHARS) && CHUNK_TRANSFER_MAX_CHARS > 0);
    assert.equal(PER_LINE_OVERHEAD_CHARS, 128);
    // 单行安全上限:须在 V8 单字符串上限(约 5.37 亿字符)之内留出 JSON 转义余量
    assert.equal(typeof SAFE_SINGLE_LINE_CHARS, 'number');
    assert.ok(SAFE_SINGLE_LINE_CHARS > 100 * 1000 * 1000 && SAFE_SINGLE_LINE_CHARS < 536 * 1000 * 1000);
});

// ===== 2. 基础切块 =====

test('空数组返回空切块列表(无需发送任何块)', () => {
    assert.deepEqual(planLineChunks([]), []);
});

test('总量在预算内切成单块,覆盖全部行', () => {
    const lines = makeLines(100, 1000); // 100 * (1000+128) ≈ 112K 字符
    const plans = planLineChunks(lines);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0], { start: 0, end: 100 });
});

test('总量超预算按预算切块,块区间连续无缝且覆盖全部行', () => {
    const lines = makeLines(1000, 1000); // 每行 1128 字符,总 ~1.13M
    const plans = planLineChunks(lines, 5000); // 预算 5000 → 每块 4 行
    assert.ok(plans.length > 1);
    // 区间连续、无缝、覆盖全量
    assert.equal(plans[0].start, 0);
    assert.equal(plans[plans.length - 1].end, lines.length);
    for (let i = 1; i < plans.length; i++) {
        assert.equal(plans[i].start, plans[i - 1].end, `第 ${i} 块应紧接前一块`);
    }
    // 每块预算不超(首块除外的首行场景不适用于均匀行)
    for (const p of plans) {
        const chars = (p.end - p.start) * (1000 + PER_LINE_OVERHEAD_CHARS);
        assert.ok(chars <= 5000, `块 [${p.start},${p.end}) 共 ${chars} 字符应不超过预算`);
    }
});

test('恰好整除预算时不产生空尾块', () => {
    // 3 行、每行成本 128 → 预算 384 恰好容纳 3 行
    const lines = makeLines(3, 0);
    const plans = planLineChunks(lines, 3 * PER_LINE_OVERHEAD_CHARS);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0], { start: 0, end: 3 });
});

// ===== 3. 单行超预算 =====

test('单行超过预算时独占一块,绝不拆行', () => {
    const lines = [
        ...makeLines(2, 10),
        { lineNumber: 3, content: 'y'.repeat(10000) },
        ...makeLines(2, 10)
    ];
    const plans = planLineChunks(lines, 500);
    // 前两行一块(2*138=276 ≤ 500,加上超长行会超 → 结算),超长行独占,后两行一块
    assert.deepEqual(plans, [
        { start: 0, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 5 }
    ]);
});

test('全部行都超预算时每行各占一块', () => {
    const lines = makeLines(4, 2000);
    const plans = planLineChunks(lines, 1000);
    assert.equal(plans.length, 4);
    plans.forEach((p, i) => {
        assert.deepEqual(p, { start: i, end: i + 1 });
    });
});

// ===== 4. 不均匀行长 =====

test('短行与长行混合时切块仍连续且每块不超预算', () => {
    const lines = [
        ...makeLines(10, 10),          // 10 * 138 = 1380
        ...makeLines(1, 100000),       // 超大行
        ...makeLines(10, 10)
    ];
    const plans = planLineChunks(lines, 2000);
    let cursor = 0;
    for (const p of plans) {
        assert.equal(p.start, cursor);
        let chars = 0;
        for (let i = p.start; i < p.end; i++) {
            chars += lines[i].content.length + PER_LINE_OVERHEAD_CHARS;
        }
        assert.ok(chars <= 2000 || p.end - p.start === 1, '超预算的块只允许是单行独占块');
        cursor = p.end;
    }
    assert.equal(cursor, lines.length);
});

// ===== 5. 防御性行为 =====

test('content 缺失/非字符串的行按 0 字符计,不抛异常', () => {
    const lines = [
        { lineNumber: 1 },
        { lineNumber: 2, content: null },
        { lineNumber: 3, content: 'ok' }
    ];
    const plans = planLineChunks(lines);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0], { start: 0, end: 3 });
});

test('默认预算下,650MB 级文件(45 万行 × 1.4KB)切成几十到一百多块', () => {
    const lines = makeLines(457101, 1400);
    const plans = planLineChunks(lines);
    // 每块 ≈ 8M / 1528 ≈ 5475 行 → 约 84 块
    assert.ok(plans.length >= 50 && plans.length <= 200,
        `切块数 ${plans.length} 应在 50~200 之间`);
    assert.equal(plans[plans.length - 1].end, 457101);
});
