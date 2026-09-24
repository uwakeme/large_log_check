# AGENTS.md

Professional VSCode extension for viewing and processing very large log files (multi-GB, tens of millions of lines) — virtual scrolling, multi-keyword/regex search, time/level/thread filtering, fold-repeating-lines, bookmarks, comments, timeline view, and 4 selectable themes. File I/O is stream-based; the whole file is never loaded into memory.

## Setup commands

- Install deps: `npm install`
- Dev (watch): `npm run watch` — then press `F5` in VSCode to launch the Extension Development Host
- Build:       `npm run compile`   (output to `out/`)
- Lint:        `npm run lint`      (eslint src --ext ts)
- Clean:       `npm run clean`     (rimraf out)
- Rebuild:     `npm run rebuild`   (clean + compile)
- Package:     `npm run package`   (vsce package → .vsix)
- Publish:     `npm run publish`   (vsce publish — NOT used in practice; releases are manual uploads, see Release process)

## Project layout

- `src/extension.ts`        — command palette / context-menu dispatch (entry point)
- `src/logViewerPanel.ts`   — WebView lifecycle, per-file singleton, postMessage bridge
- `src/logProcessor.ts`     — stream-based file I/O (fs.createReadStream + readline)
- `src/webview.html`        — WebView HTML scaffold
- `media/webview.js`        — WebView frontend logic (search, filters, virtual scroll, timeline, bookmarks)
- `media/webview.css`       — base WebView styles
- `media/themes.css`        — 3 visual theme overlays (NEON.CYBER / AURORA.GLASS / HOLO.PRISM)
- `package.json`            — manifest, command registration, user settings
- `tsconfig.json`           — TypeScript strict mode (ES2020 / CommonJS)
- `CHANGELOG.md`            — Keep-a-Changelog format; `## [Unreleased]` lives at the top

## Code style

- TypeScript strict mode (`tsconfig.json: strict: true`); do NOT use `as any` to silence errors — fix the types
- Private class fields use the `_` prefix (`_panel`, `_fileUri`, `_logProcessor`, `_disposables`)
- Comments and UI strings are in **Chinese** — match the existing tone for any new user-facing text
- File reads are stream-based only: `fs.createReadStream` + `readline.createInterface({ crlfDelay: Infinity })`
- All async methods return `Promise<T>` explicitly; wrap stream events in `new Promise(...)`
- Disposables push to `context.subscriptions` / panel's `_disposables`; clean up in `dispose()`
- Run `npm run lint` before committing; no CI is configured locally

## Testing instructions

- Unit tests use the built-in `node:test` runner: `npm test` (= compile + `node --test test/*.test.cjs`)
- `test/` is currently empty — the previous `investigationTemplates.test.cjs` / `searchHistory.test.cjs` were removed in 2026-09, so `npm test` passes with 0 tests (the unmatched glob is tolerated, and so is `vsce package`'s prepublish chain)
- If tests are reintroduced, keep them in `test/*.test.cjs`; webview-side modules need browser-global stubs (localStorage etc.) to run under node:test
- Manual test path: `npm run watch` → `F5` in VSCode → exercise the feature in the Extension Development Host

## PR & commit conventions

- Default branch: `main` (verify with `git symbolic-ref --short refs/remotes/origin/HEAD` or `git config init.defaultBranch`)
- Branch from `main`; never push to it directly
- Conventional commits, often in Chinese — see `git log --oneline -20` for the current style
- Open the PR via `gh pr create` once `npm run lint` and `npm run compile` are green
- **Cursor rule (always applied):** every new user-facing feature must update `README.md` and `CHANGELOG.md` in the same commit. Unreleased features go under `## [Unreleased]` at the top of `CHANGELOG.md`. One entry per feature per release — do not duplicate.

### CHANGELOG 风格（v1.3.3 起生效，2026-09-14）

CHANGELOG 是**给用户看的**，不是开发人员自己看的：

- **写业务和功能的变化与修改**，不写内部实现细节
- **不写专业术语**（"陈旧守卫"、"pageRanges"、"handleDataChange" 这类开发内部概念不放）
- **不写方法名 / 类名 / 内部函数名**（`setFilterAndApply`、`LogParser.extractLogLevel` 这类不放）
- **不写 issue 编号 / commit hash / PR 链接**（不是开发 changelog，是用户 changelog）
- **不写版本号 / 日期在描述里**（版本号在 `## [1.x.y]` 标题上，描述里不重复）
- **直接说用户能看到的现象或行为**，而不是改了什么代码
- **简洁易懂**：一条 entry 一两句话，看完知道发生了什么变化、是否需要做什么操作

正例（用户视角）：

> - **折叠模式下搜索/筛选后页数不刷新、出现空白页** — 折叠浏览到第 N 页后搜索或筛选，**总页数仍显示 N 页**，翻到后面几页会完全空白
> - **支持自定义日志级别缩写** — 像 `I` / `E` / `W` 这种简写现在能识别为 INFO / ERROR / WARN，在「设置 → 扩展 → 大日志文件查看器 → Level Aliases」里调整

反例（开发视角，不要这么写）：

> - 修复 `setFilterAndApply` 中 `clearPageRanges: false` 导致 `calculateAllPagesAsync` 续算逻辑静默空转
> - 新增 `big-log-viewer.level.aliases` 配置 schema 覆盖 `DEFAULT_LEVEL_ALIASES`，正则 alternation 长 token 排前避免短 token 抢先

> 如果一条 entry 同时既有用户视角的"现象/行为"，又有开发视角的"内部修复方案"，**只写用户视角那条**。开发视角的细节走 git log / commit message / 代码注释，不进 CHANGELOG。

### Approval gates（v1.3.3 起生效，2026-09-14）

凡是会修改仓库历史或对远程产生副作用的动作，**必须先获得用户明确确认**，再由 agent 实际执行；agent 不主动触发。

| 动作 | 必须确认 | 说明 |
| --- | --- | --- |
| `git add` + `git commit` | ✅ | 不自动 commit，先输出 diff 摘要等用户点头 |
| `git tag`（含 `git tag -a`）| ✅ | 不自动打 tag，附注消息也要用户过目 |
| `git push`（含 `git push --follow-tags`、`git push --force`）| ✅ | 远程写入是单向且可见，不自动 push |
| `vsce publish` / `ovsx publish` | ✅ | 不可逆的 Marketplace 发布，**永远不自动执行**（与下文 Release process 配合） |
| `git reset --hard` / `git commit --amend` 已推送的提交 | ✅ | 改写历史的动作，先确认再执行 |
| `npm run package` 产物（`*.vsix`）| ⚠️ 可选 | 用户没要求发版就不必生成；如已生成且要丢弃，落到 `mavis-trash`（非永久 `Remove-Item`） |

**约定的交互仪式**：

1. agent 完成代码/测试/文档改动后，停下，输出一段「建议的下一步」列出候选动作（commit / tag / push / publish / .vsix）
2. 等用户回复「可以提交」「帮我 push」之类明确指令
3. agent 才执行对应命令，且在执行前再次 echo 命令与影响范围

**不要做的事**：

- 不把「计划已批准」等同于「可以自动 commit / push / publish」—— plan 阶段是设计，实现完成后才进入发版动作；发版动作始终是另一道闸
- 不在脚本/批量动作里夹带 `git commit` 或 `git push`（`vscode:prepublish` 钩子只跑 lint / compile / test，不提交任何东西）
- 不在网络异常、命令失败后自动重试 push / publish（先回报用户）

## Project homepage (GitHub Pages)

项目主页 URL：**https://uwakeme.github.io/large_log_check/**（已设置到 repo 的 Website 字段）

### 站点内容只放 `gh-pages` 分支,`main` 不要有 `site/` / `docs/` 站点目录

- `gh-pages` 分支根目录直接是站点:`index.html`、`styles.css`、`images/`（README 配图等）
- 主分支工作流:`main` 上生成/重写 `site/` 临时目录 → 用 `git worktree add -B gh-pages <tmp> origin/gh-pages` 隔离 worktree → worktree 内 `git rm -rf .` + `git clean -fdx` 清空 → `Copy-Item site\*` 复制进去 → commit → `git push -u origin gh-pages` → `git worktree remove <tmp> --force`
- 推送后**删掉** `main` 根下的 `site/`(走 `rm -- site/`,mavis-trash 可恢复)
- 不要把 `site/` commit 到 `main` —— 会污染源码仓库

### GitHub Pages 操作约束

- **Save 按钮灰 = 当前设置已是已保存状态**,不是出错;改任意下拉(Source / Branch)才会激活 Save
- **Custom domain 不要填 `hexo.blog.uwakeme.tech`**(本机 DNS 没配 A/CNAME,填了站点能 "live" 但访问 404);留空用默认 GitHub 子域
- **unpublish 后无法用 Save 重新启用** —— 改下拉也未必生效。最稳的方法:推空 commit 到 `gh-pages`,GitHub 自动恢复部署:
  ```bash
  git worktree add -B gh-pages <tmp> origin/gh-pages
  cd <tmp>
  git commit --allow-empty -m "chore: trigger GitHub Pages redeploy after unpublish"
  git push origin gh-pages
  git worktree remove <tmp> --force
  ```
- 主页后续如需自动部署,加 GitHub Action workflow(push main 时同步更新 `gh-pages`);本机 `git credential` 不易导出 PAT,GitHub API 调用(设置 repo homepage 等)需要用户提供 PAT

## Release process (every version)

1. Bump `version` in `package.json`
2. Move CHANGELOG `## [Unreleased]` entries into `## [x.y.z] - YYYY-MM-DD`; keep an empty `## [Unreleased]` at the top
3. `npm run package` — the `vscode:prepublish` chain (lint + compile + test) must pass; artifact is `big-log-viewer-<version>.vsix`
4. Commit as `<old> -> <new>` (e.g. `1.3.1 -> 1.3.2`), then create an annotated tag `v<x.y.z>` on that commit
5. Push `main` and the tag together — every release MUST be tagged, because the README version badge reads the latest tag
6. Generate the GitHub Release page content for the tag and hand it to the user; they create the release and upload the `.vsix` themselves (to GitHub and to the Marketplace — never run `vsce publish`):
   - Title: `大日志文件查看器 v<x.y.z>`
   - Notes: condensed from the release's CHANGELOG section — one short bullet per entry under `### Added / Changed / Fixed`
   - **No install instructions in the notes** — "how to install" lives only in `README.md`; the release body carries just the changelog summary, and the `.vsix` goes in as the attached binary
   - Label: Latest

## Architecture (key facts)

- **Three runtime layers:** extension host (Node/TS, strict) → WebView (sandboxed browser) via `vscode.Webview.postMessage`
- **Per-file panel singleton** in `src/logViewerPanel.ts:8` (`_panels: Map<filePath, LogViewerPanel>`) — opening the same file reveals the existing panel
- **State location matters:** bookmarks, comments, highlight rules, paged view → WebView (`media/webview.js`); total-line counts, file reads, destructive ops (time/line delete) → extension host (`src/logProcessor.ts`)
- **Message protocol** lives in the `onDidReceiveMessage` switch in `src/logViewerPanel.ts:84` — that is the canonical list of what the WebView can ask the host to do; add a new case there when a feature needs host-side work
- **Log parsing is regex-based, not parser-based.** Time-format detection iterates over `timePatterns` and level detection over `logLevelPatterns` in `src/logProcessor.ts:35`

## Security

- Never commit secrets — `.env` is in `.gitignore`
- Destructive operations (`deleteByTime`, `deleteByLine`, file trim) modify the original file — the README warns to back up first; mirror that warning in any new destructive feature and in the WebView confirmation UI
- Stream-based reads are mandatory; loading a whole multi-GB file would OOM the extension host
- User-controllable regex in search runs inside the WebView's sandboxed VM, but be mindful of ReDoS in any new pattern — keep alternations bounded and avoid nested quantifiers
