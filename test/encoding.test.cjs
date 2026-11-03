'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 编译产物在 out/ 下;npm test 脚本会先 compile 再 node --test
const { detectEncoding, decoderLabel } = require('../out/encoding.js');
const { LogProcessor } = require('../out/logProcessor.js');

// =====================================================================
// 0. 环境哨兵:官方发行版 Node 自带全量 ICU,TextDecoder 支持 gb18030。
//    若这个用例挂了,说明跑测试的 Node 是裁剪过 ICU 的定制构建,
//    后面所有 GBK 相关行为在该环境下都不可用 — 与实现无关,先修环境。
// =====================================================================
test('环境哨兵:当前 Node 的 TextDecoder 支持 gb18030 解码', () => {
    // 「中文」的 GBK 字节序列
    const decoded = new TextDecoder('gb18030').decode(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    assert.equal(decoded, '中文');
});

// =====================================================================
// 1. detectEncoding:BOM 优先
// =====================================================================
test('BOM:UTF-8(EF BB BF)识别为 utf-8 且带 BOM 标记', () => {
    const buf = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('2026-11-03 INFO 服务启动\n', 'utf8')
    ]);
    assert.deepEqual(detectEncoding(buf), { encoding: 'utf-8', hasBom: true });
});

test('BOM:UTF-16 LE(FF FE)识别为 utf-16le', () => {
    const buf = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('服务启动\n', 'utf16le')
    ]);
    assert.deepEqual(detectEncoding(buf), { encoding: 'utf-16le', hasBom: true });
});

test('BOM:UTF-16 BE(FE FF)识别为 utf-16be', () => {
    const text = '服务启动\n';
    const be = Buffer.from(text, 'utf16le').swap16();
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    assert.deepEqual(detectEncoding(buf), { encoding: 'utf-16be', hasBom: true });
});

// =====================================================================
// 2. detectEncoding:无 BOM 时按「严格 UTF-8 试解」分流
// =====================================================================
test('无 BOM:合法 UTF-8 中文识别为 utf-8', () => {
    const buf = Buffer.from('2026-11-03 INFO 服务启动完成\n', 'utf8');
    assert.deepEqual(detectEncoding(buf), { encoding: 'utf-8', hasBom: false });
});

test('无 BOM:纯 ASCII 识别为 utf-8(ASCII 是任何编码的公共子集)', () => {
    const buf = Buffer.from('2026-11-03 10:00:00 INFO started\n', 'utf8');
    assert.deepEqual(detectEncoding(buf), { encoding: 'utf-8', hasBom: false });
});

test('无 BOM:GBK 中文识别为 gbk(GBK 字节几乎不可能恰好是合法 UTF-8)', () => {
    // 「服务启动完成」的 GBK 字节(手工固定,做夹具用)
    const gbk = Buffer.from([0xb7, 0xfe, 0xce, 0xf1, 0xc6, 0xf4, 0xb6, 0xaf, 0xcd, 0xea, 0xb3, 0xc9]);
    assert.equal(new TextDecoder('gb18030').decode(gbk), '服务启动完成'); // 夹具自校验
    assert.deepEqual(detectEncoding(gbk), { encoding: 'gbk', hasBom: false });
});

test('无 BOM:孤立无效字节(0x80)落入 gbk 兜底', () => {
    const buf = Buffer.concat([Buffer.from('2026-11-03 INFO '), Buffer.from([0x80, 0x81])]);
    assert.equal(detectEncoding(buf).encoding, 'gbk');
});

test('无 BOM:64KB 边界截断的多字节序列不误判(stream 缓冲)', () => {
    // 结尾是被截断的三字节 UTF-8 序列开头(E4 B8),严格解码不应报错
    const buf = Buffer.concat([
        Buffer.from('a'.repeat(100), 'utf8'),
        Buffer.from([0xe4, 0xb8])
    ]);
    assert.equal(detectEncoding(buf).encoding, 'utf-8');
});

// =====================================================================
// 3. decoderLabel:编码 → TextDecoder 标签映射
// =====================================================================
test('decoderLabel:gbk 映射到超集 gb18030,其余原样', () => {
    assert.equal(decoderLabel('gbk'), 'gb18030');
    assert.equal(decoderLabel('utf-8'), 'utf-8');
    assert.equal(decoderLabel('utf-16le'), 'utf-16le');
    assert.equal(decoderLabel('utf-16be'), 'utf-16be');
});

// =====================================================================
// 4. LogProcessor 集成:解码读取 + 破坏性操作守卫
// =====================================================================
let tmpDir;
test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olv-encoding-'));
});
test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 「2026-11-03 10:00:00 INFO 服务启动完成」整行的 GBK 字节 */
function gbkLine() {
    return Buffer.concat([
        Buffer.from('2026-11-03 10:00:00 INFO ', 'utf8'),
        Buffer.from([0xb7, 0xfe, 0xce, 0xf1, 0xc6, 0xf4, 0xb6, 0xaf, 0xcd, 0xea, 0xb3, 0xc9]),
        Buffer.from('\n', 'utf8')
    ]);
}

test('集成:GBK 文件 readAllLines 解码为可读中文,不乱码', async () => {
    const file = path.join(tmpDir, 'gbk.log');
    fs.writeFileSync(file, Buffer.concat([gbkLine(), gbkLine()]));
    const processor = new LogProcessor(file);
    const lines = await processor.readAllLines();
    assert.equal(lines.length, 2);
    assert.equal(lines[0].content, '2026-11-03 10:00:00 INFO 服务启动完成');
});

test('集成:UTF-16 LE(BOM) 文件 readAllLines 正常解码', async () => {
    const file = path.join(tmpDir, 'utf16le.log');
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('2026-11-03 10:00:00 INFO 服务启动\n', 'utf16le')
    ]));
    const processor = new LogProcessor(file);
    const lines = await processor.readAllLines();
    assert.equal(lines[0].content, '2026-11-03 10:00:00 INFO 服务启动');
});

test('集成:UTF-8(带 BOM) 文件首行不带 U+FEFF 前缀', async () => {
    const file = path.join(tmpDir, 'utf8bom.log');
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('2026-11-03 10:00:00 INFO started\n', 'utf8')
    ]));
    const processor = new LogProcessor(file);
    const lines = await processor.readAllLines();
    assert.ok(!lines[0].content.startsWith('\ufeff'), '首行不应残留 BOM 字符');
    assert.equal(lines[0].content, '2026-11-03 10:00:00 INFO started');
});

test('集成:GBK 文件执行 deleteByLine 被拦截并给出明确提示', async () => {
    const file = path.join(tmpDir, 'gbk-delete.log');
    fs.writeFileSync(file, Buffer.concat([gbkLine(), gbkLine(), gbkLine()]));
    const processor = new LogProcessor(file);
    await assert.rejects(
        () => processor.deleteByLine(1, 'before'),
        /非 UTF-8|暂不支持/
    );
    // 原文件必须原封不动(守卫在重写前拦截)
    const after = fs.readFileSync(file);
    assert.equal(after.length, gbkLine().length * 3);
});

test('集成:UTF-8 文件 deleteByLine 行为不变(回归)', async () => {
    const file = path.join(tmpDir, 'utf8-delete.log');
    fs.writeFileSync(file, 'a\nb\nc\n', 'utf8');
    const processor = new LogProcessor(file);
    const deleted = await processor.deleteByLine(1, 'before');
    assert.equal(deleted, 0); // 第 1 行之前没有行
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\nc\n');
});
