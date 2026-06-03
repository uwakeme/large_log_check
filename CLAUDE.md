# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**big-log-viewer** (大日志文件查看器) — a VSCode extension (publisher `wake`, current version `1.2.6`) for viewing and processing very large log files (multi-GB, tens of millions of lines). The user-facing value is virtual scrolling, multi-keyword/regex search, time/level/thread filtering, fold-repeating-lines, bookmarks, comments, and a timeline view. Features are documented for end-users in `README.md`; release history lives in `CHANGELOG.md` (Keep-a-Changelog format, `## [Unreleased]` at the top).

## Common commands

```bash
npm install          # install deps
npm run compile      # tsc -p ./  →  out/
npm run watch        # tsc -watch -p ./  (use this while editing, then F5 to reload)
npm run lint         # eslint src --ext ts
npm run clean        # rimraf out
npm run rebuild      # clean + compile
npm run package      # vsce package  →  .vsix
npm run publish      # vsce publish
```

**Debug**: open the project in VSCode, press `F5` to launch the Extension Development Host, and test the extension in that window. With `npm run watch` running, edits auto-compile — manually reload the dev host to pick them up.

**No test suite exists.** `pretest` is wired to `npm run compile` but there is no test runner. If you add tests, you will need to introduce a runner.

## Architecture (big picture)

The extension has three runtime layers and four source files. Knowing which layer owns a piece of state is the most important thing to internalize.

```
┌────────────────────────────────────────────────────────────────────┐
│ Extension host (Node.js, TypeScript strict mode)                  │
│                                                                    │
│  src/extension.ts        command palette / context-menu dispatch  │
│      │                                                             │
│      ▼                                                             │
│  src/logViewerPanel.ts   WebView lifecycle, per-file singleton,   │
│                          HTML/CSS/JS injection, postMessage bridge │
│      │                                                             │
│      ▼                                                             │
│  src/logProcessor.ts     Stream-based file I/O — NEVER loads the  │
│                          whole file. All read/search/delete goes   │
│                          through fs.createReadStream + readline.   │
└────────────────────────┬───────────────────────────────────────────┘
                         │  vscode.Webview.postMessage
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ WebView frontend (sandboxed browser)                               │
│                                                                    │
│  src/webview.html        static HTML scaffold                      │
│  media/webview.css       styles (uses @vscode/codicons)           │
│  media/webview.js        all UI logic — search, filters, virtual   │
│                          scroll, timeline, bookmarks, comments     │
└────────────────────────────────────────────────────────────────────┘
```

### Key architectural facts

- **Per-file panel singleton.** `LogViewerPanel._panels: Map<filePath, LogViewerPanel>` (`src/logViewerPanel.ts:8`). Opening the same file twice reveals the existing panel; opening a different file creates a new one. `LogViewerPanel.getActivePanel()` walks the map to find a visible panel — this is what every command in `extension.ts` dispatches into.
- **State location matters.** Bookmarks, comments, highlight rules, and the in-memory paged view live in the **WebView** (`media/webview.js`). Total-line counts, file reads, and destructive operations (time/line delete) live in the **extension host** (`LogProcessor`). Commands that need to mutate the host state round-trip through `postMessage` (e.g. `getStatistics`, `toggleBookmarks`, `jumpToLineInFullLog`).
- **Streams everywhere.** `LogProcessor` (`src/logProcessor.ts`) uses `fs.createReadStream` + `readline.createInterface({ crlfDelay: Infinity })` for every file operation, wrapping the stream in `new Promise(...)`. This is non-negotiable — loading the file whole would break GB-scale support.
- **Progress reporting.** `getTotalLines` accepts a `progressCallback` and fires every 10,000 lines. The panel surfaces this as the loading progress bar.
- **Log parsing is regex-based, not parser-based.** Time-format detection iterates over five patterns (`timePatterns` in `logProcessor.ts:35`), and level detection iterates over `logLevelPatterns` in priority order. New formats are added by appending a regex, not by writing a parser.

### Message protocol (the extension ↔ WebView contract)

`LogViewerPanel`'s `onDidReceiveMessage` switch in `src/logViewerPanel.ts:84` is the canonical list of what the WebView can ask the host to do (`loadMore`, `search`, `filterByLevel`, `filterByThread`, `refresh`, delete variants, `exportLogs`, etc.). When adding a feature that needs the host (file I/O, destructive ops), add a case here. When a feature is purely visual, keep it in `media/webview.js`.

## Project-specific conventions

These are enforced or assumed; see `AGENTS.md` for the full set (interface shapes, async/await style, disposable pattern, import order, Chinese comments, etc.).

- **Comments and UI strings are in Chinese.** New user-facing strings follow the existing tone.
- **Private fields use the `_` prefix** (`_panel`, `_fileUri`, `_logProcessor`, `_disposables`).
- **Settings live in `package.json` under `contributes.configuration`** and are read via `vscode.workspace.getConfiguration('big-log-viewer')`. Three current settings: `search.debounceMs` (400), `collapse.minRepeatCount` (2), `timeline.samplePoints` (200). Add new tunables there, not in a config file.
- **No runtime dependencies** beyond `@vscode/codicons` for icons. Everything heavy (file I/O, regex, DOM) comes from Node + the WebView.
- **TypeScript strict mode is on** (`tsconfig.json`). Don't use `as any` to silence errors — fix the types.

## Cursor / project rules

From `.cursor/rules/custom-rule.mdc` (always applied):

1. **Update `README.md` and `CHANGELOG.md` immediately** when adding or modifying a feature — same commit, not later.
2. Unreleased changes go under `## [Unreleased]` at the top of `CHANGELOG.md`.
3. One entry per feature per version — don't duplicate a feature across multiple bullets in the same release.

## Where to look for what

| You want to…                                    | Start here                                                |
|-------------------------------------------------|-----------------------------------------------------------|
| Add or change a command palette command         | `src/extension.ts` — add a `registerCommand`, push to `context.subscriptions` |
| Add a WebView ↔ host message                    | `src/logViewerPanel.ts` switch in `onDidReceiveMessage` + the matching handler in `media/webview.js` |
| Change file reading / search / delete logic     | `src/logProcessor.ts` — keep it stream-based              |
| Change UI layout, virtual scroll, filters       | `media/webview.js` + `media/webview.css`                  |
| Add a new log timestamp or level format         | `src/logProcessor.ts` `timePatterns` / `logLevelPatterns` |
| Add a new user setting                          | `package.json` `contributes.configuration.properties`     |
| Document a user-facing feature                  | `README.md` (usage) + `CHANGELOG.md` (Unreleased)         |
| Coding style, interface shapes, async patterns  | `AGENTS.md`                                               |
