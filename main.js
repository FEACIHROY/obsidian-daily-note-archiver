const { Plugin, PluginSettingTab, Setting, Notice, ItemView, Modal, moment } = require('obsidian');

// ============================================================
// 常量
// ============================================================
const SIDEBAR_VIEW_TYPE = "daily-note-archiver-sidebar";

// ============================================================
// 默认配置
// ============================================================
const DEFAULT_SETTINGS = {
    // —— 日记归档 ——
    dailyPath:     "日记/每日",
    historyPath:   "日记/每日/历史记录",
    keepCount:     7,
    dateFormat:    "YYYY-MM-DD",
    noteTitle:     "# {{date}}",
    noteTemplate:  "\n## 📝 今日任务\n- [ ] \n\n## 💭 笔记\n\n## 📅 回顾\n",
    autoCreate:    true,
    autoArchive:   true,
    // —— 侧边栏 ——
    workEndTime:   "18:00",
    todoFolder:    "",
    autoCarryTasks: true,
    showClock:     true,
    showCalendar:  true,
    showTodos:     true,
};

// ============================================================
// 插件主体
// ============================================================
module.exports = class DailyNoteArchiverPlugin extends Plugin {

    // ---------------------------------------------------------
    // 生命周期
    // ---------------------------------------------------------
    async onload() {
        try {
            await this.loadSettings();

            // 注册侧边栏视图
            this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new DailyNoteSidebarView(leaf, this));

            // 添加侧边栏切换图标
            this.addRibbonIcon("calendar", "每日笔记", () => {
                this.toggleSidebar();
            });

            // 注册设置面板
            this.addSettingTab(new ArchiverSettingTab(this.app, this));

            // 激活侧边栏
            this.app.workspace.onLayoutReady(() => {
                this.initSidebar();
                this.runDailyTasks();
            });

            console.log("✅ [每日笔记归档器] 插件加载完成");
        } catch (error) {
            console.error("❌ [每日笔记归档器] 插件加载失败:", error);
            new Notice("❌ 每日笔记归档器加载失败: " + error.message);
        }
    }

    async onunload() {
        // 清理侧边栏
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
        console.log("🔄 [每日笔记归档器] 插件已卸载");
    }

    // ---------------------------------------------------------
    // 侧边栏管理
    // ---------------------------------------------------------
    async initSidebar() {
        const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
        if (leaves.length === 0) {
            const leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
            }
        }
    }

    async toggleSidebar() {
        const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
        if (leaves.length > 0) {
            this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
        } else {
            const leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
            }
        }
    }

    // ---------------------------------------------------------
    // 配置持久化
    // ---------------------------------------------------------
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // 实时刷新侧边栏（设置变更立即生效）
        this.refreshSidebar();
    }

    refreshSidebar() {
        const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
        for (const leaf of leaves) {
            if (leaf.view instanceof DailyNoteSidebarView) {
                leaf.view.render();
            }
        }
    }

    // ---------------------------------------------------------
    // 每日任务
    // ---------------------------------------------------------
    async runDailyTasks() {
        if (this.settings.autoCreate) await this.ensureDailyNote();
        if (this.settings.autoArchive) await this.archiveOldNotes();
    }

    // ---------------------------------------------------------
    // 创建今日日记
    // ---------------------------------------------------------
    async ensureDailyNote() {
        try {
            const today    = moment().format(this.settings.dateFormat);
            const fileName = `${today}.md`;
            const dirPath  = this.settings.dailyPath;
            const filePath = `${dirPath}/${fileName}`;

            if (this.app.vault.getAbstractFileByPath(filePath)) {
                console.log(`✅ [每日笔记归档器] 今日日记已存在：${fileName}`);
                return;
            }

            if (!this.app.vault.getAbstractFileByPath(dirPath)) {
                await this.app.vault.createFolder(dirPath);
            }

            const titleLine = this.settings.noteTitle.replace(/\{\{date\}\}/g, today);
            let body = this.settings.noteTemplate.replace(/\{\{date\}\}/g, today);

            // 自动附带之前未完成的任务
            if (this.settings.autoCarryTasks) {
                const carried = await this.collectUnfinishedTasks(dirPath);
                if (carried.length > 0) {
                    body += "\n" + "## 🔄 未完成任务" + "\n" + carried.join("\n") + "\n";
                }
            }

            await this.app.vault.create(filePath, titleLine + "\n" + body);

            console.log(`📄 [每日笔记归档器] 已创建：${fileName}`);
            if (this.settings.autoCarryTasks) {
                new Notice(`📝 已创建今日日记，并附带之前未完成的任务`);
            } else {
                new Notice(`📝 已创建今日日记：${fileName}`);
            }
        } catch (error) {
            console.error("❌ [每日笔记归档器] 创建日记失败：", error);
        }
    }

    // ---------------------------------------------------------
    // 收集之前未完成的任务（排除已取消 [-] 的）
    // ---------------------------------------------------------
    async collectUnfinishedTasks(dailyPath) {
        const tasks = [];
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(dailyPath + "/") && f.extension === "md")
            .sort((a, b) => b.name.localeCompare(a.name)); // 最新的在前

        // 跳过今日文件
        const todayFileName = moment().format(this.settings.dateFormat) + ".md";
        for (const file of files) {
            if (file.name === todayFileName) continue;
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split("\n");
            for (const line of lines) {
                // 匹配 - [ ] 未完成且不是已取消 [-]
                const match = line.match(/^\s*[-*]\s+\[\s\]\s+(.+)$/);
                if (match) {
                    const text = match[1].trim();
                    // 跳过已取消（带 ~~text~~ 标记）和纯空
                    if (!text || text.startsWith("~~")) continue;
                    tasks.push("- [ ] " + text);
                }
            }
        }
        // 去重
        return [...new Set(tasks)];
    }

    // ---------------------------------------------------------
    // 归档旧日记
    // ---------------------------------------------------------
    async archiveOldNotes() {
        const { dailyPath, historyPath, keepCount } = this.settings;
        try {
            if (!this.app.vault.getAbstractFileByPath(dailyPath)) return;

            const allFiles = this.app.vault.getMarkdownFiles();
            const dailyFiles = allFiles.filter(f =>
                f.path.startsWith(dailyPath + "/") &&
                !f.path.startsWith(historyPath + "/")
            );

            if (dailyFiles.length <= keepCount) return;

            dailyFiles.sort((a, b) => b.name.localeCompare(a.name));
            const toArchive = dailyFiles.slice(keepCount);

            if (!this.app.vault.getAbstractFileByPath(historyPath)) {
                await this.app.vault.createFolder(historyPath);
            }

            let moved = 0;
            for (const file of toArchive) {
                const newPath = `${historyPath}/${file.name}`;
                if (this.app.vault.getAbstractFileByPath(newPath)) continue;
                await this.app.vault.rename(file, newPath);
                moved++;
            }

            if (moved > 0) new Notice(`📋 ${moved} 个旧文件已移至历史记录`);
        } catch (error) {
            console.error("❌ [每日笔记归档器] 归档错误：", error);
            new Notice("❌ 归档失败，详见控制台");
        }
    }

    async runNow() {
        await this.ensureDailyNote();
        await this.archiveOldNotes();
    }
};

// ============================================================
// 侧边栏视图
// ============================================================
class DailyNoteSidebarView extends ItemView {

    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.clockInterval = null;
        this.calendarDate = moment();   // 当前日历月份
    }

    getViewType()    { return SIDEBAR_VIEW_TYPE; }
    getDisplayText() { return "每日笔记"; }
    getIcon()        { return "calendar"; }

    async onOpen() {
        this.render();
        // 每秒更新时钟
        this.clockInterval = setInterval(() => this.updateClock(), 1000);
        // 文件变更时刷新待办（带防重入标记）
        this.registerEvent(
            this.app.vault.on("modify", () => this.scheduleRefreshTodos())
        );
        this.registerEvent(
            this.app.vault.on("create", () => this.scheduleRefreshTodos())
        );
        this.registerEvent(
            this.app.vault.on("delete", () => this.scheduleRefreshTodos())
        );
    }

    async onClose() {
        if (this.clockInterval) {
            clearInterval(this.clockInterval);
            this.clockInterval = null;
        }
    }

    // ---------------------------------------------------------
    // 主渲染入口
    // ---------------------------------------------------------
    render() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.classList.add("daily-note-sidebar");

        this.renderClockSection(containerEl);
        this.renderCalendarSection(containerEl);
        this.renderTodoSection(containerEl);
    }

    // =====================================================
    // 时钟 & 倒计时
    // =====================================================
    renderClockSection(parent) {
        if (!this.plugin.settings.showClock) return;

        const section = parent.createDiv({ cls: "dns-section dns-clock-section" });
        this.clockSection = section;
        this.clockEl = section.createDiv({ cls: "dns-clock" });
        this.countdownEl = section.createDiv({ cls: "dns-countdown" });
        // 点击倒计时文字切换显示/隐藏
        this.countdownEl.style.cursor = "pointer";
        this.countdownEl.title = "点击切换倒计时显示";
        this._countdownHidden = false;
        this.countdownEl.onclick = () => {
            this._countdownHidden = !this._countdownHidden;
            if (this._countdownHidden) {
                this.countdownEl.textContent = "⏰ 点击显示";
                this.countdownEl.style.opacity = "0.5";
            } else {
                this.countdownEl.style.opacity = "1";
                this.updateClock();
            }
        };
        this.updateClock();
    }

    updateClock() {
        if (!this.clockEl) return;

        const now = moment();
        this.clockEl.textContent = now.format("HH:mm:ss");

        // 倒计时（隐藏状态时不更新时间文字）
        if (this._countdownHidden) return;
        const endTime = this.plugin.settings.workEndTime; // "18:00"
        const end = moment(endTime, "HH:mm");
        let diff = end.diff(now);

        if (diff <= 0) {
            // 已过下班时间 → 显示明天下班倒计时
            end.add(1, "day");
            diff = end.diff(now);
            this.countdownEl.textContent = `⏰ 已下班 · 明天下班还剩 ${this.formatDuration(diff)}`;
        } else {
            this.countdownEl.textContent = `⏰ 下班还剩 ${this.formatDuration(diff)}`;
        }
    }

    formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    // =====================================================
    // 日历
    // =====================================================
    renderCalendarSection(parent) {
        if (!this.plugin.settings.showCalendar) return;

        const section = parent.createDiv({ cls: "dns-section" });
        section.createEl("div", { cls: "dns-section-title", text: "📅 日历" });

        // 导航栏
        const nav = section.createDiv({ cls: "dns-cal-nav" });
        nav.createEl("button", { cls: "dns-cal-btn", text: "◀" })
            .onclick = () => { this.calendarDate.subtract(1, "month"); this.renderCalendarGrid(gridContainer); };
        this.calTitleEl = nav.createEl("span", { cls: "dns-cal-title" });
        nav.createEl("button", { cls: "dns-cal-btn", text: "▶" })
            .onclick = () => { this.calendarDate.add(1, "month"); this.renderCalendarGrid(gridContainer); };
        // 回到今天
        nav.createEl("button", { cls: "dns-cal-today-btn", text: "今天" })
            .onclick = () => { this.calendarDate = moment(); this.renderCalendarGrid(gridContainer); };

        // 日历网格容器
        const gridContainer = section.createDiv({ cls: "dns-cal-grid" });
        this.renderCalendarGrid(gridContainer);
    }

    renderCalendarGrid(container) {
        if (!this.calTitleEl) return;
        container.empty();

        const date = this.calendarDate;
        this.calTitleEl.textContent = date.format("YYYY年 M月");

        const year = date.year();
        const month = date.month(); // 0-based
        const today = moment().format("YYYY-MM-DD");

        // 获取该月所有有日记的日期（含历史记录）
        const dailyPath = this.plugin.settings.dailyPath;
        const historyPath = this.plugin.settings.historyPath;
        const dateFormat = this.plugin.settings.dateFormat;
        const existingDates = new Set();
        const scanFolder = (folder) => {
            if (this.app.vault.getAbstractFileByPath(folder)) {
                const files = this.app.vault.getMarkdownFiles()
                    .filter(f => f.path.startsWith(folder + "/") && f.extension === "md");
                for (const f of files) {
                    existingDates.add(f.name.replace(/\.md$/, ""));
                }
            }
        };
        scanFolder(dailyPath);
        scanFolder(historyPath);

        // 星期标题
        const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
        const headerRow = container.createEl("div", { cls: "dns-cal-row dns-cal-header" });
        for (const d of dayNames) {
            headerRow.createEl("span", { cls: "dns-cal-cell dns-cal-dayname", text: d });
        }

        // 第一天是星期几
        const firstDay = moment([year, month, 1]).day();
        const daysInMonth = moment([year, month]).daysInMonth();

        // 空白填充
        let row = container.createEl("div", { cls: "dns-cal-row" });
        for (let i = 0; i < firstDay; i++) {
            row.createEl("span", { cls: "dns-cal-cell dns-cal-empty" });
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = moment([year, month, d]).format(dateFormat);
            const dateKey = moment([year, month, d]).format("YYYY-MM-DD");

            const cell = row.createEl("span", {
                cls: "dns-cal-cell dns-cal-day" +
                     (dateKey === today ? " dns-cal-today" : "") +
                     (existingDates.has(dateStr) ? " dns-cal-has-note" : "")
            });
            cell.textContent = String(d);

            // 点击打开（如果有日记）
            cell.onclick = () => this.openDailyNote(dateStr);

            // 换行
            const col = (firstDay + d) % 7;
            if (col === 0 && d < daysInMonth) {
                row = container.createEl("div", { cls: "dns-cal-row" });
            }
        }

        // 补齐最后一行剩余的空格（避免 flex 拉伸歪掉）
        const totalCells = firstDay + daysInMonth;
        const remainder = totalCells % 7;
        if (remainder !== 0) {
            for (let i = remainder; i < 7; i++) {
                row.createEl("span", { cls: "dns-cal-cell dns-cal-empty" });
            }
        }
    }

    async openDailyNote(dateStr) {
        const dailyPath   = this.plugin.settings.dailyPath;
        const historyPath = this.plugin.settings.historyPath;
        let file = this.app.vault.getAbstractFileByPath(`${dailyPath}/${dateStr}.md`);
        if (!file) {
            file = this.app.vault.getAbstractFileByPath(`${historyPath}/${dateStr}.md`);
        }
        if (file) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
        }
    }

    // =====================================================
    // 待办列表
    // =====================================================
    renderTodoSection(parent) {
        if (!this.plugin.settings.showTodos) return;

        const section = parent.createDiv({ cls: "dns-section" });
        const header = section.createDiv({ cls: "dns-section-title" });

        // 标题 + 刷新按钮
        const titleSpan = header.createEl("span", { text: "📋 未完成任务" });
        const refreshBtn = header.createEl("button", { cls: "dns-refresh-btn", text: "↻" });
        refreshBtn.onclick = () => this.refreshTodos();

        this.todoListEl = section.createDiv({ cls: "dns-todo-list" });
        this.refreshTodos();
    }

    async refreshTodos() {
        if (!this.todoListEl || this._refreshing) return;
        this._refreshing = true;
        this.todoListEl.empty();

        const folder = this.plugin.settings.todoFolder;
        if (!folder) {
            this.todoListEl.createEl("div", {
                cls: "dns-todo-empty",
                text: "请在设置中配置待办扫描文件夹"
            });
            return;
        }

        // 检查文件夹是否存在
        if (!this.app.vault.getAbstractFileByPath(folder)) {
            this.todoListEl.createEl("div", {
                cls: "dns-todo-empty",
                text: `文件夹 "${folder}" 不存在`
            });
            return;
        }

        // 扫描文件夹内所有 .md 文件
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(folder + "/") && f.extension === "md");

        // 按文件名降序（最新的在前），用于去重时保留最新版本
        files.sort((a, b) => b.name.localeCompare(a.name));

        // 解析所有未完成任务（按任务文本去重，保留最新文件中的那个）
        const todos = [];
        const seenTasks = new Set();
        for (const file of files) {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // 匹配 - [ ] 未完成 或 - [x] 已完成
                const match = line.match(/^(\s*)[-*]\s+\[([ x])\]\s+(.+)$/);
                if (match) {
                    let taskText = match[3];
                    const isChecked = match[2] === "x";
                    // 跳过已取消的（带 ~~text~~）
                    if (taskText.trim().startsWith("~~")) continue;
                    // 提取末尾的完成时间： ✅ YYYY-MM-DD HH:mm
                    const doneMatch = taskText.match(/✅\s*(\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2})\s*$/);
                    if (doneMatch) {
                        taskText = taskText.slice(0, -doneMatch[0].length).trim();
                    }

                    // 提取末尾的 DDL： 📅 YYYY-MM-DD
                    let ddl = null;
                    const ddlMatch = taskText.match(/📅\s*(\d{4}-\d{2}-\d{2})\s*$/);
                    if (ddlMatch) {
                        ddl = ddlMatch[1];
                        taskText = taskText.slice(0, -ddlMatch[0].length).trim();
                    }
                    // 去重：已完成的任务也加入 seenTasks，防止旧笔记中同任务冒出
                    const dedupKey = taskText.trim().toLowerCase();
                    if (seenTasks.has(dedupKey)) continue;
                    seenTasks.add(dedupKey);

                    // 已完成的不展示
                    if (isChecked) continue;

                    todos.push({
                        file: file,
                        line: i,
                        indent: match[1],
                        marker: line.startsWith(" ") ? "*" : "-",
                        raw: line,
                        text: taskText,
                        ddl: ddl,
                    });
                }
            }
        }

        if (todos.length === 0) {
            this.todoListEl.createEl("div", {
                cls: "dns-todo-empty",
                text: "🎉 没有未完成的任务"
            });
            this._refreshing = false;
            return;
        }

        // 标题显示数量
        const parentSection = this.todoListEl.parentElement;
        const titleEl = parentSection?.querySelector(".dns-section-title span");
        if (titleEl) titleEl.textContent = `📋 未完成任务 (${todos.length})`;

        // 渲染每个待办
        for (const todo of todos) {
            const item = this.todoListEl.createDiv({ cls: "dns-todo-item" });

            // 勾选框
            const checkbox = item.createEl("input", { cls: "dns-todo-checkbox", type: "checkbox" });
            checkbox.onclick = (e) => {
                e.stopPropagation();
                this.toggleTodo(todo);
            };

            // 任务文本（点开跳转到对应笔记）
            const textEl = item.createEl("span", { cls: "dns-todo-text", text: todo.text });
            textEl.onclick = () => this.openFileAtLine(todo.file, todo.line);

            // DDL 显示 + 日历按钮 + 取消标记
            const ddlRow = item.createDiv({ cls: "dns-todo-ddl-row" });

            const ddlEl = ddlRow.createEl("span", {
                cls: "dns-todo-ddl" + (todo.ddl ? "" : " dns-todo-ddl-empty"),
                text: todo.ddl ? `📅 ${todo.ddl}` : "设置截止日"
            });
            ddlEl.onclick = () => this.pickDateForTodo(todo);

            // 取消标记按钮
            const cancelEl = ddlRow.createEl("span", { cls: "dns-todo-cancel", text: "⊘ 取消" });
            cancelEl.onclick = () => this.cancelTodo(todo);

            // 时间轴按钮
            const timelineEl = ddlRow.createEl("span", { cls: "dns-todo-timeline", text: "📊 时间轴" });
            timelineEl.onclick = () => this.showTodoTimeline(todo);

            // 来源文件名
            const sourceEl = item.createEl("div", { cls: "dns-todo-source", text: `📎 ${todo.file.path}` });
            sourceEl.onclick = () => this.openFileAtLine(todo.file, todo.line);
        }

        this._refreshing = false;
    }

    scheduleRefreshTodos() {
        // 防重入 + 防并发：已有刷新在进行则跳过
        if (this._refreshing || !this.todoListEl) return;
        this.refreshTodos();
    }

    async toggleTodo(todo) {
        try {
            const content = await this.app.vault.read(todo.file);
            const lines = content.split("\n");
            const lineStr = lines[todo.line];
            if (!lineStr) return;

            let newLine;
            if (/\[\s\]/.test(lineStr)) {
                // 未完成 → 已完成，标注完成时间
                const now = moment().format("YYYY-MM-DD HH:mm");
                // 去掉旧的完成标记（如果有）再追加新的
                let base = lineStr.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}/, "");
                newLine = base.replace(/\[\s\]/, "[x]") + ` ✅ ${now}`;
            } else if (/\[x\]/.test(lineStr)) {
                // 已完成 → 未完成，去掉完成标记
                newLine = lineStr.replace(/\[x\]/, "[ ]").replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}/, "");
            } else {
                return;
            }

            lines[todo.line] = newLine;
            // modify 会自动触发 vault.on("modify") 事件 → 刷新列表
            await this.app.vault.modify(todo.file, lines.join("\n"));
        } catch (error) {
            console.error("❌ 切换待办失败：", error);
            new Notice("❌ 切换待办失败");
        }
    }

    async pickDateForTodo(todo) {
        // 创建临时的 date input 让用户选择
        const input = document.createElement("input");
        input.type = "date";
        input.style.position = "fixed";
        input.style.opacity = "0";
        input.style.pointerEvents = "none";
        document.body.appendChild(input);

        // 如果有现有 DDL，设为默认值
        if (todo.ddl) {
            input.value = todo.ddl;
        }

        input.onchange = async () => {
            const selectedDate = input.value; // "YYYY-MM-DD"
            document.body.removeChild(input);
            if (!selectedDate) return;
            await this.saveTodoDDL(todo, selectedDate);
        };

        // 如果用户按 ESC 或失去焦点时没有选择，清理
        input.onblur = () => {
            setTimeout(() => { if (document.body.contains(input)) document.body.removeChild(input); }, 200);
        };

        // 触发日期选择器
        input.showPicker();
    }

    async saveTodoDDL(todo, dateStr) {
        try {
            const content = await this.app.vault.read(todo.file);
            const lines = content.split("\n");
            const lineStr = lines[todo.line];
            if (!lineStr) return;

            // 去掉旧的 DDL 再追加新的
            let newLine = lineStr.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*$/, "");
            newLine = newLine + ` 📅 ${dateStr}`;

            lines[todo.line] = newLine;
            await this.app.vault.modify(todo.file, lines.join("\n"));
            // modify 事件会自动刷新列表
        } catch (error) {
            console.error("❌ 设置 DDL 失败：", error);
            new Notice("❌ 设置截止日失败");
        }
    }

    async cancelTodo(todo) {
        try {
            const content = await this.app.vault.read(todo.file);
            const lines = content.split("\n");
            const lineStr = lines[todo.line];
            if (!lineStr) return;

            // 检查是否已取消（~~text~~）
            const isCanceled = /~~(.+)~~/.test(lineStr);

            let newLine;
            if (isCanceled) {
                // 取消取消标记
                newLine = lineStr.replace(/~~(.+)~~/g, "$1");
            } else {
                // 标记为已取消（在任务文本外包裹 ~~ ~~）
                const match = lineStr.match(/^(\s*[-*]\s+\[\s\]\s+)(.+)$/);
                if (!match) return;
                newLine = match[1] + "~~" + match[2].trim() + "~~";
            }

            lines[todo.line] = newLine;
            await this.app.vault.modify(todo.file, lines.join("\n"));
        } catch (error) {
            console.error("❌ 取消标记失败：", error);
            new Notice("❌ 取消标记失败");
        }
    }

    async showTodoTimeline(todo) {
        const dailyPath = this.plugin.settings.dailyPath;
        const historyPath = this.plugin.settings.historyPath;
        const taskKey = todo.text.trim().toLowerCase();

        // 收集所有文件中的同任务记录
        const entries = [];
        const entriesPromises = [];
        const foldersToScan = [dailyPath];
        if (historyPath) foldersToScan.push(historyPath);

        for (const folder of foldersToScan) {
            if (!this.app.vault.getAbstractFileByPath(folder)) continue;
            const files = this.app.vault.getMarkdownFiles()
                .filter(f => f.path.startsWith(folder + "/") && f.extension === "md")
                .sort((a, b) => a.name.localeCompare(b.name));
            for (const file of files) {
                entriesPromises.push(
                    (async () => {
                        const content = await this.app.vault.cachedRead(file);
                        const lines = content.split("\n");
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            const match = line.match(/^(\s*)[-*]\s+\[([ x-])\]\s+(.+)$/);
                            if (!match) continue;
                            const text = match[3].replace(/✅.*$/, "").replace(/📅.*$/, "").trim().toLowerCase();
                            if (text === taskKey) {
                                const dateStr = file.name.replace(/\.md$/, "");
                                let status = "⬜ 未完成";
                                if (match[2] === "x") {
                                    const doneTime = match[3].match(/✅\s*(\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2})/);
                                    status = doneTime ? `✅ 已完成 ${doneTime[1]}` : "✅ 已完成";
                                } else if (match[2] === "-") {
                                    status = "⊘ 已取消";
                                } else if (match[3].includes("~~")) {
                                    status = "⊘ 已取消";
                                }
                                // 检查是否已取消（带 ~~）
                                entries.push({ date: dateStr, status, line: match[0].trim(), file, lineNum: i });
                            }
                        }
                    })()
                );
            }
        }

        await Promise.all(entriesPromises);
        entries.sort((a, b) => a.date.localeCompare(b.date));

        // 弹窗展示
        const modal = new TaskTimelineModal(this.app, todo.text, entries);
        modal.open();
    }

    async openFileAtLine(file, line) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file, { active: true });
        // 延迟等编辑器渲染后跳转到行
        setTimeout(() => {
            try {
                const editor = leaf.view?.editor;
                if (editor) {
                    editor.setCursor({ line, ch: 0 });
                    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
                }
            } catch (e) {
                console.warn("跳转到行失败：", e);
            }
        }, 200);
    }
}

// ============================================================
// 时间轴弹窗
// ============================================================
class ArchiverSettingTab extends PluginSettingTab {

    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        const settings = this.plugin.settings;

        containerEl.empty();
        containerEl.createEl("h2", { text: "📋 每日笔记归档器 — 设置" });
        containerEl.createEl("p", {
            text: "每次打开 Obsidian 时自动创建今日日记，并清理旧文件至历史记录文件夹。",
            attr: { style: "color: var(--text-muted); margin-bottom: 2em;" }
        });

        // ======== 归档路径 ========
        containerEl.createEl("h3", { text: "📁 归档路径" });

        new Setting(containerEl)
            .setName("日记文件夹路径")
            .setDesc("存放每日日记的目录")
            .addText(text => text
                .setPlaceholder("日记/每日")
                .setValue(settings.dailyPath)
                .onChange(async val => { settings.dailyPath = val; await this.plugin.saveSettings(); })
            );

        new Setting(containerEl)
            .setName("历史记录文件夹路径")
            .setDesc("旧日记移入的目录")
            .addText(text => text
                .setPlaceholder("日记/每日/历史记录")
                .setValue(settings.historyPath)
                .onChange(async val => { settings.historyPath = val; await this.plugin.saveSettings(); })
            );

        // ======== 保留规则 ========
        containerEl.createEl("h3", { text: "📌 保留规则" });

        new Setting(containerEl)
            .setName("保留文件数")
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(settings.keepCount)
                .setDynamicTooltip()
                .onChange(async val => { settings.keepCount = val; await this.plugin.saveSettings(); })
            );

        // ======== 日期格式 ========
        containerEl.createEl("h3", { text: "📅 日期格式" });

        new Setting(containerEl)
            .setName("日期格式")
            .setDesc("moment.js 格式，例如 YYYY-MM-DD / YYYYMMDD")
            .addText(text => text
                .setPlaceholder("YYYY-MM-DD")
                .setValue(settings.dateFormat)
                .onChange(async val => {
                    if (!val.trim()) settings.dateFormat = DEFAULT_SETTINGS.dateFormat;
                    else settings.dateFormat = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        const preview = moment().format(settings.dateFormat);
        containerEl.createEl("p", {
            text: `📎 预览：${preview}.md`,
            attr: { style: "color: var(--text-accent); font-family: monospace; margin-left: 1em;" }
        });

        // ======== 日记模板 ========
        containerEl.createEl("h3", { text: "📝 日记模板" });

        new Setting(containerEl)
            .setName("标题行")
            .setDesc("支持 {{date}} 占位符")
            .addText(text => text
                .setPlaceholder("# {{date}}")
                .setValue(settings.noteTitle)
                .onChange(async val => { settings.noteTitle = val; await this.plugin.saveSettings(); })
            );

        new Setting(containerEl)
            .setName("正文模板")
            .setDesc("支持 {{date}} 占位符")
            .addTextArea(text => text
                .setPlaceholder("## 📝 今日任务\n- [ ] \n\n## 💭 笔记")
                .setValue(settings.noteTemplate)
                .onChange(async val => { settings.noteTemplate = val; await this.plugin.saveSettings(); })
            );

        const todayStr = moment().format(settings.dateFormat);
        const tTitle = settings.noteTitle.replace(/\{\{date\}\}/g, todayStr);
        const tBody  = settings.noteTemplate.replace(/\{\{date\}\}/g, todayStr);
        containerEl.createEl("p", { text: "📄 预览：", attr: { style: "font-weight: bold; margin-top: 1em; margin-left: 1em;" } });
        containerEl.createEl("pre", {
            text: tTitle + "\n" + tBody,
            attr: { style: "margin-left:1em;padding:0.8em;background:var(--background-secondary);border-radius:6px;font-size:0.9em;white-space:pre-wrap;" }
        });

        // ======== 归档行为 ========
        containerEl.createEl("h3", { text: "⚙️ 归档行为" });

        new Setting(containerEl)
            .setName("启动时自动创建今日日记")
            .addToggle(toggle => toggle.setValue(settings.autoCreate)
                .onChange(async val => { settings.autoCreate = val; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName("启动时自动归档旧文件")
            .addToggle(toggle => toggle.setValue(settings.autoArchive)
                .onChange(async val => { settings.autoArchive = val; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName("启动时附带之前未完成的任务")
            .setDesc("创建今日日记时，自动将前几天未完成的任务（未取消 [-] 的）添加到今日任务列表")
            .addToggle(toggle => toggle.setValue(settings.autoCarryTasks)
                .onChange(async val => { settings.autoCarryTasks = val; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName("立即执行一次")
            .addButton(btn => btn.setButtonText("▶ 立即执行").setCta()
                .onClick(async () => {
                    btn.setDisabled(true); btn.setButtonText("⏳ …");
                    await this.plugin.runNow();
                    btn.setButtonText("✅"); setTimeout(() => { btn.setDisabled(false); btn.setButtonText("▶ 立即执行"); }, 2000);
                }));

        // ======== 侧边栏 ========
        containerEl.createEl("h3", { text: "📺 侧边栏设置" });
        containerEl.createEl("p", {
            text: "右侧边栏的显示内容（修改后实时生效）",
            attr: { style: "color: var(--text-muted); margin-bottom: 1em;" }
        });

        new Setting(containerEl)
            .setName("显示时钟 & 下班倒计时")
            .addToggle(toggle => toggle.setValue(settings.showClock)
                .onChange(async val => { settings.showClock = val; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName("显示日历")
            .addToggle(toggle => toggle.setValue(settings.showCalendar)
                .onChange(async val => { settings.showCalendar = val; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName("显示未完成任务")
            .addToggle(toggle => toggle.setValue(settings.showTodos)
                .onChange(async val => { settings.showTodos = val; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName("下班时间")
            .setDesc("HH:mm 格式，用于倒计时")
            .addText(text => text
                .setPlaceholder("18:00")
                .setValue(settings.workEndTime)
                .onChange(async val => {
                    if (/^\d{1,2}:\d{2}$/.test(val)) {
                        settings.workEndTime = val;
                    } else {
                        settings.workEndTime = DEFAULT_SETTINGS.workEndTime;
                    }
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("待办扫描文件夹")
            .setDesc("扫描此文件夹下所有 md 文件中的未完成任务")
            .addText(text => text
                .setPlaceholder("日记/每日")
                .setValue(settings.todoFolder)
                .onChange(async val => { settings.todoFolder = val; await this.plugin.saveSettings(); })
            );

        // ======== 重置 ========
        containerEl.createEl("hr", { attr: { style: "margin: 2em 0 1em;" } });

        new Setting(containerEl)
            .setName("重置所有设置为默认值")
            .addButton(btn => btn.setButtonText("重置为默认").setWarning()
                .onClick(async () => {
                    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                    await this.plugin.saveSettings();
                    this.display();
                    new Notice("已重置");
                })
            );
    }
}


class TaskTimelineModal extends Modal {

    constructor(app, taskText, entries) {
        super(app);
        this.taskText = taskText;
        this.entries = entries;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.classList.add("dns-timeline-modal");

        contentEl.createEl("h3", { text: `📊 任务时间轴: ${this.taskText}` });

        if (this.entries.length === 0) {
            contentEl.createEl("p", { text: "未找到相关记录" });
            return;
        }

        const list = contentEl.createEl("div", { cls: "dns-timeline-list" });

        for (const entry of this.entries) {
            const item = list.createDiv({ cls: "dns-timeline-item" });

            // 日期
            const dateEl = item.createEl("span", { cls: "dns-timeline-date", text: `📅 ${entry.date}` });

            // 状态
            const statusEl = item.createEl("span", { cls: "dns-timeline-status", text: `  ${entry.status}` });

            // 点击跳转
            item.onclick = () => {
                const leaf = this.app.workspace.getLeaf(false);
                leaf.openFile(entry.file, { active: true });
                this.close();
            };
            item.style.cursor = "pointer";
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
