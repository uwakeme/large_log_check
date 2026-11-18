'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveVersionFromTag,
  extractChangelogSection,
  toReleaseNotes,
  assertVersionMatchesPackage,
} = require('../scripts/release-prep.cjs');

const ROOT_DIR = path.resolve(__dirname, '..');

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- 还没发布的改动

## [1.5.3] - 2026-11-18
### Fixed
- **带点号的线程名认不出来** — 现在照常标出

## [1.5.2] - 2026-11-11
### Added
- **新增文件大小上限设置** — 默认 1GB
`;

test('resolveVersionFromTag: 去掉 v 前缀并容忍空白', () => {
  assert.strictEqual(resolveVersionFromTag('v1.5.3'), '1.5.3');
  assert.strictEqual(resolveVersionFromTag('1.5.3'), '1.5.3');
  assert.strictEqual(resolveVersionFromTag('  v1.5.3  '), '1.5.3');
});

test('resolveVersionFromTag: 预发布版本号保留后缀', () => {
  assert.strictEqual(resolveVersionFromTag('v1.6.0-rc.1'), '1.6.0-rc.1');
});

test('resolveVersionFromTag: 非法 tag 抛错', () => {
  assert.throws(() => resolveVersionFromTag(''), /缺少 tag 参数/);
  assert.throws(() => resolveVersionFromTag('main'), /无法从 tag/);
  assert.throws(() => resolveVersionFromTag('v1.5'), /无法从 tag/);
  assert.throws(() => resolveVersionFromTag('v1.5.3.4'), /无法从 tag/);
});

test('extractChangelogSection: 只取到目标版本段落，不含标题行', () => {
  const notes = extractChangelogSection(SAMPLE, '1.5.3');
  assert.match(notes, /带点号的线程名认不出来/);
  assert.doesNotMatch(notes, /新增文件大小上限设置/);
  assert.doesNotMatch(notes, /还没发布的改动/);
  assert.doesNotMatch(notes, /^## /m);
});

test('extractChangelogSection: 版本号前缀写法不影响匹配', () => {
  const notes = extractChangelogSection(SAMPLE, 'v1.5.2');
  assert.match(notes, /新增文件大小上限设置/);
  assert.doesNotMatch(notes, /带点号的线程名认不出来/);
});

test('extractChangelogSection: 兼容 CRLF 换行', () => {
  const notes = extractChangelogSection(SAMPLE.replace(/\n/g, '\r\n'), '1.5.3');
  assert.match(notes, /带点号的线程名认不出来/);
});

test('extractChangelogSection: 找不到版本段落时抛错', () => {
  assert.throws(() => extractChangelogSection(SAMPLE, '9.9.9'), /找不到版本 9\.9\.9 的段落/);
});

test('extractChangelogSection: 段落为空时抛错', () => {
  assert.throws(
    () => extractChangelogSection('## [1.0.0]\n\n## [0.9.0]\n- 更早的改动\n', '1.0.0'),
    /段落是空的/
  );
});

test('toReleaseNotes: 去掉条目标题上的加粗标记', () => {
  const notes = toReleaseNotes('### Fixed\n- **带点号的线程名认不出来** — 现在能识别了');
  assert.strictEqual(notes, '### Fixed\n- 带点号的线程名认不出来 — 现在能识别了');
});

test('toReleaseNotes: 保留小节标题与段落间的空行', () => {
  const notes = toReleaseNotes(
    '### Added\n- **新增设置** — 默认 1GB\n\n### Fixed\n- **修好了** — 不再卡死'
  );
  assert.strictEqual(notes, '### Added\n- 新增设置 — 默认 1GB\n\n### Fixed\n- 修好了 — 不再卡死');
});

test('toReleaseNotes: 统一 CRLF 并压缩多余空行', () => {
  const notes = toReleaseNotes('### Fixed\r\n- **甲** — 乙\r\n\r\n\r\n\r\n### Changed\r\n- **丙** — 丁');
  assert.strictEqual(notes, '### Fixed\n- 甲 — 乙\n\n### Changed\n- 丙 — 丁');
});

test('assertVersionMatchesPackage: 一致时返回版本号', () => {
  assert.strictEqual(assertVersionMatchesPackage('1.5.3', { version: '1.5.3' }), '1.5.3');
});

test('assertVersionMatchesPackage: 不一致时抛错并说明两边的版本', () => {
  assert.throws(
    () => assertVersionMatchesPackage('1.5.3', { version: '1.5.2' }),
    /版本不一致：tag 是 1\.5\.3，package\.json 是 1\.5\.2/
  );
});

test('仓库现状：CHANGELOG 必须有当前 package.json 版本的段落', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  const notes = extractChangelogSection(changelog, packageJson.version);
  assert.ok(notes.length > 0, `版本 ${packageJson.version} 的 CHANGELOG 段落是空的`);
});

test('仓库现状：当前版本的 Release 说明与历史 Release 格式一致', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  const notes = toReleaseNotes(extractChangelogSection(changelog, packageJson.version));
  assert.doesNotMatch(notes, /\*\*/, 'Release 说明里不应残留加粗标记');
  assert.match(notes, /^### (Added|Changed|Fixed)/, 'Release 说明应以 ### 小节开头');
  assert.doesNotMatch(notes, /^\#\# /m, 'Release 说明里不应出现版本标题行');
});
