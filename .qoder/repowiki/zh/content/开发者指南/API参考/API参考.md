# API参考

<cite>
**本文档中引用的文件**
- [extension.ts](file://src/extension.ts)
- [logViewerPanel.ts](file://src/logViewerPanel.ts)
- [logProcessor.ts](file://src/logProcessor.ts)
- [webview.html](file://src/webview.html)
- [package.json](file://package.json)
</cite>

## 目录
1. [简介](#简介)
2. [扩展命令API](#扩展命令api)
3. [LogViewerPanel类API](#logviewerpanel类api)
4. [LogProcessor类API](#logprocessor类api)
5. [WebView通信消息](#webview通信消息)
6. [数据结构定义](#数据结构定义)
7. [错误处理机制](#错误处理机制)

## 简介

large_log_check是一个Visual Studio Code扩展，提供专业的大型日志文件查看和处理功能。该扩展通过三个核心模块实现完整的日志处理能力：
- **extension.ts**: VSCode扩展入口点，注册命令和激活逻辑
- **logViewerPanel.ts**: WebView面板管理器，负责UI交互和状态管理
- **logProcessor.ts**: 日志处理器，提供核心日志处理算法

## 扩展命令API

### big-log-viewer.openLogFile

**触发条件**: 用户通过命令面板、文件资源管理器右键菜单或编辑器标题栏触发

**执行逻辑**:
1. 显示文件选择对话框（如果未提供URI）
2. 验证文件格式（.log, .txt）
3. 创建或显示日志查看器面板
4. 加载指定的日志文件

**参数**: 
- `uri` (可选): vscode.Uri - 要打开的日志文件路径

**使用示例**:
```typescript
// 通过命令面板调用
vscode.commands.executeCommand('big-log-viewer.openLogFile');

// 通过文件资源管理器右键菜单调用
// 在文件上右键 -> "打开大日志文件"
```

**节来源**
- [extension.ts](file://src/extension.ts#L8-L31)

### big-log-viewer.deleteByTime

**触发条件**: 当前已打开日志文件且用户选择按时间删除操作

**执行逻辑**:
1. 检查是否已打开日志文件
2. 显示删除模式选择（之前/之后）
3. 输入目标时间（支持多种格式）
4. 提供三种操作选项：隐藏、导出、修改原文件
5. 执行相应的删除操作

**参数**: 无

**时间格式支持**:
- `YYYY-MM-DD HH:mm:ss`
- `YYYY/MM/DD HH:mm:ss`
- `DD-MM-YYYY HH:mm:ss`
- `YYYY-MM-DDTHH:mm:ss` (ISO 8601)

**节来源**
- [extension.ts](file://src/extension.ts#L35-L70)

### big-log-viewer.deleteByLine

**触发条件**: 当前已打开日志文件且用户选择按行数删除操作

**执行逻辑**:
1. 检查是否已打开日志文件
2. 显示删除模式选择（之前/之后）
3. 输入目标行号（必须大于0）
4. 提供三种操作选项：隐藏、导出、修改原文件
5. 执行相应的删除操作

**参数**: 无

**节来源**
- [extension.ts](file://src/extension.ts#L74-L109)

## LogViewerPanel类API

### 静态方法

#### createOrShow(extensionUri: vscode.Uri, fileUri: vscode.Uri)

**功能**: 创建或显示日志查看器面板

**参数**:
- `extensionUri`: vscode.Uri - 扩展根目录URI
- `fileUri`: vscode.Uri - 要加载的日志文件URI

**返回值**: 无

**行为**:
- 如果面板已存在，则显示现有面板并重新加载文件
- 如果面板不存在，则创建新面板并初始化

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L14-L38)

### 实例方法

#### dispose()

**功能**: 释放面板资源

**行为**:
- 清空当前面板引用
- 释放WebView面板
- 清理所有订阅的Disposable对象

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L497-L507)

#### deleteByTimeOptions(timeStr: string, mode: string)

**功能**: 处理按时间删除操作的用户选择

**参数**:
- `timeStr`: string - 目标时间字符串
- `mode`: string - 删除模式 ('before' | 'after')

**行为**:
1. 显示操作选择对话框
2. 根据用户选择执行相应操作
3. 更新UI显示结果

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L180-L228)

#### deleteByLineOptions(lineNumber: number, mode: string)

**功能**: 处理按行数删除操作的用户选择

**参数**:
- `lineNumber`: number - 目标行号
- `mode`: string - 删除模式 ('before' | 'after')

**行为**:
1. 显示操作选择对话框
2. 根据用户选择执行相应操作
3. 更新UI显示结果

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L230-L278)

## LogProcessor类API

### 构造函数

#### constructor(filePath: string)

**功能**: 初始化日志处理器

**参数**:
- `filePath`: string - 日志文件路径

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L56-L58)

### 核心方法

#### getTotalLines(): Promise<number>

**功能**: 获取文件总行数

**参数**: 无

**返回值**: Promise<number> - 文件总行数

**异常处理**: 
- 文件不存在时抛出Error
- 读取权限不足时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L63-L85)

#### readLines(startLine: number, count: number): Promise<LogLine[]>

**功能**: 读取指定范围的行

**参数**:
- `startLine`: number - 起始行号（从0开始）
- `count`: number - 读取行数

**返回值**: Promise<LogLine[]> - 日志行数组

**异常处理**: 
- 文件读取错误时抛出Error
- 流中断时自动停止

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L90-L130)

#### search(keyword: string, reverse: boolean = false): Promise<LogLine[]>

**功能**: 关键词搜索

**参数**:
- `keyword`: string - 搜索关键词
- `reverse`: boolean - 是否反向搜索（默认false）

**返回值**: Promise<LogLine[]> - 搜索结果

**异常处理**: 
- 搜索过程中出现错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L135-L173)

#### regexSearch(pattern: string, flags: string = 'i', reverse: boolean = false): Promise<LogLine[]>

**功能**: 正则表达式搜索

**参数**:
- `pattern`: string - 正则表达式模式
- `flags`: string - 正则标志（默认'i'）
- `reverse`: boolean - 是否反向搜索（默认false）

**返回值**: Promise<LogLine[]> - 搜索结果

**异常处理**: 
- 无效的正则表达式时抛出Error
- 搜索过程中出现错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L704-L749)

#### filterByTime(timeStr: string, mode: string, keep: boolean): Promise<LogLine[]>

**功能**: 按时间过滤日志（不修改文件）

**参数**:
- `timeStr`: string - 目标时间字符串
- `mode`: string - 过滤模式 ('before' | 'after')
- `keep`: boolean - 是否保留匹配项

**返回值**: Promise<LogLine[]> - 过滤结果

**异常处理**: 
- 无法解析时间格式时抛出Error
- 文件读取错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L178-L231)

#### filterByLevel(levels: string[]): Promise<LogLine[]>

**功能**: 按日志级别过滤

**参数**:
- `levels`: string[] - 要保留的日志级别列表

**返回值**: Promise<LogLine[]> - 过滤结果

**异常处理**: 
- 文件读取错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L650-L699)

#### deleteByTime(timeStr: string, mode: string): Promise<number>

**功能**: 按时间删除日志（修改原文件）

**参数**:
- `timeStr`: string - 目标时间字符串
- `mode`: string - 删除模式 ('before' | 'after')

**返回值**: Promise<number> - 删除的行数

**异常处理**: 
- 无法解析时间格式时抛出Error
- 文件写入错误时抛出Error
- 原文件替换失败时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L339-L409)

#### deleteByLine(lineNumber: number, mode: string): Promise<number>

**功能**: 按行数删除日志

**参数**:
- `lineNumber`: number - 目标行号
- `mode`: string - 删除模式 ('before' | 'after')

**返回值**: Promise<number> - 删除的行数

**异常处理**: 
- 文件写入错误时抛出Error
- 原文件替换失败时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L414-L475)

#### getStatistics(): Promise<LogStats>

**功能**: 获取日志统计信息

**参数**: 无

**返回值**: Promise<LogStats> - 统计信息对象

**统计信息包括**:
- 总行数
- 各级别日志数量
- 时间范围
- 类名统计
- 方法名统计
- 线程名统计

**异常处理**: 
- 文件读取错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L666-L699)

#### findLineByTime(timeStr: string): Promise<{ lineNumber: number; line: LogLine } | null>

**功能**: 查找第一个大于或等于指定时间的日志行

**参数**:
- `timeStr`: string - 目标时间字符串

**返回值**: Promise<{ lineNumber: number; line: LogLine } | null> - 找到的行信息或null

**异常处理**: 
- 无法解析时间格式时抛出Error
- 文件读取错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L237-L286)

#### exportLogs(lines: LogLine[], outputPath: string): Promise<void>

**功能**: 导出日志到文件

**参数**:
- `lines`: LogLine[] - 要导出的日志行
- `outputPath`: string - 输出文件路径

**返回值**: Promise<void>

**异常处理**: 
- 文件写入错误时抛出Error

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L754-L771)

## WebView通信消息

### 消息命令格式

WebView与扩展之间通过postMessage进行双向通信，支持以下命令：

#### loadMore
**用途**: 请求加载更多日志行

**数据格式**:
```typescript
{
  command: 'loadMore',
  startLine: number,  // 起始行号
  count: number       // 加载行数
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L58)

#### search
**用途**: 执行关键词搜索

**数据格式**:
```typescript
{
  command: 'search',
  keyword: string,    // 搜索关键词
  reverse: boolean    // 是否反向搜索
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L61)

#### regexSearch
**用途**: 执行正则表达式搜索

**数据格式**:
```typescript
{
  command: 'regexSearch',
  pattern: string,    // 正则表达式模式
  flags: string,      // 正则标志
  reverse: boolean    // 是否反向搜索
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L73)

#### filterByLevel
**用途**: 按日志级别过滤

**数据格式**:
```typescript
{
  command: 'filterByLevel',
  levels: string[]    // 日志级别列表
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L66)

#### getStatistics
**用途**: 获取日志统计信息

**数据格式**:
```typescript
{
  command: 'getStatistics'
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L69)

#### refresh
**用途**: 刷新当前日志文件

**数据格式**:
```typescript
{
  command: 'refresh'
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L64)

#### exportLogs
**用途**: 导出当前视图的日志

**数据格式**:
```typescript
{
  command: 'exportLogs',
  lines: LogLine[]     // 要导出的日志行
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L76)

#### deleteByTime
**用途**: 按时间删除日志

**数据格式**:
```typescript
{
  command: 'deleteByTime',
  timeStr: string,    // 目标时间
  mode: string        // 删除模式
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L79)

#### deleteByLine
**用途**: 按行数删除日志

**数据格式**:
```typescript
{
  command: 'deleteByLine',
  lineNumber: number, // 目标行号
  mode: string        // 删除模式
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L82)

#### jumpToTime
**用途**: 跳转到指定时间的日志

**数据格式**:
```typescript
{
  command: 'jumpToTime',
  timeStr: string     // 目标时间
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L85)

#### jumpToLineInFullLog
**用途**: 跳转到完整日志的指定行

**数据格式**:
```typescript
{
  command: 'jumpToLineInFullLog',
  lineNumber: number  // 目标行号
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L88)

#### showMessage
**用途**: 显示消息通知

**数据格式**:
```typescript
{
  command: 'showMessage',
  type: 'warning' | 'info',  // 消息类型
  message: string           // 消息内容
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L91)

### 响应消息格式

#### fileLoaded
**用途**: 文件加载完成响应

**数据格式**:
```typescript
{
  command: 'fileLoaded',
  data: {
    fileName: string,
    filePath: string,
    fileSize: string,
    totalLines: number,
    lines: LogLine[],
    allLoaded: boolean
  }
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L132-L142)

#### moreLines
**用途**: 加载更多行响应

**数据格式**:
```typescript
{
  command: 'moreLines',
  data: {
    startLine: number,
    lines: LogLine[]
  }
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L153-L159)

#### searchResults
**用途**: 搜索结果响应

**数据格式**:
```typescript
{
  command: 'searchResults',
  data: {
    keyword: string,
    results: LogLine[],
    isRegex?: boolean
  }
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L168-L174)

#### filterResults
**用途**: 过滤结果响应

**数据格式**:
```typescript
{
  command: 'filterResults',
  data: {
    levels: string[],
    results: LogLine[]
  }
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L418-L423)

#### statisticsResults
**用途**: 统计结果响应

**数据格式**:
```typescript
{
  command: 'statisticsResults',
  data: LogStats
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L441-L444)

#### jumpToTimeResult
**用途**: 时间跳转结果响应

**数据格式**:
```typescript
{
  command: 'jumpToTimeResult',
  data: {
    success: boolean,
    targetLineNumber?: number,
    lines?: LogLine[],
    startLine?: number,
    message?: string
  }
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L331-L339)

#### jumpToLineInFullLogResult
**用途**: 完整日志跳转结果响应

**数据格式**:
```typescript
{
  command: 'jumpToLineInFullLogResult',
  data: {
    fileName: string,
    filePath: string,
    fileSize: string,
    totalLines: number,
    lines: LogLine[],
    allLoaded: boolean,
    targetLineNumber: number
  }
}
```

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L390-L401)

## 数据结构定义

### LogLine接口

```typescript
interface LogLine {
  lineNumber: number;    // 行号（从1开始）
  content: string;       // 日志内容
  timestamp?: Date;      // 时间戳
  level?: string;        // 日志级别
}
```

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L4-L9)

### LogStats接口

```typescript
interface LogStats {
  totalLines: number;                    // 总行数
  errorCount: number;                    // 错误数量
  warnCount: number;                     // 警告数量
  infoCount: number;                     // 信息数量
  debugCount: number;                    // 调试数量
  otherCount: number;                    // 其他数量
  timeRange?: {                         // 时间范围
    start?: Date;
    end?: Date;
  };
  classCounts?: Map<string, number>;    // 类名统计
  methodCounts?: Map<string, number>;   // 方法名统计
  threadCounts?: Map<string, number>;   // 线程名统计
}
```

**节来源**
- [logProcessor.ts](file://src/logProcessor.ts#L11-L28)

## 错误处理机制

### 异常类型

1. **文件相关异常**
   - 文件不存在
   - 读取权限不足
   - 写入权限不足
   - 文件锁定

2. **时间解析异常**
   - 无法识别的时间格式
   - 无效的时间值

3. **正则表达式异常**
   - 语法错误
   - 无效的标志

4. **内存相关异常**
   - 文件过大导致内存不足
   - 流中断

### 错误处理策略

1. **用户友好提示**
   - 使用vscode.window.showError/WarningMessage显示错误信息
   - 提供具体的错误描述和解决建议

2. **优雅降级**
   - 大文件自动采用分页加载
   - 搜索失败时返回空结果而非崩溃

3. **资源清理**
   - 自动关闭文件流
   - 清理临时文件
   - 释放内存资源

4. **日志记录**
   - 在控制台输出详细错误信息
   - 记录关键操作的执行状态

**节来源**
- [logViewerPanel.ts](file://src/logViewerPanel.ts#L160-L162)
- [logProcessor.ts](file://src/logProcessor.ts#L82-L84)