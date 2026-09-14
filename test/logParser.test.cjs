'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// logParser 是被 tsc 编到 out/ 下的;npm test 脚本会先 compile 再 node --test
const {
    LogParser,
    setLevelAliases,
    parseLevelAliases,
} = require('../out/logParser.js');

// 每次测试前重置别名（清掉 setLevelAliases 改过的 module 状态），保证隔离
test.beforeEach(() => {
    setLevelAliases([]);
    // setLevelAliases([]) 在 length===0 时回退到 DEFAULT_LEVEL_ALIASES（设计如此）。
    // 真正想测「未传配置」的行为时用这个 beforeEach 即可。
});

test.afterEach(() => {
    setLevelAliases([]);
});

// =====================================================================
// 1. 默认表映射（issue #3 核心诉求）
// =====================================================================
test('默认别名：单字符 I/E/W/D/T/V/F 都能识别', () => {
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 I start'),  'INFO');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 E crash'),  'ERROR');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 W warn'),   'WARN');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 D trace'),  'DEBUG');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 T trace2'), 'DEBUG');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 V verb'),   'DEBUG');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 F fatal'),  'ERROR');
});

test('默认别名：多字符变体 ERR/WRN/INF/DBG/TRC 各归其位', () => {
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 ERR boom'),  'ERROR');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 WRN warn'),  'WARN');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 INF info'),  'INFO');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 DBG dbg'),   'DEBUG');
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 TRC trace'), 'DEBUG');
});

test('方括号形式也支持单字符别名', () => {
    assert.equal(LogParser.extractLogLevel('[E] something'), 'ERROR');
    assert.equal(LogParser.extractLogLevel('[I] something'), 'INFO');
    assert.equal(LogParser.extractLogLevel('[W] something'), 'WARN');
});

// =====================================================================
// 2. 形态边界
// =====================================================================
test('quick 形态：时间戳后的单字符别名识别', () => {
    assert.equal(LogParser.extractLogLevel('10:00:00 E x'), 'ERROR');
});

test('bracket 形态：[E] 识别', () => {
    assert.equal(LogParser.extractLogLevel('[E] x'), 'ERROR');
});

test('bare 形态：单字符不参与裸词（避免 I/O、英文 I 误判）', () => {
    // E/tag x 在默认表下不应被当作 ERROR（裸词不识别单字符别名）
    assert.equal(LogParser.extractLogLevel('E/tag x'), undefined);
});

// =====================================================================
// 3. 标准词回归（与现状一致）
// =====================================================================
test('标准词 ERROR quick 形态', () => {
    assert.equal(LogParser.extractLogLevel('10:00:00 ERROR x'), 'ERROR');
});

test('标准词 INFO bracket 形态', () => {
    assert.equal(LogParser.extractLogLevel('[INFO] x'), 'INFO');
});

test('裸词 standard token — 消息里出现 error 小写也识别', () => {
    // 标准 token 大小写不敏感（正则 i flag）
    assert.equal(LogParser.extractLogLevel('an error happened'), 'ERROR');
});

// =====================================================================
// 4. 负样例（关键）
// =====================================================================
test('East / Window 不被误判为 ERROR/WARN（标准词没匹配 + 裸词单字符不参与）', () => {
    assert.equal(LogParser.extractLogLevel('East bound train'), undefined);
    assert.equal(LogParser.extractLogLevel('Window 7 boot complete'), undefined);
});

test('disk I/O error on sda1 — I 不参与裸词，应判 ERROR（标准 ERROR 命中）', () => {
    // 关键负样例：如果 I 进了裸词，I 会先匹配 → 错判 INFO。
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00.123 disk I/O error on sda1'), 'ERROR');
});

test('英文代词 I think we should retry — I 不参与裸词，无级别', () => {
    assert.equal(LogParser.extractLogLevel('I think we should retry'), undefined);
});

// =====================================================================
// 5. 配置生效（setLevelAliases / parseLevelAliases）
// =====================================================================
test('setLevelAliases 后立即用新表', () => {
    setLevelAliases([{ token: 'EXCEPTION', canonical: 'ERROR' }]);
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 EXCEPTION boom'), 'ERROR');
    // 同时默认表里的 I 应该不再识别为 INFO（被用户配置整体替换）
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 I start'), undefined);
});

test('setLevelAliases([]) 恢复默认表', () => {
    setLevelAliases([{ token: 'EXCEPTION', canonical: 'ERROR' }]);
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 I start'), undefined);
    setLevelAliases([]);
    assert.equal(LogParser.extractLogLevel('2026-09-14 10:00:00 I start'), 'INFO');
});

test('parseLevelAliases 校验/归一化用户配置', () => {
    const out = parseLevelAliases({
        ERROR: [' e ', 'ERR', 'E', 'E'],  // 去空白、大写、去重
        WARN:  ['WRN'],
        INFO:  ['I'],
        DEBUG: ['D'],
        INVALID: ['xxx'],                 // 非法键忽略
    });
    const tokens = out.map(e => e.token).sort();
    assert.deepEqual(tokens, ['D', 'E', 'ERR', 'I', 'WRN'].sort());
    // 非法键被忽略
    assert.equal(out.find(e => e.canonical === ('INVALID')), undefined);
});

test('parseLevelAliases 非对象 / 空 → 默认表', () => {
    assert.equal(parseLevelAliases(null).length > 0, true);
    assert.equal(parseLevelAliases(undefined).length > 0, true);
    assert.equal(parseLevelAliases('garbage').length > 0, true);
    // 空对象：四个键都没有效 token → 默认表
    assert.equal(parseLevelAliases({}).length, 12);  // DEFAULT_LEVEL_ALIASES 的长度
});

test('parseLevelAliases 单个键的 tokens 为空数组 → 整体返回默认表', () => {
    const out = parseLevelAliases({ ERROR: [] });
    // 整体没有有效 token → 回到默认
    assert.equal(out.length, 12);
});

// =====================================================================
// 6. normalizeLevel 兜底（标准词仍按原 4 桶映射）
// =====================================================================
test('normalizeLevel 兜底：FATAL/SEVERE → ERROR', () => {
    // normalizeLevel 是 private，但通过 extractLogLevel 的 bracket 路径间接验证
    assert.equal(LogParser.extractLogLevel('10:00:00 FATAL x'),  'ERROR');
    assert.equal(LogParser.extractLogLevel('10:00:00 SEVERE x'), 'ERROR');
});

test('normalizeLevel 兜底：WARNING → WARN、INFORMATION → INFO', () => {
    assert.equal(LogParser.extractLogLevel('10:00:00 WARNING x'),     'WARN');
    assert.equal(LogParser.extractLogLevel('10:00:00 INFORMATION x'), 'INFO');
});

test('normalizeLevel 兜底：TRACE/VERBOSE → DEBUG', () => {
    assert.equal(LogParser.extractLogLevel('10:00:00 TRACE x'),   'DEBUG');
    assert.equal(LogParser.extractLogLevel('10:00:00 VERBOSE x'), 'DEBUG');
});

// =====================================================================
// 7. extractThreadName — 排除集要包含标准 token + 活跃 alias token
// =====================================================================
test('extractThreadName：[E]/[ERR] 不作线程名（默认表下被排除）', () => {
    assert.equal(LogParser.extractThreadName('[E] something'), undefined);
    assert.equal(LogParser.extractThreadName('[ERR] something'), undefined);
});

test('extractThreadName：[main]/[http-nio-1] 仍识别为线程名', () => {
    assert.equal(LogParser.extractThreadName('[main] work'),           'main');
    assert.equal(LogParser.extractThreadName('[http-nio-1] work'),    'http-nio-1');
});

test('extractThreadName：用户加 EXCEPTION 别名后，[EXCEPTION] 也不作线程名', () => {
    setLevelAliases([{ token: 'EXCEPTION', canonical: 'ERROR' }]);
    assert.equal(LogParser.extractThreadName('[EXCEPTION] boom'), undefined);
    setLevelAliases([]);
});
