'use strict';

/**
 * 发版准备：校验 tag 与 package.json 的 version 是否一致，并从 CHANGELOG.md 提取该版本的段落。
 *
 * 用法：
 *   node scripts/release-prep.cjs v1.5.3          # 用仓库根目录的 CHANGELOG.md
 *   node scripts/release-prep.cjs v1.5.3 a/b.md   # 指定 CHANGELOG 路径
 *
 * 行为约定：
 *   - 成功：stdout 输出该版本的 CHANGELOG 正文（可直接作为 GitHub Release 说明）
 *   - 失败：stderr 输出原因并以退出码 1 结束（CI 随即失败，避免带着空说明发版）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

/** 转义正则元字符（版本号里的点要按字面量匹配） */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 tag 名解析版本号：v1.5.3 → 1.5.3（不带 v 前缀也接受）
 * 只接受 x.y.z 与 x.y.z-预发布 两种形式，其它一律视为非法
 */
function resolveVersionFromTag(tag) {
  const trimmed = String(tag || '').trim();
  if (!trimmed) {
    throw new Error('缺少 tag 参数');
  }
  const matched = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(trimmed);
  if (!matched) {
    throw new Error(`无法从 tag "${trimmed}" 解析版本号（期望形如 v1.5.3）`);
  }
  return matched[1];
}

/**
 * 取 CHANGELOG 中指定版本的段落正文（不含 `## [x.y.z] - 日期` 标题行）
 * 段落从标题行之后开始，到下一个 `## ` 标题之前结束
 */
function extractChangelogSection(changelogText, version) {
  // 容忍直接传 tag（带 v 前缀）的用法
  const target = String(version || '').trim().replace(/^v/i, '');
  if (!target) {
    throw new Error('缺少版本号');
  }
  const lines = String(changelogText).split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+\\[?${escapeRegExp(target)}\\]?(\\s+-\\s+.+)?$`);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    throw new Error(`CHANGELOG.md 中找不到版本 ${target} 的段落`);
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start, end).join('\n').trim();
  if (!body) {
    throw new Error(`CHANGELOG.md 中版本 ${target} 的段落是空的`);
  }
  return body;
}

/**
 * 把 CHANGELOG 段落转成 Release 说明，格式与历史 Release 正文保持一致：
 * - 去掉条目标题上的加粗标记（`**标题**` → `标题`）
 * - 统一换行为 LF，压缩多余空行
 */
function toReleaseNotes(section) {
  return String(section)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\*\*(.+?)\*\*/g, '$1'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 校验 tag 版本与 package.json 的 version 一致，不一致直接抛错 */
function assertVersionMatchesPackage(version, packageJson) {
  const current = packageJson && packageJson.version;
  if (!current) {
    throw new Error('package.json 里没有 version 字段');
  }
  if (current !== version) {
    throw new Error(`版本不一致：tag 是 ${version}，package.json 是 ${current}。请先改 package.json 的 version 再打 tag`);
  }
  return current;
}

module.exports = {
  resolveVersionFromTag,
  extractChangelogSection,
  toReleaseNotes,
  assertVersionMatchesPackage,
};

// 命令行入口：node scripts/release-prep.cjs <tag> [changelogPath]
if (require.main === module) {
  try {
    const [tag, changelogArg] = process.argv.slice(2);
    const version = resolveVersionFromTag(tag);
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assertVersionMatchesPackage(version, packageJson);

    const changelogPath = changelogArg
      ? path.resolve(process.cwd(), changelogArg)
      : path.join(ROOT_DIR, 'CHANGELOG.md');
    const notes = extractChangelogSection(fs.readFileSync(changelogPath, 'utf8'), version);

    process.stdout.write(`${toReleaseNotes(notes)}\n`);
  } catch (error) {
    process.stderr.write(`发版准备失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
