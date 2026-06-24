# Code Standards

These are the project's coding conventions. Every agent in `.harness/reins/` links to this file rather than re-encoding the rules in their own `agent.md`. Update here, not in every rein.

## TypeScript

- Strict mode is on (`tsconfig.json: strict: true`). Do NOT silence errors with `as any` — fix the types.
- Target: ES2020, module: CommonJS.
- All async methods return `Promise<T>` explicitly. Wrap stream events in `new Promise((resolve, reject) => { ... })`.
- Use `async/await` for all asynchronous operations — no raw `.then()` chains.

## Naming

- Private class fields: `_` prefix (`_panel`, `_fileUri`, `_logProcessor`, `_disposables`).
- Public methods: `camelCase` (`createOrShow`, `getActivePanel`).
- Static private fields: `_` prefix (`private static _panels: Map<...>`).
- Interfaces: `PascalCase` (`LogLine`, `LogStats`).
- Constants (regex patterns) in class: `camelCase` (`timePatterns`, `logLevelPatterns`).

## Imports

Order matters; lint config expects this order:

```typescript
// 1. Node.js built-ins
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';

// 2. VSCode API
import * as vscode from 'vscode';

// 3. Local modules
import { LogProcessor } from './logProcessor';
import { LogViewerPanel } from './logViewerPanel';
```

## Comments & UI strings

- Comments and all user-facing strings are in **Chinese**. Match the existing tone for new copy.
- Use JSDoc-style block comments for public methods.
- Inline comments for non-obvious logic (especially regex, parsing).

```typescript
/**
 * Search for lines containing keyword.
 * @param keyword  Search keyword
 * @param reverse  Reverse search order
 * @param isMultiple  Multi-keyword mode (space-separated)
 */
async search(keyword: string, reverse = false, isMultiple = false): Promise<LogLine[]>
```

## Stream-based file I/O (non-negotiable)

This extension's whole value proposition is multi-GB log support. All file reads MUST be stream-based:

```typescript
const stream = fs.createReadStream(this.filePath);
const rl = readline.createInterface({
  input: stream,
  crlfDelay: Infinity
});

rl.on('line', (line) => { /* process */ });
rl.on('close', () => { /* resolve */ });
rl.on('error', (err) => { /* reject */ });
```

Loading a whole file via `fs.readFileSync` or `fs.promises.readFile` is a bug, full stop.

## Disposable pattern

```typescript
private _disposables: vscode.Disposable[] = [];

public dispose() {
  this._panel.dispose();
  while (this._disposables.length) {
    const x = this._disposables.pop();
    if (x) { x.dispose(); }
  }
}
```

Always push new listeners/subscriptions into `_disposables` and let `dispose()` clean up.

## WebView communication

```typescript
// Extension host → WebView
this._panel.webview.postMessage({ command: 'someCommand', data: {...} });

// WebView → extension host (in onDidReceiveMessage)
switch (message.command) {
  case 'someAction':
    await this.handleAction(message.data);
    break;
}
```

The canonical list of accepted messages lives in the `onDidReceiveMessage` switch in `src/logViewerPanel.ts:84`. Add a case there when a feature needs host-side work; keep purely visual logic in `media/webview.js`.

## Lint

- `npm run lint` runs `eslint src --ext ts`. Must pass before any commit.
- No `eslint --fix` reflex on a lint error — read the error and fix the source.
