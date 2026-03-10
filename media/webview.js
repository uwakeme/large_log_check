const vscode = acquireVsCodeApi();
let allLines = [];
let currentSearchKeyword = '';
let currentSearchIsRegex = false; // 当前搜索是否为正则模式
let currentSearchIsMultiple = false; // 当前搜索是否为多关键词模式
let isInSearchMode = false;       // 是否处于搜索结果模式
let searchBackup = null;          // 搜索前的状态备份（分页、滚动、数据）
let originalLines = []; // 保存原始数据用于过滤
let isFiltering = false; // 标记是否在过滤模式下
let bookmarks = new Set(); // 书签集合，存储行号
let comments = new Map(); // 注释集合，key为行号，value为注释内容
let timelineData = null; // 时间线数据
let fileStats = null; // 完整的文件统计信息（包含时间范围）
let isTimelineExpanded = true; // 时间线是否展开
let isCollapseMode = false; // 是否开启折叠模式
let expandedGroups = new Set(); // 已展开的折叠组
let pageRanges = new Map(); // 记录每页实际加载的行范围 Map<pageNumber, {start, end}>
let isCalculatingPages = false; // 是否正在计算页面范围
let calculationProgress = 0; // 计算进度（0-100）
let currentCalculationId = 0; // 当前计算任务ID，用于取消旧任务
let lastHoveredBucketIndex = null; // 时间线当前悬停的桶索引
// 当前内存中 allLines[0] 对应的文件行索引（从 0 开始），用于统一后台增量加载起点
let baseLineOffset = 0;

// 用户可配置参数（从 VSCode 设置同步）
let userSettings = {
    searchDebounceMs: 400,
    collapseMinRepeatCount: 2,
    timelineSamplePoints: 200
};

// 筛选状态管理
let currentFilterType = null; // 当前筛选类型: 'thread', 'class', 'method', null
let currentFilterValue = null; // 当前筛选值
let savedPageBeforeFilter = 1; // 筛选前的页码
let savedFirstLineBeforeFilter = null; // 筛选前当前页第一行的行号

// ========== 统一过滤系统 ==========
// 所有过滤条件存储在这里，让各种过滤可以叠加生效
let unifiedFilters = {
    keyword: null,           // 搜索关键词
    isRegex: false,          // 是否正则搜索
    isMultiple: false,       // 是否多关键词搜索
    threadName: null,        // 线程名筛选
    className: null,         // 类名筛选
    methodName: null,        // 方法名筛选
    levels: null,            // 日志级别过滤 (数组，如 ['ERROR', 'WARN'])
    timeRange: null,         // 时间范围 { start, end }
};

// 原始完整数据（用于统一过滤）
let fullDataCache = [];

// ========== 按钮加载状态管理 ==========

/**
 * 设置按钮的加载状态
 * @param {HTMLButtonElement} button - 按钮元素
 * @param {boolean} loading - 是否处于加载状态
 */
function setButtonLoading(button, loading) {
    if (!button) return;
    if (loading) {
        button.classList.add('loading');
        button.disabled = true;
    } else {
        button.classList.remove('loading');
        button.disabled = false;
    }
}

/**
 * 根据按钮ID设置加载状态
 * @param {string} buttonId - 按钮的ID
 * @param {boolean} loading - 是否处于加载状态
 */
function setButtonLoadingById(buttonId, loading) {
    const button = document.getElementById(buttonId);
    setButtonLoading(button, loading);
}

// ========== 统一过滤系统核心函数 ==========

/**
 * 应用所有过滤条件到数据
 * 这个函数会将所有已设置的过滤条件叠加应用
 */
function applyUnifiedFilters() {
    console.log('应用统一过滤 - 当前条件:', unifiedFilters);
    
    // 如果没有任何过滤条件，显示全部数据
    if (!hasAnyFilter()) {
        console.log('没有过滤条件，显示全部数据');
        allLines = [...fullDataCache];
        isFiltering = false;
        currentSearchKeyword = '';
        return;
    }
    
    // 从完整数据开始过滤
    let results = [...fullDataCache];
    
    // 应用关键词搜索
    if (unifiedFilters.keyword) {
        currentSearchKeyword = unifiedFilters.keyword;
        currentSearchIsRegex = unifiedFilters.isRegex;
        currentSearchIsMultiple = unifiedFilters.isMultiple;
        
        results = results.filter(line => {
            const content = (line.content || '').toLowerCase();
            
            if (unifiedFilters.isRegex) {
                try {
                    const regex = new RegExp(unifiedFilters.keyword, 'i');
                    return regex.test(line.content || '');
                } catch (e) {
                    console.warn('正则表达式错误:', e);
                    return false;
                }
            } else if (unifiedFilters.isMultiple) {
                // 多关键词 AND 匹配
                const keywords = unifiedFilters.keyword.trim().split(/\s+/).map(k => k.toLowerCase());
                return keywords.every(k => content.includes(k));
            } else {
                return content.includes(unifiedFilters.keyword.toLowerCase());
            }
        });
    } else {
        currentSearchKeyword = '';
    }
    
    // 应用线程名筛选
    if (unifiedFilters.threadName) {
        results = results.filter(line => {
            const fields = extractLogFields(line);
            return fields.threadName && fields.threadName === unifiedFilters.threadName;
        });
    }
    
    // 应用类名筛选
    if (unifiedFilters.className) {
        results = results.filter(line => {
            const fields = extractLogFields(line);
            return fields.className && fields.className.includes(unifiedFilters.className);
        });
    }
    
    // 应用方法名筛选
    if (unifiedFilters.methodName) {
        results = results.filter(line => {
            const fields = extractLogFields(line);
            return fields.methodName && fields.methodName === unifiedFilters.methodName;
        });
    }
    
    // 应用日志级别过滤
    if (unifiedFilters.levels && unifiedFilters.levels.length > 0) {
        const levelsSet = new Set(unifiedFilters.levels.map(l => l.toUpperCase()));
        results = results.filter(line => {
            const level = line.level ? line.level.toUpperCase() : 'OTHER';
            return levelsSet.has(level);
        });
    }
    
    // 应用时间范围过滤
    if (unifiedFilters.timeRange) {
        results = results.filter(line => {
            if (!line.timestamp) return false;
            const lineTime = new Date(line.timestamp);
            
            if (unifiedFilters.timeRange.start) {
                const start = new Date(unifiedFilters.timeRange.start);
                if (lineTime < start) return false;
            }
            
            if (unifiedFilters.timeRange.end) {
                const end = new Date(unifiedFilters.timeRange.end);
                if (lineTime > end) return false;
            }
            
            return true;
        });
    }
    
    console.log(`过滤完成 - 原始数据: ${fullDataCache.length} 条，过滤后: ${results.length} 条`);
    
    allLines = results;
    isFiltering = hasAnyFilter();
}

/**
 * 检查是否有任何过滤条件
 */
function hasAnyFilter() {
    return !!(
        unifiedFilters.keyword ||
        unifiedFilters.threadName ||
        unifiedFilters.className ||
        unifiedFilters.methodName ||
        (unifiedFilters.levels && unifiedFilters.levels.length > 0) ||
        unifiedFilters.timeRange
    );
}

/**
 * 设置过滤条件并应用
 * @param {Object} filters - 要设置的过滤条件
 */
function setFilterAndApply(filters) {
    // 合并过滤条件
    Object.assign(unifiedFilters, filters);
    
    // 检查是否已完全加载数据
    if (allDataLoaded || fullDataCache.length >= totalLinesInFile) {
        // 数据已完全加载，在前端进行统一过滤
        console.log('数据已完全加载，在前端进行统一过滤');
        applyUnifiedFilters();
        
        // 更新界面
        handleDataChange({
            resetPage: true,
            clearPageRanges: true,
            triggerAsyncCalc: true
        });
        
        // 显示提示信息
        if (allLines.length === 0) {
            showToast('未找到符合所有条件的日志');
        } else {
            showToast(`找到 ${allLines.length} 条符合条件的日志`);
        }
    } else {
        // 数据未完全加载，请求后台加载全部数据
        console.log('数据未完全加载，请求后台加载全部数据');
        showToast(' 正在加载完整数据，请稍候...');
        
        // 请求后台继续加载
        requestAllData();
    }
}

/**
 * 清除特定的过滤条件
 */
function clearFilter(filterName) {
    if (filterName === 'keyword') {
        unifiedFilters.keyword = null;
        unifiedFilters.isRegex = false;
        unifiedFilters.isMultiple = false;
    } else if (filterName === 'threadName') {
        unifiedFilters.threadName = null;
    } else if (filterName === 'className') {
        unifiedFilters.className = null;
    } else if (filterName === 'methodName') {
        unifiedFilters.methodName = null;
    } else if (filterName === 'levels') {
        unifiedFilters.levels = null;
    } else if (filterName === 'timeRange') {
        unifiedFilters.timeRange = null;
    }
    
    // 重新应用剩余的过滤条件
    applyUnifiedFilters();
    
    // 更新界面
    handleDataChange({
        resetPage: true,
        clearPageRanges: true,
        triggerAsyncCalc: true
    });
}

/**
 * 清除所有过滤条件
 */
function clearAllFilters() {
    unifiedFilters = {
        keyword: null,
        isRegex: false,
        isMultiple: false,
        threadName: null,
        className: null,
        methodName: null,
        levels: null,
        timeRange: null,
    };
    
    applyUnifiedFilters();
    
    handleDataChange({
        resetPage: true,
        clearPageRanges: true,
        triggerAsyncCalc: true
    });
    
    showToast('已清除所有过滤条件');
}

/**
 * 统一处理数据变更后的页面计算
 * 在以下情况下调用：
 * 1. 文件加载/刷新
 * 2. 搜索/筛选操作
 * 3. 切换折叠模式
 * 4. 加载更多数据
 */
function handleDataChange(options = {}) {
    const {
        resetPage = true,           // 是否重置到第一页
        clearPageRanges = true,     // 是否清空页面范围记录
        triggerAsyncCalc = true     // 是否触发异步计算
    } = options;

    console.log('🔄 数据变更处理:', { resetPage, clearPageRanges, triggerAsyncCalc, isCollapseMode, dataLength: allLines.length });

    // 重置页码
    if (resetPage) {
        currentPage = 1;
    }

    // 清空页面范围记录
    if (clearPageRanges) {
        pageRanges.clear();
    }

    // 更新分页器和渲染
    updatePagination();
    renderLines();

    // 如果开启了折叠模式且有数据，触发异步计算
    if (triggerAsyncCalc && isCollapseMode && allLines.length > 0) {
        console.log('📊 触发异步页面计算...');
        calculateAllPagesAsync(clearPageRanges);
    }
}

// 分页参数
let currentPage = 1;
let pageSize = 100;
let totalPages = 1;

// 数据加载状态
let totalLinesInFile = 0;
let allDataLoaded = false;
let isBackgroundLoading = false; // 是否正在后台加载
let backgroundLoadChunkSize = 5000; // 每次后台加载的行数

window.addEventListener('message', event => {
    const message = event.data;

    switch (message.command) {
        case 'fileLoaded':
            handleFileLoaded(message.data);
            break;
        case 'moreLines':
            handleMoreLines(message.data);
            break;
        case 'searchResults':
            handleSearchResults(message.data);
            break;
        case 'filterResults':
            handleFilterResults(message.data);
            break;
        case 'statisticsResults':
            handleStatisticsResults(message.data);
            break;
        case 'timelineData':
            handleTimelineData(message.data);
            break;
        case 'jumpToTimeResult':
            handleJumpToTimeResult(message.data);
            break;
        case 'jumpToLineInFullLogResult':
            handleJumpToLineInFullLogResult(message.data);
            break;
        case 'toggleBookmarks':
            showBookmarksModal();
            break;
        case 'toggleComments':
            showCommentsModal();
            break;
        case 'showAdvancedSearch':
            showAdvancedSearchModal();
            break;
        case 'config':
            if (message.data) {
                userSettings = {
                    ...userSettings,
                    searchDebounceMs: typeof message.data.searchDebounceMs === 'number' ? message.data.searchDebounceMs : userSettings.searchDebounceMs,
                    collapseMinRepeatCount: typeof message.data.collapseMinRepeatCount === 'number' ? message.data.collapseMinRepeatCount : userSettings.collapseMinRepeatCount,
                    timelineSamplePoints: typeof message.data.timelineSamplePoints === 'number' ? message.data.timelineSamplePoints : userSettings.timelineSamplePoints
                };
                console.log('已从扩展配置同步设置:', userSettings);
            }
            break;
        case 'loadingProgress':
            updateLoadingProgress(message.data);
            break;
    }
});

/**
 * 更新加载进度
 */
function updateLoadingProgress(data) {
    const loadingIndicator = document.getElementById('loadingIndicator');
    const progressBar = document.getElementById('loadingProgressBar');
    const progressText = document.getElementById('loadingProgressText');
    const loadingStage = document.getElementById('loadingStage');
    
    // 确保加载提示是显示的
    if (loadingIndicator) {
        loadingIndicator.style.display = 'flex';
        loadingIndicator.style.pointerEvents = 'auto';
    }
    
    if (progressBar && data.progress !== undefined) {
        const progress = Math.min(100, Math.max(0, data.progress));
        progressBar.style.width = progress + '%';
        
        if (progressText) {
            progressText.textContent = `${progress.toFixed(1)}%`;
            
            // 显示具体信息
            if (data.current && data.total) {
                progressText.textContent += ` (${data.current.toLocaleString()} / ${data.total.toLocaleString()} 行)`;
            }
        }
    }
    
    if (loadingStage && data.stage) {
        loadingStage.textContent = data.stage;
    }
}

function handleFileLoaded(data) {
    // 隐藏加载提示（使用 !important 强制覆盖）
    const loadingIndicator = document.getElementById('loadingIndicator');
      
    if (loadingIndicator) {
        loadingIndicator.style.display = 'none';
        loadingIndicator.style.pointerEvents = 'none';
    }
    
    // 恢复刷新按钮状态
    setButtonLoadingById('refreshBtn', false);
    
    document.getElementById('fileName').textContent = data.fileName || '';
    document.getElementById('fileSize').textContent = data.fileSize || '0';
    document.getElementById('totalLines').textContent = data.totalLines || '0';

    totalLinesInFile = data.totalLines || 0;
    // 初次加载时，数据从文件开头开始
    baseLineOffset = 0;
    allDataLoaded = data.allLoaded || false;
    isFiltering = false; // 重置过滤状态
    currentSearchKeyword = ''; // 重置搜索关键词
    currentSearchIsRegex = false;
    currentSearchIsMultiple = false;
    isInSearchMode = false;
    searchBackup = null;

    // 清除筛选状态
    currentFilterType = null;
    currentFilterValue = null;
    hideFilterStatus();
    
    // 清除统一过滤条件
    unifiedFilters = {
        keyword: null,
        isRegex: false,
        isMultiple: false,
        threadName: null,
        className: null,
        methodName: null,
        levels: null,
        timeRange: null,
    };

    allLines = data.lines || [];
    originalLines = [...allLines];
    
    // 初始化完整数据缓存（用于统一过滤）
    fullDataCache = [...allLines];

    // 统一处理数据变更
    handleDataChange();

    // 异步请求采样时间线数据（快速，不阻塞UI）
    vscode.postMessage({
        command: 'sampleTimeline',
        sampleCount: userSettings.timelineSamplePoints || 200  // 采样点数可配置
    });

    // 如果数据未全部加载，启动后台加载
    if (!allDataLoaded && allLines.length < totalLinesInFile) {
        // 重置后台加载状态，并从当前偏移量开始统一加载
        isBackgroundLoading = false;
        startBackgroundLoading();
    }
}

function handleMoreLines(data) {
    const newLines = data.lines || [];
    const startLine = typeof data.startLine === 'number' ? data.startLine : (baseLineOffset + allLines.length);

    console.log(` handleMoreLines: 收到 ${newLines.length} 行, startLine = ${startLine}, baseLineOffset = ${baseLineOffset}`);

    // 更新右下角后台加载进度
    updateBackgroundLoadingProgress();

    // 确保新数据与当前缓冲区在文件中的位置是连续的：
    // 期望 startLine === baseLineOffset + allLines.length
    const expectedStart = baseLineOffset + fullDataCache.length;
    if (startLine !== expectedStart) {
        console.warn(`handleMoreLines: 起始行不连续, 期望 ${expectedStart}, 实际 ${startLine}，将重置缓冲区为新数据`);
        // 出现不连续时，为避免错乱，直接以新数据为准并重置偏移量
        baseLineOffset = startLine;
        fullDataCache = newLines.slice();
    } else {
        // 追加到完整数据缓存
        fullDataCache = fullDataCache.concat(newLines);
    }
    
    // 重新应用统一过滤（如果有过滤条件）
    if (hasAnyFilter()) {
        applyUnifiedFilters();
    } else {
        allLines = [...fullDataCache];
        originalLines = [...fullDataCache];
    }

    // 如果已计算过统计信息，增量更新统计数据，避免重新扫描整个文件
    if (fileStats) {
        updateStatsWithNewLines(newLines);
    }

    // 检查是否已加载全部数据
    if (fullDataCache.length >= totalLinesInFile) {
        allDataLoaded = true;
        isBackgroundLoading = false;
        
        // 确保进度条显示 100% 并隐藏
        updateBackgroundLoadingProgress();
        setTimeout(() => {
            hideBackgroundLoadingIndicator();
        }, 1000); // 显示 100% 持续 1 秒后隐藏
    }

    // 更新加载状态显示
    updateLoadingStatus();

    // 加载更多数据时不重置页码，但需要重新计算
    handleDataChange({
        resetPage: false,           // 不重置页码
        clearPageRanges: false,     // 不清空已计算的页面
        triggerAsyncCalc: true      // 触发异步计算新页面
    });
}

function handleSearchResults(data) {
    console.log('收到搜索结果 - 原始数据:', data);
    console.log('搜索结果数量:', data.results ? data.results.length : 'undefined');
    console.log('搜索关键词:', data.keyword);
    console.log('修改前 allLines 数量:', allLines.length);

    currentSearchKeyword = data.keyword;
    currentSearchIsRegex = !!data.isRegex;
    currentSearchIsMultiple = !!data.isMultiple;
    allLines = data.results || [];

    console.log('修改后 allLines 数量:', allLines.length);
    console.log('修改后 currentSearchKeyword:', currentSearchKeyword);

    // 如果搜索结果为空，给出提示
    if (allLines.length === 0) {
        vscode.postMessage({
            command: 'showMessage',
            type: 'info',
            message: `未找到包含 "${data.keyword}" 的日志`
        });
    } else {
        console.log('搜索成功，准备渲染', allLines.length, '条结果');
    }

    // 统一处理数据变更
    console.log('即将调用 handleDataChange');
    handleDataChange();
    console.log('handleDataChange 调用完成');
}

function handleFilterResults(data) {
    allLines = data.results || [];
    console.log(' 收到过滤结果:', allLines.length, '条');
    isFiltering = true; // 设置为过滤模式

    // 进入过滤模式时，清理搜索状态（避免与搜索备份冲突）
    isInSearchMode = false;
    searchBackup = null;
    currentSearchKeyword = '';
    currentSearchIsRegex = false;
    currentSearchIsMultiple = false;

    // 统一处理数据变更
    handleDataChange();

    // 如果过滤结果为空，给出友好提示
    if (allLines.length === 0) {
        const levelText = (data.levels || []).join('、');
        vscode.postMessage({
            command: 'showMessage',
            type: 'warning',
            message: `未找到 ${levelText} 级别的日志，请尝试其他级别或查看统计信息`
        });
    }
}

function handleStatisticsResults(data) {
    // 保存统计信息
    fileStats = data;
    console.log('📊 保存文件统计信息:', fileStats);

    showStatsModal(data);
}

// 使用新加载的行增量更新统计信息（仅更新基础数量与时间范围）
function updateStatsWithNewLines(newLines) {
    if (!fileStats || !Array.isArray(newLines) || newLines.length === 0) {
        return;
    }

    fileStats.totalLines += newLines.length;

    newLines.forEach(line => {
        const level = (line.level || '').toUpperCase();
        if (level === 'ERROR') {
            fileStats.errorCount++;
        } else if (level === 'WARN') {
            fileStats.warnCount++;
        } else if (level === 'INFO') {
            fileStats.infoCount++;
        } else if (level === 'DEBUG') {
            fileStats.debugCount++;
        } else {
            fileStats.otherCount++;
        }

        if (line.timestamp) {
            const ts = new Date(line.timestamp);
            if (!fileStats.timeRange) {
                fileStats.timeRange = { start: ts, end: ts };
            } else {
                const currentStart = fileStats.timeRange.start ? new Date(fileStats.timeRange.start) : null;
                const currentEnd = fileStats.timeRange.end ? new Date(fileStats.timeRange.end) : null;

                if (!currentStart || ts < currentStart) {
                    fileStats.timeRange.start = ts;
                }
                if (!currentEnd || ts > currentEnd) {
                    fileStats.timeRange.end = ts;
                }
            }
        }
    });

    console.log('📊 统计信息已增量更新:', fileStats);
}

function handleTimelineData(data) {
    console.log('收到时间线采样数据:', data);

    if (!data || !data.startTime || !data.endTime || !data.samples || data.samples.length === 0) {
        console.log('时间线数据不完整，隐藏时间线');
        document.getElementById('timelinePanel').style.display = 'none';
        return;
    }

    generateTimelineFromSamples(data);
}

function handleJumpToLineInFullLogResult(data) {
    // 重新加载完整日志数据
    document.getElementById('fileName').textContent = data.fileName;
    document.getElementById('fileSize').textContent = data.fileSize;
    document.getElementById('totalLines').textContent = data.totalLines;

    totalLinesInFile = data.totalLines;
    allDataLoaded = data.allLoaded || false;
    // 后端可能返回从中间位置开始的一段日志，记录偏移量（默认 0）
    baseLineOffset = typeof data.startLine === 'number' ? data.startLine : 0;
    isFiltering = false; // 重置过滤状态
    currentSearchKeyword = ''; // 重置搜索关键词
    currentSearchIsRegex = false;
    currentSearchIsMultiple = false;
    isInSearchMode = false;
    searchBackup = null;

    allLines = data.lines;
    originalLines = [...data.lines];
    
    // 🔧 关键修复：更新完整数据缓存，确保跳转后显示正确的内容
    fullDataCache = [...data.lines];
    
    // 🔧 清空统一过滤条件，确保显示完整日志
    unifiedFilters = {
        keyword: null,
        isRegex: false,
        isMultiple: false,
        threadName: null,
        className: null,
        methodName: null,
        levels: null,
        timeRange: null,
    };

    console.log(`📦 跳转数据已加载 - baseLineOffset: ${baseLineOffset}, 数据行数: ${allLines.length}, 目标行号: ${data.targetLineNumber}`);

    // 显示加载提示
    if (allLines.length > 0) {
        const firstLine = allLines[0].lineNumber || 0;
        const lastLine = allLines[allLines.length - 1].lineNumber || 0;
        
        if (allDataLoaded) {
            showToast(`已加载完整日志，跳转到第 ${data.targetLineNumber} 行`);
        } else if (baseLineOffset === 0) {
            // 从文件开头加载
            showToast(`已加载前 ${allLines.length} 行数据，跳转到第 ${data.targetLineNumber} 行`);
        } else {
            // 从中间加载（旧逻辑，现在应该不会走到这里了）
            showToast(`已加载第 ${firstLine}~${lastLine} 行数据，定位到第 ${data.targetLineNumber} 行`);
        }
    }

    // 统一处理数据变更（但不重置页码，因为要跳转到目标行）
    handleDataChange({
        resetPage: false  // 不重置页码，由 jumpToLine 决定
    });

    // 跳转到目标行
    jumpToLine(data.targetLineNumber);

    // 时间线使用后端采样结果，这里只需要重绘当前位置指示器，无需重新统计全文件
    drawTimeline();
}

function renderLines() {
    const container = document.getElementById('logContainer');
    const oldContent = container.innerHTML;
    container.innerHTML = '';

    console.log('🎨 渲染日志 - 当前 allLines 数量:', allLines.length, '，折叠模式:', isCollapseMode, '，搜索关键词:', currentSearchKeyword, '，过滤模式:', isFiltering);
    console.log('已清空容器，旧内容长度:', oldContent.length);

    if (allLines.length === 0) {
        container.innerHTML = '<div class="loading">没有日志数据</div>';
        document.getElementById('pagination').style.display = 'none';
        document.getElementById('loadedLines').textContent = '0';
        console.log('渲染结果: 显示"没有日志数据"');
        return;
    }

    // 计算分页
    let startIndex, endIndex;

    if (isCollapseMode && pageRanges.has(currentPage)) {
        // 折叠模式且已记录过该页范围，直接使用
        const range = pageRanges.get(currentPage);
        startIndex = range.start;
        endIndex = range.end;
        console.log(`📖 使用已记录的第 ${currentPage} 页范围: ${startIndex}-${endIndex}`);
    } else if (isCollapseMode && currentPage > 1 && pageRanges.has(currentPage - 1)) {
        // 折叠模式且是新页面，从上一页的结束位置开始
        const prevRange = pageRanges.get(currentPage - 1);
        startIndex = prevRange.end;
        endIndex = Math.min(startIndex + pageSize, allLines.length);
        console.log(`📖 从上一页结束位置 ${startIndex} 开始加载第 ${currentPage} 页`);
    } else {
        // 非折叠模式或第一页，使用标准计算
        startIndex = (currentPage - 1) * pageSize;
        endIndex = Math.min(startIndex + pageSize, allLines.length);
        console.log(`📖 标准分页计算第 ${currentPage} 页: ${startIndex}-${endIndex}`);
    }

    // 如果开启折叠模式，动态调整加载数量以填满页面
    if (isCollapseMode) {
        const targetDisplayLines = pageSize; // 目标显示数量（折叠后）
        let displayCount = 0;
        let tempEndIndex = endIndex;
        let attempts = 0;
        const maxAttempts = 5; // 最多尝试5次，避免死循环
        const maxLoadLines = pageSize * 50; // 最多加载50倍，避免过度加载

        // 尝试加载更多数据直到达到目标显示数量
        while (displayCount < targetDisplayLines && tempEndIndex < allLines.length && attempts < maxAttempts) {
            // 限制最大加载范围
            if (tempEndIndex - startIndex > maxLoadLines) {
                console.log(`已达到最大加载限制 ${maxLoadLines} 行，停止加载`);
                break;
            }

            const testLines = allLines.slice(startIndex, tempEndIndex);
            const collapsed = collapseRepeatedLines(testLines, startIndex);
            displayCount = collapsed.length;

            console.log(`🔄 尝试 ${attempts + 1}：加载 ${tempEndIndex - startIndex} 行，折叠后得到 ${displayCount} 条，目标 ${targetDisplayLines} 条`);

            if (displayCount < targetDisplayLines) {
                // 需要加载更多，但要限制增量
                const needed = targetDisplayLines - displayCount;
                const ratio = displayCount > 0 ? (tempEndIndex - startIndex) / displayCount : 1;

                // 根据重复率动态调整增量
                let increment;
                if (ratio > 50) {
                    // 重复率极高，大幅增加
                    increment = Math.ceil(needed * ratio);
                } else if (ratio > 10) {
                    // 重复率高，显著增加
                    increment = Math.ceil(needed * ratio * 0.8);
                } else {
                    // 重复率较低，适度增加
                    increment = Math.ceil(needed * ratio * 0.5);
                }

                increment = Math.max(increment, 100); // 至少增加100条
                increment = Math.min(increment, pageSize * 10); // 最多增加10倍pageSize

                tempEndIndex = Math.min(tempEndIndex + increment, allLines.length);
                attempts++;
            } else {
                break;
            }
        }

        endIndex = tempEndIndex;
        console.log(`折叠模式：最终加载范围 ${startIndex}-${endIndex}（${endIndex - startIndex} 行），折叠后显示 ${displayCount} 条`);

        // 记录该页的实际范围
        pageRanges.set(currentPage, { start: startIndex, end: endIndex });
    } else if (isCollapseMode) {
        // 折叠模式但没有智能加载，也要记录范围
        pageRanges.set(currentPage, { start: startIndex, end: endIndex });
    }

    let pageLines = allLines.slice(startIndex, endIndex);

    // 如果开启折叠模式，进行折叠处理
    if (isCollapseMode) {
        pageLines = collapseRepeatedLines(pageLines, startIndex);
    }

    pageLines.forEach((item, index) => {
        // item 可能是单条日志或折叠组
        if (item.isCollapsed) {
            // 渲染折叠组
            renderCollapsedGroup(container, item);
        } else {
            // 渲染单条日志
            const line = item;
            renderSingleLine(container, line, startIndex, index);
        }
    });

    document.getElementById('loadedLines').textContent = allLines.length;
    document.getElementById('pagination').style.display = 'flex';

    console.log(`渲染完成！实际显示 ${pageLines.length} 条（原始 ${endIndex - startIndex} 行）`);
}

// 计算指定页面的范围（不渲染，只计算）
function calculatePageRange(pageNum) {
    console.log(`🧮 计算第 ${pageNum} 页范围...`);

    if (allLines.length === 0) {
        pageRanges.set(pageNum, { start: 0, end: 0 });
        return;
    }

    // 计算分页
    let startIndex, endIndex;

    if (pageNum === 1) {
        startIndex = 0;
        endIndex = Math.min(pageSize, allLines.length);
    } else if (pageRanges.has(pageNum - 1)) {
        const prevRange = pageRanges.get(pageNum - 1);
        startIndex = prevRange.end;
        endIndex = Math.min(startIndex + pageSize, allLines.length);
    } else {
        console.log(`无法计算第 ${pageNum} 页，缺少上一页数据`);
        return;
    }

    // 如果开启折叠模式，动态调整加载数量以填满页面
    if (isCollapseMode) {
        const targetDisplayLines = pageSize;
        let displayCount = 0;
        let tempEndIndex = endIndex;
        let attempts = 0;
        const maxAttempts = 5;
        const maxLoadLines = pageSize * 50;

        while (displayCount < targetDisplayLines && tempEndIndex < allLines.length && attempts < maxAttempts) {
            if (tempEndIndex - startIndex > maxLoadLines) {
                break;
            }

            const testLines = allLines.slice(startIndex, tempEndIndex);
            const collapsed = collapseRepeatedLines(testLines, startIndex);
            displayCount = collapsed.length;

            console.log(`🔄 折叠尝试 ${attempts + 1}: 加载 ${tempEndIndex - startIndex} 行 -> 折叠后 ${displayCount} 条`);

            if (displayCount < targetDisplayLines) {
                const needed = targetDisplayLines - displayCount;
                const ratio = displayCount > 0 ? (tempEndIndex - startIndex) / displayCount : 1;

                // 根据重复率动态调整增量
                // 如果折叠率很高（ratio大），说明重复很多，需要加载更多行
                let increment;
                if (ratio > 50) {
                    // 重复率极高（平均50行折叠成1条），大幅增加
                    increment = Math.ceil(needed * ratio);
                } else if (ratio > 10) {
                    // 重复率高（平均10行折叠成1条），显著增加
                    increment = Math.ceil(needed * ratio * 0.8);
                } else {
                    // 重复率较低，适度增加
                    increment = Math.ceil(needed * ratio * 0.5);
                }

                increment = Math.max(increment, 100);  // 最少增加100行
                increment = Math.min(increment, pageSize * 10);  // 最多一次增加1000行
                tempEndIndex = Math.min(tempEndIndex + increment, allLines.length);
                attempts++;
            } else {
                break;
            }
        }

        endIndex = tempEndIndex;
    }

    pageRanges.set(pageNum, { start: startIndex, end: endIndex });
    console.log(`第 ${pageNum} 页范围: ${startIndex}-${endIndex}`);
}

// 异步计算所有页面范围
async function calculateAllPagesAsync(shouldClearRanges = true) {
    if (allLines.length === 0 || !isCollapseMode) {
        return;
    }

    // 生成新的计算任务ID，取消旧任务
    currentCalculationId++;
    const myCalculationId = currentCalculationId;
    console.log(`📊 开始新的计算任务 #${myCalculationId}，取消旧任务... (清空范围: ${shouldClearRanges})`);

    isCalculatingPages = true;
    calculationProgress = 0;

    // 只在需要时清空页面范围
    if (shouldClearRanges) {
        pageRanges.clear();
    }

    updatePagination(); // 更新UI显示"计算中..."

    // 如果不清空范围，从已计算的最后一页继续
    let pageNum = 1;
    let lastEndIndex = 0;

    if (!shouldClearRanges && pageRanges.size > 0) {
        // 找到最后已计算的页面
        const lastPage = Math.max(...Array.from(pageRanges.keys()));
        const lastRange = pageRanges.get(lastPage);
        if (lastRange) {
            pageNum = lastPage + 1;
            lastEndIndex = lastRange.end;
            console.log(`📊 任务 #${myCalculationId} 从第 ${pageNum} 页继续计算 (上次结束位置: ${lastEndIndex})`);
        }
    }

    // 使用分批处理，每次计算5页，然后让出CPU时间
    while (lastEndIndex < allLines.length && isCollapseMode) {
        // 检查是否被新任务取代
        if (myCalculationId !== currentCalculationId) {
            console.log(`计算任务 #${myCalculationId} 被新任务取代，停止计算`);
            return;
        }

        // 批量计算5页
        for (let i = 0; i < 5 && lastEndIndex < allLines.length; i++) {
            // 检查折叠模式和任务ID
            if (!isCollapseMode || myCalculationId !== currentCalculationId) break;

            calculatePageRange(pageNum);
            const range = pageRanges.get(pageNum);
            if (range) {
                lastEndIndex = range.end;
                pageNum++;
            } else {
                break;
            }
        }

        // 如果已经取消折叠模式或被新任务取代，退出计算
        if (!isCollapseMode) {
            console.log(`计算任务 #${myCalculationId} - 折叠模式已取消，停止计算`);
            isCalculatingPages = false;
            calculationProgress = 0;
            return;
        }

        if (myCalculationId !== currentCalculationId) {
            console.log(`计算任务 #${myCalculationId} 被取代，停止计算`);
            return;
        }

        // 计算进度
        calculationProgress = Math.min(99, Math.floor((lastEndIndex / allLines.length) * 100));
        console.log(`📊 计算任务 #${myCalculationId} 进度: ${calculationProgress}% (已计算 ${pageNum - 1} 页，处理到第 ${lastEndIndex} 行)`);
        updatePagination(); // 更新进度显示

        // 让出CPU时间，保持页面响应
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    // 最后再次确认是否仍是当前任务
    if (myCalculationId === currentCalculationId) {
        calculationProgress = 100;
        isCalculatingPages = false;
        console.log(`计算任务 #${myCalculationId} 完成！共 ${pageNum - 1} 页`);
        updatePagination(); // 最终更新显示精确值
    } else {
        console.log(`计算任务 #${myCalculationId} 完成时已被取代`);
    }
}

// 提取日志的核心内容（去除时间戳）
function extractLogContent(line) {
    const content = (line.content || line).toString();

    // 尝试移除常见的时间戳格式
    // 格式1: 2025-11-20 08:16:50.054
    let result = content.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s*/, '');

    // 格式2: [2025-11-20 08:16:50.054]
    result = result.replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(\.\d+)?\]\s*/, '');

    // 格式3: 2025-11-20 08:16:50
    result = result.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*/, '');

    // 格式4: [2025-11-20 08:16:50]
    result = result.replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/, '');

    // 格式5: 2025/11/20 08:16:50.054
    result = result.replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(\.\d+)?\s*/, '');

    return result.trim();
}

// 折叠重复的日志行（支持多行模式重复）
function collapseRepeatedLines(lines, startIndex) {
    console.log('开始折叠分析，总行数:', lines.length);
    const result = [];
    let i = 0;
    let totalCollapsed = 0;

    while (i < lines.length) {
        // 尝试不同的模式长度（1行、2行、3行...最多10行）
        let bestPatternLength = 0;
        let bestRepeatCount = 0;

        for (let patternLength = 1; patternLength <= Math.min(10, Math.floor((lines.length - i) / 2)); patternLength++) {
            // 获取当前模式（去除时间戳）
            const pattern = [];
            for (let k = 0; k < patternLength; k++) {
                if (i + k >= lines.length) break;
                const content = extractLogContent(lines[i + k]);
                pattern.push(content);
            }

            if (pattern.length < patternLength) break;

            // 检测这个模式重复了多少次
            let repeatCount = 1;
            let j = i + patternLength;

            while (j + patternLength <= lines.length) {
                let matches = true;
                for (let k = 0; k < patternLength; k++) {
                    const currentContent = extractLogContent(lines[j + k]);
                    if (currentContent !== pattern[k]) {
                        matches = false;
                        break;
                    }
                }

                if (matches) {
                    repeatCount++;
                    j += patternLength;
                } else {
                    break;
                }
            }

            // 如果这个模式至少重复2次，且比之前找到的更好
            if (repeatCount >= 2 && repeatCount > bestRepeatCount) {
                bestPatternLength = patternLength;
                bestRepeatCount = repeatCount;
            }
        }

        const minRepeat = Math.max(1, userSettings.collapseMinRepeatCount || 2);
        if (bestPatternLength > 0 && bestRepeatCount >= minRepeat) {
            // 找到了重复模式
            const firstLineNumber = lines[i].lineNumber || (startIndex + i + 1);
            const groupId = `group_${firstLineNumber}`;
            const totalLines = bestPatternLength * bestRepeatCount;

            console.log(`找到重复模式：从行 ${firstLineNumber} 开始，${bestPatternLength} 行为一组，重复 ${bestRepeatCount} 次，共 ${totalLines} 行`);
            if (bestPatternLength > 1) {
                console.log('  模式第一行:', extractLogContent(lines[i]).substring(0, 80));
            }
            totalCollapsed++;

            result.push({
                isCollapsed: true,
                groupId: groupId,
                patternLength: bestPatternLength,
                repeatCount: bestRepeatCount,
                lines: lines.slice(i, i + totalLines),
                firstLine: lines[i],
                isExpanded: expandedGroups.has(groupId)
            });

            i += totalLines;
        } else {
            // 没有重复，直接添加
            result.push(lines[i]);
            i++;
        }
    }

    console.log(`📊 折叠完成！找到 ${totalCollapsed} 个重复组，最终输出 ${result.length} 条`);
    return result;
}

// 渲染折叠组
function renderCollapsedGroup(container, group) {
    const lineDiv = document.createElement('div');
    lineDiv.className = 'log-line collapsed';
    lineDiv.dataset.groupId = group.groupId;

    // 添加级别样式
    if (group.firstLine.level) {
        lineDiv.classList.add(group.firstLine.level.toLowerCase());
    }

    const firstLineNumber = group.firstLine.lineNumber || group.lines[0].lineNumber;

    const lineNumber = document.createElement('span');
    lineNumber.className = 'log-line-number';
    lineNumber.textContent = firstLineNumber.toString();

    const lineContent = document.createElement('span');
    lineContent.className = 'log-line-content';

    // 显示模式的第一行
    const content = group.firstLine.content || group.firstLine;
    let highlightedContent = highlightKeywords(content, currentSearchKeyword);

    // 统计当前折叠组内与搜索关键词匹配的日志条数
    let matchCount = 0;
    if (currentSearchKeyword && Array.isArray(group.lines)) {
        try {
            let matcher = null;
            if (currentSearchIsRegex) {
                matcher = new RegExp(currentSearchKeyword, 'i');
            } else if (currentSearchIsMultiple) {
                // 多关键词模式：简单的全匹配检查
                matcher = {
                    test: (text) => {
                        const keywords = currentSearchKeyword.trim().split(/\s+/);
                        return keywords.every(k => text.toLowerCase().includes(k.toLowerCase()));
                    }
                };
            }
            for (const line of group.lines) {
                const text = (line.content || line || '').toString();
                if (!text) continue;
                if (matcher) {
                    if (matcher.test(text)) {
                        matchCount++;
                    }
                } else {
                    if (text.toLowerCase().includes(currentSearchKeyword.toLowerCase())) {
                        matchCount++;
                    }
                }
            }
        } catch (e) {
            console.warn('搜索匹配统计失败:', e);
        }
    }

    let matchInfo = '';
    if (matchCount > 0) {
        matchInfo = `，匹配 ${matchCount} 条`;
    }

    // 添加重复次数徽章 + 匹配计数
    if (group.patternLength === 1) {
        // 单行重复
        highlightedContent += `<span class="repeat-count" title="点击${group.isExpanded ? '折叠' : '展开'}详情">重复 ${group.repeatCount} 次${matchInfo}</span>`;
    } else {
        // 多行模式重复
        highlightedContent += `<span class="repeat-count" title="点击${group.isExpanded ? '折叠' : '展开'}详情">${group.patternLength} 行为一组，重复 ${group.repeatCount} 次${matchInfo}</span>`;
    }

    lineContent.innerHTML = highlightedContent;

    // 点击展开/折叠
    lineDiv.onclick = () => {
        toggleGroup(group.groupId);
    };

    lineDiv.appendChild(lineNumber);
    lineDiv.appendChild(lineContent);
    container.appendChild(lineDiv);

    // 如果已展开，显示所有行
    if (group.isExpanded) {
        group.lines.forEach((line, index) => {
            const expandedLineDiv = document.createElement('div');
            expandedLineDiv.className = 'log-line';
            expandedLineDiv.style.marginLeft = '20px';
            expandedLineDiv.style.opacity = '0.8';

            // 每个模式组之间加个分隔线
            if (index > 0 && index % group.patternLength === 0) {
                expandedLineDiv.style.borderTop = '1px dashed rgba(139, 92, 246, 0.3)';
                expandedLineDiv.style.marginTop = '3px';
                expandedLineDiv.style.paddingTop = '3px';
            }

            const actualLineNumber = line.lineNumber || (firstLineNumber + index);

            const expandedLineNumber = document.createElement('span');
            expandedLineNumber.className = 'log-line-number';
            expandedLineNumber.textContent = actualLineNumber.toString();

            const expandedLineContent = document.createElement('span');
            expandedLineContent.className = 'log-line-content';
            const expandedContent = line.content || line;
            expandedLineContent.innerHTML = highlightKeywords(expandedContent, currentSearchKeyword);

            expandedLineDiv.appendChild(expandedLineNumber);
            expandedLineDiv.appendChild(expandedLineContent);
            container.appendChild(expandedLineDiv);
        });
    }
}

// 渲染单条日志
function renderSingleLine(container, line, startIndex, index) {
    const lineDiv = document.createElement('div');
    lineDiv.className = 'log-line';

    const actualLineNumber = line.lineNumber || startIndex + index + 1;

    // 根据日志级别添加样式
    if (line.level) {
        lineDiv.classList.add(line.level.toLowerCase());
    }

    // 如果是书签行，添加书签标记
    if (bookmarks.has(actualLineNumber)) {
        lineDiv.style.backgroundColor = 'rgba(255, 193, 7, 0.1)';
        lineDiv.style.borderRight = '3px solid #ffc107';
    }

    const lineNumber = document.createElement('span');
    lineNumber.className = 'log-line-number';
    lineNumber.textContent = actualLineNumber.toString();

    // 如果是书签，显示书签图标
    if (bookmarks.has(actualLineNumber)) {
        lineNumber.innerHTML = '<i class="codicon codicon-bookmark" style="font-size: 10px; color: #ffc107;"></i> ' + actualLineNumber.toString();
    }

    const lineContent = document.createElement('span');
    lineContent.className = 'log-line-content';

    const content = line.content || line;

    // 尝试解析JSON/XML并添加到日志内容后面
    const parsedStructure = detectAndParseStructuredData(content);

    // 增强高亮功能
    let highlightedContent = highlightKeywords(content, currentSearchKeyword);

    // 如果有注释，添加注释徽章
    if (comments.has(actualLineNumber)) {
        highlightedContent += `<span class="comment-badge" onclick="event.stopPropagation(); editComment(${actualLineNumber})" title="点击编辑注释"><i class="codicon codicon-comment"></i> 有注释</span>`;
    }

    lineContent.innerHTML = highlightedContent;

    // 添加右键菜单复制功能
    lineDiv.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e, content, actualLineNumber);
    };

    // 添加双击书签功能（只有在没有选中文本时才触发）
    lineDiv.ondblclick = (e) => {
        // 检查是否有文本被选中
        const selection = window.getSelection();
        const selectedText = selection.toString();

        // 如果有文本被选中，说明用户想复制，不触发书签
        if (selectedText && selectedText.trim().length > 0) {
            console.log('📋 用户选中了文本，不触发书签');
            return;
        }

        e.stopPropagation();
        toggleBookmark(actualLineNumber);
    };

    // 先添加行号和内容
    lineDiv.appendChild(lineNumber);
    lineDiv.appendChild(lineContent);

    // 搜索/过滤模式下，在行号前添加跳转按钮（不再自动点击跳转）
    if (currentSearchKeyword || isFiltering) {
        // 添加一个小的跳转按钮
        const jumpBtn = document.createElement('span');
        jumpBtn.className = 'jump-btn';
        jumpBtn.innerHTML = '<i class="codicon codicon-link"></i>';
        jumpBtn.title = '跳转到完整日志中的此行';
        jumpBtn.onclick = (e) => {
            e.stopPropagation();
            jumpToLineInFullLog(actualLineNumber);
        };
        // 在行号之前插入跳转按钮
        lineDiv.insertBefore(jumpBtn, lineNumber);
    }

    // 如果解析出JSON/XML结构，添加到下方
    if (parsedStructure) {
        const structDiv = document.createElement('div');
        structDiv.innerHTML = parsedStructure;
        lineDiv.appendChild(structDiv);
    }

    // 如果有注释，在下方显示注释内容
    if (comments.has(actualLineNumber)) {
        const commentDiv = document.createElement('div');
        commentDiv.className = 'log-comment';
        commentDiv.innerHTML = '<i class="codicon codicon-note"></i> ' + escapeHtml(comments.get(actualLineNumber));
        lineDiv.appendChild(commentDiv);
    }

    container.appendChild(lineDiv);
}

// 切换折叠组
function toggleGroup(groupId) {
    if (expandedGroups.has(groupId)) {
        expandedGroups.delete(groupId);
    } else {
        expandedGroups.add(groupId);
    }
    renderLines();
}

// 切换折叠模式
function toggleCollapseMode() {
    isCollapseMode = document.getElementById('collapseRepeated').checked;
    console.log('切换折叠模式:', isCollapseMode);

    expandedGroups.clear(); // 清空展开状态

    // 统一处理数据变更
    handleDataChange();
}

// 增强的关键词高亮功能 - 使用自定义规则
function highlightKeywords(content, keyword) {
    if (!content) return '';

    // 🔧 关键修复：先处理高亮规则（在原始文本上匹配），最后才转义HTML
    // 创建一个标记数组来记录需要高亮的位置
    const highlights = [];
    
    // 应用所有启用的自定义高亮规则（在原始文本上匹配）
    customHighlightRules.forEach(rule => {
        if (!rule.enabled) return;

        try {
            let regex;
            if (rule.type === 'text') {
                // 文本匹配
                const escaped = escapeRegex(rule.pattern);
                regex = new RegExp(escaped, 'gi');
            } else {
                // 正则表达式匹配
                regex = new RegExp(rule.pattern, 'g');
            }

            let match;
            while ((match = regex.exec(content)) !== null) {
                const matchText = match[0];
                const startPos = match.index;
                const endPos = startPos + matchText.length;
                
                // 根据规则名称生成不同的HTML
                let html;
                let style;
                
                // 区分样式：日志级别保留实心背景，其他（线程、类、方法）使用轮廓样式以减少"水果沙拉"视觉杂乱
                if (rule.name && rule.name.includes('日志级别')) {
                    style = `background-color: ${rule.bgColor}; color: ${rule.textColor}; border-radius: 2px; padding: 0 3px;`;
                } else {
                    // 使用轮廓样式：主色作为文字和边框色，背景微透
                    // 注意：这里假设 rule.bgColor 是 HEX 格式
                    const color = rule.bgColor;
                    style = `color: ${color}; border: 1px solid ${color}60; background-color: ${color}10; border-radius: 3px; padding: 0 4px;`;
                }

                if (rule.name === '线程名') {
                    const threadNameMatch = matchText.match(/\[([a-zA-Z][a-zA-Z0-9-_]*)\]/);
                    const threadName = threadNameMatch ? threadNameMatch[1] : '';
                    if (!threadName) continue; // 跳过无效的线程名
                    const safeThreadName = threadName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    html = `<span class="custom-highlight" style="${style}">${escapeHtml(matchText)}<span class="filter-icon" onclick="event.stopPropagation(); filterByThreadName('${safeThreadName}')" title="点击筛选线程: ${threadName}"><i class="codicon codicon-filter" style="font-size: 10px;"></i></span></span>`;
                } else if (rule.name === '类名') {
                    const className = matchText.trim();
                    if (!className) continue; // 跳过无效的类名
                    const safeClassName = className.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    html = `<span class="custom-highlight" style="${style}">${escapeHtml(matchText)}<span class="filter-icon" onclick="event.stopPropagation(); filterByClassName('${safeClassName}')" title="点击筛选类: ${className}"><i class="codicon codicon-filter" style="font-size: 10px;"></i></span></span>`;
                } else if (rule.name === '方法名') {
                    const methodMatch = matchText.match(/\[([a-zA-Z_][a-zA-Z0-9_]*):\d+\]/);
                    const methodName = methodMatch ? methodMatch[1] : '';
                    if (!methodName) continue; // 跳过无效的方法名
                    const safeMethodName = methodName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    html = `<span class="custom-highlight" style="${style}">${escapeHtml(matchText)}<span class="filter-icon" onclick="event.stopPropagation(); filterByMethodName('${safeMethodName}')" title="点击筛选方法: ${methodName}"><i class="codicon codicon-filter" style="font-size: 10px;"></i></span></span>`;
                } else {
                    html = `<span class="custom-highlight" style="${style}">${escapeHtml(matchText)}</span>`;
                }
                
                highlights.push({ start: startPos, end: endPos, html: html, priority: 1 });
            }
        } catch (e) {
            console.error(`规则 "${rule.name}" 应用失败:`, e);
        }
    });

    // 处理搜索关键词高亮（优先级最高）
    if (keyword) {
        const keywords = currentSearchIsMultiple ? keyword.trim().split(/\s+/) : [keyword];
        keywords.forEach(k => {
            if (k) {
                const regex = new RegExp(escapeRegex(k), 'gi');
                let match;
                while ((match = regex.exec(content)) !== null) {
                    const matchText = match[0];
                    const startPos = match.index;
                    const endPos = startPos + matchText.length;
                    const html = `<span class="highlight">${escapeHtml(matchText)}</span>`;
                    highlights.push({ start: startPos, end: endPos, html: html, priority: 2 });
                }
            }
        });
    }

    // 如果没有高亮，直接返回转义后的文本
    if (highlights.length === 0) {
        return escapeHtml(content);
    }

    // 按优先级和位置排序，解决重叠问题（优先级高的优先，位置靠前的优先）
    highlights.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority; // 优先级高的在前
        return a.start - b.start; // 位置靠前的在前
    });

    // 合并重叠的高亮区域，构建最终的HTML
    const finalHighlights = [];
    highlights.forEach(h => {
        // 检查是否与已有的高亮重叠
        const overlaps = finalHighlights.some(f => 
            (h.start >= f.start && h.start < f.end) || 
            (h.end > f.start && h.end <= f.end) ||
            (h.start <= f.start && h.end >= f.end)
        );
        if (!overlaps) {
            finalHighlights.push(h);
        }
    });

    // 按位置排序
    finalHighlights.sort((a, b) => a.start - b.start);

    // 构建最终的HTML字符串
    let result = '';
    let lastPos = 0;
    finalHighlights.forEach(h => {
        // 添加未高亮的部分
        if (h.start > lastPos) {
            result += escapeHtml(content.substring(lastPos, h.start));
        }
        // 添加高亮的部分
        result += h.html;
        lastPos = h.end;
    });
    // 添加剩余的未高亮部分
    if (lastPos < content.length) {
        result += escapeHtml(content.substring(lastPos));
    }

    return result;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function search() {
    const keyword = document.getElementById('searchInput').value.trim();
    const isRegex = document.getElementById('regexMode').checked;
    const currentPageOnly = document.getElementById('currentPageOnlyMode').checked;

    // 关键字为空：清除关键词过滤
    if (!keyword) {
        clearFilter('keyword');
        return;
    }

    // 如果选中"只在当前页搜索"
    if (currentPageOnly) {
        searchInCurrentPage(keyword, isRegex);
        return;
    }

    // 设置关键词过滤条件（全局搜索）
    setFilterAndApply({
        keyword: keyword,
        isRegex: isRegex,
        isMultiple: !isRegex  // 正则模式下不使用多关键词
    });
}

/**
 * 在当前页搜索
 */
function searchInCurrentPage(keyword, isRegex) {
    // 获取当前页显示的日志
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const currentPageLines = allLines.slice(startIndex, endIndex);
    
    if (currentPageLines.length === 0) {
        showToast('当前页没有数据');
        return;
    }
    
    // 过滤当前页的日志
    let results = currentPageLines.filter(line => {
        const content = (line.content || '').toLowerCase();
        
        if (isRegex) {
            try {
                const regex = new RegExp(keyword, 'i');
                return regex.test(line.content || '');
            } catch (e) {
                console.warn('正则表达式错误:', e);
                return false;
            }
        } else {
            // 多关键词 AND 匹配
            const keywords = keyword.trim().split(/\s+/).map(k => k.toLowerCase());
            return keywords.every(k => content.includes(k));
        }
    });
    
    if (results.length === 0) {
        showToast(`当前页未找到包含 "${keyword}" 的日志`);
        return;
    }
    
    // 高亮显示搜索关键词
    currentSearchKeyword = keyword;
    currentSearchIsRegex = isRegex;
    currentSearchIsMultiple = !isRegex;
    
    // 临时只显示当前页的搜索结果
    const originalAllLines = allLines;
    const originalCurrentPage = currentPage;
    
    allLines = results;
    currentPage = 1;
    
    // 重新渲染
    renderLines();
    updatePagination();
    
    // 显示提示和恢复按钮
    showToast(`在当前页找到 ${results.length} 条匹配日志`);
    
    // 保存原始数据，用于恢复
    window._currentPageSearchBackup = {
        originalAllLines: originalAllLines,
        originalCurrentPage: originalCurrentPage
    };
    
    // 显示提示信息
    showCurrentPageSearchStatus(keyword, results.length);
}

/**
 * 显示当前页搜索状态
 */
function showCurrentPageSearchStatus(keyword, count) {
    const panel = document.getElementById('filterStatusPanel');
    const statusText = document.getElementById('filterStatusText');
    statusText.innerHTML = `当前页搜索: "${keyword}" (找到 ${count} 条)`;
    panel.style.display = 'flex';
    
    // 修改清除按钮的行为
    const clearBtn = panel.querySelector('button');
    clearBtn.onclick = clearCurrentPageSearch;
    clearBtn.innerHTML = '<i class="codicon codicon-close"></i> 退出当前页搜索';
}

/**
 * 清除当前页搜索
 */
function clearCurrentPageSearch() {
    if (window._currentPageSearchBackup) {
        // 恢复原始数据
        allLines = window._currentPageSearchBackup.originalAllLines;
        currentPage = window._currentPageSearchBackup.originalCurrentPage;
        
        // 清除备份
        window._currentPageSearchBackup = null;
        
        // 清除搜索关键词
        currentSearchKeyword = '';
        currentSearchIsRegex = false;
        currentSearchIsMultiple = false;
        
        // 重新渲染
        renderLines();
        updatePagination();
        
        // 隐藏状态面板
        hideFilterStatus();
        
        // 恢复清除按钮的原始行为
        const panel = document.getElementById('filterStatusPanel');
        const clearBtn = panel.querySelector('button');
        clearBtn.onclick = clearCustomFilter;
        clearBtn.innerHTML = '<i class="codicon codicon-close"></i> 取消筛选';
        
        showToast('已退出当前页搜索');
    }
}

function applyFilter() {
    const levels = [];
    const errorChecked = document.getElementById('filterError').checked;
    const warnChecked = document.getElementById('filterWarn').checked;
    const infoChecked = document.getElementById('filterInfo').checked;
    const debugChecked = document.getElementById('filterDebug').checked;
    const otherChecked = document.getElementById('filterOther').checked;

    if (errorChecked) { levels.push('ERROR'); }
    if (warnChecked) { levels.push('WARN'); }
    if (infoChecked) { levels.push('INFO'); }
    if (debugChecked) { levels.push('DEBUG'); }
    if (otherChecked) { levels.push('OTHER'); }

    console.log('Filter applied:', levels);
    console.log('Checkboxes:', { errorChecked, warnChecked, infoChecked, debugChecked, otherChecked });

    // 更新全选框状态
    const allChecked = errorChecked && warnChecked && infoChecked && debugChecked && otherChecked;
    const allUnchecked = !errorChecked && !warnChecked && !infoChecked && !debugChecked && !otherChecked;
    const filterAllCheckbox = document.getElementById('filterAll');

    console.log('🔵 检查全选状态 - allChecked:', allChecked, 'allUnchecked:', allUnchecked);

    if (allChecked) {
        filterAllCheckbox.checked = true;
        filterAllCheckbox.indeterminate = false;
    } else if (allUnchecked) {
        filterAllCheckbox.checked = false;
        filterAllCheckbox.indeterminate = false;
    } else {
        filterAllCheckbox.indeterminate = true;
    }

    // 如果全部选中，清除级别过滤
    if (allChecked) {
        console.log('全部选中，清除级别过滤');
        clearFilter('levels');
        return;
    }

    // 如果全部不选，显示空
    if (levels.length === 0) {
        console.log('没有选择任何级别');
        setFilterAndApply({ levels: [] });
        return;
    }

    // 应用级别过滤
    console.log(' 应用级别过滤:', levels);
    setFilterAndApply({ levels: levels });
}

function toggleAll() {
    const filterAll = document.getElementById('filterAll');
    const checked = filterAll.checked;

    document.getElementById('filterError').checked = checked;
    document.getElementById('filterWarn').checked = checked;
    document.getElementById('filterInfo').checked = checked;
    document.getElementById('filterDebug').checked = checked;
    document.getElementById('filterOther').checked = checked;

    filterAll.indeterminate = false;
    applyFilter();
}

function showStats() {
    vscode.postMessage({
        command: 'getStatistics'
    });
}

function showStatsModal(stats) {
    const grid = document.getElementById('statsGrid');

    // 转换 Map 为数组并排序
    const classStats = stats.classCounts ?
        Array.from(Object.entries(stats.classCounts)).sort((a, b) => b[1] - a[1]).slice(0, 10) : [];
    const methodStats = stats.methodCounts ?
        Array.from(Object.entries(stats.methodCounts)).sort((a, b) => b[1] - a[1]).slice(0, 10) : [];
    const threadStats = stats.threadCounts ?
        Array.from(Object.entries(stats.threadCounts)).sort((a, b) => b[1] - a[1]).slice(0, 10) : [];

    grid.innerHTML = `
        <div class="stats-card">
            <h3>总行数</h3>
            <div class="value">${stats.totalLines}</div>
        </div>
        <div class="stats-card">
            <h3>ERROR</h3>
            <div class="value" style="color: #f14c4c;">${stats.errorCount}</div>
        </div>
        <div class="stats-card">
            <h3>WARN</h3>
            <div class="value" style="color: #cca700;">${stats.warnCount}</div>
        </div>
        <div class="stats-card">
            <h3>INFO</h3>
            <div class="value" style="color: #4fc1ff;">${stats.infoCount}</div>
        </div>
        <div class="stats-card">
            <h3>DEBUG</h3>
            <div class="value" style="color: #b267e6;">${stats.debugCount}</div>
        </div>
        <div class="stats-card">
            <h3>其他</h3>
            <div class="value">${stats.otherCount}</div>
        </div>
    `;

    if (stats.timeRange && stats.timeRange.start) {
        grid.innerHTML += `
            <div class="stats-card" style="grid-column: 1 / -1;">
                <h3>时间范围</h3>
                <div style="font-size: 14px;">
                    ${new Date(stats.timeRange.start).toLocaleString()} - 
                    ${new Date(stats.timeRange.end).toLocaleString()}
                </div>
            </div>
        `;
    }

    // 添加类名统计
    if (classStats.length > 0) {
        grid.innerHTML += `
            <div class="stats-card" style="grid-column: 1 / -1;">
                <h3><i class="codicon codicon-symbol-class"></i> 最活跃的类 (Top 10)</h3>
                <div style="font-size: 13px; margin-top: 10px;">
                    ${classStats.map(([name, count]) =>
            `<div style="padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; transition: background-color 0.2s;" 
                              onmouseover="this.style.backgroundColor='var(--vscode-list-hoverBackground)'" 
                              onmouseout="this.style.backgroundColor='transparent'"
                              onclick="filterByClassName('${name.replace(/'/g, "\\'")}')"
                              title="点击筛选包含此类的日志">
                            <span style="font-weight: bold; color: var(--vscode-textLink-foreground);">${name}</span>
                            <span style="float: right; color: var(--vscode-descriptionForeground);">${count} 次</span>
                        </div>`
        ).join('')}
                </div>
            </div>
        `;
    }

    // 添加方法名统计
    if (methodStats.length > 0) {
        grid.innerHTML += `
            <div class="stats-card" style="grid-column: 1 / -1;">
                <h3><i class="codicon codicon-symbol-method"></i> 最常调用的方法 (Top 10)</h3>
                <div style="font-size: 13px; margin-top: 10px;">
                    ${methodStats.map(([name, count]) =>
            `<div style="padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; transition: background-color 0.2s;" 
                              onmouseover="this.style.backgroundColor='var(--vscode-list-hoverBackground)'" 
                              onmouseout="this.style.backgroundColor='transparent'"
                              onclick="filterByMethodName('${name.replace(/'/g, "\\'")}')"
                              title="点击筛选包含此方法的日志">
                            <span style="font-weight: bold; color: var(--vscode-textLink-foreground);">${name}</span>
                            <span style="float: right; color: var(--vscode-descriptionForeground);">${count} 次</span>
                        </div>`
        ).join('')}
                </div>
            </div>
        `;
    }

    // 添加线程名统计
    if (threadStats.length > 0) {
        grid.innerHTML += `
            <div class="stats-card" style="grid-column: 1 / -1;">
                <h3><i class="codicon codicon-list-tree"></i> 最活跃的线程 (Top 10)</h3>
                <div style="font-size: 13px; margin-top: 10px;">
                    ${threadStats.map(([name, count]) =>
            `<div style="padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; transition: background-color 0.2s;" 
                              onmouseover="this.style.backgroundColor='var(--vscode-list-hoverBackground)'" 
                              onmouseout="this.style.backgroundColor='transparent'"
                              onclick="filterByThreadName('${name.replace(/'/g, "\\'")}')"
                              title="点击筛选包含此线程的日志">
                            <span style="font-weight: bold; color: var(--vscode-textLink-foreground);">${name}</span>
                            <span style="float: right; color: var(--vscode-descriptionForeground);">${count} 次</span>
                        </div>`
        ).join('')}
                </div>
            </div>
        `;
    }

    document.getElementById('statsModal').style.display = 'block';
}

function closeStatsModal() {
    document.getElementById('statsModal').style.display = 'none';
}

// ========== 书签功能 ==========
function toggleBookmark(lineNumber) {
    if (bookmarks.has(lineNumber)) {
        bookmarks.delete(lineNumber);
        console.log('➖ 移除书签:', lineNumber);
    } else {
        bookmarks.add(lineNumber);
        console.log('➕ 添加书签:', lineNumber);
    }
    renderLines(); // 重新渲染以显示书签标记
}

function showBookmarksModal() {
    const modal = document.getElementById('bookmarksModal');
    const list = document.getElementById('bookmarksList');

    if (bookmarks.size === 0) {
        list.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--vscode-descriptionForeground);">暂无书签<br>双击日志行可添加书签</div>';
    } else {
        const bookmarkArray = Array.from(bookmarks).sort((a, b) => a - b);
        list.innerHTML = bookmarkArray.map(lineNum => {
            // 从完整数据缓存中查找，而不是从当前显示的数据中查找
            const dataSource = fullDataCache.length > 0 ? fullDataCache : allLines;
            const line = dataSource.find(l => l.lineNumber === lineNum);
            const content = line ? (line.content || line) : '（已不存在）';
            const preview = content.substring(0, 100) + (content.length > 100 ? '...' : '');

            return `
                <div style="padding: 10px; margin-bottom: 10px; background-color: var(--vscode-editorWidget-background); border-radius: 5px; border-left: 3px solid #ffc107; cursor: pointer; transition: background-color 0.2s;"
                     onmouseover="this.style.backgroundColor='var(--vscode-list-hoverBackground)'"
                     onmouseout="this.style.backgroundColor='var(--vscode-editorWidget-background)'"
                     onclick="jumpToBookmark(${lineNum})">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <span style="font-weight: bold; color: var(--vscode-textLink-foreground);"><i class="codicon codicon-bookmark"></i> 行 ${lineNum}</span>
                        <button onclick="event.stopPropagation(); removeBookmark(${lineNum})" style="padding: 2px 8px; font-size: 11px;">删除</button>
                    </div>
                    <div style="font-size: 12px; color: var(--vscode-descriptionForeground); font-family: 'Consolas', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(preview)}
                    </div>
                </div>
            `;
        }).join('');
    }

    modal.style.display = 'block';
}

function closeBookmarksModal() {
    document.getElementById('bookmarksModal').style.display = 'none';
}

function jumpToBookmark(lineNumber) {
    closeBookmarksModal();
    jumpToLine(lineNumber);
}

function removeBookmark(lineNumber) {
    bookmarks.delete(lineNumber);
    showBookmarksModal(); // 刷新书签列表
    renderLines(); // 重新渲染
}

/**
 * 导出带书签的日志
 */
function exportBookmarkedLogs() {
    if (bookmarks.size === 0) {
        showToast('没有书签，无法导出');
        return;
    }
    
    setButtonLoadingById('exportBookmarksBtn', true);
    
    // 从完整数据缓存中获取所有带书签的日志行
    const dataSource = fullDataCache.length > 0 ? fullDataCache : allLines;
    const bookmarkedLines = dataSource.filter(line => {
        const lineNumber = line.lineNumber || 0;
        return bookmarks.has(lineNumber);
    });
    
    if (bookmarkedLines.length === 0) {
        setButtonLoadingById('exportBookmarksBtn', false);
        showToast('未找到书签对应的日志行');
        return;
    }
    
    // 按行号排序
    bookmarkedLines.sort((a, b) => {
        const lineNumA = a.lineNumber || 0;
        const lineNumB = b.lineNumber || 0;
        return lineNumA - lineNumB;
    });
    
    // 发送到后端进行导出
    vscode.postMessage({
        command: 'exportLogs',
        lines: bookmarkedLines,
        exportType: 'bookmarked'  // 标记这是书签导出
    });
    
    // 导出完成后会收到 toast 通知，这里延迟恢复按钮状态
    setTimeout(() => setButtonLoadingById('exportBookmarksBtn', false), 1000);
    
    showToast(`正在导出 ${bookmarkedLines.length} 条带书签的日志...`);
    closeBookmarksModal();
}

// ==========  注释功能 ==========
let currentCommentLineNumber = null; // 当前正在编辑注释的行号
let enableJsonParse = true; // 是否启用JSON/XML解析

// 自定义高亮规则
let customHighlightRules = [];
let editingRuleIndex = -1; // 正在编辑的规则索引

// 初始化预设规则
function initDefaultHighlightRules() {
    customHighlightRules = [
        { id: 1, name: '日志级别 - ERROR', type: 'regex', pattern: '\\b(ERROR|FATAL|SEVERE)\\b', bgColor: '#f14c4c', textColor: '#ffffff', enabled: true, builtin: true },
        { id: 2, name: '日志级别 - WARN', type: 'regex', pattern: '\\b(WARN|WARNING)\\b', bgColor: '#cca700', textColor: '#ffffff', enabled: true, builtin: true },
        { id: 3, name: '日志级别 - INFO', type: 'regex', pattern: '\\b(INFO)\\b', bgColor: '#4fc1ff', textColor: '#000000', enabled: true, builtin: true },
        { id: 4, name: '日志级别 - DEBUG', type: 'regex', pattern: '\\b(DEBUG|TRACE|VERBOSE)\\b', bgColor: '#b267e6', textColor: '#ffffff', enabled: true, builtin: true },
        { id: 5, name: '时间戳', type: 'regex', pattern: '\\d{4}[-/]\\d{2}[-/]\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?', bgColor: '#b267e6', textColor: '#ffffff', enabled: true, builtin: true },
        { id: 6, name: '线程名', type: 'regex', pattern: '\\[(?!ERROR|FATAL|SEVERE|WARN|WARNING|INFO|INFORMATION|DEBUG|TRACE|VERBOSE\\])([a-zA-Z][a-zA-Z0-9-_]*)\\]', bgColor: '#06b6d4', textColor: '#ffffff', enabled: true, builtin: true },
        { id: 7, name: '类名', type: 'regex', pattern: '\\b([a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*\\.[A-Z][a-zA-Z0-9_]*)\\b', bgColor: '#10b981', textColor: '#ffffff', enabled: true, builtin: true },
        { id: 8, name: '方法名', type: 'regex', pattern: '\\[([a-zA-Z_][a-zA-Z0-9_]*):\\d+\\]', bgColor: '#f59e0b', textColor: '#ffffff', enabled: true, builtin: true }
    ];
    loadCustomRulesFromStorage();
}

// 从 localStorage 加载自定义规则
function loadCustomRulesFromStorage() {
    try {
        const saved = localStorage.getItem('customHighlightRules');
        if (saved) {
            const customRules = JSON.parse(saved);
            // 合并内置规则和自定义规则
            customHighlightRules = customHighlightRules.concat(customRules);
        }
    } catch (e) {
        console.error('加载自定义规则失败:', e);
    }
}

// 保存自定义规则到 localStorage
function saveCustomRulesToStorage() {
    try {
        // 只保存非内置规则
        const customRules = customHighlightRules.filter(r => !r.builtin);
        localStorage.setItem('customHighlightRules', JSON.stringify(customRules));
    } catch (e) {
        console.error('保存自定义规则失败:', e);
    }
}

// 初始化
initDefaultHighlightRules();

// 自定义确认对话框
function showCustomConfirm(message, title = '确认') {
    return new Promise((resolve) => {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.className = 'confirm-dialog';

        // 标题
        const titleEl = document.createElement('div');
        titleEl.className = 'confirm-title';
        titleEl.textContent = title;

        // 消息
        const messageEl = document.createElement('div');
        messageEl.className = 'confirm-message';
        messageEl.textContent = message;

        // 按钮容器
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'confirm-buttons';

        // 取消按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(false);
        });

        // 确认按钮
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确认';
        confirmBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(true);
        });

        buttonsDiv.appendChild(cancelBtn);
        buttonsDiv.appendChild(confirmBtn);

        dialog.appendChild(titleEl);
        dialog.appendChild(messageEl);
        dialog.appendChild(buttonsDiv);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 点击遮罩层关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
                resolve(false);
            }
        });

        // 聚焦确认按钮
        confirmBtn.focus();
    });
}

// 更多菜单管理
function toggleMoreMenu() {
    const dropdown = document.querySelector('.dropdown');
    dropdown.classList.toggle('show');
}

function closeMoreMenu() {
    const dropdown = document.querySelector('.dropdown');
    dropdown.classList.remove('show');
}

// 点击外部关闭下拉菜单
document.addEventListener('click', function (event) {
    const dropdown = document.querySelector('.dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        dropdown.classList.remove('show');
    }
});

function addOrEditComment(lineNumber) {
    console.log('addOrEditComment 被调用，行号:', lineNumber);

    currentCommentLineNumber = lineNumber;
    const existingComment = comments.get(lineNumber) || '';
    const line = allLines.find(l => l.lineNumber === lineNumber);
    const content = line ? (line.content || line) : '';
    const preview = content.substring(0, 100) + (content.length > 100 ? '...' : '');

    // 设置弹窗内容
    document.getElementById('commentInputTitle').innerHTML = existingComment ? '<i class="codicon codicon-edit"></i> 编辑注释' : '<i class="codicon codicon-comment-add"></i> 添加注释';
    document.getElementById('commentInputLineNumber').textContent = lineNumber;
    document.getElementById('commentInputPreview').textContent = content;
    document.getElementById('commentInputText').value = existingComment;

    // 显示弹窗
    document.getElementById('commentInputModal').style.display = 'block';

    // 自动聚焦到输入框
    setTimeout(() => {
        const textarea = document.getElementById('commentInputText');
        textarea.focus();
        textarea.select();
    }, 100);

}

function closeCommentInputModal() {
    document.getElementById('commentInputModal').style.display = 'none';
    currentCommentLineNumber = null;
}

function confirmCommentInput() {
    if (currentCommentLineNumber === null) {
        return;
    }

    const lineNumber = currentCommentLineNumber;
    const commentText = document.getElementById('commentInputText').value;
    const existingComment = comments.get(lineNumber) || '';

    if (commentText.trim()) {
        comments.set(lineNumber, commentText.trim());
        showToast(`注释已${existingComment ? '更新' : '添加'}`);
    } else if (existingComment) {
        // 如果输入空白且原来有注释，则删除
        comments.delete(lineNumber);
        showToast('注释已删除');
    }

    renderLines();
    closeCommentInputModal();
}

function editComment(lineNumber) {
    addOrEditComment(lineNumber);
}

function deleteComment(lineNumber) {
    if (confirm('确定要删除这条注释吗？')) {
        // 确保行号是数字类型，因为 Map 的 key 可能是数字或字符串
        const lineNum = Number(lineNumber);
        comments.delete(lineNum);
        showToast('注释已删除');
        renderLines();
    }
}

function showCommentsModal() {
    const modal = document.getElementById('commentsModal');
    const list = document.getElementById('commentsList');

    if (comments.size === 0) {
        list.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--vscode-descriptionForeground);">暂无注释<br>右键点击日志行可添加注释</div>';
    } else {
        // 将Map转为数组并按行号排序
        const commentArray = Array.from(comments.entries()).sort((a, b) => a[0] - b[0]);
        list.innerHTML = commentArray.map(([lineNum, comment]) => {
            const line = allLines.find(l => l.lineNumber === lineNum);
            const content = line ? (line.content || line) : '（已不存在）';
            const preview = content.substring(0, 80) + (content.length > 80 ? '...' : '');

            return `
                <div style="padding: 12px; margin-bottom: 10px; background-color: var(--vscode-editorWidget-background); border-radius: 5px; border-left: 3px solid #10b981;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-weight: bold; color: var(--vscode-textLink-foreground); cursor: pointer;" onclick="jumpToComment(${lineNum})"><i class="codicon codicon-comment"></i> 行 ${lineNum}</span>
                        <div style="display: flex; gap: 5px;">
                            <button onclick="editComment(${lineNum})" style="padding: 2px 8px; font-size: 11px;">编辑</button>
                            <button onclick="deleteCommentFromList(${lineNum})" style="padding: 2px 8px; font-size: 11px;">删除</button>
                        </div>
                    </div>
                    <div style="font-size: 11px; color: var(--vscode-descriptionForeground); font-family: 'Consolas', monospace; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(preview)}
                    </div>
                    <div style="background-color: rgba(16, 185, 129, 0.1); padding: 8px; border-radius: 3px; font-size: 12px; font-style: italic; color: var(--vscode-editor-foreground);">
                        ${escapeHtml(comment)}
                    </div>
                </div>
            `;
        }).join('');
    }

    modal.style.display = 'block';
}

function closeCommentsModal() {
    document.getElementById('commentsModal').style.display = 'none';
}

function jumpToComment(lineNumber) {
    closeCommentsModal();
    jumpToLine(lineNumber);
}

function deleteCommentFromList(lineNumber) {
    if (confirm('确定要删除这条注释吗？')) {
        comments.delete(lineNumber);
        showCommentsModal(); // 刷新注释列表
        renderLines(); // 重新渲染
        showToast('注释已删除');
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: #10b981;
        color: white;
        padding: 10px 20px;
        border-radius: 5px;
        font-weight: bold;
        z-index: 10000;
        animation: fadeInOut 2s ease-in-out;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        if (document.body.contains(toast)) {
            document.body.removeChild(toast);
        }
    }, 2000);
}

// ========== 复制功能 ==========
let currentContextMenu = null;

function showContextMenu(event, content, lineNumber) {
    // 移除旧的菜单
    if (currentContextMenu) {
        document.body.removeChild(currentContextMenu);
    }

    // 获取选中的文本
    const selectedText = window.getSelection().toString();

    // 创建菜单
    const menu = document.createElement('div');
    menu.className = 'context-menu';

    // 复制选中文本
    if (selectedText) {
        const copySelectedItem = document.createElement('div');
        copySelectedItem.className = 'context-menu-item';
        copySelectedItem.innerHTML = '<span>📋</span><span>复制选中内容</span>';
        copySelectedItem.onclick = (e) => {
            e.stopPropagation();
            copyToClipboard(selectedText);
            closeContextMenu();
        };
        menu.appendChild(copySelectedItem);

        // 分隔线
        const separator1 = document.createElement('div');
        separator1.className = 'context-menu-separator';
        menu.appendChild(separator1);
    }

    // 复制整行
    const copyLineItem = document.createElement('div');
    copyLineItem.className = 'context-menu-item';
    copyLineItem.innerHTML = '<span>📄</span><span>复制整行</span>';
    copyLineItem.onclick = (e) => {
        e.stopPropagation();
        copyToClipboard(content);
        closeContextMenu();
    };
    menu.appendChild(copyLineItem);

    // 分隔线
    const separator2 = document.createElement('div');
    separator2.className = 'context-menu-separator';
    menu.appendChild(separator2);

    // 添加/移除书签
    const bookmarkItem = document.createElement('div');
    bookmarkItem.className = 'context-menu-item';
    const isBookmarked = bookmarks.has(lineNumber);
    bookmarkItem.innerHTML = isBookmarked
        ? '<span><i class="codicon codicon-trash"></i></span><span>移除书签</span>'
        : '<span><i class="codicon codicon-bookmark"></i></span><span>添加书签</span>';
    bookmarkItem.onclick = (e) => {
        e.stopPropagation();
        toggleBookmark(lineNumber);
        closeContextMenu();
    };
    menu.appendChild(bookmarkItem);

    // 添加/编辑注释
    const commentItem = document.createElement('div');
    commentItem.className = 'context-menu-item';
    const hasComment = comments.has(lineNumber);
    commentItem.innerHTML = hasComment
        ? '<span><i class="codicon codicon-edit"></i></span><span>编辑注释</span>'
        : '<span><i class="codicon codicon-comment-add"></i></span><span>添加注释</span>';
    commentItem.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        closeContextMenu();
        // 延迟执行，确保菜单先关闭
        setTimeout(() => {
            addOrEditComment(lineNumber);
        }, 100);
    };
    menu.appendChild(commentItem);

    // 如果已有注释，显示删除注释选项
    if (hasComment) {
        const deleteCommentItem = document.createElement('div');
        deleteCommentItem.className = 'context-menu-item';
        deleteCommentItem.innerHTML = '<span><i class="codicon codicon-trash"></i></span><span>删除注释</span>';
        deleteCommentItem.onclick = (e) => {
            e.stopPropagation();
            deleteComment(lineNumber);
            closeContextMenu();
        };
        menu.appendChild(deleteCommentItem);
    }

    // 分隔线
    const separator3 = document.createElement('div');
    separator3.className = 'context-menu-separator';
    menu.appendChild(separator3);

    // 定位到此行（当前视图）
    const jumpItem = document.createElement('div');
    jumpItem.className = 'context-menu-item';
    jumpItem.innerHTML = '<span><i class="codicon codicon-target"></i></span><span>定位到第 ' + lineNumber + ' 行</span>';
    jumpItem.onclick = (e) => {
        e.stopPropagation();
        jumpToLine(lineNumber);
        closeContextMenu();
    };
    menu.appendChild(jumpItem);

    // 如果是搜索/过滤模式，添加"跳转到完整日志"选项
    if (currentSearchKeyword || isFiltering) {
        const jumpToFullLogItem = document.createElement('div');
        jumpToFullLogItem.className = 'context-menu-item';
        jumpToFullLogItem.innerHTML = '<span><i class="codicon codicon-link"></i></span><span>跳转到完整日志</span>';
        jumpToFullLogItem.onclick = (e) => {
            e.stopPropagation();
            jumpToLineInFullLog(lineNumber);
            closeContextMenu();
        };
        menu.appendChild(jumpToFullLogItem);
    }

    // 设置位置
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';

    document.body.appendChild(menu);
    currentContextMenu = menu;

    // 点击其他地方关闭菜单
    setTimeout(() => {
        document.addEventListener('click', closeContextMenu);
    }, 0);
}

function closeContextMenu() {
    if (currentContextMenu) {
        document.body.removeChild(currentContextMenu);
        currentContextMenu = null;
    }
    document.removeEventListener('click', closeContextMenu);
}

function copyToClipboard(text) {
    // 使用 Clipboard API
    navigator.clipboard.writeText(text).then(() => {
        // 显示复制成功提示
        showCopyToast();
    }).catch(err => {
        console.error('复制失败:', err);
    });
}

function showCopyToast() {
    const toast = document.createElement('div');
    toast.textContent = '已复制到剪贴板';
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: #10b981;
        color: white;
        padding: 10px 20px;
        border-radius: 5px;
        font-weight: bold;
        z-index: 10000;
        animation: fadeInOut 2s ease-in-out;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        document.body.removeChild(toast);
    }, 2000);
}

// ========== 高级搜索 ==========
let advSearchConditionId = 0;

function showAdvancedSearchModal() {
    document.getElementById('advancedSearchModal').style.display = 'block';
    // 如果没有条件，自动添加第一个
    const conditionsContainer = document.getElementById('advSearchConditions');
    if (conditionsContainer.children.length === 0) {
        addAdvSearchCondition();
    }
}

function closeAdvancedSearchModal() {
    document.getElementById('advancedSearchModal').style.display = 'none';
    // 清空所有条件
    document.getElementById('advSearchConditions').innerHTML = '';
    advSearchConditionId = 0;
}

function addAdvSearchCondition() {
    const conditionId = advSearchConditionId++;
    const conditionsContainer = document.getElementById('advSearchConditions');
    
    const conditionDiv = document.createElement('div');
    conditionDiv.id = `advSearchCondition_${conditionId}`;
    conditionDiv.style.cssText = 'display: flex; gap: 10px; align-items: flex-start; padding: 10px; background-color: var(--vscode-editor-background); border-radius: 3px; border: 1px solid var(--vscode-panel-border);';
    
    conditionDiv.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; gap: 10px; align-items: center;">
                <select id="advSearchType_${conditionId}" onchange="onAdvSearchTypeChange(${conditionId})" style="padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px;">
                    <option value="keyword">关键词</option>
                    <option value="thread">线程名</option>
                    <option value="class">类名</option>
                    <option value="method">方法名</option>
                    <option value="level">日志级别</option>
                    <option value="time">时间范围</option>
                </select>
                <div id="advSearchMatchType_${conditionId}" style="display: none;">
                    <select id="advSearchMatch_${conditionId}" style="padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px;">
                        <option value="exact">精确匹配</option>
                        <option value="contains">包含</option>
                    </select>
                </div>
            </div>
            <div id="advSearchValue_${conditionId}">
                <input type="text" id="advSearchInput_${conditionId}" placeholder="输入搜索内容（多关键词用空格分隔）" style="width: 100%; padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px;">
            </div>
        </div>
        <button onclick="removeAdvSearchCondition(${conditionId})" title="删除此条件" style="padding: 6px 10px; font-size: 12px; background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);"><i class="codicon codicon-close"></i></button>
    `;
    
    conditionsContainer.appendChild(conditionDiv);
}

function removeAdvSearchCondition(conditionId) {
    const conditionDiv = document.getElementById(`advSearchCondition_${conditionId}`);
    if (conditionDiv) {
        conditionDiv.remove();
    }
}

function onAdvSearchTypeChange(conditionId) {
    const type = document.getElementById(`advSearchType_${conditionId}`).value;
    const valueContainer = document.getElementById(`advSearchValue_${conditionId}`);
    const matchTypeContainer = document.getElementById(`advSearchMatchType_${conditionId}`);
    
    // 显示/隐藏匹配类型选择器
    if (type === 'thread' || type === 'class' || type === 'method') {
        matchTypeContainer.style.display = 'block';
    } else {
        matchTypeContainer.style.display = 'none';
    }
    
    // 根据类型渲染不同的输入控件
    switch (type) {
        case 'keyword':
        case 'thread':
        case 'class':
        case 'method':
            valueContainer.innerHTML = `<input type="text" id="advSearchInput_${conditionId}" placeholder="${getPlaceholder(type)}" style="width: 100%; padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px;">`;
            break;
        case 'level':
            valueContainer.innerHTML = `
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <label style="font-size: 12px;"><input type="checkbox" id="advSearchLevel_${conditionId}_ERROR" checked> <span style="color: #f14c4c;">■</span> ERROR</label>
                    <label style="font-size: 12px;"><input type="checkbox" id="advSearchLevel_${conditionId}_WARN" checked> <span style="color: #cca700;">■</span> WARN</label>
                    <label style="font-size: 12px;"><input type="checkbox" id="advSearchLevel_${conditionId}_INFO" checked> <span style="color: #4fc1ff;">■</span> INFO</label>
                    <label style="font-size: 12px;"><input type="checkbox" id="advSearchLevel_${conditionId}_DEBUG" checked> <span style="color: #b267e6;">■</span> DEBUG</label>
                    <label style="font-size: 12px;"><input type="checkbox" id="advSearchLevel_${conditionId}_OTHER" checked> 其他</label>
                </div>
            `;
            break;
        case 'time':
            valueContainer.innerHTML = `
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <input type="text" id="advSearchStartTime_${conditionId}" placeholder="开始时间 (2024-01-01 10:00:00)" style="padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px;">
                    <input type="text" id="advSearchEndTime_${conditionId}" placeholder="结束时间 (2024-01-01 18:00:00)" style="padding: 6px 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px;">
                </div>
            `;
            break;
    }
}

function getPlaceholder(type) {
    switch (type) {
        case 'keyword': return '输入搜索内容（多关键词用空格分隔）';
        case 'thread': return '输入线程名，例如：http-nio-8080-exec-1';
        case 'class': return '输入类名，例如：com.example.UserService';
        case 'method': return '输入方法名，例如：getUserById';
        default: return '';
    }
}

// 提取日志行中的字段
function extractLogFields(line) {
    let content = line.content || line;
    
    // 如果 content 是字符串且包含 HTML 标签，需要先移除 HTML 标签
    if (typeof content === 'string' && content.includes('<')) {
        // 创建临时 DOM 元素来提取纯文本
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        content = tempDiv.textContent || tempDiv.innerText || content;
    }
    
    // 提取线程名 [threadName] - 排除日志级别
    const threadMatch = content.match(/\[((?!ERROR|FATAL|SEVERE|WARN|WARNING|INFO|INFORMATION|DEBUG|TRACE|VERBOSE\])[a-zA-Z][a-zA-Z0-9-_]*)\]/);
    const threadName = threadMatch ? threadMatch[1] : '';
    

    
    // 提取类名 package.ClassName
    const classMatch = content.match(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.[A-Z][a-zA-Z0-9_]*)\b/);
    const className = classMatch ? classMatch[1] : '';
    
    // 提取方法名 [methodName:lineNumber]
    const methodMatch = content.match(/\[([a-zA-Z_][a-zA-Z0-9_]*):\d+\]/);
    const methodName = methodMatch ? methodMatch[1] : '';
    
    return { threadName, className, methodName, content };
}

function confirmAdvancedSearch() {
    const logic = document.getElementById('advSearchLogic').value;
    const conditionsContainer = document.getElementById('advSearchConditions');
    
    if (conditionsContainer.children.length === 0) {
        showToast('请至少添加一个搜索条件');
        return;
    }
    
    // 收集所有条件
    const conditions = [];
    for (let i = 0; i < conditionsContainer.children.length; i++) {
        const child = conditionsContainer.children[i];
        const conditionId = child.id.split('_')[1];
        const type = document.getElementById(`advSearchType_${conditionId}`).value;
        
        const condition = { type };
        
        switch (type) {
            case 'keyword':
            case 'thread':
            case 'class':
            case 'method':
                const input = document.getElementById(`advSearchInput_${conditionId}`);
                if (!input || !input.value.trim()) continue;
                condition.value = input.value.trim();
                if (type !== 'keyword') {
                    condition.matchType = document.getElementById(`advSearchMatch_${conditionId}`).value;
                }
                break;
            case 'level':
                const levels = [];
                if (document.getElementById(`advSearchLevel_${conditionId}_ERROR`)?.checked) levels.push('ERROR');
                if (document.getElementById(`advSearchLevel_${conditionId}_WARN`)?.checked) levels.push('WARN');
                if (document.getElementById(`advSearchLevel_${conditionId}_INFO`)?.checked) levels.push('INFO');
                if (document.getElementById(`advSearchLevel_${conditionId}_DEBUG`)?.checked) levels.push('DEBUG');
                if (document.getElementById(`advSearchLevel_${conditionId}_OTHER`)?.checked) levels.push('OTHER');
                if (levels.length === 0 || levels.length === 5) continue; // 全选或全不选，跳过
                condition.levels = levels;
                break;
            case 'time':
                const startTime = document.getElementById(`advSearchStartTime_${conditionId}`)?.value.trim();
                const endTime = document.getElementById(`advSearchEndTime_${conditionId}`)?.value.trim();
                if (!startTime && !endTime) continue;
                condition.startTime = startTime;
                condition.endTime = endTime;
                break;
        }
        
        conditions.push(condition);
    }
    
    if (conditions.length === 0) {
        showToast('请至少填写一个有效的搜索条件');
        return;
    }
    
    console.log('高级搜索条件:', { logic, conditions });
    
    // 进入搜索模式前备份
    if (!isInSearchMode) {
        const container = document.getElementById('logContainer');
        searchBackup = {
            allLines: allLines,
            originalLines: originalLines,
            totalLinesInFile,
            allDataLoaded,
            isCollapseMode,
            currentPage,
            pageRanges: new Map(pageRanges),
            scrollTop: container ? container.scrollTop : 0
        };
        isInSearchMode = true;
    }
    
    // 应用过滤条件
    let results = [...allLines];
    
    if (logic === 'AND') {
        // AND 逻辑：所有条件都必须满足
        results = results.filter(line => {
            return conditions.every(condition => matchCondition(line, condition));
        });
    } else {
        // OR 逻辑：满足任一条件即可
        results = results.filter(line => {
            return conditions.some(condition => matchCondition(line, condition));
        });
    }

    allLines = results;
    currentPage = 1;
    isFiltering = true;
    
    handleDataChange({
        resetPage: true,
        clearPageRanges: true,
        triggerAsyncCalc: true
    });

    closeAdvancedSearchModal();

    if (results.length === 0) {
        showToast('未找到符合条件的日志');
    } else {
        showToast(`找到 ${results.length} 条匹配的日志`);
    }
}

function matchCondition(line, condition) {
    const fields = extractLogFields(line);
    const content = fields.content;
    
    switch (condition.type) {
        case 'keyword':
            // 多关键词搜索
            const keywords = condition.value.split(/\s+/).filter(k => k);
            return keywords.every(keyword => content.toLowerCase().includes(keyword.toLowerCase()));
            
        case 'thread':
            if (!fields.threadName) return false;
            if (condition.matchType === 'exact') {
                return fields.threadName === condition.value;
            } else {
                return fields.threadName.toLowerCase().includes(condition.value.toLowerCase());
            }
            
        case 'class':
            if (!fields.className) return false;
            if (condition.matchType === 'exact') {
                return fields.className === condition.value;
            } else {
                return fields.className.toLowerCase().includes(condition.value.toLowerCase());
            }
            
        case 'method':
            if (!fields.methodName) return false;
            if (condition.matchType === 'exact') {
                return fields.methodName === condition.value;
            } else {
                return fields.methodName.toLowerCase().includes(condition.value.toLowerCase());
            }
            
        case 'level':
            const level = line.level ? line.level.toUpperCase() : 'OTHER';
            return condition.levels.includes(level);
            
        case 'time':
            if (!line.timestamp) return false;
            const lineTime = new Date(line.timestamp);
            
            if (condition.startTime) {
                const start = new Date(condition.startTime);
                if (lineTime < start) return false;
            }
            
            if (condition.endTime) {
                const end = new Date(condition.endTime);
                if (lineTime > end) return false;
            }
            
            return true;
            
        default:
            return true;
    }
}


// ========== 时间线功能 ==========
function toggleTimeline() {
    isTimelineExpanded = !isTimelineExpanded;
    const content = document.getElementById('timelineContent');
    const icon = document.getElementById('timelineToggleIcon');

    if (isTimelineExpanded) {
        content.style.display = 'block';
        icon.textContent = '▼';
    } else {
        content.style.display = 'none';
        icon.textContent = '▶';
    }
}

function generateTimeline() {
    // 提取所有带时间戳的日志
    const logsWithTime = allLines.filter(line => line.timestamp);

    if (logsWithTime.length === 0) {
        document.getElementById('timelinePanel').style.display = 'none';
        return;
    }

    // 显示时间线面板
    document.getElementById('timelinePanel').style.display = 'block';

    // 获取时间范围
    const timestamps = logsWithTime.map(line => new Date(line.timestamp).getTime());
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    const timeRange = maxTime - minTime;

    // 分成20个时间段
    const bucketCount = 20;
    const bucketSize = timeRange / bucketCount;
    const buckets = new Array(bucketCount).fill(0).map(() => ({
        count: 0,
        error: 0,
        warn: 0,
        info: 0,
        debug: 0,
        lines: []
    }));

    // 统计每个时间段的日志数量
    logsWithTime.forEach(line => {
        const time = new Date(line.timestamp).getTime();
        const bucketIndex = Math.min(Math.floor((time - minTime) / bucketSize), bucketCount - 1);

        buckets[bucketIndex].count++;
        buckets[bucketIndex].lines.push(line);

        const level = (line.level || 'OTHER').toUpperCase();
        if (level === 'ERROR') buckets[bucketIndex].error++;
        else if (level === 'WARN') buckets[bucketIndex].warn++;
        else if (level === 'INFO') buckets[bucketIndex].info++;
        else if (level === 'DEBUG') buckets[bucketIndex].debug++;
    });

    timelineData = {
        buckets,
        minTime,
        maxTime,
        bucketSize
    };

    // 绘制时间线
    drawTimeline();

    // 显示时间范围
    const startDate = new Date(minTime);
    const endDate = new Date(maxTime);
    const info = document.getElementById('timelineInfo');
    info.innerHTML = `<span>时间范围: ${formatDate(startDate)} 至 ${formatDate(endDate)}</span> <span style="margin-left: 20px;">总计: ${logsWithTime.length} 条日志</span>`;
}

function drawTimeline() {
    if (!timelineData) return;

    const canvas = document.getElementById('timelineCanvas');
    const ctx = canvas.getContext('2d');

    // 设置画布大小
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = 80;

    // 清空画布
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { buckets } = timelineData;
    const maxCount = Math.max(...buckets.map(b => b.count));

    const barWidth = canvas.width / buckets.length;
    const maxHeight = canvas.height - 20;

    // 绘制柱状图
    buckets.forEach((bucket, i) => {
        const x = i * barWidth;
        const heightRatio = bucket.count / maxCount;

        // 绘制分层柱状图（按级别）
        let currentY = canvas.height - 20;

        // ERROR (红色)
        if (bucket.error > 0) {
            const h = (bucket.error / bucket.count) * heightRatio * maxHeight;
            ctx.fillStyle = '#f14c4c';
            ctx.fillRect(x + 1, currentY - h, barWidth - 2, h);
            currentY -= h;
        }

        // WARN (橙色)
        if (bucket.warn > 0) {
            const h = (bucket.warn / bucket.count) * heightRatio * maxHeight;
            ctx.fillStyle = '#cca700';
            ctx.fillRect(x + 1, currentY - h, barWidth - 2, h);
            currentY -= h;
        }

        // INFO (蓝色)
        if (bucket.info > 0) {
            const h = (bucket.info / bucket.count) * heightRatio * maxHeight;
            ctx.fillStyle = '#4fc1ff';
            ctx.fillRect(x + 1, currentY - h, barWidth - 2, h);
            currentY -= h;
        }

        // DEBUG (紫色)
        if (bucket.debug > 0) {
            const h = (bucket.debug / bucket.count) * heightRatio * maxHeight;
            ctx.fillStyle = '#b267e6';
            ctx.fillRect(x + 1, currentY - h, barWidth - 2, h);
        }
    });

    // 绘制当前浏览位置指示器
    drawCurrentPositionIndicator(ctx, canvas, buckets, barWidth);

    // 添加点击事件
    canvas.onclick = (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const bucketIndex = Math.floor(x / barWidth);

        if (bucketIndex >= 0 && bucketIndex < buckets.length) {
            const bucket = buckets[bucketIndex];
            if (bucket.lines.length > 0) {
                // 跳转到该时间段的第一条日志
                const targetLine = bucket.lines[0];
                jumpToLine(targetLine.lineNumber);
            }
        }
    };

    // 添加鼠标悬停提示
    canvas.onmousemove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const bucketIndex = Math.floor(x / barWidth);

        if (bucketIndex >= 0 && bucketIndex < buckets.length) {
            const bucket = buckets[bucketIndex];
            const startTime = new Date(timelineData.minTime + bucketIndex * timelineData.bucketSize);
            canvas.title = `${formatTime(startTime)}\n总计: ${bucket.count} 条\nERROR: ${bucket.error} | WARN: ${bucket.warn} | INFO: ${bucket.info} | DEBUG: ${bucket.debug}`;
        }
    };
}

function formatDate(date) {
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatTime(date) {
    return date.toLocaleString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// 绘制当前浏览位置指示器
function drawCurrentPositionIndicator(ctx, canvas, buckets, barWidth) {
    if (!timelineData || buckets.length === 0) {
        console.log('指示器：没有时间线数据');
        return;
    }

    // 获取当前可见区域中间的行号
    const visibleLines = getVisibleLines();
    console.log(' 可见行数量:', visibleLines.length);

    if (visibleLines.length === 0) {
        console.log('指示器：没有可见行');
        return;
    }

    // 取可见区域中间的日志行
    const middleIndex = Math.floor(visibleLines.length / 2);
    const currentLine = visibleLines[middleIndex];
    console.log('📍 当前中间行:', currentLine);

    if (!currentLine || !currentLine.lineNumber) {
        console.log('指示器：当前行无效');
        return;
    }

    // 在所有bucket中查找这条日志对应的时间戳
    let currentTime = null;

    for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (bucket.lines && bucket.lines.length > 0) {
            const foundLine = bucket.lines.find(l => l.lineNumber === currentLine.lineNumber);
            if (foundLine && foundLine.timestamp) {
                currentTime = new Date(foundLine.timestamp).getTime();
                console.log('找到精确时间戳:', new Date(currentTime).toLocaleString());
                break;
            }
        }
    }

    // 如果没找到精确匹配，根据行号比例估算位置
    if (!currentTime) {
        // 计算当前行在整个文件中的相对位置
        const totalLines = totalLinesInFile || allLines.length;
        if (totalLines === 0) {
            console.log('指示器：总行数为0');
            return;
        }

        const relativePosition = currentLine.lineNumber / totalLines;
        const timeRange = timelineData.maxTime - timelineData.minTime;
        currentTime = timelineData.minTime + relativePosition * timeRange;
        console.log('📊 估算时间戳（行号比例）:', new Date(currentTime).toLocaleString(), '比例:', relativePosition);
    }

    // 计算指示器在时间线上的位置
    const timeRange = timelineData.maxTime - timelineData.minTime;
    if (timeRange <= 0) {
        console.log('指示器：时间范围无效');
        return;
    }

    const relativePosition = (currentTime - timelineData.minTime) / timeRange;
    const indicatorX = Math.max(0, Math.min(canvas.width, relativePosition * canvas.width));
    console.log('指示器X位置:', indicatorX, '画布宽度:', canvas.width, '相对位置:', relativePosition);

    // 绘制指示器（一条垂直的红线）
    ctx.save();
    ctx.strokeStyle = '#ff3333';
    ctx.lineWidth = 3;
    ctx.setLineDash([]);

    // 绘制垂直线
    ctx.beginPath();
    ctx.moveTo(indicatorX, 0);
    ctx.lineTo(indicatorX, canvas.height - 20);
    ctx.stroke();

    // 绘制顶部三角形标记
    ctx.fillStyle = '#ff3333';
    ctx.beginPath();
    ctx.moveTo(indicatorX, 0);
    ctx.lineTo(indicatorX - 6, 10);
    ctx.lineTo(indicatorX + 6, 10);
    ctx.closePath();
    ctx.fill();

    // 绘制底部三角形标记
    ctx.beginPath();
    ctx.moveTo(indicatorX, canvas.height - 20);
    ctx.lineTo(indicatorX - 6, canvas.height - 30);
    ctx.lineTo(indicatorX + 6, canvas.height - 30);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
    console.log('指示器绘制完成');
}

// 获取当前可见的日志行
function getVisibleLines() {
    const container = document.getElementById('logContainer');
    if (!container) {
        console.log('getVisibleLines: 找不到 logContainer');
        return [];
    }

    const lines = container.querySelectorAll('.log-line');
    console.log('📋 总日志行数:', lines.length);

    const visibleLines = [];
    const containerRect = container.getBoundingClientRect();

    lines.forEach(lineEl => {
        const rect = lineEl.getBoundingClientRect();
        // 检查该行是否在可视区域内
        if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
            const lineNumber = parseInt(lineEl.dataset.lineNumber);
            if (lineNumber) {
                const line = allLines.find(l => l.lineNumber === lineNumber);
                if (line) {
                    visibleLines.push(line);
                }
            }
        }
    });

    console.log(' 可见行:', visibleLines.length, '条');
    return visibleLines;
}

// 按类名筛选
function filterByClassName(className) {
    closeStatsModal();

    // 保存筛选前的位置
    savePositionBeforeFilter();

    // 记录筛选状态
    currentFilterType = 'class';
    currentFilterValue = className;
    showFilterStatus(`类名: ${className}`);

    // 应用类名过滤
    setFilterAndApply({ className: className });
}

// 按方法名筛选
function filterByMethodName(methodName) {
    closeStatsModal();

    // 保存筛选前的位置
    savePositionBeforeFilter();

    // 记录筛选状态
    currentFilterType = 'method';
    currentFilterValue = methodName;
    showFilterStatus(`方法名: ${methodName}`);

    // 应用方法名过滤
    setFilterAndApply({ methodName: methodName });
}

// 按线程名筛选
function filterByThreadName(threadName) {
    closeStatsModal();

    // 保存筛选前的位置
    savePositionBeforeFilter();

    // 记录筛选状态
    currentFilterType = 'thread';
    currentFilterValue = threadName;
    showFilterStatus(`线程名: ${threadName}`);

    // 应用线程名过滤
    setFilterAndApply({ threadName: threadName });
}

// 保存筛选前的位置
function savePositionBeforeFilter() {
    savedPageBeforeFilter = currentPage;

    // 保存当前页第一行的行号
    if (allLines.length > 0) {
        const startIndex = (currentPage - 1) * pageSize;
        if (startIndex < allLines.length) {
            savedFirstLineBeforeFilter = allLines[startIndex].lineNumber || (startIndex + 1);
        }
    }

}

// 显示筛选状态
function showFilterStatus(text) {
    const panel = document.getElementById('filterStatusPanel');
    const statusText = document.getElementById('filterStatusText');
    statusText.textContent = text;
    panel.style.display = 'flex';
}

// 隐藏筛选状态
function hideFilterStatus() {
    const panel = document.getElementById('filterStatusPanel');
    panel.style.display = 'none';
}

// 清除自定义筛选
function clearCustomFilter() {
    console.log('清除筛选');
    currentFilterType = null;
    currentTimelineBucketIndex = null;
    currentFilterValue = null;
    hideFilterStatus();

    // 清除所有统一过滤条件
    clearAllFilters();
    
    // 重置保存的位置
    savedPageBeforeFilter = 1;
    savedFirstLineBeforeFilter = null;
}

function showDeleteByTimeDialog() {
    document.getElementById('deleteByTimeModal').style.display = 'block';
}

function closeDeleteByTimeModal() {
    document.getElementById('deleteByTimeModal').style.display = 'none';
    document.getElementById('deleteTimeInput').value = '';
}

// ========== 删除方式选择 ==========
function showDeleteModal() {
    document.getElementById('deleteModal').style.display = 'block';
}

function closeDeleteModal() {
    document.getElementById('deleteModal').style.display = 'none';
}

function selectDeleteByTime() {
    closeDeleteModal();
    showDeleteByTimeDialog();
}

function selectDeleteByLine() {
    closeDeleteModal();
    showDeleteByLineDialog();
}

function confirmDeleteByTime() {
    const timeStr = document.getElementById('deleteTimeInput').value.trim();
    const mode = document.getElementById('deleteTimeMode').value;

    if (!timeStr) {
        alert('请输入时间！');
        return;
    }

    // 简单验证时间格式
    if (!/^\d{4}-\d{2}-\d{2}/.test(timeStr)) {
        alert('时间格式不正确！请使用格式：2024-01-01 12:00:00 或 2024-01-01');
        return;
    }

    vscode.postMessage({
        command: 'deleteByTime',
        timeStr: timeStr,
        mode: mode
    });

    closeDeleteByTimeModal();
}

function showDeleteByLineDialog() {
    document.getElementById('deleteByLineModal').style.display = 'block';
}

function closeDeleteByLineModal() {
    document.getElementById('deleteByLineModal').style.display = 'none';
    document.getElementById('deleteLineInput').value = '';
}

function showJumpDialog() {
    document.getElementById('jumpModal').style.display = 'block';
    document.getElementById('jumpLineInput').focus();
}

function closeJumpModal() {
    document.getElementById('jumpModal').style.display = 'none';
    document.getElementById('jumpLineInput').value = '';
    document.getElementById('jumpTimeInput').value = '';
}

function switchJumpMode() {
    const mode = document.getElementById('jumpMode').value;
    const lineSection = document.getElementById('jumpByLineSection');
    const timeSection = document.getElementById('jumpByTimeSection');

    if (mode === 'line') {
        lineSection.style.display = 'block';
        timeSection.style.display = 'none';
        document.getElementById('jumpLineInput').focus();
    } else {
        lineSection.style.display = 'none';
        timeSection.style.display = 'block';

        // 自动设置当前时间
        const timeInput = document.getElementById('jumpTimeInput');
        if (!timeInput.value) {
            // 获取当前时间并格式化为 datetime-local 格式（YYYY-MM-DDTHH:mm）
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
        }

        timeInput.focus();
    }
}

function confirmJump() {
    const mode = document.getElementById('jumpMode').value;

    if (mode === 'line') {
        const lineNumber = parseInt(document.getElementById('jumpLineInput').value);
        if (!lineNumber || lineNumber < 1) {
            alert('请输入有效的行号（大于0的整数）！');
            return;
        }
        if (lineNumber > allLines.length) {
            alert(`行号超出范围！当前总行数：${allLines.length}`);
            return;
        }
        jumpToLine(lineNumber);
    } else {
        const timeInputValue = document.getElementById('jumpTimeInput').value.trim();
        if (!timeInputValue) {
            alert('请选择或输入时间！');
            return;
        }

        // datetime-local 格式：YYYY-MM-DDTHH:mm 或 YYYY-MM-DDTHH:mm:ss
        // 转换为后端期望的格式：YYYY-MM-DD HH:mm:ss
        let timeStr = timeInputValue.replace('T', ' ');

        // 如果没有秒，添加 :00
        if (timeStr.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)) {
            timeStr += ':00';
        }

        console.log('🕐 跳转到时间:', timeStr);
        jumpToTime(timeStr);
    }

    closeJumpModal();
}

function jumpToLine(lineNumber) {
    console.log('定位到行号:', lineNumber);
    console.log(`📊 当前数据状态 - allLines: ${allLines.length} 行, baseLineOffset: ${baseLineOffset}, totalLinesInFile: ${totalLinesInFile}`);
    
    // 检查数据范围
    if (allLines.length > 0) {
        const firstLine = allLines[0].lineNumber || 0;
        const lastLine = allLines[allLines.length - 1].lineNumber || 0;
        console.log(`📄 已加载数据范围: ${firstLine} ~ ${lastLine}`);
        
        // 检查目标行是否在已加载范围内
        if (lineNumber < firstLine || lineNumber > lastLine) {
            console.warn(`目标行 ${lineNumber} 不在已加载数据范围内 (${firstLine} ~ ${lastLine})`);
            showToast(`目标行不在当前加载的数据范围内，可能需要重新加载`);
        }
    }

    // 在折叠模式下，需要智能查找目标页
    if (isCollapseMode && pageRanges.size > 0) {
        console.log('📏 折叠模式 - 智能查找目标页');

        // 先尝试在已计算的页面中查找
        for (let [pageNum, range] of pageRanges.entries()) {
            // 查找该页范围内的日志是否包含目标行号
            const pageLines = allLines.slice(range.start, range.end);
            const hasTargetLine = pageLines.some(line => {
                const actualLineNumber = line.lineNumber || 0;
                return actualLineNumber === lineNumber;
            });

            if (hasTargetLine) {
                console.log(`在第 ${pageNum} 页找到目标行`);
                currentPage = pageNum;
                updatePagination();
                renderLines();
                drawTimeline(); // 重绘时间线以更新高亮位置

                // 等待渲染完成后高亮目标行
                setTimeout(() => {
                    highlightTargetLine(lineNumber);
                }, 100);
                return;
            }
        }

        // 如果在已计算的页面中没找到，尝试在数组中查找索引位置
        console.log('已计算页面中未找到，在数组中查找');
        const targetIndex = allLines.findIndex(line => line.lineNumber === lineNumber);

        if (targetIndex !== -1) {
            // 根据索引位置估算页码（折叠模式下可能不准确，但比直接用行号好）
            const estimatedPage = Math.ceil((targetIndex + 1) / pageSize);
            currentPage = Math.max(1, Math.min(estimatedPage, totalPages));
            console.log(`📍 目标行索引: ${targetIndex}，估算页码: ${estimatedPage}`);
        } else {
            // 完全找不到，使用行号估算（最后的备用方案）
            const estimatedPage = Math.ceil(lineNumber / pageSize);
            currentPage = Math.max(1, Math.min(estimatedPage, totalPages));
            console.log(`完全找不到目标行，使用行号估算: ${estimatedPage}`);
        }
    } else {
        // 非折叠模式或未计算页面，使用标准计算
        // 🔧 修复：在 allLines 数组中查找目标行号的索引位置
        const targetIndex = allLines.findIndex(line => line.lineNumber === lineNumber);

        if (targetIndex !== -1) {
            // 🔧 关键修复：根据索引位置计算页码
            // 注意：这里计算的是在当前 allLines 数组中的页码，不是文件中的绝对页码
            const targetPage = Math.ceil((targetIndex + 1) / pageSize);
            currentPage = targetPage;
            console.log(`找到目标行 ${lineNumber}，数组索引: ${targetIndex}，在当前数据中的页码: ${targetPage}`);
            
            // 如果数据是从中间加载的，显示提示信息
            if (baseLineOffset > 0) {
                console.log(`当前数据从第 ${baseLineOffset + 1} 行开始加载，共 ${allLines.length} 行`);
            }
        } else {
            // 🔧 修复：未找到目标行时，判断是否因为数据范围问题
            if (baseLineOffset > 0 && allLines.length > 0) {
                // 数据是从中间加载的，但目标行不在范围内
                const firstLine = allLines[0].lineNumber || 0;
                const lastLine = allLines[allLines.length - 1].lineNumber || 0;
                console.error(`目标行 ${lineNumber} 不在已加载范围 (${firstLine}~${lastLine}) 内！`);
                showToast(`目标行 ${lineNumber} 不在已加载数据范围内，请重新加载`);
                currentPage = 1; // 跳转到第一页
            } else {
                // 数据从头开始，使用行号估算（适用于完整日志）
                const targetPage = Math.ceil(lineNumber / pageSize);
                currentPage = targetPage;
                console.log(`未找到目标行 ${lineNumber}，使用行号估算跳转到第 ${targetPage} 页`);
            }
        }
    }

    updatePagination();
    renderLines();
    drawTimeline(); // 重绘时间线以更新高亮位置

    // 等待渲染完成后高亮目标行
    setTimeout(() => {
        highlightTargetLine(lineNumber);
    }, 100);
}

// 从搜索结果跳转到完整日志的指定行
function jumpToLineInFullLog(lineNumber) {
    console.log('🚀 跳转到完整日志的行:', lineNumber);

    // 清除搜索关键词和过滤状态
    currentSearchKeyword = '';
    document.getElementById('searchInput').value = '';
    isFiltering = false;

    // 🔧 关键修复：如果数据已经完全加载，直接在当前数据中跳转，不需要重新加载
    if (allDataLoaded && fullDataCache.length > 0) {
        console.log('数据已完全加载，直接跳转到目标行');
        
        // 恢复到完整日志模式
        isInSearchMode = false;
        searchBackup = null;
        
        // 🔧 关键修复：从完整数据缓存恢复数据
        allLines = [...fullDataCache];
        originalLines = [...fullDataCache];
        
        // 🔧 清空统一过滤条件，确保显示完整日志
        unifiedFilters = {
            keyword: null,
            isRegex: false,
            isMultiple: false,
            threadName: null,
            className: null,
            methodName: null,
            levels: null,
            timeRange: null,
        };
        
        // 重新渲染并跳转
        handleDataChange({ resetPage: false });
        jumpToLine(lineNumber);
        drawTimeline();
        showToast(`已跳转到第 ${lineNumber} 行`);
        return;
    }

    // 数据未完全加载，需要请求后端重新加载
    console.log('数据未完全加载，请求后端加载完整日志');
    showToast('📦 正在加载完整日志...');

    // 请求后端重新加载完整日志，并跳转到指定行
    vscode.postMessage({
        command: 'jumpToLineInFullLog',
        lineNumber: lineNumber
    });
}

function jumpToTime(timeStr) {
    console.log('定位到时间:', timeStr);

    // 直接请求后端查找
    vscode.postMessage({
        command: 'jumpToTime',
        timeStr: timeStr
    });
}

function handleJumpToTimeResult(data) {
    if (data.success) {
        console.log('找到目标时间的日志，行号:', data.targetLineNumber);

        // 如果正在筛选或搜索模式，需要先退出到完整日志
        if (isFiltering || currentSearchKeyword) {
            console.log('🔄 退出筛选/搜索模式，重新加载完整日志...');
            isFiltering = false;
            currentSearchKeyword = '';
            currentFilterType = null;
            currentFilterValue = null;
            hideFilterStatus();
            document.getElementById('searchInput').value = '';

            // 请求重新加载完整日志并跳转
            vscode.postMessage({
                command: 'jumpToLineInFullLog',
                lineNumber: data.targetLineNumber
            });
            return;
        }

        // 检查目标行是否在已加载的数据中
        const targetIndex = allLines.findIndex(line => line.lineNumber === data.targetLineNumber);

        if (targetIndex !== -1) {
            // 目标行已在内存中，直接跳转，不重新加载数据
            console.log(`目标行已在内存中（索引: ${targetIndex}），直接跳转`);
            jumpToLine(data.targetLineNumber);
            showToast(`已跳转到第 ${data.targetLineNumber} 行`);
            return;
        }

        // 目标行不在已加载数据中，需要加载
        console.log('目标行不在已加载范围，需要加载新数据');

        // 合并新加载的数据
        const newLines = data.lines;
        const startLine = typeof data.startLine === 'number' ? data.startLine : 0;

        console.log(` 接收到 ${newLines.length} 行数据，起始行号: ${startLine}`);

        // 检查数据重叠情况
        if (allLines.length > 0) {
            const firstLoadedLineNum = allLines[0].lineNumber || 1;
            const lastLoadedLineNum = allLines[allLines.length - 1].lineNumber || allLines.length;
            const newFirstLineNum = newLines[0].lineNumber || startLine + 1;
            const newLastLineNum = newLines[newLines.length - 1].lineNumber || startLine + newLines.length;

            console.log(`📊 当前数据范围: ${firstLoadedLineNum} - ${lastLoadedLineNum}`);
            console.log(`📊 新数据范围: ${newFirstLineNum} - ${newLastLineNum}`);

            // 如果新数据和已有数据有连续性，尝试合并
            if (newFirstLineNum > lastLoadedLineNum && newFirstLineNum - lastLoadedLineNum < 1000) {
                // 新数据在后面且相近，追加
                console.log('追加新数据到末尾');
                allLines = allLines.concat(newLines);
                originalLines = [...allLines];
            } else if (newLastLineNum < firstLoadedLineNum && firstLoadedLineNum - newLastLineNum < 1000) {
                // 新数据在前面且相近，前置
                console.log('前置新数据到开头');
                allLines = newLines.concat(allLines);
                originalLines = [...allLines];
            } else {
                // 数据不连续，替换为新数据
                console.log('🔄 数据不连续，使用新数据');
                allLines = newLines;
                originalLines = [...newLines];
                allDataLoaded = false;
            }
        } else {
            // 没有已加载数据，直接使用新数据
            allLines = newLines;
            originalLines = [...newLines];
            allDataLoaded = false;
        }

        // 记录当前缓冲区在文件中的起始行，用于统一后台加载
        baseLineOffset = startLine;

        // 重新计算页面（保持折叠状态）
        handleDataChange({
            resetPage: true,
            clearPageRanges: true,
            triggerAsyncCalc: isCollapseMode  // 只在折叠模式下触发异步计算
        });

        // 更新页面信息显示
        document.getElementById('totalLinesInPage').textContent = allLines.length;
        document.getElementById('totalLines').textContent = totalLinesInFile;
        document.getElementById('loadedLines').textContent = allLines.length;

        // 显示行范围信息（如果是部分数据）
        if (allLines.length > 0 && allLines.length < totalLinesInFile) {
            const firstLine = allLines[0].lineNumber || 1;
            const lastLine = allLines[allLines.length - 1].lineNumber || allLines.length;
            document.getElementById('lineRangeStart').textContent = firstLine;
            document.getElementById('lineRangeEnd').textContent = lastLine;
            document.getElementById('lineRangeInfo').style.display = 'inline';
        } else {
            document.getElementById('lineRangeInfo').style.display = 'none';
        }

        // 延迟跳转，确保页面已渲染
        setTimeout(() => {
            jumpToLine(data.targetLineNumber);
            showToast(`已跳转到第 ${data.targetLineNumber} 行`);
        }, 300);

        // 如有需要，重新启用统一的后台加载逻辑
        if (!allDataLoaded && baseLineOffset + allLines.length < totalLinesInFile) {
            isBackgroundLoading = false;
            startBackgroundLoading();
        }
    } else {
        console.error('未找到目标时间的日志');
        showToast(data.message || '未找到大于或等于该时间的日志！');
    }
}

function highlightTargetLine(lineNumber) {
    console.log('🔆 高亮目标行:', lineNumber);

    // 移除之前的高亮
    document.querySelectorAll('.log-line.highlight-target').forEach(el => {
        el.classList.remove('highlight-target');
    });

    // 查找目标行（通过行号匹配，而不是索引）
    const logLines = document.querySelectorAll('.log-line');

    for (let i = 0; i < logLines.length; i++) {
        const logLine = logLines[i];
        const lineNumberSpan = logLine.querySelector('.log-line-number');

        if (lineNumberSpan) {
            // 提取行号（去除书签图标）
            const displayedLineNumber = parseInt(lineNumberSpan.textContent.trim());

            if (displayedLineNumber === lineNumber) {
                console.log(`找到目标行，索引: ${i}`);
                logLine.classList.add('highlight-target');

                // 滚动到可见区域
                logLine.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // 3秒后移除高亮
                setTimeout(() => {
                    logLine.classList.remove('highlight-target');
                }, 3000);

                return;
            }
        }
    }

    console.log('未找到目标行，可能不在当前页面');
}

function confirmDeleteByLine() {
    const lineNumber = parseInt(document.getElementById('deleteLineInput').value);
    const mode = document.getElementById('deleteLineMode').value;

    if (!lineNumber || lineNumber < 1) {
        alert('请输入有效的行号（大于0的整数）！');
        return;
    }

    vscode.postMessage({
        command: 'deleteByLine',
        lineNumber: lineNumber,
        mode: mode
    });

    closeDeleteByLineModal();
}

function exportLogs() {
    setButtonLoadingById('exportBtn', true);
    vscode.postMessage({
        command: 'exportLogs',
        lines: allLines
    });
    // 导出完成后会收到 toast 通知，这里延迟恢复按钮状态
    setTimeout(() => setButtonLoadingById('exportBtn', false), 1000);
}

function refresh() {
    setButtonLoadingById('refreshBtn', true);
    currentSearchKeyword = '';
    document.getElementById('searchInput').value = '';
    currentPage = 1;
    isFiltering = false; // 退出过滤模式
    vscode.postMessage({
        command: 'refresh'
    });
}

// 分页功能
function updatePagination() {
    let isEstimated = false; // 标记总页数是否为估算值

    // 在折叠模式下，总页数难以精确计算，需要动态估算
    if (isCollapseMode) {
        // 如果已经有页面范围记录，根据最后一页的结束位置估算
        if (pageRanges.size > 0) {
            const maxPage = Math.max(...pageRanges.keys());
            const maxRange = pageRanges.get(maxPage);

            if (maxRange.end >= allLines.length) {
                // 已经到达最后，总页数就是已知的最大页
                totalPages = maxPage;
                isEstimated = false; // 精确值
            } else {
                // 还有更多数据，至少比当前已知最大页多1页，以便启用"下一页"按钮
                totalPages = maxPage + 1;
                isEstimated = true; // 估算值
            }
        } else {
            // 没有记录，使用标准计算作为初始估算
            totalPages = Math.ceil(allLines.length / pageSize);
            isEstimated = true; // 估算值
        }
    } else {
        // 非折叠模式，使用标准计算
        // 🔧 修复：如果数据未全部加载（baseLineOffset > 0 或未全部加载），总页数应该基于整个文件
        if (!allDataLoaded && baseLineOffset > 0) {
            // 数据是从中间加载的，总页数基于文件总行数估算
            totalPages = Math.ceil(totalLinesInFile / pageSize);
            isEstimated = true; // 这是估算值
            console.log(`📊 部分加载模式 - 总页数基于文件总行数: ${totalLinesInFile} 行 ≈ ${totalPages} 页`);
        } else {
            // 数据从头开始加载，总页数基于已加载数据
            totalPages = Math.ceil(allLines.length / pageSize);
            isEstimated = false;
        }
    }

    if (totalPages < 1) totalPages = 1;
    if (currentPage > totalPages) currentPage = totalPages;

    document.getElementById('currentPageInput').value = currentPage;

    // 显示总页数：计算中、估算值或精确值
    const totalPagesElement = document.getElementById('totalPages');
    if (isCalculatingPages) {
        // 正在计算中
        totalPagesElement.textContent = `计算中... ${calculationProgress}%`;
    } else if (isEstimated) {
        // 估算值
        totalPagesElement.textContent = `≥ ${totalPages - 1}`;
    } else {
        // 精确值
        totalPagesElement.textContent = totalPages;
    }

    document.getElementById('totalLinesInPage').textContent = allLines.length;

    // 更新按钮状态
    document.getElementById('firstPageBtn').disabled = currentPage === 1;
    document.getElementById('prevPageBtn').disabled = currentPage === 1;

    // 在折叠模式下，如果是估算值，说明还有更多数据，不禁用“下一页”按钮
    if (isCollapseMode && isEstimated) {
        document.getElementById('nextPageBtn').disabled = false;
        document.getElementById('lastPageBtn').disabled = false;
    } else {
        document.getElementById('nextPageBtn').disabled = currentPage === totalPages;
        document.getElementById('lastPageBtn').disabled = currentPage === totalPages;
    }

    // 检查是否需要加载更多数据
    checkAndLoadMore();
}

function checkAndLoadMore() {
    // 如果已加载全部数据，不再加载
    if (allDataLoaded) return;

    // 如果处于过滤模式或搜索模式，不自动加载更多数据
    if (isFiltering || currentSearchKeyword) {
        console.log('🚫 处于过滤/搜索模式，不加载更多数据');
        return;
    }

    // 如果当前页接近已加载数据的末尾，自动加载更多
    const loadedLines = allLines.length;
    const currentMaxLine = currentPage * pageSize;

    if (currentMaxLine >= loadedLines - 500 && loadedLines < totalLinesInFile) {
        loadMoreData();
    }
}

function loadMoreData() {
    if (allDataLoaded) return;

    const currentLoaded = allLines.length;
    const remaining = totalLinesInFile - currentLoaded;
    const toLoad = Math.min(remaining, 10000); // 每次加载10000行

    vscode.postMessage({
        command: 'loadMore',
        startLine: currentLoaded,
        count: toLoad
    });
}

function showLoadMoreHint() {
    // 在页面底部显示加载更多按钮
    const pagination = document.getElementById('pagination');
    let loadMoreBtn = document.getElementById('loadMoreBtn');

    if (!loadMoreBtn) {
        loadMoreBtn = document.createElement('button');
        loadMoreBtn.id = 'loadMoreBtn';
        loadMoreBtn.style.backgroundColor = '#0e7490';
        loadMoreBtn.style.marginLeft = '20px';
        loadMoreBtn.innerHTML = '📂 加载更多数据';
        loadMoreBtn.onclick = function () {
            loadAllRemainingData();
        };
        pagination.appendChild(loadMoreBtn);
    }

    loadMoreBtn.style.display = allDataLoaded ? 'none' : 'inline-block';
}

function loadAllRemainingData() {
    if (allDataLoaded) return;

    const remaining = totalLinesInFile - allLines.length;
    if (remaining <= 0) {
        allDataLoaded = true;
        return;
    }

    vscode.postMessage({
        command: 'loadMore',
        startLine: allLines.length,
        count: remaining
    });

    // 隐藏加载按钮
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) {
        loadMoreBtn.style.display = 'none';
    }
}

// 请求加载全部数据（用于统一过滤）
function requestAllData() {
    if (allDataLoaded) {
        // 数据已全部加载，直接应用过滤
        applyUnifiedFilters();
        handleDataChange({
            resetPage: true,
            clearPageRanges: true,
            triggerAsyncCalc: true
        });
        return;
    }
    
    // 开始后台加载
    startBackgroundLoading();
    
    // 监听加载完成事件
    const checkInterval = setInterval(() => {
        if (allDataLoaded || fullDataCache.length >= totalLinesInFile) {
            clearInterval(checkInterval);
            console.log('数据加载完成，应用统一过滤');
            applyUnifiedFilters();
            handleDataChange({
                resetPage: true,
                clearPageRanges: true,
                triggerAsyncCalc: true
            });
            showToast(`找到 ${allLines.length} 条符合条件的日志`);
        }
    }, 1000);
}

// 后台逐步加载数据
function startBackgroundLoading() {
    if (isBackgroundLoading || allDataLoaded) {
        return;
    }

    isBackgroundLoading = true;
    console.log('🔄 开始后台加载数据...');

    // 显示右下角后台加载进度
    showBackgroundLoadingIndicator();

    // 更新状态栏显示
    updateLoadingStatus();

    loadNextChunk();
}

function loadNextChunk() {
    if (allDataLoaded || !isBackgroundLoading) {
        isBackgroundLoading = false;
        return;
    }

    const remaining = totalLinesInFile - (baseLineOffset + fullDataCache.length);
    if (remaining <= 0) {
        allDataLoaded = true;
        isBackgroundLoading = false;
        console.log('后台加载完成！');
        updateLoadingStatus();
        
        // 确保进度条显示 100% 并隐藏
        updateBackgroundLoadingProgress();
        setTimeout(() => {
            hideBackgroundLoadingIndicator();
        }, 1000);
        return;
    }

    const chunkSize = Math.min(backgroundLoadChunkSize, remaining);
    const startLine = baseLineOffset + fullDataCache.length;
    console.log(` 后台加载: 第 ${startLine} - ${startLine + chunkSize} 行（baseOffset=${baseLineOffset}）`);

    vscode.postMessage({
        command: 'loadMore',
        startLine: startLine,
        count: chunkSize
    });

    // 延迟加载下一批，避免阻塞UI（每批间隔500ms）
    setTimeout(() => {
        loadNextChunk();
    }, 500);
}

function updateLoadingStatus() {
    const loadedLines = document.getElementById('loadedLines');
    if (loadedLines) {
        if (isBackgroundLoading) {
            const percent = Math.floor((allLines.length / totalLinesInFile) * 100);
            loadedLines.textContent = `${allLines.length} (${percent}% 后台加载中...)`;
        } else if (allDataLoaded) {
            loadedLines.textContent = allLines.length + ' ✓';
        } else {
            loadedLines.textContent = allLines.length;
        }
    }
}

// 显示右下角后台加载进度提示
function showBackgroundLoadingIndicator() {
    const indicator = document.getElementById('backgroundLoadingIndicator');
    if (indicator) {
        indicator.style.display = 'block';
        updateBackgroundLoadingProgress();
    }
}

// 隐藏右下角后台加载进度提示
function hideBackgroundLoadingIndicator() {
    const indicator = document.getElementById('backgroundLoadingIndicator');
    if (indicator) {
        // 添加淡出动画
        indicator.style.opacity = '0';
        indicator.style.transition = 'opacity 0.3s ease-out';
        setTimeout(() => {
            indicator.style.display = 'none';
            indicator.style.opacity = '1';
        }, 300);
    }
}

// 更新右下角后台加载进度
function updateBackgroundLoadingProgress() {
    const progressBar = document.getElementById('backgroundProgressBar');
    const progressText = document.getElementById('backgroundProgressText');
    
    if (progressBar && progressText) {
        const loaded = fullDataCache.length;
        const total = totalLinesInFile;
        const percent = Math.min(100, Math.floor((loaded / total) * 100));
        
        progressBar.style.width = percent + '%';
        
        if (percent >= 100) {
            progressText.textContent = `加载完成！(${total.toLocaleString()} 行)`;
        } else {
            progressText.textContent = `${percent}% (${loaded.toLocaleString()} / ${total.toLocaleString()} 行)`;
        }
    }
}

// 取消后台加载
function cancelBackgroundLoading() {
    if (isBackgroundLoading) {
        isBackgroundLoading = false;
        hideBackgroundLoadingIndicator();
        updateLoadingStatus();
        showToast('已暂停后台加载');
    }
}

function goToFirstPage() {
    currentPage = 1;
    updatePagination();
    renderLines();
    drawTimeline(); // 重绘时间线以更新高亮位置
}

function goToPrevPage() {
    if (currentPage > 1) {
        currentPage--;
        updatePagination();
        renderLines();
        drawTimeline(); // 重绘时间线以更新高亮位置
        // 翻页后自动滚动到顶部
        requestAnimationFrame(() => {
            const logContainer = document.getElementById('logContainer');
            if (logContainer) {
                logContainer.scrollTop = 0;
            }
        });
    }
}

function goToNextPage() {
    if (currentPage < totalPages) {
        currentPage++;
        updatePagination();
        renderLines();
        drawTimeline(); // 重绘时间线以更新高亮位置
        // 翻页后自动滚动到顶部
        requestAnimationFrame(() => {
            const logContainer = document.getElementById('logContainer');
            if (logContainer) {
                logContainer.scrollTop = 0;
            }
        });
    }
}

function goToLastPage() {
    currentPage = totalPages;
    updatePagination();
    renderLines();
    drawTimeline(); // 重绘时间线以更新高亮位置
    // 翻页后自动滚动到顶部
    requestAnimationFrame(() => {
        const logContainer = document.getElementById('logContainer');
        if (logContainer) {
            logContainer.scrollTop = 0;
        }
    });
}

function goToPage(page) {
    page = parseInt(page);
    if (page >= 1 && page <= totalPages) {
        currentPage = page;

        // 在折叠模式下，如果跳转到未计算过的页面，需要先计算中间的所有页面
        if (isCollapseMode && !pageRanges.has(page)) {

            // 从第一页开始顺序计算到目标页
            pageRanges.clear();
            for (let p = 1; p <= page; p++) {
                currentPage = p;
                // 不显示，只计算范围
                calculatePageRange(p);
            }
        }

        updatePagination();
        renderLines();
        drawTimeline(); // 重绘时间线以更新高亮位置
        // 翻页后自动滚动到顶部
        requestAnimationFrame(() => {
            const logContainer = document.getElementById('logContainer');
            if (logContainer) {
                logContainer.scrollTop = 0;
            } else {
                console.log('找不到 logContainer 元素');
            }
        });
    } else {
        document.getElementById('currentPageInput').value = currentPage;
    }
}

function changePageSize(size) {
    pageSize = parseInt(size);
    currentPage = 1;
    pageRanges.clear(); // 清空页面范围记录，重新计算
    updatePagination();
    renderLines();
    // 改变页面大小后自动滚动到顶部
    requestAnimationFrame(() => {
        const logContainer = document.getElementById('logContainer');
        if (logContainer) {
            logContainer.scrollTop = 0;
        }
    });
}

// ========== 时间线导航功能 ==========

function toggleTimeline() {
    isTimelineExpanded = !isTimelineExpanded;
    const content = document.getElementById('timelineContent');
    const icon = document.getElementById('timelineToggleIcon');

    if (isTimelineExpanded) {
        content.style.display = 'block';
        icon.textContent = '▼';
    } else {
        content.style.display = 'none';
        icon.textContent = '▶';
    }
}

// 使用采样数据生成时间线（快速异步加载）
function generateTimelineFromSamples(sampledData) {
    console.log('使用采样数据生成时间线');

    const startTime = new Date(sampledData.startTime);
    const endTime = new Date(sampledData.endTime);
    const timeRange = endTime - startTime;

    console.log('📊 完整时间范围（采样）:', startTime.toLocaleString(), '-', endTime.toLocaleString());

    // 如果时间范围太小，不显示时间线
    if (timeRange < 1000) {
        console.log('时间范围太小，隐藏时间线');
        document.getElementById('timelinePanel').style.display = 'none';
        return;
    }

    // 将时间分成若干个桶（bucket）
    const bucketCount = 50;
    const bucketSize = timeRange / bucketCount;
    const buckets = new Array(bucketCount).fill(0);
    const bucketLevels = new Array(bucketCount).fill(null).map(() => ({ ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, OTHER: 0 }));

    // 将采样点分配到各个桶中
    for (let sample of sampledData.samples) {
        if (sample.timestamp) {
            const time = new Date(sample.timestamp);
            const bucketIndex = Math.min(Math.floor((time - startTime) / bucketSize), bucketCount - 1);
            if (bucketIndex >= 0) {
                buckets[bucketIndex]++;

                const level = (sample.level || 'OTHER').toUpperCase();
                if (bucketLevels[bucketIndex][level] !== undefined) {
                    bucketLevels[bucketIndex][level]++;
                } else {
                    bucketLevels[bucketIndex]['OTHER']++;
                }
            }
        }
    }

    // 保存时间线数据
    timelineData = {
        startTime,
        endTime,
        timeRange,
        buckets,
        bucketLevels,
        bucketSize,
        bucketCount
    };

    console.log('基于采样的时间线数据生成完成，采样点数:', sampledData.samples.length);

    // 显示时间线面板
    document.getElementById('timelinePanel').style.display = 'block';

    // 更新时间信息（主信息 + 悬停附加信息占位）
    const info = document.getElementById('timelineInfo');
    info.innerHTML = `
        <span id="timelineMainInfo">
            📅 ${startTime.toLocaleString()} — ${endTime.toLocaleString()}
            <span style="margin-left: 15px;">📊 基于 ${sampledData.samples.length} 个采样点</span>
        </span>
        <span id="timelineHoverExtra" style="margin-left: 15px; font-size: 11px; color: var(--vscode-descriptionForeground);"></span>
    `;

    // 延迟绘制
    setTimeout(() => {
        drawTimeline();
    }, 100);
}

function generateTimeline() {
    console.log('📊 开始生成时间线，allLines 数量:', allLines.length);

    // 从allLines中提取时间戳
    const timestamps = [];
    const levelCounts = { ERROR: [], WARN: [], INFO: [], DEBUG: [], OTHER: [] };

    for (let line of allLines) {
        if (line.timestamp) {
            timestamps.push(new Date(line.timestamp));
        }
    }

    console.log('📊 提取到的时间戳数量:', timestamps.length);

    // 如果没有时间戳，隐藏时间线
    if (timestamps.length === 0) {
        console.log('没有找到时间戳，隐藏时间线');
        document.getElementById('timelinePanel').style.display = 'none';
        return;
    }

    // 找出时间范围
    timestamps.sort((a, b) => a - b);
    const startTime = timestamps[0];
    const endTime = timestamps[timestamps.length - 1];
    const timeRange = endTime - startTime;

    console.log('📊 时间范围:', startTime.toLocaleString(), '-', endTime.toLocaleString(), '，范围:', timeRange, 'ms');

    // 如果时间范围太小（比如都是同一秒），不显示时间线
    if (timeRange < 1000) { // 小于1秒
        console.log('时间范围太小，隐藏时间线');
        document.getElementById('timelinePanel').style.display = 'none';
        return;
    }

    // 将时间分成若干个桶（bucket）
    const bucketCount = 50; // 时间线分成50段
    const bucketSize = timeRange / bucketCount;
    const buckets = new Array(bucketCount).fill(0);
    const bucketLevels = new Array(bucketCount).fill(null).map(() => ({ ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, OTHER: 0 }));

    // 统计每个桶的日志数量和级别分布
    for (let line of allLines) {
        if (line.timestamp) {
            const time = new Date(line.timestamp);
            const bucketIndex = Math.min(Math.floor((time - startTime) / bucketSize), bucketCount - 1);
            buckets[bucketIndex]++;

            const level = (line.level || 'OTHER').toUpperCase();
            if (bucketLevels[bucketIndex][level] !== undefined) {
                bucketLevels[bucketIndex][level]++;
            } else {
                bucketLevels[bucketIndex]['OTHER']++;
            }
        }
    }

    // 保存时间线数据
    timelineData = {
        startTime,
        endTime,
        timeRange,
        buckets,
        bucketLevels,
        bucketSize,
        bucketCount
    };

    console.log('时间线数据生成完成，准备绘制');

    // 显示时间线面板
    document.getElementById('timelinePanel').style.display = 'block';

    // 更新时间信息（主信息 + 悬停附加信息占位）
    const info = document.getElementById('timelineInfo');
    info.innerHTML = `
        <span id="timelineMainInfo">
            📅 ${startTime.toLocaleString()} — ${endTime.toLocaleString()}
            <span style="margin-left: 15px;">📊 共 ${timestamps.length} 条有时间戳的日志</span>
        </span>
        <span id="timelineHoverExtra" style="margin-left: 15px; font-size: 11px; color: var(--vscode-descriptionForeground);"></span>
    `;

    // 延迟绘制，确保Canvas元素已经渲染好
    setTimeout(() => {
        drawTimeline();
    }, 100);
}

function drawTimeline() {
    if (!timelineData) {
        console.log('drawTimeline: timelineData 为空');
        return;
    }

    const canvas = document.getElementById('timelineCanvas');
    if (!canvas) {
        console.log('drawTimeline: 找不到 canvas 元素');
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.log('drawTimeline: 无法获取 2d context');
        return;
    }

    // 设置canvas实际尺寸（高分辨率）
    const rect = canvas.getBoundingClientRect();

    // 确保canvas有有效尺寸
    if (rect.width === 0 || rect.height === 0) {
        console.log('drawTimeline: canvas 尺寸为0，等待渲染...');
        // 再次延迟尝试
        setTimeout(() => drawTimeline(), 200);
        return;
    }

    console.log('🎨 开始绘制时间线，canvas 尺寸:', rect.width, 'x', rect.height);

    canvas.width = rect.width * 2;
    canvas.height = 160;
    ctx.scale(2, 2);

    const width = rect.width;
    const height = 80;

    // 清空画布
    ctx.clearRect(0, 0, width, height);

    // 找出最大值用于归一化
    const maxCount = Math.max(...timelineData.buckets, 1);

    // 计算每个柱子的宽度
    const barWidth = width / timelineData.bucketCount;

    console.log('🎨 绘制参数 - 最大值:', maxCount, '，柱宽:', barWidth);

    // 绘制柱状图
    for (let i = 0; i < timelineData.bucketCount; i++) {
        const count = timelineData.buckets[i];
        const barHeight = (count / maxCount) * (height - 10);
        const x = i * barWidth;
        const y = height - barHeight;

        // 根据级别分布决定颜色
        const levels = timelineData.bucketLevels[i];
        let color = '#888888'; // 默认灰色

        if (levels.ERROR > 0) {
            color = '#f14c4c'; // 红色 - ERROR
        } else if (levels.WARN > 0) {
            color = '#cca700'; // 橙色 - WARN
        } else if (levels.INFO > 0) {
            color = '#4fc1ff'; // 蓝色 - INFO
        } else if (levels.DEBUG > 0) {
            color = '#b267e6'; // 紫色 - DEBUG
        }

        // 绘制柱子
        ctx.fillStyle = color;
        ctx.fillRect(x, y, Math.max(barWidth - 1, 1), barHeight);
    }

    // 绘制当前浏览位置指示器
    drawTimelineIndicator(ctx, width, height);

    console.log('时间线绘制完成');
}

// 获取当前浏览位置对应的时间块索引
function getCurrentBucketIndex() {
    if (!timelineData || !timelineData.startTime || !timelineData.timeRange) {
        console.log('getCurrentBucketIndex: timelineData 不完整');
        return -1;
    }

    // 计算当前页的起始索引
    let startIndex, endIndex;
    if (isCollapseMode && pageRanges.has(currentPage)) {
        const range = pageRanges.get(currentPage);
        startIndex = range.start;
        endIndex = range.end;
    } else {
        startIndex = (currentPage - 1) * pageSize;
        endIndex = Math.min(startIndex + pageSize, allLines.length);
    }

    // 从当前页的日志中找到第一个有时间戳的行
    let currentTime = null;
    for (let i = startIndex; i < endIndex && i < allLines.length; i++) {
        if (allLines[i] && allLines[i].timestamp) {
            currentTime = new Date(allLines[i].timestamp);
            break;
        }
    }

    if (!currentTime) {
        console.log('getCurrentBucketIndex: 当前页没有时间戳');
        return -1;
    }

    // 计算当前时间在整个时间轴上的相对位置
    const timeOffset = currentTime - timelineData.startTime;
    const timeProgress = timeOffset / timelineData.timeRange;

    // 计算对应的bucket索引
    const bucketIndex = Math.floor(timeProgress * timelineData.bucketCount);

    console.log('当前位置 - 页码:', currentPage, '索引范围:', startIndex, '-', endIndex, '时间:', currentTime.toLocaleString(), '时间进度:', (timeProgress * 100).toFixed(1) + '%', '对应bucket:', bucketIndex);

    // 限制在有效范围内
    return Math.max(0, Math.min(timelineData.bucketCount - 1, bucketIndex));
}

// 绘制时间线上的当前位置指示器（高亮当前时间块）
function drawTimelineIndicator(ctx, width, height) {
    const currentBucket = getCurrentBucketIndex();
    if (currentBucket === -1 || currentBucket == null) {
        return;
    }

    console.log('高亮当前时间块:', currentBucket);

    // 计算当前bucket的位置和宽度
    const barWidth = width / timelineData.bucketCount;
    const x = currentBucket * barWidth;

    // 绘制半透明的白色高亮覆盖层
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(x, 0, barWidth, height);

    // 绘制边框强调
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 1, barWidth - 2, height - 2);

    ctx.restore();
}

// 获取当前页面显示的日志行
function getDisplayedLines() {
    // 从当前页面的 allLines 中获取有时间戳的行
    const linesWithTime = allLines.filter(line => line && line.timestamp);
    console.log('📋 当前显示的日志行（有时间戳）:', linesWithTime.length);
    return linesWithTime;
}

// 点击时间线跳转
document.getElementById('timelineCanvas').addEventListener('click', function (e) {
    if (!timelineData) return;

    const canvas = this;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickRatio = x / rect.width;

    // 计算点击位置对应的时间
    const targetTime = new Date(timelineData.startTime.getTime() + clickRatio * timelineData.timeRange);

    console.log('🕐 时间线点击 - 目标时间:', targetTime.toLocaleString());

    // 格式化时间为字符串（YYYY-MM-DD HH:mm:ss）
    const year = targetTime.getFullYear();
    const month = String(targetTime.getMonth() + 1).padStart(2, '0');
    const day = String(targetTime.getDate()).padStart(2, '0');
    const hours = String(targetTime.getHours()).padStart(2, '0');
    const minutes = String(targetTime.getMinutes()).padStart(2, '0');
    const seconds = String(targetTime.getSeconds()).padStart(2, '0');
    const timeStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    console.log('请求后端查找时间:', timeStr);
    showToast('正在查找目标时间点...');

    // 请求后端查找该时间点的日志行
    vscode.postMessage({
        command: 'jumpToTime',
        timeStr: timeStr
    });
});

// 鼠标悬停显示时间信息 + 快捷筛选入口
document.getElementById('timelineCanvas').addEventListener('mousemove', function (e) {
    if (!timelineData) return;

    const canvas = this;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hoverRatio = x / rect.width;

    // 计算悬停位置对应的时间
    const hoverTime = new Date(timelineData.startTime.getTime() + hoverRatio * timelineData.timeRange);

    // 找到对应的桶
    const bucketIndex = Math.min(Math.floor(hoverRatio * timelineData.bucketCount), timelineData.bucketCount - 1);
    const count = timelineData.buckets[bucketIndex];
    const levels = timelineData.bucketLevels[bucketIndex];

    lastHoveredBucketIndex = bucketIndex;

    // 更新标题显示详细信息
    canvas.title = `${hoverTime.toLocaleString()}\n日志数: ${count}\nERROR: ${levels.ERROR} | WARN: ${levels.WARN} | INFO: ${levels.INFO} | DEBUG: ${levels.DEBUG}`;

    // 在面板中显示当前时间段信息
    const hoverExtra = document.getElementById('timelineHoverExtra');
    if (hoverExtra) {
        const bucketStartMs = timelineData.startTime.getTime() + bucketIndex * timelineData.bucketSize;
        const bucketEndMs = bucketStartMs + timelineData.bucketSize;
        const bucketStart = new Date(bucketStartMs);
        const bucketEnd = new Date(bucketEndMs);

        hoverExtra.innerHTML = `当前: ${bucketStart.toLocaleString()} ~ ${bucketEnd.toLocaleString()} ，日志数: ${count}`;
    }
});

// 搜索框即时搜索 + 回车搜索（带防抖）
(function () {
    const input = document.getElementById('searchInput');
    if (!input) {
        return;
    }

    let instantSearchTimer = null;

    // 输入时即时搜索（防抖）
    input.addEventListener('input', function () {
        // 防抖：用户停止输入一小段时间后再触发搜索，避免频繁请求
        if (instantSearchTimer) {
            clearTimeout(instantSearchTimer);
        }

        instantSearchTimer = setTimeout(() => {
            search();
        }, userSettings.searchDebounceMs || 400); // 防抖间隔可通过设置调整
    });

    // 回车键触发搜索（保持原行为）
    input.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            search();
        }
    });
})();

// ========== JSON/XML 自动解析功能 ==========

// 判断是否应该渲染JSON
function shouldRenderJSON(parsed) {
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.keys(parsed).length > 0;
    }
    if (Array.isArray(parsed)) {
        if (parsed.length === 1 && typeof parsed[0] === 'number') {
            return false;
        }
        return parsed.length > 0 && (typeof parsed[0] === 'object' || parsed.length > 3);
    }
    return false;
}

// 从指定位置提取JSON字符串
function extractJSONAt(str, startIndex, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < str.length; i++) {
        const char = str[i];
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (char === openChar) {
            depth++;
        } else if (char === closeChar) {
            depth--;
            if (depth === 0) {
                return {
                    json: str.substring(startIndex, i + 1),
                    startIndex: startIndex,
                    endIndex: i
                };
            }
        }
    }
    return null;
}

// 提取所有JSON
function extractAllJSON(content) {
    const results = [];
    let currentIndex = 0;

    while (currentIndex < content.length) {
        const nextObjStart = content.indexOf('{', currentIndex);
        const nextArrStart = content.indexOf('[', currentIndex);

        let nextStart = -1;
        let openChar = '';
        let closeChar = '';

        if (nextObjStart !== -1 && (nextArrStart === -1 || nextObjStart < nextArrStart)) {
            nextStart = nextObjStart;
            openChar = '{';
            closeChar = '}';
        } else if (nextArrStart !== -1) {
            nextStart = nextArrStart;
            openChar = '[';
            closeChar = ']';
        }

        if (nextStart === -1) break;

        const extracted = extractJSONAt(content, nextStart, openChar, closeChar);
        if (extracted) {
            try {
                const parsed = JSON.parse(extracted.json);
                if (shouldRenderJSON(parsed)) {
                    results.push(extracted);
                    currentIndex = extracted.endIndex + 1;
                    continue;
                }
            } catch (e) { }
        }
        currentIndex = nextStart + 1;
    }
    return results;
}

// 渲染混合内容
function renderMixedContent(content, jsonObjects) {
    // 只渲染JSON部分，其他部分返回null让原来的渲染逻辑处理
    // 这样可以保持日志前缀的高亮样式
    let html = '';
    let lastIndex = 0;

    jsonObjects.forEach((item, index) => {
        // 添加JSON之前的普通文本（但不包括第一个JSON之前的）
        if (index > 0 && item.startIndex > lastIndex) {
            const text = content.substring(lastIndex, item.startIndex);
            if (text.trim()) {
                html += `<span class="json-separator">${escapeHtml(text)}</span>`;
            }
        }

        // 渲染JSON
        try {
            const parsed = JSON.parse(item.json);
            html += '<span class="json-inline">';
            html += renderJSONTree(parsed);
            html += '</span>';
        } catch (e) {
            html += `<span class="json-error">${escapeHtml(item.json)}</span>`;
        }

        lastIndex = item.endIndex + 1;
    });

    // 添加最后的普通文本
    if (lastIndex < content.length) {
        const text = content.substring(lastIndex);
        if (text.trim()) {
            html += `<span class="json-separator">${escapeHtml(text)}</span>`;
        }
    }

    return html;
}

function detectAndParseStructuredData(content) {
    // 如果功能未启用，直接返回
    if (!enableJsonParse) return null;

    if (!content || typeof content !== 'string') return null;

    // 提取所有JSON对象和数组
    const jsonObjects = extractAllJSON(content);

    if (jsonObjects.length === 0) {
        // 没有找到JSON，尝试检测XML
        const xmlMatch = content.match(/<[^>]+>[\s\S]*<\/[^>]+>/);
        if (xmlMatch) {
            try {
                const xmlStr = xmlMatch[0];
                return renderXMLTree(xmlStr);
            } catch (e) {
                // 不是有效的XML
            }
        }
        return null;
    }

    // 如果只有一个JSON对象，直接返回
    if (jsonObjects.length === 1) {
        const item = jsonObjects[0];
        try {
            const parsed = JSON.parse(item.json);
            if (shouldRenderJSON(parsed)) {
                console.log('解析单个JSON，属性数:', Object.keys(parsed).length || parsed.length);
                return renderJSONTree(parsed);
            }
        } catch (e) {
            console.warn('JSON解析失败:', e.message);
        }
        return null;
    }

    // 多个JSON对象：渲染混合内容
    console.log(`📊 检测到${jsonObjects.length}个JSON对象，使用混合模式渲染`);
    return renderMixedContent(content, jsonObjects);
}

// 使用括号匹配算法提取完整的JSON字符串
function extractJSON(str, openChar, closeChar) {
    const startIndex = str.indexOf(openChar);
    if (startIndex === -1) return null;

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < str.length; i++) {
        const char = str[i];

        // 处理转义字符
        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        // 处理字符串
        if (char === '"') {
            inString = !inString;
            continue;
        }

        // 在字符串内部，忽略括号
        if (inString) continue;

        // 只匹配目标类型的括号，忽略其他类型
        if (char === openChar) {
            depth++;
        } else if (char === closeChar) {
            depth--;
            if (depth === 0) {
                // 找到匹配的闭合括号
                const result = str.substring(startIndex, i + 1);
                console.debug(`提取JSON (${openChar}${closeChar}): 长度=${result.length}, 开头=${result.substring(0, 80)}...`);
                return result;
            }
        }
    }

    console.debug(`未找到匹配的括号 (${openChar}${closeChar})`);
    return null; // 没有找到匹配的括号
}

function renderJSONTree(obj, depth = 0, parentCollapsed = false) {
    const id = 'json_' + Math.random().toString(36).substr(2, 9);

    if (obj === null) {
        return `<span class="json-null">null</span>`;
    }

    if (typeof obj === 'string') {
        return `<span class="json-string">"${escapeHtml(obj)}"</span>`;
    }

    if (typeof obj === 'number') {
        return `<span class="json-number">${obj}</span>`;
    }

    if (typeof obj === 'boolean') {
        return `<span class="json-boolean">${obj}</span>`;
    }

    const isArray = Array.isArray(obj);
    const keys = Object.keys(obj);
    const len = keys.length;

    if (len === 0) {
        return isArray ? '<span>[]</span>' : '<span>{}</span>';
    }

    // 计算渲染后的预估行数
    const estimatedLines = estimateJSONLines(obj, depth);

    // 根据行数和深度决定是否折叠
    let defaultCollapsed = false;
    if (depth === 0) {
        // 根层级：超过20行折叠
        defaultCollapsed = estimatedLines > 20;
    } else {
        // 嵌套层级：如果父级折叠了，全部折叠；否则全部展开，不再嵌套折叠
        defaultCollapsed = parentCollapsed;
    }

    console.log(`  → 是否折叠: ${defaultCollapsed}`);

    // 只有第一层级添加 json-tree 容器和折叠控件
    const isRootLevel = depth === 0;

    let html = '';

    if (isRootLevel) {
        // 根层级：添加完整的折叠控件
        html += '<div class="json-tree">';
        html += `<span class="json-tree-toggle" onclick="toggleJSONNode('${id}')">${defaultCollapsed ? '\u25b6' : '\u25bc'}</span>`;

        // 折叠按钮（折叠时显示）
        html += `<span class="json-expand-btn" onclick="toggleJSONNode('${id}')" id="${id}_btn" style="display:${defaultCollapsed ? 'inline-block' : 'none'};cursor:pointer;">${isArray ? '[' : '{'} ${len} items, ~${estimatedLines} lines ${isArray ? ']' : '}'}</span>`;

        // 开始括号（展开时显示）
        html += `<span id="${id}_open" style="display:${defaultCollapsed ? 'none' : 'inline'}">${isArray ? '[' : '{'}</span>`;
    } else {
        // 嵌套层级：不添加任何折叠控件，直接显示
        html += `<span>${isArray ? '[' : '{'}</span>`;
    }

    // 只有根层级才使用 json-tree-item 和折叠类
    if (isRootLevel) {
        html += `<div id="${id}" class="json-tree-item${defaultCollapsed ? ' json-tree-collapsed' : ''}">`;
    } else {
        // 嵌套层级不使用折叠类，直接用普通div
        html += '<div>';
    };

    keys.forEach((key, index) => {
        const value = obj[key];
        const isLast = index === len - 1;

        html += '<div style="margin-left: 15px;">';

        if (!isArray) {
            html += `<span class="json-key">"${escapeHtml(key)}"</span>: `;
        }

        if (typeof value === 'object' && value !== null) {
            // 传递当前层级的折叠状态给子级
            html += renderJSONTree(value, depth + 1, defaultCollapsed);
        } else {
            html += renderJSONTree(value, depth + 1, defaultCollapsed);
        }

        if (!isLast) {
            html += ',';
        }

        html += '</div>';
    });

    html += '</div>';

    // 结束括号：根层级需要根据折叠状态控制显示/隐藏，嵌套层级总是显示
    if (isRootLevel) {
        // 根层级：结束括号（展开时显示，折叠时隐藏）
        html += `<span id="${id}_close" style="display:${defaultCollapsed ? 'none' : 'inline'}">${isArray ? ']' : '}'}</span>`;
    } else {
        // 嵌套层级：总是显示结束括号
        html += `<span>${isArray ? ']' : '}'}</span>`;
    }

    if (isRootLevel) {
        html += '</div>';
    }

    return html;
}

// 预估JSON对象渲染后的行数
function estimateJSONLines(obj, depth = 0) {
    if (obj === null || typeof obj !== 'object') {
        return 1; // 基本类型占用1行
    }

    const isArray = Array.isArray(obj);
    const keys = Object.keys(obj);
    const len = keys.length;

    if (len === 0) {
        return 1; // 空对象/数组占用1行
    }

    let totalLines = 0;

    keys.forEach(key => {
        const value = obj[key];

        if (typeof value === 'object' && value !== null) {
            // 递归计算嵌套对象的行数
            totalLines += estimateJSONLines(value, depth + 1);
        } else {
            // 基本类型占用1行
            totalLines += 1;
        }
    });

    // 加上开始和结束符号的行数（如果有内容）
    if (totalLines > 0) {
        totalLines += 2; // { 和 } 各占一行
    }

    return totalLines;
}

function renderXMLTree(xmlStr) {
    const id = 'xml_' + Math.random().toString(36).substr(2, 9);

    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlStr, 'text/xml');

        if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
            return null;
        }

        return renderXMLNode(xmlDoc.documentElement, 0);
    } catch (e) {
        return null;
    }
}

function renderXMLNode(node, depth = 0) {
    if (!node) return '';

    const id = 'xml_' + Math.random().toString(36).substr(2, 9);
    const tagName = node.tagName;
    const hasChildren = node.children.length > 0;
    const hasText = node.childNodes.length === 1 && node.childNodes[0].nodeType === 3;

    // 默认折叠深度>1的节点
    const defaultCollapsed = depth > 1;

    let html = '<div class="xml-tree">';

    if (hasChildren) {
        html += `<span class="xml-tree-toggle" onclick="toggleXMLNode('${id}')">${defaultCollapsed ? '▶' : '▼'}</span>`;
    } else {
        html += '<span style="display:inline-block;width:14px;"></span>';
    }

    // 开始标签
    html += '<span class="xml-tag">&lt;' + escapeHtml(tagName);

    // 属性
    if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i++) {
            const attr = node.attributes[i];
            html += ' <span class="xml-attr-name">' + escapeHtml(attr.name) + '</span>=';
            html += '<span class="xml-attr-value">"' + escapeHtml(attr.value) + '"</span>';
        }
    }

    if (!hasChildren && !hasText) {
        html += '/&gt;</span>';
    } else {
        html += '&gt;</span>';

        if (hasText) {
            html += escapeHtml(node.textContent.trim());
        } else if (hasChildren) {
            html += `<div id="${id}" class="xml-tree-item${defaultCollapsed ? ' xml-tree-collapsed' : ''}">`;

            for (let i = 0; i < node.children.length; i++) {
                html += renderXMLNode(node.children[i], depth + 1);
            }

            html += '</div>';
        }

        html += '<span class="xml-tag">&lt;/' + escapeHtml(tagName) + '&gt;</span>';
    }

    html += '</div>';

    return html;
}

function toggleJSONNode(id) {
    const contentNode = document.getElementById(id);
    if (!contentNode) return;

    // 根层级才有 json-tree 容器
    const container = contentNode.closest('.json-tree');
    if (!container) {
        console.warn('未找到 json-tree 容器，这个节点可能不支持折叠');
        return;
    }

    const btn = document.getElementById(id + '_btn');
    const openBracket = document.getElementById(id + '_open');
    const closeBracket = document.getElementById(id + '_close');
    const toggle = container.querySelector('.json-tree-toggle');

    if (contentNode.classList.contains('json-tree-collapsed')) {
        // 展开：隐藏按钮，显示大括号和内容
        contentNode.classList.remove('json-tree-collapsed');
        if (toggle) toggle.textContent = '▼';
        if (btn) btn.style.display = 'none';
        if (openBracket) openBracket.style.display = 'inline';
        if (closeBracket) closeBracket.style.display = 'inline';
    } else {
        // 折叠：显示按钮，隐藏大括号和内容
        contentNode.classList.add('json-tree-collapsed');
        if (toggle) toggle.textContent = '▶';
        if (btn) btn.style.display = 'inline-block';
        if (openBracket) openBracket.style.display = 'none';
        if (closeBracket) closeBracket.style.display = 'none';
    }
}

function toggleXMLNode(id) {
    const node = document.getElementById(id);
    const toggle = node.previousElementSibling.previousElementSibling;

    if (node.classList.contains('xml-tree-collapsed')) {
        node.classList.remove('xml-tree-collapsed');
        toggle.textContent = '▼';
    } else {
        node.classList.add('xml-tree-collapsed');
        toggle.textContent = '▶';
    }
}

// 切换JSON/XML解析功能
function toggleJsonParse() {
    enableJsonParse = document.getElementById('enableJsonParse').checked;
    console.log('JSON/XML解析功能:', enableJsonParse ? '已启用' : '已禁用');
    // 重新渲染当前页面
    renderLines();
}

// ========== 自定义高亮规则管理 ==========

function showCustomHighlightModal() {
    renderHighlightRulesList();
    document.getElementById('customHighlightModal').style.display = 'block';
}

function closeCustomHighlightModal() {
    document.getElementById('customHighlightModal').style.display = 'none';
}

function showAddRuleDialog() {
    editingRuleIndex = -1;
    document.getElementById('ruleModalTitle').textContent = '➕ 添加高亮规则';
    document.getElementById('ruleName').value = '';
    document.getElementById('ruleType').value = 'text';
    document.getElementById('rulePattern').value = '';
    document.getElementById('ruleBgColor').value = '#10b981';
    document.getElementById('ruleTextColor').value = '#ffffff';
    document.getElementById('ruleEnabled').checked = true;
    updateColorPreview();
    document.getElementById('addRuleModal').style.display = 'block';
}

function closeAddRuleModal() {
    document.getElementById('addRuleModal').style.display = 'none';
}

function saveHighlightRule() {
    const name = document.getElementById('ruleName').value.trim();
    const type = document.getElementById('ruleType').value;
    const pattern = document.getElementById('rulePattern').value.trim();
    const bgColor = document.getElementById('ruleBgColor').value;
    const textColor = document.getElementById('ruleTextColor').value;
    const enabled = document.getElementById('ruleEnabled').checked;

    if (!name) {
        showToast('请输入规则名称');
        document.getElementById('ruleName').focus();
        return;
    }

    if (!pattern) {
        showToast('请输入匹配内容');
        document.getElementById('rulePattern').focus();
        return;
    }

    // 验证正则表达式
    if (type === 'regex') {
        try {
            new RegExp(pattern);
        } catch (e) {
            showToast('正则表达式格式错误：' + e.message);
            document.getElementById('rulePattern').focus();
            return;
        }
    }

    const rule = {
        id: editingRuleIndex >= 0 ? customHighlightRules[editingRuleIndex].id : Date.now(),
        name,
        type,
        pattern,
        bgColor,
        textColor,
        enabled,
        builtin: false
    };

    if (editingRuleIndex >= 0) {
        // 更新现有规则
        customHighlightRules[editingRuleIndex] = rule;
    } else {
        // 添加新规则
        customHighlightRules.push(rule);
    }

    saveCustomRulesToStorage();
    closeAddRuleModal();
    renderHighlightRulesList();
    renderLines(); // 重新渲染日志以应用新规则
    showToast('规则已保存');
}

// ========== 设置面板 ==========
function showSettingsModal() {
    console.log('🔧 showSettingsModal 被调用');
    
    // 如果扩展侧尚未发送配置，可主动请求一次
    try {
        vscode.postMessage({ command: 'getSettings' });
    } catch (e) {
        console.error('发送 getSettings 消息失败:', e);
    }

    // 将当前配置填入输入框（容错，避免元素不存在时报错）
    const debounceInput = document.getElementById('settingSearchDebounce');
    if (debounceInput) {
        debounceInput.value = userSettings.searchDebounceMs;
    }

    const collapseInput = document.getElementById('settingCollapseMinRepeat');
    if (collapseInput) {
        collapseInput.value = userSettings.collapseMinRepeatCount;
    }

    const timelineInput = document.getElementById('settingTimelineSample');
    if (timelineInput) {
        timelineInput.value = userSettings.timelineSamplePoints;
    }

    const modal = document.getElementById('settingsModal');
    console.log('📦 settingsModal 元素:', modal);
    if (modal) {
        console.log('正在显示设置面板...');
        modal.style.display = 'block';
        console.log('设置面板 display 已设置为 block');
    } else {
        console.error('未找到 id 为 settingsModal 的元素');
    }
}

function closeSettingsModal() {
    document.getElementById('settingsModal').style.display = 'none';
}

function saveSettings() {
    const searchDebounce = parseInt(document.getElementById('settingSearchDebounce').value, 10);
    const collapseMinRepeat = parseInt(document.getElementById('settingCollapseMinRepeat').value, 10);
    const timelineSample = parseInt(document.getElementById('settingTimelineSample').value, 10);

    if (isNaN(searchDebounce) || searchDebounce < 0) {
        showToast('搜索防抖时间必须是大于等于 0 的数字');
        return;
    }
    if (isNaN(collapseMinRepeat) || collapseMinRepeat < 1) {
        showToast('折叠最小重复次数必须是大于等于 1 的整数');
        return;
    }
    if (isNaN(timelineSample) || timelineSample < 20 || timelineSample > 1000) {
        showToast('时间线采样点数需在 20 ~ 1000 之间');
        return;
    }

    const newSettings = {
        searchDebounceMs: searchDebounce,
        collapseMinRepeatCount: collapseMinRepeat,
        timelineSamplePoints: timelineSample
    };

    // 先更新前端内存中的配置，立即生效
    userSettings = { ...userSettings, ...newSettings };

    vscode.postMessage({
        command: 'updateSettings',
        data: newSettings
    });

    closeSettingsModal();
}

function editHighlightRule(index) {
    editingRuleIndex = index;
    const rule = customHighlightRules[index];

    document.getElementById('ruleModalTitle').textContent = '编辑高亮规则';
    document.getElementById('ruleName').value = rule.name;
    document.getElementById('ruleType').value = rule.type;
    document.getElementById('rulePattern').value = rule.pattern;
    document.getElementById('ruleBgColor').value = rule.bgColor;
    document.getElementById('ruleTextColor').value = rule.textColor;
    document.getElementById('ruleEnabled').checked = rule.enabled;
    updateColorPreview();
    document.getElementById('addRuleModal').style.display = 'block';
}

function toggleHighlightRule(index) {
    customHighlightRules[index].enabled = !customHighlightRules[index].enabled;
    saveCustomRulesToStorage();
    renderHighlightRulesList();
    renderLines(); // 重新渲染日志
}

function deleteHighlightRule(index) {
    console.log('删除规则被调用, index:', index);
    console.log('当前规则数量:', customHighlightRules.length);

    if (index < 0 || index >= customHighlightRules.length) {
        console.error('无效的索引:', index);
        showToast('规则索引错误');
        return;
    }

    const rule = customHighlightRules[index];
    console.log('要删除的规则:', rule);

    if (rule.builtin) {
        showToast('内置规则不能删除，但可以禁用');
        return;
    }

    // 使用自定义确认对话框
    showCustomConfirm(`确定要删除规则 "${rule.name}" 吗？`, '删除规则').then(confirmed => {
        if (confirmed) {
            console.log('用户确认删除');
            customHighlightRules.splice(index, 1);
            console.log('删除后规则数量:', customHighlightRules.length);
            saveCustomRulesToStorage();
            renderHighlightRulesList();
            renderLines(); // 重新渲染日志
            showToast('规则已删除');
        } else {
            console.log('用户取消删除');
        }
    });
}

function resetToDefault() {
    // 使用自定义确认对话框
    showCustomConfirm('确定要重置所有规则到默认状态吗？这将删除所有自定义规则！', '重置规则').then(confirmed => {
        if (confirmed) {
            // 只保留内置规则
            customHighlightRules = customHighlightRules.filter(r => r.builtin);
            // 启用所有内置规则
            customHighlightRules.forEach(r => r.enabled = true);
            localStorage.removeItem('customHighlightRules');
            renderHighlightRulesList();
            renderLines();
            showToast('已重置到默认规则');
        }
    });
}

function renderHighlightRulesList() {
    const container = document.getElementById('highlightRulesList');

    if (customHighlightRules.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--vscode-descriptionForeground);">暂无规则</div>';
        return;
    }

    // 清空容器
    container.innerHTML = '';

    customHighlightRules.forEach((rule, index) => {
        const typeLabel = rule.type === 'text' ? '文本' : '正则';
        const currentIndex = index; // 保存当前索引，避免闭包问题

        // 创建规则项
        const ruleItem = document.createElement('div');
        ruleItem.className = 'rule-item';
        ruleItem.style.borderLeftColor = rule.bgColor;
        ruleItem.setAttribute('data-index', currentIndex); // 添加数据属性

        // 复选框
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = rule.enabled;
        checkbox.style.cursor = 'pointer';
        checkbox.addEventListener('change', function () {
            toggleHighlightRule(currentIndex);
        });

        // 内容区域
        const contentDiv = document.createElement('div');
        contentDiv.style.flex = '1';

        // 规则名称行
        const nameDiv = document.createElement('div');
        nameDiv.style.fontWeight = 'bold';
        nameDiv.style.marginBottom = '5px';
        nameDiv.textContent = rule.name + ' ';

        if (rule.builtin) {
            const builtinTag = document.createElement('span');
            builtinTag.style.cssText = 'background-color: #6366f1; color: white; font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: 5px;';
            builtinTag.textContent = '内置';
            nameDiv.appendChild(builtinTag);
        }

        const typeTag = document.createElement('span');
        typeTag.style.cssText = 'background-color: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: 5px;';
        typeTag.textContent = typeLabel;
        nameDiv.appendChild(typeTag);

        // 匹配内容行
        const patternDiv = document.createElement('div');
        patternDiv.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground); font-family: "Consolas", monospace;';
        patternDiv.textContent = rule.pattern;

        // 示例效果
        const exampleDiv = document.createElement('div');
        exampleDiv.style.marginTop = '5px';
        const exampleSpan = document.createElement('span');
        exampleSpan.className = 'custom-highlight';
        exampleSpan.style.cssText = `background-color: ${rule.bgColor}; color: ${rule.textColor}; font-size: 11px;`;
        exampleSpan.textContent = '示例效果';
        exampleDiv.appendChild(exampleSpan);

        contentDiv.appendChild(nameDiv);
        contentDiv.appendChild(patternDiv);
        contentDiv.appendChild(exampleDiv);

        // 按钮区域
        const buttonsDiv = document.createElement('div');
        buttonsDiv.style.display = 'flex';
        buttonsDiv.style.gap = '5px';

        if (!rule.builtin) {
            // 编辑按钮
            const editBtn = document.createElement('button');
            editBtn.textContent = '编辑';
            editBtn.style.cssText = 'padding: 5px 10px; font-size: 11px;';
            editBtn.addEventListener('click', function () {
                console.log('编辑按钮被点击, index:', currentIndex);
                editHighlightRule(currentIndex);
            });

            // 删除按钮
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '删除';
            deleteBtn.style.cssText = 'padding: 5px 10px; font-size: 11px;';
            deleteBtn.addEventListener('click', function (e) {
                console.log('🔴 删除按钮被点击, index:', currentIndex);
                e.stopPropagation(); // 阻止事件冒泡
                deleteHighlightRule(currentIndex);
            });

            buttonsDiv.appendChild(editBtn);
            buttonsDiv.appendChild(deleteBtn);
        }

        ruleItem.appendChild(checkbox);
        ruleItem.appendChild(contentDiv);
        ruleItem.appendChild(buttonsDiv);

        container.appendChild(ruleItem);
    });

    // 重置按钮
    const resetDiv = document.createElement('div');
    resetDiv.style.cssText = 'margin-top: 20px; text-align: center;';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '🔄 重置为默认规则';
    resetBtn.addEventListener('click', resetToDefault);
    resetDiv.appendChild(resetBtn);

    container.appendChild(resetDiv);
}

function updateColorPreview() {
    const bgColor = document.getElementById('ruleBgColor').value;
    const textColor = document.getElementById('ruleTextColor').value;
    const preview = document.getElementById('colorPreview');
    if (preview) {
        preview.style.backgroundColor = bgColor;
        preview.style.color = textColor;
    }
}

// ========== 结束自定义高亮规则管理 ==========

// 键盘快捷键支持
document.addEventListener('keydown', function (e) {
    // 不在输入框中时才响应
    if (e.target.tagName === 'INPUT') return;

    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPrevPage();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goToNextPage();
    } else if (e.key === 'Home') {
        e.preventDefault();
        goToFirstPage();
    } else if (e.key === 'End') {
        e.preventDefault();
        goToLastPage();
    }
});

// 监听日志容器的滚动事件，更新时间线指示器
let scrollUpdateTimer = null;
const logContainer = document.getElementById('logContainer');
if (logContainer) {
    logContainer.addEventListener('scroll', function () {
        // 使用防抖，避免频繁重绘
        if (scrollUpdateTimer) {
            clearTimeout(scrollUpdateTimer);
        }
        scrollUpdateTimer = setTimeout(() => {
            // 只有在时间线面板可见时才更新
            const timelinePanel = document.getElementById('timelinePanel');
            if (timelinePanel && timelinePanel.style.display !== 'none') {
                drawTimeline();
            }
        }, 100); // 100ms 防抖
    });
}

