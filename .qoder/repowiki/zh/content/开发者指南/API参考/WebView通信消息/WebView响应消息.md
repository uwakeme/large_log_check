# WebView响应消息

<cite>
**本文档引用的文件**   
- [extension.ts](file://src\extension.ts)
- [logViewerPanel.ts](file://src\logViewerPanel.ts)
- [logProcessor.ts](file://src\logProcessor.ts)
- [webview.html](file://src\webview.html)
</cite>

## 目录
1. [介绍](#介绍)
2. [响应消息结构](#响应消息结构)
3. [消息序列化处理](#消息序列化处理)
4. [前端接收处理逻辑](#前端接收处理逻辑)
5. [错误状态处理](#错误状态处理)

## 介绍
本项目是一个VSCode扩展，用于查看和分析大型日志文件。扩展通过WebView界面与用户交互，后端（VSCode扩展）向前端（WebView）发送各种响应消息，以更新界面状态、返回查询结果和处理用户操作。这些消息通过`postMessage`机制发送，包含不同的命令和数据结构。

**Section sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L1-L509)
- [webview.html](file://src\webview.html#L1-L4178)

## 响应消息结构
后端向前端发送的响应消息遵循统一的结构：包含一个`command`字段标识消息类型，以及一个`data`字段包含具体的数据。以下是主要的响应消息类型及其结构：

### fileLoaded消息
当文件加载完成时，后端发送`fileLoaded`消息，通知前端文件已准备好。

```mermaid
classDiagram
class fileLoaded {
+command : "fileLoaded"
+data : FileLoadedData
}
class FileLoadedData {
+fileName : string
+filePath : string
+fileSize : string
+totalLines : number
+lines : LogLine[]
+allLoaded : boolean
}
class LogLine {
+lineNumber : number
+content : string
+timestamp? : Date
+level? : string
}
fileLoaded --> FileLoadedData : "包含"
FileLoadedData --> LogLine : "包含多条"
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L132-L142)

### moreLines消息
当需要加载更多日志行时，后端发送`moreLines`消息，返回额外的日志数据。

```mermaid
classDiagram
class moreLines {
+command : "moreLines"
+data : MoreLinesData
}
class MoreLinesData {
+startLine : number
+lines : LogLine[]
}
class LogLine {
+lineNumber : number
+content : string
+timestamp? : Date
+level? : string
}
moreLines --> MoreLinesData : "包含"
MoreLinesData --> LogLine : "包含多条"
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L153-L159)

### searchResults消息
当执行搜索操作后，后端发送`searchResults`消息，返回搜索结果。

```mermaid
classDiagram
class searchResults {
+command : "searchResults"
+data : SearchResultsData
}
class SearchResultsData {
+keyword : string
+results : LogLine[]
+isRegex? : boolean
}
class LogLine {
+lineNumber : number
+content : string
+timestamp? : Date
+level? : string
}
searchResults --> SearchResultsData : "包含"
SearchResultsData --> LogLine : "包含多条"
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L168-L174)
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L453-L460)

### filterResults消息
当执行过滤操作后，后端发送`filterResults`消息，返回过滤结果。

```mermaid
classDiagram
class filterResults {
+command : "filterResults"
+data : FilterResultsData
}
class FilterResultsData {
+levels : string[]
+results : LogLine[]
}
class LogLine {
+lineNumber : number
+content : string
+timestamp? : Date
+level? : string
}
filterResults --> FilterResultsData : "包含"
FilterResultsData --> LogLine : "包含多条"
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L198-L204)
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L417-L423)

### statisticsResults消息
当请求统计信息时，后端发送`statisticsResults`消息，返回详细的日志统计。

```mermaid
classDiagram
class statisticsResults {
+command : "statisticsResults"
+data : LogStats
}
class LogStats {
+totalLines : number
+errorCount : number
+warnCount : number
+infoCount : number
+debugCount : number
+otherCount : number
+timeRange? : TimeRange
+classCounts? : object
+methodCounts? : object
+threadCounts? : object
}
class TimeRange {
+start? : Date
+end? : Date
}
statisticsResults --> LogStats : "包含"
LogStats --> TimeRange : "可选包含"
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L441-L444)
- [logProcessor.ts](file://src\logProcessor.ts#L11-L28)

### jumpToTimeResult消息
当执行时间跳转操作时，后端发送`jumpToTimeResult`消息，返回跳转结果。

```mermaid
classDiagram
class jumpToTimeResult {
+command : "jumpToTimeResult"
+data : JumpToTimeResultData
}
class JumpToTimeResultData {
+success : boolean
+targetLineNumber? : number
+lines? : LogLine[]
+startLine? : number
+message? : string
}
class LogLine {
+lineNumber : number
+content : string
+timestamp? : Date
+level? : string
}
jumpToTimeResult --> JumpToTimeResultData : "包含"
JumpToTimeResultData --> LogLine : "可选包含多条"
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L331-L339)
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L343-L349)

## 消息序列化处理
由于WebView的`postMessage`机制不支持直接传输`Map`等复杂对象，后端在发送包含`Map`类型的数据时需要进行序列化处理。

### Map类型转换
在`getStatistics`方法中，`LogStats`接口定义了`classCounts`、`methodCounts`和`threadCounts`为`Map`类型，但在发送前需要转换为普通对象。

```mermaid
flowchart TD
A[获取统计信息] --> B{包含Map类型?}
B --> |是| C[使用Object.fromEntries转换]
B --> |否| D[直接发送]
C --> E[发送序列化后的对象]
D --> E
E --> F[前端接收并处理]
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L433-L439)

**Section sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L429-L448)
- [logProcessor.ts](file://src\logProcessor.ts#L566-L645)

## 前端接收处理逻辑
前端通过监听`message`事件来接收后端发送的消息，并根据`command`字段分发到不同的处理函数。

```mermaid
sequenceDiagram
participant 后端 as 后端(VSCode扩展)
participant 前端 as 前端(WebView)
后端->>前端 : postMessage({command : 'fileLoaded', data : {...}})
前端->>前端 : 监听到message事件
前端->>前端 : 根据command分发
前端->>前端 : 调用handleFileLoaded(data)
前端->>前端 : 更新UI界面
后端->>前端 : postMessage({command : 'moreLines', data : {...}})
前端->>前端 : 监听到message事件
前端->>前端 : 根据command分发
前端->>前端 : 调用handleMoreLines(data)
前端->>前端 : 追加日志行到界面
后端->>前端 : postMessage({command : 'searchResults', data : {...}})
前端->>前端 : 监听到message事件
前端->>前端 : 根据command分发
前端->>前端 : 调用handleSearchResults(data)
前端->>前端 : 显示搜索结果
```

**Diagram sources**
- [webview.html](file://src\webview.html#L1189-L1214)
- [webview.html](file://src\webview.html#L1217-L1241)

**Section sources**
- [webview.html](file://src\webview.html#L1180-L1399)

## 错误状态处理
系统在处理各种操作时都包含了完善的错误处理机制，确保用户能够获得清晰的反馈。

### 后端错误处理
后端在处理文件操作、搜索、过滤等操作时，使用try-catch捕获异常，并通过VSCode的API显示错误信息。

```mermaid
flowchart TD
A[执行操作] --> B{发生错误?}
B --> |是| C[捕获异常]
C --> D[显示错误消息]
C --> E[发送错误状态到前端]
B --> |否| F[发送成功结果]
D --> G[用户收到反馈]
E --> G
F --> G
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L145-L147)
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L160-L163)

### 前端错误处理
前端在接收到错误状态时，会显示相应的提示信息，帮助用户理解问题所在。

```mermaid
sequenceDiagram
participant 后端 as 后端
participant 前端 as 前端
后端->>前端 : 发送错误结果
前端->>前端 : 检查success字段
前端->>前端 : 显示错误提示
前端->>用户 : 用户获得反馈
```

**Diagram sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L343-L349)
- [webview.html](file://src\webview.html#L1277-L1282)

**Section sources**
- [logViewerPanel.ts](file://src\logViewerPanel.ts#L320-L360)
- [webview.html](file://src\webview.html#L1265-L1283)