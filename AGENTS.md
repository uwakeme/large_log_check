# AGENTS.md

Professional VSCode extension for viewing and processing large log files (one auto-rotated chunk at a time, typically up to a few hundred MB) — paged rendering, multi-keyword/regex search, time/level/thread filtering, fold-repeating-lines, bookmarks, comments, timeline view, and 4 selectable themes. Disk reads are stream-based (`fs.createReadStream` + readline) with real byte progress; after loading, ALL lines live in memory (extension host + WebView copies) — a deliberate per-chunk design, NOT a multi-GB-file design. Line/time jumps use streaming window reads (±500 lines) and never reload the whole file.

## Why this exists (motivation — use this framing in user-facing copy)

The author's real driver: people around them inspect log files with **记事本 (Notepad) / Notepad++ / `less`**, whose search-and-filter capabilities are very limited. This tool exists to give those people a dedicated log viewer.

**Do not frame the problem as "VSCode can't open big files"** — that is a weaker, partly inaccurate story. Lead with the 记事本/Notepad++ angle ("别再用记事本看日志了"). The accurate framing is: 缺的从来不是「能打开」，是「快速定位」——在几十万行里快速定位到那几行的能力（搜索 / 过滤 / 跳转 / 时间线是一套完整动作），不是单纯的「筛选」。

**文风**：面向程序员的工具介绍，只讲功能和使用，**不讲代码与实现**（不写架构分层、类名/接口、流式读取、内存模型等）。性能只说用户能感知的结论（"翻页不卡""搜索是即时的"），不解释原理。

## Setup commands

- Install deps: `npm install`
- Dev (watch): `npm run watch` — then press `F5` in VSCode to launch the Extension Development Host
- Build:       `npm run compile`   (output to `out/`)
- Lint:        `npm run lint`      (eslint src --ext ts)
- Clean:       `npm run clean`     (rimraf out)
- Rebuild:     `npm run rebuild`   (clean + compile)
- Package:     `npm run package`   (vsce package → .vsix)
- Publish:     `npm run publish`   (vsce publish — 只用于上架 Marketplace，必须人工执行；GitHub Release 由 tag 触发的 CI 自动完成，见 Release process)

## Project layout

- `src/extension.ts`        — command palette / context-menu dispatch (entry point)
- `src/logViewerPanel.ts`   — WebView lifecycle, per-file singleton, postMessage bridge
- `src/logProcessor.ts`     — stream-based file I/O (fs.createReadStream + readline)
- `src/webview.html`        — WebView HTML scaffold
- `media/webview.js`        — WebView frontend logic (search, filters, virtual scroll, timeline, bookmarks)
- `media/clipboard.js`      — WebView 日志选区复制（接管 Ctrl+C）+ 日志区点选时让输入框让出焦点、焦点收拢到日志容器（规避 VS Code 1.143 webview 复制前的焦点恢复劫持）
- `media/searchShortcut.js` — 选中日志文字后 Ctrl/Cmd+F 直接搜索（复用 clipboard.js 的 getLogSelectionText，须在其后加载）
- `media/investigationTemplates.js` — 排查模板（模板 CRUD、导入导出、运行流水线）
- `media/searchHistory.js`  — 搜索历史存储（会话级内存，按文件面板隔离）
- `media/lineRange.js`      — 行号范围限定纯逻辑（弹窗解析/右键单边界校验/范围文案，须在 webview.js 之前加载）
- `media/foldLongLines.js`  — 长行折叠纯逻辑（长行粗筛/真实截断判定/点击归属判定/命中裁切判定，须在 webview.js 之前加载）
- `media/webview.css`       — base WebView styles
- `media/themes.css`        — 3 visual theme overlays (NEON.CYBER / AURORA.GLASS / HOLO.PRISM)
- `package.json`            — manifest, command registration, user settings
- `tsconfig.json`           — TypeScript strict mode (ES2020 / CommonJS)
- `CHANGELOG.md`            — Keep-a-Changelog format; `## [Unreleased]` lives at the top
- `.github/workflows/release.yml` — 发版流水线：推送 `v*` tag → 打包 `.vsix` → 自动创建 GitHub Release（附 .vsix，说明取自 CHANGELOG 对应版本段落）
- `scripts/release-prep.cjs` — 发版准备：校验 tag 版本与 `package.json` 一致、从 CHANGELOG 提取版本段落（单测在 `test/releasePrep.test.cjs`）

## Code style

- TypeScript strict mode (`tsconfig.json: strict: true`); do NOT use `as any` to silence errors — fix the types
- Private class fields use the `_` prefix (`_panel`, `_fileUri`, `_logProcessor`, `_disposables`)
- Comments and UI strings are in **Chinese** — match the existing tone for any new user-facing text
- File reads are stream-based only: `fs.createReadStream` + `readline.createInterface({ crlfDelay: Infinity })`
- All async methods return `Promise<T>` explicitly; wrap stream events in `new Promise(...)`
- Disposables push to `context.subscriptions` / panel's `_disposables`; clean up in `dispose()`
- Run `npm run lint` before committing;本地没有 PR 级 CI，只有 tag 推送触发的发版流水线（`.github/workflows/release.yml`）

## Testing instructions

- Unit tests use the built-in `node:test` runner: `npm test` (= compile + `node --test test/*.test.cjs`)
- `test/` 现有十一个测试文件：`logParser.test.cjs`（级别别名 / 时间戳解析）、`encoding.test.cjs`（GBK/UTF-16 编码识别）、`templateImport.test.cjs`（排查模板导入校验 / 限定范围动作）、`clipboard.test.cjs`（日志选区复制）、`searchShortcut.test.cjs`（选中日志 Ctrl+F 搜索）、`lineRange.test.cjs`（行号范围解析 / 校验 / 芯片文案）、`foldLongLines.test.cjs`（长行折叠判定 / 点击归属 / 命中裁切 / 行数钳制）、`threadName.test.cjs`（线程名提取）、`chunkedLoad.test.cjs`（WebView 侧分块传输协议）、`chunkedTransfer.test.cjs`（宿主侧分块切分）、`releasePrep.test.cjs`（发版准备：版本解析 / CHANGELOG 段落提取 / 版本一致性校验），共 172 个用例
- 新增测试放 `test/*.test.cjs`；webview 侧模块要打桩浏览器全局（`localStorage` / `document` / `window.getSelection` 等）再用 `vm` 加载，写法参考 `test/clipboard.test.cjs`
- `node --test` 的 glob 模式需要 Node 21+；更早版本改用 `node --test test/` 跑整个目录
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
> - **支持自定义日志级别缩写** — 像 `I` / `E` / `W` 这种简写现在能识别为 INFO / ERROR / WARN，在「设置 → 扩展 → Open Log Viewer → Level Aliases」里调整

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

### 主页内容同步约定（2026-11-09 起）

- **每次发版，或新增/修改用户可见功能时，检查 gh-pages 主页是否需要同步**。以用户可感知为准判断：新功能进「核心能力」卡片（重磅功能独立成卡，小改进并入现有卡片的 bullets）、格式/编码支持进「支持的日志格式」、纯内部修复不动主页
- 同步时把 `index.html` 三处写死的兜底版本号（页顶 brand-ver / eyebrow / 页脚 foot-meta，都带 `js-ver` class）改成新版本号；线上页面会向 GitHub API 取 `releases/latest` 动态覆盖——**发布 GitHub Release 后主页显示自动更新，无需重新部署**，兜底值仅在 API 拉取失败时展示
- 同步操作走下面的 worktree 工作流；推送 gh-pages 后用浏览器过一遍新卡片渲染与动态版本号是否正常

### 站点内容只放 `gh-pages` 分支,`main` 不要有 `site/` / `docs/` 站点目录

- `gh-pages` 分支根目录直接是站点:`index.html`、`styles.css`、`images/`（README 配图等）
- 主分支工作流:`main` 上生成/重写 `site/` 临时目录 → 用 `git worktree add -B gh-pages <tmp> origin/gh-pages` 隔离 worktree → worktree 内 `git rm -rf .` + `git clean -fdx` 清空 → `Copy-Item site\*` 复制进去 → commit → `git push -u origin gh-pages` → `git worktree remove <tmp> --force`
- 推送后**删掉** `main` 根下的 `site/`(走 `rm -- site/`,mavis-trash 可恢复)
- 不要把 `site/` commit 到 `main` —— 会污染源码仓库

### GitHub Pages 操作约束

- **版本号自动同步(2026-10-27 起)**:`index.html` 三处版本号(页顶徽章 / eyebrow / 页脚)带 `js-ver` class,页面加载时向 GitHub API 取 `releases/latest` 的 tag 动态填充;**发版只需发布 GitHub Release,主页版本号无需重新部署**。写死的版本号是拉取失败时的兜底,手改主页时记得同步更新兜底值
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
3. `npm run package` — the `vscode:prepublish` chain (lint + compile + test) must pass locally; artifact is `big-log-viewer-<version>.vsix`
4. Commit as `<old> -> <new>` (e.g. `1.3.1 -> 1.3.2`), then create an annotated tag `v<x.y.z>` on that commit
5. Push `main` and the tag together — every release MUST be tagged, because the README version badge reads the latest tag
6. **GitHub Release 由 CI 自动创建**（`.github/workflows/release.yml`，推送 `v*` tag 触发）：打包 `.vsix` → 取 CHANGELOG 对应版本段落作说明 → 创建 Release 并附上 `.vsix`。这一步无需人工操作，只需在 Actions 页面确认跑绿
   - Title: `v<x.y.z>`（与 tag 同名，与历史 Release 保持一致）
   - Notes: 该版本的 CHANGELOG 段落（由 `scripts/release-prep.cjs` 提取，条目标题上的 `**加粗**` 会被去掉）——`### Added / Changed / Fixed` 下每条一行
   - **No install instructions in the notes** — "how to install" lives only in `README.md`; the release body carries just the changelog summary, and the `.vsix` goes in as the attached binary
   - Label: Latest（非预发布 tag 自动标记）
7. **Marketplace 上架仍是人工步骤** —— 本地执行 `vsce publish`（需 Azure DevOps PAT），按上文 Approval gates，**永远不自动执行**

### Release 自动化注意事项（2026-11-18 起）

- 流水线文件：`.github/workflows/release.yml`；触发条件为推送 `v*` tag，另有 `workflow_dispatch` 手动触发（可填 tag，用于失败后重跑）
- 流水线声明了 `permissions: contents: write`，因此仓库需在 **Settings → Actions → General → Workflow permissions 设为 "Read and write permissions"**，否则创建 Release 会 403
- tag 版本与 `package.json` 的 `version` 不一致、或 CHANGELOG 里没有该版本段落 → 流水线直接失败，不会产出空说明的 Release。改完重新打 tag 再推即可
- 同一个 tag 重复触发会失败（Release 已存在）——先删掉 Release，再用 `workflow_dispatch` 重跑
- `scripts/release-prep.cjs` 同时被单测覆盖（`test/releasePrep.test.cjs`），其中一条用例会检查**仓库当前版本在 CHANGELOG 里必须有对应段落**，改版本号忘了写 CHANGELOG 会本地就报错

## Architecture (key facts)

- **Three runtime layers:** extension host (Node/TS, strict) → WebView (sandboxed browser) via `vscode.Webview.postMessage`
- **Per-file panel singleton** in `src/logViewerPanel.ts:8` (`_panels: Map<filePath, LogViewerPanel>`) — opening the same file reveals the existing panel
- **State location matters:** bookmarks, comments, highlight rules, paged view → WebView (`media/webview.js`); total-line counts, file reads, destructive ops (time/line delete) → extension host (`src/logProcessor.ts`)
- **Message protocol** lives in the `onDidReceiveMessage` switch in `src/logViewerPanel.ts:84` — that is the canonical list of what the WebView can ask the host to do; add a new case there when a feature needs host-side work
- **Log parsing is regex-based, not parser-based.** Time-format detection iterates over `timePatterns` and level detection over `logLevelPatterns` in `src/logProcessor.ts:35`

## Security

- Never commit secrets — `.env` is in `.gitignore`
- Destructive operations (`deleteByTime`, `deleteByLine`, file trim) modify the original file — the README warns to back up first; mirror that warning in any new destructive feature and in the WebView confirmation UI
- Stream-based disk reads are mandatory. Note the load model: `readAllLines` materializes every line in memory (host + WebView), so the design target is per-chunk files of a few hundred MB; do not add features that assume multi-GB single files
- User-controllable regex in search runs inside the WebView's sandboxed VM, but be mindful of ReDoS in any new pattern — keep alternations bounded and avoid nested quantifiers
