# Architecture

The extension has three runtime layers and five TypeScript source files. Knowing which layer owns a piece of state is the most important thing to internalize — most bugs come from putting state in the wrong place.

```
src/extension.ts            → command registration, lifecycle
src/logViewerPanel.ts       → WebView management, message bridge (host side)
src/logProcessor.ts         → file I/O, stream-based read/search/filter/delete
src/logParser.ts            → PURE functions (no I/O), extract timestamp/level/class/method/thread
src/webview.html            → WebView HTML scaffold (consumed via logViewerPanel._getHtmlForWebview)
```

`logParser.ts` is intentionally I/O-free so it can be unit-tested in isolation and eventually shared between host and webview (currently the webview has its own copy of the extraction logic — see "Known Limitations" in the review notes).

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

`LogViewerPanel._panels: Map<filePath, LogViewerPanel>` (`src/logViewerPanel.ts:8`) is the source of truth for "which panel shows which file". Opening the same file twice reveals the existing panel; opening a different file creates a new one. `LogViewerPanel.getActivePanel()` walks the map to find a visible panel — this is what every command in `extension.ts` dispatches into.

## Message protocol (extension ↔ WebView contract)

`LogViewerPanel.onDidReceiveMessage` switch in `src/logViewerPanel.ts:84` is the canonical list of what the WebView can ask the host to do (`loadMore`, `search`, `filterByLevel`, `filterByThread`, `refresh`, delete variants, `exportLogs`, etc.). When adding a feature that needs the host, add a case here. When a feature is purely visual, keep it in `media/webview.js`.

## Log parsing

- **Time format detection** iterates over five patterns in `timePatterns` (`src/logProcessor.ts:35`), in priority order. New formats are added by appending a regex, not by writing a parser.
- **Level detection** iterates over `logLevelPatterns` in the same file. Same append-a-regex rule.
- A line that doesn't match any time/level pattern still gets indexed — the line just has `timestamp` / `level` undefined.

## Progress reporting

`getTotalLines` accepts a `progressCallback` and fires every 10,000 lines. The panel surfaces this as the loading progress bar. When adding a long-running operation, follow the same pattern: a callback parameter + the WebView-side percentage UI.

## Settings (user-tunable behavior)

All settings live in `package.json` under `contributes.configuration.properties`:

| Setting                                          | Default | Range       | Owner rein                       |
|--------------------------------------------------|---------|-------------|----------------------------------|
| `big-log-viewer.search.debounceMs`               | 400     | ≥ 0         | webview-frontend-expert          |
| `big-log-viewer.collapse.minRepeatCount`         | 2       | ≥ 1         | webview-frontend-expert          |
| `big-log-viewer.timeline.samplePoints`           | 200     | 20 – 1000   | webview-frontend-expert          |
| `big-log-viewer.theme`                           | default | enum        | webview-frontend-expert          |

Add new tunables to `package.json` (NOT a separate config file) and read them via `vscode.workspace.getConfiguration('big-log-viewer')`.
