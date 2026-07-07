const { Plugin, PluginSettingTab, Setting, Notice, ItemView, moment } = require('obsidian');

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
        await this.loadSettings();
        console.log("🔄 [每日笔记归档器] 插件加载完成");

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
            const body      = this.settings.noteTemplate.replace(/\{\{date\}\}/g, today);
            await this.app.vault.create(filePath, titleLine + "\n" + body);

            console.log(`📄 [每日笔记归档器] 已创建：${fileName}`);
            new Notice(`📝 已创建今日日记：${fileName}`);
        } catch (error) {
            console.error("❌ [每日笔记归档器] 创建日记失败：", error);
        }
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

        const section = parent.createDiv({ cls: "dns-section" });
        this.clockEl = section.createDiv({ cls: "dns-clock" });
        this.countdownEl = section.createDiv({ cls: "dns-countdown" });
        this.updateClock();
    }

    updateClock() {
        if (!this.clockEl) return;

        const now = moment();
        this.clockEl.textContent = now.format("HH:mm:ss");

        // 倒计时
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

        // 获取该月所有有日记的日期
        const dailyPath = this.plugin.settings.dailyPath;
        const dateFormat = this.plugin.settings.dateFormat;
        const existingDates = new Set();
        if (this.app.vault.getAbstractFileByPath(dailyPath)) {
            const files = this.app.vault.getMarkdownFiles()
                .filter(f => f.path.startsWith(dailyPath + "/") && f.extension === "md");
            for (const f of files) {
                // 去掉 .md 后缀即日期字符串
                existingDates.add(f.name.replace(/\.md$/, ""));
            }
        }

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
        const dailyPath = this.plugin.settings.dailyPath;
        const filePath = `${dailyPath}/${dateStr}.md`;
        const file = this.app.vault.getAbstractFileByPath(filePath);
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

        // 解析所有未完成任务
        const todos = [];
        for (const file of files) {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // 匹配 - [ ] 或 * [ ]（未勾选）
                const match = line.match(/^(\s*)[-*]\s+\[\s\]\s+(.+)$/);
                if (match) {
                    todos.push({
                        file: file,
                        line: i,
                        indent: match[1],
                        marker: line.startsWith(" ") ? "*" : "-",
                        raw: line,
                        text: match[2],
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
                // 未完成 → 已完成
                newLine = lineStr.replace(/\[\s\]/, "[x]");
            } else if (/\[x\]/.test(lineStr)) {
                // 已完成 → 未完成
                newLine = lineStr.replace(/\[x\]/, "[ ]");
            } else {
                return; // 不是可切换的待办
            }

            lines[todo.line] = newLine;
            // modify 会自动触发 vault.on("modify") 事件 → 刷新列表
            await this.app.vault.modify(todo.file, lines.join("\n"));
        } catch (error) {
            console.error("❌ 切换待办失败：", error);
            new Notice("❌ 切换待办失败");
        }
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
// 设置面板
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
