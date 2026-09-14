# v1.3.3 发版计划 — Issue #2 / #3（#1 暂缓）

> 仓库：https://github.com/uwakeme/large_log_check（VSCode 扩展「大日志文件查看器」，当前版本 1.3.2）
> 工作目录：`E:/projects/large_log_check`；默认分支：`main`
> 调查日期：2026-09-14（初版 v1 → 评审修订 v2 → 实测复现修订 v3）
> 数据来源：GitHub REST API（`issues?state=all`）+ 本地源码逐行核实（文中所有行号均已验证）

## 0. 修订记录

| 版本 | 修订内容 |
|---|---|
| v2（评审） | R1：#2 根因重写——`handleDataChange` 的 `clearPageRanges` 默认 `true`，「旧索引未清」说法不成立，真实机制见 §4.2。R2：#2 修复范围扩到慢路径 `handleJumpToLineInFullLogResult`。R3：#3 生效语义定稿为「刷新后生效」。R4：#3 监听移到 extension.ts、单字符别名不进裸词正则。R5：复用现有 `invalidateCaches()`（logProcessor.ts:395），不新增方法。R6：清理矛盾文案与落点 |
| **v3（本轮）** | **R7：#1 整体暂缓**——单条 disable 等交互需要重新设计，移出 1.3.3，issue 保持 open（§3 只留暂缓说明，v1 的 disable 设计作废）。**R8：#2 范围扩大为「折叠分页状态族」**——用户实测复现出更严重的症状：折叠后搜索，总页数不刷新（仍 98 页）且部分页空白；根因已定位为多条路径替换 `allLines` 时保留旧 `pageRanges`（§4.2-4.3），原「跳转错位」只是该族症状之一。**R9：修复清单重排为 A 组（分页状态失效，5 项）+ B 组（跳转退出折叠，2 项）** |
| v3.1（评审采纳） | A4 范围扩大：`clearCurrentPageSearch`（1777-1806）与 `searchInCurrentPage` 对称地绕过 `handleDataChange`，两条路径一并改写（进入 `resetPage:true` / 退出 `resetPage:false`，`clearPageRanges` 均为 `true`）；A4 定死为「改走 handleDataChange」，不复用 B 组 `exitCollapseMode()`。A5 守卫位置精确化——仅在 `shouldClearRanges=false` 续算分支生效，附实现示意。§4.5 第 8 项改为进入/退出双侧验证。§8 补 `clearCurrentPageSearch` 风险行 |

---

## 1. Summary

仓库现状：**3 个 open issue、0 个 closed、0 个 PR**（2026-09-14 经 API 核实，三条 issue 均无评论）。

- **#1「多次筛选 / 多条件」**：核心诉求已在 1.3.2 落地（查询构建器）。剩余的「单条临时 disable」等交互**需要重新设计，本期暂缓**，issue 保持 open。**不进 1.3.3。**
- **#2「折叠模式 × 搜索/筛选」**：**P0，范围比 issue 标题大得多**。用户实测：折叠后共 98 页，输入搜索后**仍是 98 页**且**部分页空白**。根因已定位——多条路径在替换 `allLines` 数据集时保留按旧数据集计算的 `pageRanges`，而折叠模式的续算逻辑对「变小了的数据集」会静默空转，`updatePagination` 又完全信任陈旧范围 → 页数错、翻页空白。同族还有原 issue 报告的「跳转完整日志错位」。**修复 = 分页状态失效（A 组）+ 跳转退出折叠（B 组）。**
- **#3「支持 I/E/W 等单字符级别」**：按既定计划执行——级别别名配置 `big-log-viewer.level.aliases`（§5，与 v2 一致无改动）。

优先级：**P0 #2（A 组 → B 组）→ P1 #3**，二者正交，并入 1.3.3 一次发版。#1 暂缓不阻塞发版。

---

## 2. 已核实事实索引（实现前速查）

| 位置 | 内容 |
|---|---|
| media/webview.js:24-29 | `isCollapseMode` / `expandedGroups` / `pageRanges` / `currentCalculationId` 模块级状态 |
| media/webview.js:66 | `fullDataCache` |
| media/webview.js:102-260 | `applyUnifiedFilters` —— 前端统一过滤，**替换 `allLines`**（246 行） |
| media/webview.js:268-311 | `setFilterAndApply` —— **用户主动触发时 `clearPageRanges: false`**（288-289 行 `!isUserAction`） |
| media/webview.js:1663-1690 | `search()` —— 搜索框全局搜索入口，走 `setFilterAndApply({keyword})`（1685，无 options） |
| media/webview.js:1695-1757 / 1777-1806 | `searchInCurrentPage` / `clearCurrentPageSearch` —— 当前页搜索进入与退出，**均裸调 `renderLines()+updatePagination()`，完全绕过 handleDataChange** |
| media/webview.js:360-388 | `handleDataChange` —— `clearPageRanges` 默认 `true`；`isCollapseMode` 时触发异步分页计算 |
| media/webview.js:647-676 | `handleSearchResults` —— 后端搜索回包，走默认（正确） |
| media/webview.js:678-760 | `handleFilterResults` —— 后端筛选回包，**显式 `clearPageRanges: false`**（703-707） |
| media/webview.js:788-845 | `handleJumpToLineInFullLogResult` —— 慢路径跳转落地，**未退折叠模式** |
| media/webview.js:853-975 | `renderLines` —— 872-877：`pageRanges.has(currentPage)` 命中即按旧范围 `slice` 新数组 |
| media/webview.js:1056-1145 | `calculateAllPagesAsync` —— **首个 `await` 前同步算前 5 页**；**续算逻辑（1080-1089）在数据集变小时静默空转**；`isCollapseMode=false` 时自行终止 |
| media/webview.js:1447-1458 | 行首「跳转到完整日志」按钮 |
| media/webview.js:2682-2686 | 右键菜单「跳转到完整日志」 |
| media/webview.js:2821 / 2829 / 3041 / 3047 | 高级搜索四函数；`confirmAdvancedSearch` 传 `clearPageRanges: true`（**正确**） |
| media/webview.js:3695-3732 | `clearAllFiltersWithLine`（取消筛选）—— **两处 `clearPageRanges: false`**（3715-3719、3724-3728） |
| media/webview.js:3965-4067 | `jumpToLine`（折叠分支 3983-4024 / 非折叠分支 4025-4057） |
| media/webview.js:4070-4119 | `jumpToLineInFullLog`（快路径 4079-4108） |
| media/webview.js:4131-4150 | `handleJumpToTimeResult`（转发 `jumpToLineInFullLog`） |
| media/webview.js:4326-4400 | `updatePagination` —— **折叠分支完全信任 `pageRanges` 推导 totalPages**（4330-4349） |
| media/webview.js:1891-1941 / 3613 / 3629 / 3645 | 级别复选框 / 类名 / 方法名 / 线程名快速筛选 —— 都汇入 `setFilterAndApply` |
| src/webview.html:94-116 / 509-539 | 级别与折叠复选框 / 高级搜索弹窗 |
| src/logParser.ts:34-45 / 48-53 / 61-63 / 112-133 / 138-155 / 157-163 | `timePatterns` / `logLevelTokens` / 三条级别正则 / `extractThreadName` / `extractLogLevel` / `normalizeLevel` |
| src/logProcessor.ts:18-19 / 114 等 9 处 / 340-388 / 395-397 | statsCache（mtime 键控）/ 行级 `level` 加载时定格 / `getStatistics` / **`invalidateCaches()` 已存在** |
| src/logViewerPanel.ts:11 / 71 / 421-459 / 539-559 | `_panels` / `getAllPanels()` / 宿主 `jumpToLineInFullLog`（±500 行 seek）/ `sendConfigToWebview` |
| src/extension.ts | 148 行，命令分发；当前无任何配置监听 |
| package.json:100-140 | configuration 区块（现 4 项） |
| README.md:186 / 188 / 209 / 211 / 258 | 高级搜索 / 折叠与筛选叠加 / 高亮规则 / 定位 / 设置项表格 |
| CHANGELOG.md:8 | `## [Unreleased]`（空） |

其他已核实：issue #2、#3 正文为空；本机无 `gh` CLI（issue 操作走浏览器）；AGENTS.md「默认分支 master」一行已过时，实际为 `main`。

---

## 3. Issue #1 — 「多次筛选 / 多条件」【暂缓，不进 1.3.3】

| 字段 | 值 |
|---|---|
| Issue | https://github.com/uwakeme/large_log_check/issues/1 |
| 报告人 / 日期 | SeulYoung，2026-04-24 |
| 状态 | 核心诉求（多条件 AND/OR + 实时预览 + 删除）已随 1.3.2 查询构建器落地；**剩余交互（单条临时 disable 等）需要重新设计** |
| 本期动作 | **无代码改动，issue 保持 open** |

- v1 计划里的「眼睛图标 disable」设计**作废**，待重新设计后再排期（届时另立设计稿）。
- 发版收尾时可在 issue 下简短回复：多条件查询构建器已于 1.3.2 发布（指向 README:186），其余交互在重新设计中，后续版本跟进——回复与否由发版时决定，不作为本期验收项。

---

## 4. Issue #2 — 折叠模式 × 搜索/筛选：分页状态族（P0）

| 字段 | 值 |
|---|---|
| Issue | https://github.com/uwakeme/large_log_check/issues/2 |
| 报告人 / 日期 | SeulYoung，2026-04-24（正文为空） |
| 判断 | **真实 bug 族，P0**。实测症状比 issue 标题严重：不止跳转错位，折叠后搜索整页数据都是错的 |

### 4.1 症状（两组）

**症状 A（用户 2026-09-14 实测复现）——折叠后搜索，页数不刷新 + 空白页**

1. 打开日志，勾选「折叠重复日志」→ 分页显示共 98 页
2. 在搜索框输入关键词回车
3. 实际：总页数**仍是 98**；翻页时**部分页完全空白**，只有前几页有内容

**症状 B（issue 原始报告）——折叠 + 搜索后，行首「跳转到完整日志」错位**

点击命中行行首链接按钮（webview.js:1447-1458）或右键「跳转到完整日志」，落到错误页码/错误内容，无目标行高亮。

### 4.2 根因：`allLines` 被替换，折叠分页状态却存活

折叠模式的分页状态 = `pageRanges`（每页 → 旧数据集上的数组下标范围）+ `expandedGroups` + 由 `pageRanges` 推导的总页数。**这些状态只在数据集不变时有效**。以下路径替换了 `allLines` 却让状态存活：

**坏路径（传了/等效于 `clearPageRanges: false`）**

| 路径 | 位置 | 说明 |
|---|---|---|
| `setFilterAndApply` 用户动作分支 | 288-295 | **用户实测症状 A 的直接入口**。全局搜索（`search()` 1685 无 options）、级别复选框（1935/1941）、类名/方法名/线程名快速筛选（3613/3629/3645）全部经过这里；`shouldClearRanges = !isUserAction` 对用户操作恒为 `false` |
| `handleFilterResults` | 703-707 | 数据未全量时的后端筛选回包，**显式** `clearPageRanges: false` |
| `clearAllFiltersWithLine` | 3715-3728 | 「取消筛选」两处 `clearPageRanges: false`（反向同病：ranges 是筛选小数据集时代算的，恢复全量后前 N 页内容照旧错位） |
| `searchInCurrentPage` / `clearCurrentPageSearch` | 1739-1744 / 1777-1806 | 当前页搜索进入裸替换 `allLines`、退出裸恢复 `allLines`，都只调 `renderLines()+updatePagination()`，**完全绕过 `handleDataChange`** |

**好路径（对照，勿动）**：`confirmAdvancedSearch`（3092-3096 显式 true）、`handleSearchResults`（674 默认）、`clearFilter`（337-341 显式 true）、`toggleCollapseMode`（1497 默认）。

**症状 A 完整因果链**（数字对应用户实测的 98 页场景）：

```
折叠模式浏览全量数据
└─ calculateAllPagesAsync 算出 98 页 pageRanges（下标基于 ~全量 N 行）

输入搜索 → search() → setFilterAndApply({keyword})
├─ applyUnifiedFilters()：allLines ← 命中子集（设 300 行）        // 246
├─ 用户动作 → shouldClearRanges = false → 旧 pageRanges 全部存活   // 289-293
├─ handleDataChange({resetPage:false, clearPageRanges:false, triggerAsyncCalc:true})
│   └─ calculateAllPagesAsync(shouldClearRanges=false) 续算逻辑     // 1080-1089
│       取最后一页（98）的 end ≈ N 作为 lastEndIndex
│       while (lastEndIndex < allLines.length) → N < 300 不成立
│       └─ 循环体一次都不跑，直接标记「计算完成 100%」——静默空转
└─ updatePagination() 折叠分支                                     // 4330-4349
    maxPage=98，maxRange.end=N ≥ 300 → totalPages = 98             // ← 「还是98页」

翻到第 k 页 → renderLines                                          // 872-877
    pageRanges.has(k) 成立 → 按旧范围 slice 300 行的新数组
    k ≥ 4 时 start > 300 → slice 得空数组 → 空白页                  // ← 「有的页是空白」
```

**症状 B 因果链**（v2 已定位，v3 修订表述）：`jumpToLineInFullLog` 快路径恢复完整数据后 `handleDataChange` 默认清了 `pageRanges`，但 `isCollapseMode` 仍为 true → 异步计算在首个 `await` 前同步填回前 5 页 → `jumpToLine` 进折叠分支，目标行多半不在前 5 页，退到「原始行号 ÷ pageSize」估页——与折叠感知页码语义错位 → 跳错页。慢路径 `handleJumpToLineInFullLogResult`（788-845）同样未退折叠。

### 4.3 修复方案

**原则：凡是替换 `allLines` 数据集的路径，必须整体失效折叠分页状态（`pageRanges` / `expandedGroups` / 总页数估算）。**

**A 组——分页状态失效（修症状 A 及取消筛选）**

| # | 改动 | 位置 |
|---|---|---|
| A1 | `setFilterAndApply`：`clearPageRanges` 恒为 `true`；`resetPage` 也恒为 `true`（新数据集上「保持当前页」没有连续性，回到第 1 页——高级搜索本来就是此行为） | 288-295 |
| A2 | `handleFilterResults`：`clearPageRanges: true`、`resetPage: true` | 703-707 |
| A3 | `clearAllFiltersWithLine`：两处 `clearPageRanges: true` | 3715-3728 |
| A4 | 当前页搜索**两条路径对称**改走 `handleDataChange`，不再裸调 `renderLines()+updatePagination()`：进入 `searchInCurrentPage` 用 `{resetPage:true, clearPageRanges:true}`（回第 1 页看结果，**折叠模式保持**）；退出 `clearCurrentPageSearch` 先恢复备份的 `allLines/currentPage`，再用 `{resetPage:false, clearPageRanges:true}`（保留恢复的页码，重算分页）——退出路径不能沿用进入的 `resetPage:true`，否则恢复的页码会被打回第 1 页。必须成对修改：只修进入（清了 pageRanges）会让退出路径撞上「pageRanges 属于搜索结果小数据集、恢复的是全量数据」的新错位。当前页搜索是「在当前页结果里搜子集」，不退出折叠模式（**不复用** B 组 `exitCollapseMode()`） | 1739-1744 / 1777-1806 |
| A5 | 防御加固：`calculateAllPagesAsync` **仅在 `shouldClearRanges=false` 的续算分支**（1080-1089）加一道守卫——若 `lastRange.end > allLines.length`，说明 `pageRanges` 是基于更大旧数据集算的、已陈旧 → `pageRanges.clear()` 并按全量重算语义执行（`pageNum`/`lastEndIndex` 保持初始值 1/0）。`shouldClearRanges=true` 路径无需守卫（1071 行本就 `pageRanges.clear()`）。把「未来路径漏传 `clearPageRanges:true` 时静默空转」的风险堵死 | 1080-1089 |

A5 实现位置示意（实施时按 `calculateAllPagesAsync` 实际上下文调整）：

```js
if (!shouldClearRanges && pageRanges.size > 0) {
    const lastPage = Math.max(...Array.from(pageRanges.keys()));
    const lastRange = pageRanges.get(lastPage);
    if (lastRange && lastRange.end > allLines.length) {
        // 陈旧：pageRanges 是旧数据集的产物，当前数据集已缩小 → 放弃续算，全量重算
        pageRanges.clear();
        shouldClearRanges = true;
    } else {
        // 原有续算逻辑：pageNum = lastPage + 1; lastEndIndex = lastRange.end; ...
    }
}
```

可选加固（A1-A4 落地后非必需）：`updatePagination` 折叠分支加一致性守卫（`maxRange.end > allLines.length` 时按标准公式估算）。

**B 组——跳转退出折叠（修症状 B）**

```js
// 跳转完整日志前退出折叠模式：折叠语境下的页码语义对完整日志无意义
function exitCollapseMode() {
    if (!isCollapseMode) { return; }
    isCollapseMode = false;
    const cb = document.getElementById('collapseRepeated');
    if (cb) { cb.checked = false; }
    expandedGroups.clear();
    pageRanges.clear();
    isCalculatingPages = false;
    calculationProgress = 0;
    currentCalculationId++; // 让可能仍在运行的异步分页计算立即失效（循环内有守卫会自行退出）
}
```

调用点两处：`jumpToLineInFullLog` 快路径开头（fullDataCache 恢复之前）、`handleJumpToLineInFullLogResult` 开头（788 行起）。此后 `jumpToLine` 走非折叠分支（4025）精确 `findIndex`。异步计算循环在 `isCollapseMode=false` 时有守卫自行终止（1092/1102/1115），无泄漏。

### 4.4 改动清单

| 文件 | 改动 |
|---|---|
| `media/webview.js` | A1-A4 传参修正 + A5 守卫 + 新增 `exitCollapseMode()` 并在两处跳转路径调用 |
| `CHANGELOG.md` | `## [Unreleased]` → `### Fixed` 一条（覆盖症状 A + B） |
| `README.md`（188 行折叠与筛选段落附近） | 补一句：搜索/筛选后分页按结果重新计算；跳转到完整日志会自动退出折叠模式 |

### 4.5 验证步骤

1. **用户复现场景（症状 A）**：折叠模式浏览到 98 页 → 搜索 → 页数按命中结果重新计算（异步「计算中…」后收敛为精确值）、逐页翻无空白页、内容正确
2. 级别复选框增减、类名/方法名/线程名快速筛选 → 同样页数重算、无空白页
3. 「取消筛选」→ 恢复全量后页数与内容正确（覆盖 `clearAllFiltersWithLine` 两个分支）
4. 数据未全量时的筛选（后端 `handleFilterResults` 路径）→ 回包后页数正确
5. **症状 B**：折叠 + 搜索后点行首跳转按钮 → 搜索词清空、折叠复选框取消勾选、精确定位并高亮；慢路径（数据未加载完）、时间定位链路（4131-4150）、右键菜单入口同样验证
6. 跳转后重新勾选折叠 → 折叠模式恢复正常
7. 高级搜索路径回归（其传参本来就正确，确认无行为变化）
8. 当前页搜索（勾「当前页」）折叠模式下**双侧验证**：进入搜索 → 页数按当前页结果重算、折叠模式保持、无空白页；清空搜索框退出 → 恢复原数据集，页数与折叠模式都回到搜索前状态
9. 100MB 级日志冒烟

### 4.6 验收

- [ ] `npm run lint` / `npm run compile` / `npm test` 全绿
- [ ] §4.5 全部通过，尤其是用户实测的「98 页 + 空白页」场景
- [ ] 行为变化已确认并写入 CHANGELOG：搜索/筛选后回到第 1 页（此前用户操作会尝试保持页码）
- [ ] 4 主题无样式回归（纯逻辑改动，风险低）

---

## 5. Issue #3 — 级别别名配置（按 v2 计划执行，无改动）

| 字段 | 值 |
|---|---|
| Issue | https://github.com/uwakeme/large_log_check/issues/3 |
| 报告人 / 日期 | fredguo0312，2026-08-15（正文为空，仅标题） |
| 判断 | **真实需求，P1**。I/E/W/ERR 等变体不在任何级别正则里 → 统计落「其他」、级别过滤隐藏该行 |

### 5.1 设计：`big-log-viewer.level.aliases` 配置

#### 5.1.1 配置 schema（package.json `contributes.configuration` 新增）

```json
"big-log-viewer.level.aliases": {
    "type": "object",
    "default": {
        "ERROR": ["E", "F", "ERR"],
        "WARN":  ["W", "WRN"],
        "INFO":  ["I", "INF"],
        "DEBUG": ["D", "T", "V", "DBG", "TRC"]
    },
    "additionalProperties": {
        "type": "array",
        "items": { "type": "string" }
    },
    "description": "日志级别别名映射（键仅限 ERROR/WARN/INFO/DEBUG）。标准级别词（ERROR/FATAL/SEVERE/WARN/WARNING/INFO/INFORMATION/DEBUG/TRACE/VERBOSE）始终参与识别，此表只定义额外别名，编辑此值即整体替换默认值——例如业务日志里 I 另有含义，从 INFO 数组删掉 \"I\" 即可。单字符别名仅在「时间戳之后」与「[方括号]」两种形态参与识别，不参与裸词识别，避免把消息正文里的 I/O、英文 I 误判为级别。"
}
```

语义约定：
- **标准 token 永远参与匹配**（内置，不受配置影响）；此表只定义额外别名；
- 用户值**整体替换**默认表（VSCode object 配置的自然语义）——「关掉某个默认别名」= 删掉那一项；
- 键仅限 ERROR/WARN/INFO/DEBUG（大小写不敏感），非法键在解析时忽略。

#### 5.1.2 单字符别名的正则参与范围

| 形态 | 现有正则 | 参与的 token 集 |
|---|---|---|
| quickMatch（时间戳后） | `\d{2}:\d{2}:\d{2}[^\w]+(TOKENS)\b` | 内置 10 词 + **全部**别名 token |
| bracketForm（`[TOKEN]`） | `\[(TOKENS)\]` | 内置 10 词 + **全部**别名 token |
| bareForm（裸词） | `\b(TOKENS)\b` | 内置 10 词 + **仅长度 ≥ 2** 的别名 token |

理由：单字符进裸词会命中英文代词 `I`、`I/O` 的 `I`——且正则按位置先到先得，`2026-09-14 10:00:00.123 disk I/O error on sda1` 会因 `I` 位置先于 `error` 被判成 INFO（当前正确判为 ERROR），是真实回归。单字符前缀格式（`10:00:00 I start`、`[E] …`）几乎总是紧邻时间戳或方括号，quick/bracket 已覆盖 issue 诉求。

**已知限制**（写入 README）：无时间戳裸词位置的单字符前缀（如 logcat 无时间戳格式的 `I/tag`）不识别，落入「其他」。后续如有需要，可为单字符单独加「带毫秒容差的 quick 变体」正则，本期不做。

#### 5.1.3 logParser.ts 改造（保持全 static，别名用 module 级状态）

```ts
export type CanonicalLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
export interface LevelAliasEntry { token: string; canonical: CanonicalLevel; }

const DEFAULT_LEVEL_ALIASES: readonly LevelAliasEntry[] = [
    { token: 'E', canonical: 'ERROR' }, { token: 'F', canonical: 'ERROR' }, { token: 'ERR', canonical: 'ERROR' },
    { token: 'W', canonical: 'WARN'  }, { token: 'WRN', canonical: 'WARN'  },
    { token: 'I', canonical: 'INFO'  }, { token: 'INF', canonical: 'INFO'  },
    { token: 'D', canonical: 'DEBUG' }, { token: 'T', canonical: 'DEBUG' },
    { token: 'V', canonical: 'DEBUG' }, { token: 'DBG', canonical: 'DEBUG' }, { token: 'TRC', canonical: 'DEBUG' },
];

// module 级可变状态 + 三个懒构造正则缓存
let _activeAliases: readonly LevelAliasEntry[] = DEFAULT_LEVEL_ALIASES;
let _quickRegex: RegExp | null = null;
let _bracketRegex: RegExp | null = null;
let _bareRegex: RegExp | null = null;

export function setLevelAliases(entries: readonly LevelAliasEntry[]): void {
    _activeAliases = entries.length > 0 ? entries : DEFAULT_LEVEL_ALIASES;
    _quickRegex = _bracketRegex = _bareRegex = null;
}

// 校验/归一化用户配置：非法键忽略、token 去空白大写去重；非对象或空 → 默认表
export function parseLevelAliases(raw: unknown): LevelAliasEntry[] { /* ... */ }
```

- token 集拼装：**长 token 排前**（避免 alternation 短词抢先）；bare 集不含单字符别名（§5.1.2）；
- 删除三个 `static readonly levelXxx` 正则字段，改为 `getQuickMatchRegex()` 等懒构造 getter，`extractLogLevel` 改调 getter；
- `normalizeLevel`：先查 `_activeAliases` 映射，再走现有四桶兜底（FATAL/SEVERE→ERROR 等行为不变）；
- `extractThreadName`（124 行）的排除集改为 `logLevelTokens ∪ 活跃别名全部 token`，保持「`[E]` 不作线程名」语义一致。

#### 5.1.4 配置生效语义与监听

**生效口径：刷新/重新打开文件后生效。** 不做「实时生效」——行级 `level` 在加载时定格，实时做不到统计与行级一致，混合状态比延迟生效更糟。

```
extension.ts activate()：
├─ 启动时：setLevelAliases(parseLevelAliases(读配置))          // 全局一次
└─ onDidChangeConfiguration（一次性注册，affectsConfiguration 限定本键）
    ├─ setLevelAliases(parseLevelAliases(新配置))
    └─ showInformationMessage('日志级别别名已更新，重新打开或刷新日志文件后生效')

logViewerPanel.ts loadFile() 开头：
└─ this._logProcessor.invalidateCaches()   // 复用现有方法（logProcessor.ts:395）
   // statsCache 是 mtime 键控：文件没变也必须失效，否则刷新后统计仍是旧口径
```

- 监听注册在 extension.ts 一次（不要放 LogViewerPanel 构造——多面板会重复注册）；
- 刷新前一切保持旧口径（统计与行级一致），刷新后整体切新口径——符合「宁显勿隐」；
- 时间线采样 `sampleTimeline` 无缓存，随刷新自然走新别名（实现时复核一遍即可）。

### 5.2 改动清单

| 文件 | 改动 |
|---|---|
| `package.json` | configuration 新增 `big-log-viewer.level.aliases`（§5.1.1） |
| `src/logParser.ts` | `LevelAliasEntry` / `DEFAULT_LEVEL_ALIASES` / `setLevelAliases` / `parseLevelAliases` / 三个懒构造 getter；删三个 static 正则字段；`extractLogLevel`、`normalizeLevel`、`extractThreadName` 改造（§5.1.3） |
| `src/extension.ts` | activate 启动时初始化别名 + 注册一次性 `onDidChangeConfiguration`（§5.1.4），Disposal 推入 `context.subscriptions` |
| `src/logViewerPanel.ts` | `loadFile()` 开头调 `this._logProcessor.invalidateCaches()` |
| `src/logProcessor.ts` | **无改动**（`invalidateCaches()` 已存在，勿重复新增） |
| `test/logParser.test.cjs`（新建） | 用例见 §5.3；`require('../out/logParser.js')`；`beforeEach` 调 `setLevelAliases([])` 重置全局状态 |
| `README.md` | 设置项表格（258 行附近）加别名配置行；级别过滤段落补说明 + 已知限制 |
| `CHANGELOG.md` | `## [Unreleased]` → `### Added` 一条（含「统计口径扩大」提示） |

### 5.3 验证步骤

单元测试（`npm test`）覆盖：

1. **默认表映射**：`10:00:00 I start`→INFO；`E`→ERROR；`W`→WARN；`D/T/V`→DEBUG；`F`→ERROR；ERR/WRN/INF/DBG/TRC 各归其位
2. **形态边界**：`10:00:00 E x`（quick）识别；`[E] x`（bracket）识别；`E/tag x`（裸词单字符）→ `undefined`（落入「其他」）
3. **标准词回归**：`10:00:00 ERROR x` / `[INFO] x` / 裸词 `… error …` 行为与现状一致
4. **负样例（关键）**：`East`/`Window` 不误判；`disk I/O error on sda1` → **ERROR**（`I` 不参与裸词）；英文 `I think we should retry` → `undefined`
5. **配置生效**：`setLevelAliases` 后立即用新表；置空恢复默认；`{"ERROR": ["EXCEPTION"]}` → `EXCEPTION boom` 判 ERROR
6. **normalizeLevel 兜底**：FATAL/SEVERE→ERROR、WARNING→WARN、INFORMATION→INFO、TRACE/VERBOSE→DEBUG 不变
7. **extractThreadName**：`[E]`/`[ERR]` 不作线程名；`[main]`、`[http-nio-1]` 仍识别

手工 F5 验证：

1. 打开含 I/E/W/D 缩写的测试日志 → 统计四桶正确、「其他」为 0；工具栏勾掉 DEBUG → 对应行消失；默认高亮规则命中级别位
2. `settings.json` 从 INFO 数组删掉 `"I"` → 右下角出现「已更新，刷新后生效」提示 → 点刷新 → `I` 行落入「其他」
3. **多面板**：同时开两个日志文件 → 改配置 → 只出现一条全局提示（无重复）→ 各自刷新后统计均为新口径
4. 刷新前打开统计弹窗 → 仍是旧口径（与已加载行一致，无混合状态）

### 5.4 验收

- [ ] `npm run lint` / `npm run compile` / `npm test` 全绿（本版本起 test/ 有首批真实用例）
- [ ] 正负样例全过（含 I/O、英文 I 两个关键负样例）
- [ ] 4 主题下高亮颜色与 1.3.2 一致
- [ ] 配置变更「刷新后生效」语义符合 §5.1.4，无混合状态
- [ ] issue #3 关闭回复含配置项说明 + 默认值表 + 已知限制

---

## 6. 发版节奏与流程

### 6.1 打包

| 版本 | 内容 | 风险 |
|---|---|---|
| **1.3.3** | #2 折叠分页状态族修复（A 组 + B 组）+ #3 级别别名配置；**关闭 #2、#3**；#1 保持 open | 中。两件事正交（webview.js 状态机 / logParser.ts 正则） |

> 备注：CHANGELOG 声明遵循 SemVer，严格论「新增功能」应升 1.4.0；仓库惯例是 patch 塞功能（1.3.2 即如此），**维持 1.3.3**。

工作量粗估：#2 一天（A 组改动面比原计划大，验证矩阵 9 项）+ #3 一天（含单测）+ 发版收尾半天。

### 6.2 发版步骤（按 AGENTS.md 流程）

1. 两个 issue 的代码各自独立 commit（Conventional Commits，中文，参照 `git log --oneline`），每个 commit 同步带上对应的 README/CHANGELOG 更新（cursor rule：一个 feature 一个 commit 内文档齐）
2. `package.json` 版本 `1.3.2` → `1.3.3`
3. CHANGELOG `## [Unreleased]` 两条移入 `## [1.3.3] - <发版日>`，顶部保留空 `## [Unreleased]`
4. `npm run package` —— `vscode:prepublish`（lint + compile + test）必须通过；产物 `big-log-viewer-1.3.3.vsix`
5. 提交 `1.3.2 -> 1.3.3`，打附注标签 `v1.3.3`，`main` 与 tag 一起 push（README 徽章读最新 tag）
6. 生成 GitHub Release 文案交给用户手动发布（**绝不 `vsce publish`**）：
   - 标题：`大日志文件查看器 v1.3.3`
   - 正文：仅 CHANGELOG 摘要（Added/Fixed 各一条短句），**不含安装说明**；`.vsix` 作为附件由用户上传（GitHub + Marketplace）
   - Label：Latest

### 6.3 Issue 收尾（本机无 gh，浏览器手动操作）

| Issue | 动作 |
|---|---|
| #2 | 回复修复说明（折叠模式下搜索/筛选后分页按结果重算；跳转完整日志自动退出折叠）+ 感谢报告 → **关闭** |
| #3 | 回复新配置项 `big-log-viewer.level.aliases` + 默认值表 + 单字符识别形态说明 + 已知限制 → **关闭** |
| #1 | **保持 open**。可选：回复「多条件查询构建器已于 1.3.2 发布（README 高级搜索章节），其余交互重新设计中，后续版本跟进」 |

### 6.4 顺手项（可选）

- AGENTS.md「Default branch: master」一行更新为 `main`（已核实实际分支），随发版 commit 带上

---

## 7. Non-goals

- **#1 的单条 disable 等交互**：需重新设计，另立计划后排期（本期不动）
- 折叠模式本身的性能/可读性优化
- 单字符别名的「带毫秒容差 quick 变体」正则（logcat 无时间戳格式本期不覆盖，见 §5.1.2 已知限制）
- `searchInCurrentPage` / 高级搜索等既有交互的产品形态调整（仅按 §4.3 修状态一致性，不改交互）
- 排查模板、书签、注释、主题等既有功能扩展
- 1.4.0 规划（等 1.3.3 用户反馈）

---

## 8. 风险与缓解

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| A1 行为变化：搜索/筛选后回到第 1 页（此前用户操作尝试保持页码） | 所有走 `setFilterAndApply` 的入口 | 「保持页码」在数据集替换后本就无意义且正是空白页根因；高级搜索早已是回第 1 页的行为；CHANGELOG 明示 |
| #2 复现依赖手工验证矩阵（9 项），纯 webview 状态机难单测 | 回归 | 状态机收敛为一条原则（数据集替换 ⇒ 分页状态失效），A5 守卫兜底防未来漏网；验证步骤逐项打勾 |
| 别名默认表使老用户统计口径变化（「其他」变少、对应级别变多） | 升级 1.3.3 | CHANGELOG 明示口径扩大；README 说明如何删默认单字符 |
| 用户自加的长别名误伤正文（如自加 `RUN`） | 用户自定义 | 配置即开关，文档说明权衡 |
| `sampleTimeline` 或其他未发现的 mtime 缓存残留旧口径 | 实现期 | 实现时 grep `ache` 复核（当前仅 statsCache 一处）；loadFile 统一失效 |
| `searchBackup` 恢复路径与 A 组改动的相互作用（恢复旧 pageRanges + 旧数据集） | 退出搜索/高级搜索恢复时 | 恢复的是「同一数据集」的配套状态，语义自洽；实现时将恢复路径纳入手工验证（§4.5-7） |
| `clearCurrentPageSearch`（webview.js:1777-1806）恢复 `allLines` 时同样裸调 `renderLines()+updatePagination()`，与 `searchInCurrentPage` 对称绕过 `handleDataChange` | 折叠模式 + 当前页搜索的退出路径 | A4 已扩到两条路径对称改写；§4.5 验证第 8 项覆盖进入/退出双侧 |
| issue 操作无 gh CLI | 收尾阶段 | 已确认本机无 gh，浏览器手动回复 + 关闭 |
| 首批单测引入（test/ 此前为空） | CI 习惯变化 | AGENTS.md 已备案该约束；webview 侧模块不进单测，无需浏览器全局 stub |

---

## 9. 决策汇总

1. **#1 暂缓**：不进 1.3.3，issue 保持 open；disable 等交互待重新设计后另立计划（v1 的眼睛图标方案作废）。
2. **#2 定性升级**：不是单个跳转 bug，而是「折叠分页状态在数据集替换后未失效」的状态族。修复原则一条——**替换 `allLines` 的路径必须整体失效折叠分页状态**；具体为 A 组 5 项（含 A5 防御守卫）+ B 组跳转退出折叠（`exitCollapseMode()`）。
3. **行为变化确认**：搜索/筛选后回到第 1 页（替代原「保持页码」），CHANGELOG 明示。
4. **#3 按既定方案执行**：级别别名配置；单字符别名不进裸词正则；「刷新后生效」；监听一次性注册在 extension.ts；复用现有 `invalidateCaches()`。
5. **发版**：1.3.3 = #2 + #3，关 #2/#3，#1 保持 open；SemVer 张力已知悉，按仓库惯例维持 patch。
