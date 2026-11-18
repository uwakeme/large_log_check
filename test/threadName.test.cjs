'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

// threadName.js 是浏览器全局脚本(纯逻辑,加载期无副作用),
// 按 AGENTS.md 约定用 vm 加载后取其全局函数/常量。
const src = readFileSync(join(__dirname, '..', 'media', 'threadName.js'), 'utf8');

function loadSandbox() {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox;
}

/** 用内置规则的正则去整行里找命中(等价于 webview.js 高亮链的做法) */
function matchWithBuiltinRule(sandbox, line) {
    const regex = new RegExp(sandbox.THREAD_HIGHLIGHT_PATTERN, 'g');
    const hits = [];
    let m;
    while ((m = regex.exec(line)) !== null) {
        hits.push(m[0]);
        if (m[0].length === 0) { regex.lastIndex++; }
    }
    return hits;
}

test('内置线程名规则: 命中带点号的线程名(Spring Boot http-nio 线程)', () => {
    const sandbox = loadSandbox();
    const line = '2026-11-18 11:10.042 [INFO ] [http-nio-127.0.0.1-16600-exec-4] data.access.filter.DataAccessFilter - ok';
    assert.deepEqual(matchWithBuiltinRule(sandbox, line), ['[http-nio-127.0.0.1-16600-exec-4]']);
});

test('内置线程名规则: 命中不含点号的常见线程名', () => {
    const sandbox = loadSandbox();
    assert.deepEqual(
        matchWithBuiltinRule(sandbox, '2026-11-18 11:10.042 [INFO ] [main] c.r.a.r.service.impl.Foo - ok'),
        ['[main]']
    );
    assert.deepEqual(
        matchWithBuiltinRule(sandbox, '2026-11-18 11:10.042 [INFO ] [http-nio-8080-exec-1] com.example.Bar - ok'),
        ['[http-nio-8080-exec-1]']
    );
    assert.deepEqual(
        matchWithBuiltinRule(sandbox, '2026-11-18 11:10.042 [INFO ] [Thread-42] com.example.Bar - ok'),
        ['[Thread-42]']
    );
});

test('内置线程名规则: 不把日志级别括号当线程名', () => {
    const sandbox = loadSandbox();
    assert.deepEqual(matchWithBuiltinRule(sandbox, '2026-11-18 11:10.042 [INFO ] com.example.Bar - ok'), []);
    assert.deepEqual(matchWithBuiltinRule(sandbox, '2026-11-18 11:10.042 [ERROR] com.example.Bar - boom'), []);
});

test('内置线程名规则: 不把方法名括号当线程名', () => {
    const sandbox = loadSandbox();
    assert.deepEqual(
        matchWithBuiltinRule(sandbox, '2026-11-18 11:10.042 [INFO ] [listFn:306] demo.data.mapper.impl.GenericDataMapper : ok'),
        []
    );
});

test('提取线程名: 带点号的线程名原样取出', () => {
    const sandbox = loadSandbox();
    assert.equal(
        sandbox.extractThreadNameFromHighlight('[http-nio-127.0.0.1-16600-exec-4]'),
        'http-nio-127.0.0.1-16600-exec-4'
    );
});

test('提取线程名: 普通线程名', () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.extractThreadNameFromHighlight('[main]'), 'main');
    assert.equal(sandbox.extractThreadNameFromHighlight('[http-nio-8080-exec-1]'), 'http-nio-8080-exec-1');
});

test('提取线程名: 自定义规则命中不带括号时按整段取', () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.extractThreadNameFromHighlight('http-nio-8080-exec-1'), 'http-nio-8080-exec-1');
});

test('提取线程名: 命中片段里带额外内容时取括号内的线程名', () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.extractThreadNameFromHighlight('[main] extra'), 'main');
});

test('提取线程名: 识别不出时返回空串(不给假线程名挂筛选入口)', () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.extractThreadNameFromHighlight('[listFn:306]'), '');
    assert.equal(sandbox.extractThreadNameFromHighlight(''), '');
    assert.equal(sandbox.extractThreadNameFromHighlight(null), '');
    assert.equal(sandbox.extractThreadNameFromHighlight(undefined), '');
});

test('提取线程名: 与后端 extractThreadName 口径一致(同一个名字才能筛出结果)', () => {
    const sandbox = loadSandbox();
    // 后端(src/logParser.ts)对同一行算出的线程名
    const { LogParser } = require('../out/logParser.js');
    const line = '2026-11-18 11:10.042 [INFO ] [http-nio-127.0.0.1-16600-exec-4] data.access.filter.DataAccessFilter - ok';
    const backendName = LogParser.extractThreadName(line);
    const frontendName = sandbox.extractThreadNameFromHighlight('[http-nio-127.0.0.1-16600-exec-4]');
    assert.equal(frontendName, backendName);
});
