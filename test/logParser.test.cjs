/**
 * logParser 单元测试 — Node 内置 test runner,无第三方依赖。
 * 覆盖:时间戳提取、级别归一化、类名/方法名/线程名提取、时间字符串解析。
 *
 * 运行: node --test test/logParser.test.cjs(需先 npm run compile)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// require 编译后的产物 — 走 CommonJS,跟 .vscode 打包链路一致
const { LogParser } = require('../out/logParser.js');

test('extractTimestamp — ISO 形式', () => {
    const d = LogParser.extractTimestamp('2024-05-01 12:34:56 INFO test');
    assert.ok(d instanceof Date);
    assert.equal(d.getFullYear(), 2024);
    assert.equal(d.getMonth() + 1, 5);
    assert.equal(d.getHours(), 12);
});

test('extractTimestamp — 带毫秒', () => {
    const d = LogParser.extractTimestamp('2024-05-01 12:34:56.789 INFO');
    assert.ok(d);
    assert.equal(d.getMilliseconds(), 789);
});

test('extractTimestamp — ISO 8601 带时区', () => {
    const d = LogParser.extractTimestamp('2024-05-01T12:34:56Z something');
    assert.ok(d);
    assert.equal(d.getUTCFullYear(), 2024);
});

test('extractTimestamp — 无时间戳返回 undefined', () => {
    assert.equal(LogParser.extractTimestamp('random line without timestamp'), undefined);
});

test('extractLogLevel — INFO / WARN / ERROR / DEBUG 归一化', () => {
    assert.equal(LogParser.extractLogLevel('2024-01-01 12:00:00 INFO Hello'), 'INFO');
    assert.equal(LogParser.extractLogLevel('2024-01-01 12:00:00 WARN Hello'), 'WARN');
    assert.equal(LogParser.extractLogLevel('2024-01-01 12:00:00 ERROR Hello'), 'ERROR');
    assert.equal(LogParser.extractLogLevel('2024-01-01 12:00:00 DEBUG Hello'), 'DEBUG');
});

test('extractLogLevel — 别名归一化', () => {
    assert.equal(LogParser.extractLogLevel('... SEVERE crash'), 'ERROR');
    assert.equal(LogParser.extractLogLevel('... FATAL oops'), 'ERROR');
    assert.equal(LogParser.extractLogLevel('... WARNING deprecated'), 'WARN');
    assert.equal(LogParser.extractLogLevel('... INFORMATION notice'), 'INFO');
    assert.equal(LogParser.extractLogLevel('... VERBOSE chatty'), 'DEBUG');
});

test('extractLogLevel — 方括号形式', () => {
    assert.equal(LogParser.extractLogLevel('2024-01-01 12:00:00 [ERROR] failed'), 'ERROR');
});

test('extractClassName — Java FQN', () => {
    const line = '2024-05-01 12:00:00 INFO 1 [main] com.example.MyClass hello';
    assert.equal(LogParser.extractClassName(line), 'com.example.MyClass');
});

test('extractClassName — 中文包名也支持(Unicode 友好)', () => {
    // \p{L} + u flag 让中文标识符也能被提取
    const line = '2024-05-01 12:00:00 INFO 中文.示例类 test';
    const cls = LogParser.extractClassName(line);
    // 应该能识别出包含中文的类名
    assert.ok(cls && cls.includes('中文'), `expected cls to include 中文, got: ${cls}`);
});

test('extractMethodName — [methodName:line]', () => {
    assert.equal(LogParser.extractMethodName('... [main:42] Hello'), 'main');
    assert.equal(LogParser.extractMethodName('... [catalogueSave:479] ok'), 'catalogueSave');
});

test('extractMethodName — 无方法名返回 undefined', () => {
    assert.equal(LogParser.extractMethodName('no method here'), undefined);
});

test('extractThreadName — 标准 Java 线程名', () => {
    assert.equal(LogParser.extractThreadName('2024-05-01 12:00:00 INFO [http-nio-8080-exec-3] data.AccessFilter'), 'http-nio-8080-exec-3');
});

test('extractThreadName — 不把日志级别识别为线程名', () => {
    assert.equal(LogParser.extractThreadName('[ERROR] something'), undefined);
    assert.equal(LogParser.extractThreadName('[INFO] [WARN] [DEBUG]'), undefined);
});

test('extractThreadName — 排除 [method:line] 形式', () => {
    assert.equal(LogParser.extractThreadName('[main:42] inside'), undefined);
});

test('parseTimeString — 标准 YYYY-MM-DD HH:mm:ss', () => {
    const d = LogParser.parseTimeString('2024-05-01 12:34:56');
    assert.ok(d);
    assert.equal(d.getFullYear(), 2024);
    assert.equal(d.getSeconds(), 56);
});

test('parseTimeString — 斜杠日期也兼容', () => {
    const d = LogParser.parseTimeString('2024/05/01 12:34:56');
    assert.ok(d);
    assert.equal(d.getFullYear(), 2024);
});

test('parseTimeString — 无效格式返回 undefined', () => {
    assert.equal(LogParser.parseTimeString('not a time'), undefined);
    assert.equal(LogParser.parseTimeString(''), undefined);
});

test('buildMethodPattern — 用户输入的正则元字符被转义', () => {
    const pat = LogParser.buildMethodPattern('a.b*c');
    assert.ok(pat.test('[a.b*c:1]'), '应能匹配被转义后的模式');
    assert.ok(!pat.test('[aXbXc:1]'), '不应匹配未转义的版本');
});

test('normalizeLevel — 通过 extractLogLevel 间接验证全部分支', () => {
    // TRACE / VERBOSE 应归一化为 DEBUG
    assert.equal(LogParser.extractLogLevel('... TRACE noisy'), 'DEBUG');
    assert.equal(LogParser.extractLogLevel('... VERBOSE chatty'), 'DEBUG');
});