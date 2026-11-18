# Architecture

The extension has three runtime layers and six TypeScript source files. Knowing which layer owns a piece of state is the most important thing to internalize — most bugs come from putting state in the wrong place.

```
src/extension.ts            → command registration, lifecycle
src/logViewerPanel.ts       → WebView management, message bridge (host side)
src/logProcessor.ts         → file I/O, stream-based read/search/filter/delete
src/logParser.ts            → PURE functions (no I/O), extract timestamp/level/class/method/thread
src/encoding.ts             → file encoding detection (UTF-8 / GBK / UTF-16)
src/chunkedTransfer.ts      → host-side chunking of huge line arrays
src/webview.html            → WebView HTML scaffold (consumed via logViewerPanel._getHtmlForWebview)
```

`logParser.ts` is intentionally I/O-free so it can be unit-tested in isolation. The WebView still keeps its own copy of the thread-name extraction logic (`media/threadName.js`) — the two must stay口径一致 (`test/threadName.test.cjs` pins that).

```
┌────────────────────────────────────────────────────────────────────┐
│ Extension host (Node.js, TypeScript strict mode)                   │
│                                                                    │
│  src/extension.ts        command palette / context-menu dispatch  │
│      │                                                             │
│      ▼                                                             │
│  src/logViewerPanel.ts   WebView lifecycle, per-file singleton,    │
│                          HTML/CSS/JS injection, postMessage bridge │
│      │                                                             │
│      ▼                                                             │
│  src/logProcessor.ts     Stream-based file I/O — NEVER loads the   │
│                          whole file. All read/search/delete goes   │
│                          through fs.createReadStream + readline.   │
│  src/logParser.ts        Pure parsing (timestamp/level/class/      │
│                          method/thread), no I/O                    │
│  src/encoding.ts         Encoding detection (UTF-8/GBK/UTF-16)      │
│  src/chunkedTransfer.ts  Host-side chunking of huge line arrays    │
└────────────────────────┬───────────────────────────────────────────┘
                         │  vscode.Webview.postMessage
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ WebView frontend (sandboxed browser)                               │
│                                                                    │
│  src/webview.html        static HTML scaffold                      │
│  media/webview.css       base styles (uses @vscode/codicons)       │
│  media/themes.css        3 visual theme overlays                   │
│  media/webview.js        all UI logic — search, filters, virtual   │
│                          scroll, timeline, bookmarks, comments     │
│  media/*.js              pure-logic modules; load order matters —  │
│                          clipboard → searchShortcut → lineRange →  │
│                          foldLongLines → chunkedLoad → threadName │
│                          → webview.js → investigationTemplates →   │
│                          searchHistory                            │
└────────────────────────────────────────────────────────────────────┘
```

## State location rules

| Kind of state                                  | Lives in                | Why                                       |
|------------------------------------------------|-------------------------|-------------------------------------------|
| Bookmarks, comments, highlight rules           | WebView                 | Per-file, transient, UI-only              |
| In-memory paged view (current page)            | WebView                 | Display state, no host round-trip needed  |
| Total-line counts                              | Extension host          | Computed via stream; expensive to redo    |
| File reads (search, stats, navigation)         | Extension host          | Streams, can't run in WebView             |
| Destructive ops (time/line delete, file trim)  | Extension host          | Touches the filesystem; needs host APIs   |
| Theme selection (`big-log-viewer.theme`)       | VSCode settings (global)| Cross-device, cross-workspace persistence |

When a command in `src/extension.ts` mutates host-side state, the WebView round-trips through `postMessage` (e.g. `getStatistics`, `toggleBookmarks`, `jumpToLineInFullLog`).

## Per-file panel singleton

`LogViewerPanel._panels: Map<string, LogViewerPanel>` (`src/logViewerPanel.ts:13`) is the source of truth for "which panel shows which file". Opening the same file twice reveals the existing panel; opening a different file creates a new one. `LogViewerPanel.getActivePanel()` walks the map to find a visible panel — this is what every command in `extension.ts` dispatches into.

## Message protocol (extension ↔ WebView contract)

`LogViewerPanel.onDidReceiveMessage` switch in `src/logViewerPanel.ts:222` is the canonical list of what the WebView can ask the host to do (`loadMore`, `search`, `filterByLevel`, `filterByThread`, `refresh`, delete variants, `exportLogsBegin`/`exportLogsChunk`/`exportLogsDone`, etc.). When adding a feature that needs the host, add a case here. When a feature is purely visual, keep it in `media/webview.js`.

### Large line arrays never travel in one message

JSON-serializing a ~500MB+ line array exceeds V8's max string length and the failure is silent. Host→WebView payloads (`fileLoaded`, `filterResults`) therefore go through `postMessageWithLines`: a header carrying `data.chunkedTransferId` → `chunkTransfer` × N → `chunkTransferDone` (plus `chunkTransferAbort` on cancellation), reassembled in `media/chunkedLoad.js`. WebView→host exports mirror it with `exportLogsBegin` / `exportLogsChunk` / `exportLogsDone`.

Every command added to this protocol must be registered in the `CHUNK_PAYLOAD_FIELD` table (`media/chunkedLoad.js`) **and** in the contract test that iterates that table (`test/chunkedLoad.test.cjs`) — unregistered commands are silently dropped, there is no fallback.

## Log parsing

- **Time format detection** iterates over five patterns in `LogParser.timePatterns` (`src/logParser.ts:175`), in priority order. New formats are added by appending a regex, not by writing a parser.
- **Level detection** uses three module-level lazily-built regexes (`getQuickMatchRegex` / `getBracketMatchRegex` / `getBareMatchRegex`) that `setLevelAliases` rebuilds when the user changes `big-log-viewer.level.aliases`. There is **no `logLevelPatterns` constant** any more.
- A line that doesn't match any time/level pattern still gets indexed — the line just has `timestamp` / `level` undefined.

## Progress reporting

`getTotalLines` accepts a `progressCallback` and fires every 10,000 lines. The panel surfaces this as the loading progress bar. When adding a long-running operation, follow the same pattern: a callback parameter + the WebView-side percentage UI.

## Settings (user-tunable behavior)

All settings live in `package.json` under `contributes.configuration.properties`:

| Setting                                          | Default | Range       | Owner rein                       |
|--------------------------------------------------|---------|-------------|----------------------------------|
| `big-log-viewer.search.debounceMs`               | 400     | ≥ 0         | webview-frontend-expert          |
| `big-log-viewer.file.encoding`                   | auto    | enum        | extension-host-expert            |
| `big-log-viewer.load.maxFileSizeMB`              | 1024    | 0 – 32768   | extension-host-expert            |
| `big-log-viewer.collapse.minRepeatCount`         | 2       | ≥ 1         | webview-frontend-expert          |
| `big-log-viewer.timeline.samplePoints`           | 200     | 20 – 1000   | webview-frontend-expert          |
| `big-log-viewer.view.foldLongLines`              | true    | bool        | webview-frontend-expert          |
| `big-log-viewer.view.foldMaxRows`                | 3       | 1 – 50      | webview-frontend-expert          |
| `big-log-viewer.theme`                           | default | enum        | webview-frontend-expert          |
| `big-log-viewer.level.aliases`                   | ERROR / WARN / INFO / DEBUG 别名表 | object | extension-host-expert |

Add new tunables to `package.json` (NOT a separate config file) and read them via `vscode.workspace.getConfiguration('big-log-viewer')`.
