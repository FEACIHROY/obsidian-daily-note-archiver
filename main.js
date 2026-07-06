const { Plugin, PluginSettingTab, Setting, Notice, moment } = require('obsidian');

// ============================================================
// 默认配置
// ============================================================
const DEFAULT_SETTINGS = {
    dailyPath:   "日记/每日",
    historyPath: "日记/每日/历史记录",
    keepCount:   7,
    dateFormat:  "YYYY-MM-DD",
    noteTitle:   "# {{date}}",
    noteTemplate: [
        "",
        "## 📝 今日任务",
        "- [ ] ",
        "",
        "## 💭 笔记",
        "",
        "## 📅 回顾",
        "",
    ].join("\n"),
    // 是否每次启动自动创建今日日记
    autoCreate:  true,
    // 是否每次启动自动归档
    autoArchive: true,
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

        // 注册设置页
        this.addSettingTab(new ArchiverSettingTab(this.app, this));

        // 启动时执行每日任务
        this.app.workspace.onLayoutReady(() => {
            this.runDailyTasks();
        });
    }

    async onunload() {
        console.log("🔄 [每日笔记归档器] 插件已卸载");
    }

    // ---------------------------------------------------------
    // 配置持久化
    // ---------------------------------------------------------
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ---------------------------------------------------------
    // 每日任务
    // ---------------------------------------------------------
    async runDailyTasks() {
        if (this.settings.autoCreate) {
            await this.ensureDailyNote();
        }
        if (this.settings.autoArchive) {
            await this.archiveOldNotes();
        }
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

            // 如果已存在则跳过
            if (this.app.vault.getAbstractFileByPath(filePath)) {
                console.log(`✅ [每日笔记归档器] 今日日记已存在：${fileName}`);
                return;
            }

            // 确保目标文件夹存在
            if (!this.app.vault.getAbstractFileByPath(dirPath)) {
                await this.app.vault.createFolder(dirPath);
                console.log("📁 [每日笔记归档器] 创建每日文件夹：", dirPath);
            }

            // 组装内容（支持 {{date}} 占位符）
            let titleLine = this.settings.noteTitle.replace(/\{\{date\}\}/g, today);
            let body      = this.settings.noteTemplate.replace(/\{\{date\}\}/g, today);
            const content = titleLine + "\n" + body;

            await this.app.vault.create(filePath, content);
            console.log(`📄 [每日笔记归档器] 已创建今日日记：${fileName}`);
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
            // 检查每日文件夹是否存在
            if (!this.app.vault.getAbstractFileByPath(dailyPath)) {
                console.log("⏭️ [每日笔记归档器] 每日文件夹不存在，跳过归档");
                return;
            }

            // 收集每日文件夹内的 .md 文件（排除历史记录中的）
            const allFiles = this.app.vault.getMarkdownFiles();
            const dailyFiles = allFiles.filter(f => {
                const inDaily   = f.path.startsWith(dailyPath + "/");
                const inHistory = f.path.startsWith(historyPath + "/");
                return inDaily && !inHistory;
            });

            if (dailyFiles.length <= keepCount) {
                console.log(`✅ [每日笔记归档器] 无需归档（${dailyFiles.length} ≤ ${keepCount}）`);
                return;
            }

            // 按文件名（日期字符串）降序 → 最新的在前
            dailyFiles.sort((a, b) => b.name.localeCompare(a.name));

            // 需归档的 = 超出 keepCount 的部分
            const toArchive = dailyFiles.slice(keepCount);

            // 确保历史记录文件夹存在
            if (!this.app.vault.getAbstractFileByPath(historyPath)) {
                await this.app.vault.createFolder(historyPath);
                console.log("📁 [每日笔记归档器] 创建历史记录文件夹：", historyPath);
            }

            // 逐个移动
            let moved = 0;
            for (const file of toArchive) {
                const newPath = `${historyPath}/${file.name}`;
                if (this.app.vault.getAbstractFileByPath(newPath)) {
                    console.log(`⚠️ [每日笔记归档器] ${file.name} 已存在于历史记录中，跳过`);
                    continue;
                }
                await this.app.vault.rename(file, newPath);
                moved++;
            }

            console.log(`✅ [每日笔记归档器] 完成：${moved} 个文件移至历史记录`);
            if (moved > 0) {
                new Notice(`📋 每日笔记归档完成，${moved} 个旧文件已移至历史记录`);
            }

        } catch (error) {
            console.error("❌ [每日笔记归档器] 归档错误：", error);
            new Notice("❌ 每日笔记归档失败，详见控制台");
        }
    }

    // ---------------------------------------------------------
    // 手动触发（供控制台或命令调用）
    // ---------------------------------------------------------
    async runNow() {
        await this.ensureDailyNote();
        await this.archiveOldNotes();
    }
};

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

        // ---------- 标题 ----------
        containerEl.createEl("h2", { text: "📋 每日笔记归档器 — 设置" });
        containerEl.createEl("p", {
            text: "每次打开 Obsidian 时自动创建今日日记，并清理旧文件至历史记录文件夹。",
            attr: { style: "color: var(--text-muted); margin-bottom: 2em;" }
        });

        // ======== 基本路径 ========
        containerEl.createEl("h3", { text: "📁 路径设置" });

        new Setting(containerEl)
            .setName("日记文件夹路径")
            .setDesc("存放每日日记的目录，相对于库根目录")
            .addText(text => text
                .setPlaceholder("日记/每日")
                .setValue(settings.dailyPath)
                .onChange(async val => {
                    settings.dailyPath = val;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("历史记录文件夹路径")
            .setDesc("旧日记移入的目录，相对于库根目录")
            .addText(text => text
                .setPlaceholder("日记/每日/历史记录")
                .setValue(settings.historyPath)
                .onChange(async val => {
                    settings.historyPath = val;
                    await this.plugin.saveSettings();
                })
            );

        // ======== 保留规则 ========
        containerEl.createEl("h3", { text: "📌 保留规则" });

        new Setting(containerEl)
            .setName("保留文件数")
            .setDesc("每日文件夹中最多保留的文件数量（超出部分自动移至历史记录）")
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(settings.keepCount)
                .setDynamicTooltip()
                .onChange(async val => {
                    settings.keepCount = val;
                    await this.plugin.saveSettings();
                })
            );

        // ======== 日期格式 ========
        containerEl.createEl("h3", { text: "📅 日期格式" });

        new Setting(containerEl)
            .setName("日期格式")
            .setDesc("文件名使用的 moment.js 日期格式（例如 YYYY-MM-DD / YYYYMMDD / YYYY年M月D日）")
            .addText(text => text
                .setPlaceholder("YYYY-MM-DD")
                .setValue(settings.dateFormat)
                .onChange(async val => {
                    // 防止空值
                    if (!val.trim()) {
                        settings.dateFormat = DEFAULT_SETTINGS.dateFormat;
                    } else {
                        settings.dateFormat = val;
                    }
                    await this.plugin.saveSettings();
                    // 显示预览
                    this.display();
                })
            );

        // 日期预览
        const preview = moment().format(settings.dateFormat);
        containerEl.createEl("p", {
            text: `📎 当前格式预览：${preview}.md`,
            attr: { style: "color: var(--text-accent); font-family: monospace; margin-left: 1em;" }
        });

        // ======== 日记模板 ========
        containerEl.createEl("h3", { text: "📝 日记模板" });

        new Setting(containerEl)
            .setName("标题行")
            .setDesc("文件首行，支持 {{date}} 占位符（会被替换为实际日期）")
            .addText(text => text
                .setPlaceholder("# {{date}}")
                .setValue(settings.noteTitle)
                .onChange(async val => {
                    settings.noteTitle = val;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("正文模板")
            .setDesc("标题之后的内容，支持 {{date}} 占位符")
            .addTextArea(text => text
                .setPlaceholder("## 📝 今日任务\n- [ ] \n\n## 💭 笔记\n\n## 📅 回顾")
                .setValue(settings.noteTemplate)
                .onChange(async val => {
                    settings.noteTemplate = val;
                    await this.plugin.saveSettings();
                })
            );

        // 模板预览
        const todayStr = moment().format(settings.dateFormat);
        const previewTitle = settings.noteTitle.replace(/\{\{date\}\}/g, todayStr);
        const previewBody  = settings.noteTemplate.replace(/\{\{date\}\}/g, todayStr);
        containerEl.createEl("p", {
            text: "📄 模板预览：",
            attr: { style: "font-weight: bold; margin-top: 1em; margin-left: 1em;" }
        });
        const previewEl = containerEl.createEl("pre", {
            text: previewTitle + "\n" + previewBody,
            attr: {
                style: "margin-left: 1em; padding: 0.8em; background: var(--background-secondary); border-radius: 6px; font-size: 0.9em; white-space: pre-wrap;"
            }
        });

        // ======== 行为开关 ========
        containerEl.createEl("h3", { text: "⚙️ 行为设置" });

        new Setting(containerEl)
            .setName("启动时自动创建今日日记")
            .setDesc("每次打开 Obsidian 时自动生成今日日记文件")
            .addToggle(toggle => toggle
                .setValue(settings.autoCreate)
                .onChange(async val => {
                    settings.autoCreate = val;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("启动时自动归档旧文件")
            .setDesc("每次打开 Obsidian 时自动将超出保留数的文件移至历史记录")
            .addToggle(toggle => toggle
                .setValue(settings.autoArchive)
                .onChange(async val => {
                    settings.autoArchive = val;
                    await this.plugin.saveSettings();
                })
            );

        // ======== 手动操作 ========
        containerEl.createEl("h3", { text: "▶️ 手动执行" });

        new Setting(containerEl)
            .setName("立即执行一次")
            .setDesc("立即创建今日日记（如缺失）并归档旧文件")
            .addButton(btn => btn
                .setButtonText("▶ 立即执行")
                .setCta()
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText("⏳ 执行中…");
                    await this.plugin.runNow();
                    btn.setButtonText("✅ 完成");
                    setTimeout(() => {
                        btn.setDisabled(false);
                        btn.setButtonText("▶ 立即执行");
                    }, 2000);
                })
            );

        // ======== 重置 ========
        containerEl.createEl("h3", { text: "🔄 恢复默认" });

        new Setting(containerEl)
            .setName("重置所有设置为默认值")
            .setDesc("将清空当前配置，恢复出厂设置")
            .addButton(btn => btn
                .setButtonText("重置为默认")
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                    await this.plugin.saveSettings();
                    this.display();  // 刷新面板
                    new Notice("已重置为默认设置");
                })
            );

        // 底部信息
        containerEl.createEl("hr", { attr: { style: "margin: 2em 0 1em;" } });
        containerEl.createEl("p", {
            text: "💡 修改设置后，下次启动 Obsidian 时按新规则生效。",
            attr: { style: "color: var(--text-muted); font-size: 0.9em;" }
        });
    }
}
