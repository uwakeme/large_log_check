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
- Publish:     `npm run publish`   (vsce publish — VSCode Marketplace)

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

- **No test suite exists.** `pretest` is wired to `npm run compile` but no runner is installed
- Manual test path: `npm run watch` → `F5` in VSCode → exercise the feature in the Extension Development Host
- When introducing a test runner, wire it to `npm test` and update this section

## PR & commit conventions

- Default branch: `master` (verify with `git symbolic-ref --short refs/remotes/origin/HEAD` or `git config init.defaultBranch`)
- Branch from `master`; never push to it directly
- Conventional commits, often in Chinese — see `git log --oneline -20` for the current style
- Open the PR via `gh pr create` once `npm run lint` and `npm run compile` are green
- **Cursor rule (always applied):** every new user-facing feature must update `README.md` and `CHANGELOG.md` in the same commit. Unreleased features go under `## [Unreleased]` at the top of `CHANGELOG.md`. One entry per feature per release — do not duplicate.

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
