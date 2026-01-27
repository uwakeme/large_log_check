# AGENTS.md - Big Log Viewer (VS Code Extension)

> AI agents working on this codebase should follow these guidelines.

## Project Overview

**Name**: big-log-viewer (大日志文件查看器)  
**Type**: VS Code Extension  
**Language**: TypeScript (strict mode)  
**Purpose**: Professional large log file viewer with virtual scrolling, search, filtering, and annotation features.

## Build/Lint/Test Commands

```bash
# Install dependencies
npm install

# Build (compile TypeScript to JavaScript)
npm run compile

# Development mode (auto-compile on file changes)
npm run watch

# Lint (ESLint with TypeScript rules)
npm run lint

# Clean build output
npm run clean

# Rebuild from scratch
npm run rebuild

# Package extension for distribution (.vsix)
npm run package

# Publish to VS Code Marketplace
npm run publish
```

### Debug Extension

1. Open project in VS Code
2. Press `F5` to launch Extension Development Host
3. Test extension in the new VS Code window
4. Code changes auto-compile when using `npm run watch`

### No Tests Currently

This project does not have a test suite. Consider adding tests when implementing new features.

## Project Structure

```
large_log_check/
├── src/
│   ├── extension.ts          # Extension entry point, command registration
│   ├── logViewerPanel.ts     # WebView panel management, HTML/CSS/JS injection
│   ├── logProcessor.ts       # Core log processing (read, search, delete)
│   └── webview.html          # WebView HTML template
├── media/
│   ├── webview.css           # WebView styles
│   └── webview.js            # WebView frontend logic
├── out/                      # TypeScript compilation output (git-ignored)
├── package.json              # Extension manifest and dependencies
├── tsconfig.json             # TypeScript compiler configuration
└── .cursor/rules/            # Cursor IDE rules
```

## Code Style Guidelines

### TypeScript Configuration

- **Target**: ES2020
- **Module**: CommonJS
- **Strict Mode**: Enabled (all strict checks active)
- **Source Maps**: Enabled for debugging

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Private class fields | Underscore prefix | `_panel`, `_fileUri`, `_disposables` |
| Public methods | camelCase | `createOrShow()`, `getActivePanel()` |
| Static fields | Underscore prefix for private | `private static _panels: Map<...>` |
| Interfaces | PascalCase | `LogLine`, `LogStats` |
| Constants (regex patterns) | camelCase in class | `timePatterns`, `logLevelPatterns` |

### Import Style

```typescript
// Node.js built-ins first
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';

// VS Code API
import * as vscode from 'vscode';

// Local modules
import { LogProcessor } from './logProcessor';
import { LogViewerPanel } from './logViewerPanel';
```

### Interface Definitions

```typescript
export interface LogLine {
    lineNumber: number;
    content: string;
    timestamp?: Date;
    level?: string;
}
```

### Async/Await Patterns

- Use `async/await` for all asynchronous operations
- Return `Promise<T>` explicitly for async methods
- Use `new Promise()` wrapper for stream-based operations

```typescript
async readLines(startLine: number, count: number): Promise<LogLine[]> {
    return new Promise((resolve, reject) => {
        // Stream processing logic
        rl.on('close', () => resolve(lines));
        rl.on('error', (error) => reject(error));
    });
}
```

### Error Handling

```typescript
try {
    const result = await this._logProcessor.someOperation();
    // Handle success
} catch (error) {
    vscode.window.showErrorMessage(`Operation failed: ${error}`);
}
```

### VS Code API Patterns

**Command Registration:**
```typescript
let command = vscode.commands.registerCommand('big-log-viewer.commandName', async () => {
    // Command logic
});
context.subscriptions.push(command);
```

**WebView Communication:**
```typescript
// Extension -> WebView
this._panel.webview.postMessage({ command: 'someCommand', data: {...} });

// WebView -> Extension (in onDidReceiveMessage handler)
switch (message.command) {
    case 'someAction':
        await this.handleAction(message.data);
        break;
}
```

**Disposable Pattern:**
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

### Stream-Based File Processing

Use Node.js streams for large file handling:

```typescript
const stream = fs.createReadStream(this.filePath);
const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
});

rl.on('line', (line) => {
    // Process each line
});

rl.on('close', () => {
    resolve(results);
});
```

### Comments and Documentation

- Comments are primarily in **Chinese** (project is Chinese-focused)
- Use JSDoc-style comments for public methods
- Inline comments for complex logic

```typescript
/**
 * Search for lines containing keyword
 * @param keyword Search keyword
 * @param reverse Reverse search order
 * @param isMultiple Multi-keyword mode (space-separated)
 */
async search(keyword: string, reverse: boolean = false, isMultiple: boolean = false): Promise<LogLine[]>
```

## Cursor Rules (IMPORTANT)

From `.cursor/rules/custom-rule.mdc`:

1. **Update README and CHANGELOG immediately** after adding or modifying features
2. Unreleased features go under **"Unreleased"** section in CHANGELOG
3. Same feature in same version = single entry (no duplicates)

## Key Architecture Patterns

### Singleton-like Panel Management

```typescript
private static _panels: Map<string, LogViewerPanel> = new Map();

public static createOrShow(extensionUri: vscode.Uri, fileUri: vscode.Uri) {
    const filePath = fileUri.fsPath;
    if (LogViewerPanel._panels.has(filePath)) {
        return LogViewerPanel._panels.get(filePath)!;
    }
    // Create new panel
}
```

### Progress Callback Pattern

```typescript
async getTotalLines(progressCallback?: (currentLines: number) => void): Promise<number> {
    // Report progress every 10,000 lines
    if (progressCallback && lineCount - lastReportedCount >= 10000) {
        progressCallback(lineCount);
    }
}
```

## Do's and Don'ts

### Do

- Use stream-based processing for file operations
- Implement proper cleanup with `dispose()` method
- Use VS Code configuration API for user settings
- Send/receive messages via WebView postMessage
- Support multiple file panels simultaneously

### Don't

- Load entire large files into memory at once
- Use synchronous file operations
- Suppress TypeScript strict mode errors with `as any`
- Forget to update README/CHANGELOG after feature changes
- Create duplicate entries in CHANGELOG for same feature

## Extension Configuration Options

Defined in `package.json`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `big-log-viewer.search.debounceMs` | number | 400 | Search input debounce time (ms) |
| `big-log-viewer.collapse.minRepeatCount` | number | 2 | Minimum repeats before collapsing |
| `big-log-viewer.timeline.samplePoints` | number | 200 | Timeline sampling points (20-1000) |

## Dependencies

**Dev Dependencies Only** (no runtime dependencies):
- `@types/node`: ^18.0.0
- `@types/vscode`: ^1.75.0
- `@typescript-eslint/eslint-plugin`: ^5.0.0
- `@typescript-eslint/parser`: ^5.0.0
- `eslint`: ^8.0.0
- `typescript`: ^5.0.0
- `@vscode/vsce`: ^2.22.0 (for packaging)
- `rimraf`: ^5.0.0 (for clean command)

## Environment Requirements

- Node.js >= 18.0.0
- VS Code >= 1.75.0
- TypeScript >= 5.0.0
