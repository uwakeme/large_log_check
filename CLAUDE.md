# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**big-log-viewer** (Open Log Viewer) — a VSCode extension (publisher `wake`) for viewing and processing large log files (one auto-rotated chunk at a time, typically up to a few hundred MB). The user-facing value is paged rendering, multi-keyword/regex search, time/level/thread filtering, fold-repeating-lines, bookmarks, comments, and a timeline view. Opening a file loads ALL lines into memory (host + WebView); line/time jumps stream only a ±500-line window. Features are documented for end-users in `README.md`; release history lives in `CHANGELOG.md` (Keep-a-Changelog format, `## [Unreleased]` at the top).

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

**Tests**: `npm test` (= compile + `node --test test/*.test.cjs`, needs Node 21+ for the glob; earlier versions use `node --test test/`). Eleven test files in `test/` cover the pure-logic modules (log parser, encoding, chunked transfer, release prep) and the browser-global webview scripts via `node:vm` sandboxes with stubbed DOM globals — see `test/clipboard.test.cjs` for the stubbing pattern. `npm run package` runs lint + compile + tests via the `vscode:prepublish` hook.

**Release**: pushing a `v*` tag runs `.github/workflows/release.yml`, which verifies the tag version against `package.json`, packages the `.vsix`, and creates the GitHub Release (title = tag, notes = that version's CHANGELOG section, `.vsix` attached). `scripts/release-prep.cjs` holds that logic and is unit-tested. Marketplace publishing stays a manual `npm run publish`.

## Architecture (big picture)

The extension has three runtime layers and six TypeScript sources. Knowing which layer owns a piece of state is the most important thing to internalize.

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
│  src/logParser.ts        Pure parsing: timestamp / level / class / │
│                          method / thread name (no I/O)            │
│  src/encoding.ts         File encoding detection (UTF-8/GBK/UTF-16)│
│  src/chunkedTransfer.ts  Host-side chunking of huge line arrays    │
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
│  media/*.js                pure-logic modules; load order matters —       │
│                            clipboard → searchShortcut → lineRange →        │
│                            foldLongLines → chunkedLoad → threadName →     │
│                            webview.js → investigationTemplates →          │
│                            searchHistory                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Key architectural facts

- **Per-file panel singleton.** `LogViewerPanel._panels: Map<string, LogViewerPanel>` (`src/logViewerPanel.ts:13`). Opening the same file twice reveals the existing panel; opening a different file creates a new one. `LogViewerPanel.getActivePanel()` walks the map to find a visible panel — this is what every command in `extension.ts` dispatches into.
- **State location matters.** Bookmarks, comments, highlight rules, and the in-memory paged view live in the **WebView** (`media/webview.js`). Total-line counts, file reads, and destructive operations (time/line delete) live in the **extension host** (`LogProcessor`). Commands that need to mutate the host state round-trip through `postMessage` (e.g. `getStatistics`, `toggleBookmarks`, `jumpToLineInFullLog`).
- **Streams everywhere (disk I/O).** `LogProcessor` (`src/logProcessor.ts`) uses `fs.createReadStream` + `readline.createInterface({ crlfDelay: Infinity })` for every file operation, wrapping the stream in `new Promise(...)`. This is non-negotiable. In-memory model is the opposite: `readAllLines` materializes the full file into `LogLine[]` and posts it to the WebView — the accepted per-chunk design (target: single files of a few hundred MB).
- **Progress reporting.** `getTotalLines` accepts a `progressCallback` and fires every 10,000 lines. The panel surfaces this as the loading progress bar.
- **Log parsing is regex-based, not parser-based.** Time-format detection iterates over five patterns (`LogParser.timePatterns` in `src/logParser.ts:175`); level detection uses three module-level lazily-built regexes (`getQuickMatchRegex` / `getBracketMatchRegex` / `getBareMatchRegex`) that `setLevelAliases` rebuilds when the user changes `big-log-viewer.level.aliases` — there is no `logLevelPatterns` constant any more. New formats are added by appending a regex, not by writing a parser.

### Message protocol (the extension ↔ WebView contract)

`LogViewerPanel`'s `onDidReceiveMessage` switch in `src/logViewerPanel.ts:222` is the canonical list of what the WebView can ask the host to do (`filterByThread`/`filterByClass`/`filterByMethod`, `refresh`, delete variants, `jumpToTime`, `exportLogsBegin`/`exportLogsChunk`/`exportLogsDone`, etc.). When adding a feature that needs the host (file I/O, destructive ops), add a case here. When a feature is purely visual, keep it in `media/webview.js`.

**Large line arrays never travel in a single message** (JSON-serializing ~500MB+ exceeds V8's max string length and the failure is silent). Host→WebView (`fileLoaded`, `filterResults`) goes through `postMessageWithLines`: header (`data.chunkedTransferId`) → `chunkTransfer` × N → `chunkTransferDone` (+ `chunkTransferAbort` on cancellation), reassembled in `media/chunkedLoad.js` into the original message. WebView→host exports mirror this with `exportLogsBegin`/`Chunk`/`Done`. When adding a command to the chunked protocol, register its consumer-read payload field in `CHUNK_PAYLOAD_FIELD` (`media/chunkedLoad.js`) **and** in the contract test that iterates that table (`test/chunkedLoad.test.cjs`) — there is no silent fallback for unregistered commands.

## Project-specific conventions

These are enforced or assumed; see `AGENTS.md` for the full set (interface shapes, async/await style, disposable pattern, import order, Chinese comments, etc.).

- **Comments and UI strings are in Chinese.** New user-facing strings follow the existing tone.
- **Private fields use the `_` prefix** (`_panel`, `_fileUri`, `_logProcessor`, `_disposables`).
- **Settings live in `package.json` under `contributes.configuration`** and are read via `vscode.workspace.getConfiguration('big-log-viewer')`. Nine current settings: `search.debounceMs` (400), `file.encoding` (auto), `load.maxFileSizeMB` (1024), `collapse.minRepeatCount` (2), `timeline.samplePoints` (200), `view.foldLongLines` (true), `view.foldMaxRows` (3), `theme` (default), `level.aliases` (ERROR/WARN/INFO/DEBUG alias map). Add new tunables there, not in a config file.
- **No runtime dependencies** beyond `@vscode/codicons` for icons. Everything heavy (file I/O, regex, DOM) comes from Node + the WebView.
- **TypeScript strict mode is on** (`tsconfig.json`). Don't use `as any` to silence errors — fix the types.

## Project rules

From `AGENTS.md` → "PR & commit conventions" (always applied):

1. **Update `README.md` and `CHANGELOG.md` immediately** when adding or modifying a feature — same commit, not later.
2. Unreleased changes go under `## [Unreleased]` at the top of `CHANGELOG.md`.
3. One entry per feature per version — don't duplicate a feature across multiple bullets in the same release.

(The original source file `.cursor/rules/custom-rule.mdc` was removed in commit `f737072`; the rules now live in `AGENTS.md`.)

## Where to look for what

| You want to…                                    | Start here                                                |
|-------------------------------------------------|-----------------------------------------------------------|
| Add or change a command palette command         | `src/extension.ts` — add a `registerCommand`, push to `context.subscriptions` |
| Add a WebView ↔ host message                    | `src/logViewerPanel.ts` switch in `onDidReceiveMessage` + the matching handler in `media/webview.js` |
| Change file reading / search / delete logic     | `src/logProcessor.ts` — keep it stream-based              |
| Change UI layout, virtual scroll, filters       | `media/webview.js` + `media/webview.css`                  |
| Add a new log timestamp or level format         | `src/logParser.ts` — `LogParser.timePatterns` for timestamps; level detection is the module-level lazily-built regexes + the `big-log-viewer.level.aliases` setting |
| Add a new user setting                          | `package.json` `contributes.configuration.properties`     |
| Document a user-facing feature                  | `README.md` (usage) + `CHANGELOG.md` (Unreleased)         |
| Change the release flow or Release format      | `.github/workflows/release.yml` + `scripts/release-prep.cjs` — match the **existing published releases**: read `https://api.github.com/repos/uwakeme/large_log_check/releases/tags/<tag>` first, don't trust the format written in the docs |
| Update the GitHub Pages project homepage       | `docs/index.html` + `docs/styles.css` on `main` (the site lives in `docs/`, published from branch `main` + `/docs`; there is no `gh-pages` branch) — see the homepage section in `AGENTS.md` |
| Coding style, interface shapes, async patterns  | `AGENTS.md`                                               |
