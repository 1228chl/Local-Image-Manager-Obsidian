const { Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile } = require('obsidian');

// ========== 默认设置 ==========
const DEFAULT_SETTINGS = {
    baseFolder: 'Assets/Image',   // 基础存储目录
    maxHeadingDepth: 6,           // 文件名中最大标题深度
    uploadOnPaste: 'always',      // 'always' 或 'ask'
};

// ========== 主插件类 ==========
class LocalImageManager extends Plugin {
    async onload() {
        await this.loadSettings();

        // 添加设置选项卡
        this.addSettingTab(new SettingTab(this.app, this));

        // 注册粘贴事件
        this.registerEvent(this.app.workspace.on('editor-paste', this.handlePaste.bind(this)));

        // 可选：添加一个命令手动整理序号（后续可扩展）
        this.addCommand({
            id: 'reorder-images',
            name: '重新整理当前笔记的图片序号',
            callback: () => this.reorderCurrentNoteImages(),
        });
    }

    onunload() {
        // 清理工作（无特殊）
    }

    // ========== 加载/保存设置 ==========
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ========== 核心：处理粘贴 ==========
    async handlePaste(evt) {
        const files = evt.clipboardData?.files;
        if (!files || files.length === 0) return;
        const imageFile = Array.from(files).find(file => file.type.startsWith('image/'));
        if (!imageFile) return;

        // 如果设置为询问，则弹窗确认
        if (this.settings.uploadOnPaste === 'ask') {
            const confirmed = await new Promise(resolve => {
                const modal = new ConfirmationModal(this.app, '保存图片到本地？', '是否将图片保存到本地并插入链接？');
                modal.open();
                modal.onClose = () => resolve(modal.confirmed);
            });
            if (!confirmed) return;
        }

        // 阻止默认粘贴（防止插入原始文件）
        evt.preventDefault();

        // 执行保存
        await this.saveImageLocally(imageFile);
    }

    // ========== 保存图片到本地（核心逻辑） ==========
    async saveImageLocally(imageFile) {
        const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
        if (!activeView) {
            new Notice('没有打开的编辑器。');
            return;
        }
        const editor = activeView.editor;
        const noteFile = activeView.file;
        if (!noteFile) return;

        // 1. 生成文件名（基于标题层级）
        const extension = imageFile.name.split('.').pop() || 'png';
        const noteBasename = noteFile.basename;
        let newFileName;
        try {
            newFileName = await this.generateFileNameFromHeading(editor, noteBasename, extension);
        } catch (err) {
            console.error('生成文件名失败，使用时间戳', err);
            const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
            newFileName = `${timestamp}.${extension}`;
        }

        // 2. 确定存储路径（按照笔记路径存放）
        const notePath = noteFile.path;
        const baseFolder = this.settings.baseFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        // 去掉扩展名，得到笔记名
        const noteName = noteFile.basename;
        // 笔记所在目录（相对于 vault 根）
        const noteDir = notePath.substring(0, notePath.lastIndexOf('/') + 1); // 如 "DL/"
        // 构建目标文件夹: baseFolder + noteDir + noteName
        let targetFolder = baseFolder;
        if (noteDir) targetFolder = `${targetFolder}/${noteDir}`.replace(/\/$/, '');
        if (noteName) targetFolder = `${targetFolder}/${noteName}`;
        targetFolder = targetFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

        // 确保文件夹存在
        await this.ensureFolderExists(targetFolder);

        // 3. 读取图片数据并保存
        const arrayBuffer = await imageFile.arrayBuffer();
        let targetPath = `${targetFolder}/${newFileName}`;
        // 处理重名（加计数器）
        let finalPath = targetPath;
        let counter = 1;
        const adapter = this.app.vault.adapter;
        while (await adapter.exists(finalPath)) {
            const ext = newFileName.split('.').pop();
            const base = newFileName.slice(0, -(ext.length + 1));
            finalPath = `${targetFolder}/${base}-${counter}.${ext}`;
            counter++;
        }
        await this.app.vault.createBinary(finalPath, arrayBuffer);

        // 4. 插入 Wiki 链接到编辑器
        // 使用相对路径（相对于当前笔记），更简洁
        const activeFile = activeView.file;
        const linkPath = this.app.metadataCache.fileToLinktext(activeFile, finalPath);
        const linkText = `![[${linkPath}]]`;
        editor.replaceSelection(linkText);

        new Notice(`图片已保存到: ${finalPath}`);
    }

    // ========== 生成基于标题层级的文件名 ==========
    async generateFileNameFromHeading(editor, noteBasename, extension) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
            return `${timestamp}.${extension}`;
        }

        const cache = this.app.metadataCache.getFileCache(activeFile);
        const headings = cache?.headings;
        if (!headings || headings.length === 0) {
            const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
            return `${timestamp}.${extension}`;
        }

        const cursor = editor.getCursor();
        const cursorLine = cursor.line;

        // 1. 找到光标所在的标题（最后一个行号 ≤ 光标行号的标题）
        let currentHeading = null;
        for (let i = headings.length - 1; i >= 0; i--) {
            const heading = headings[i];
            if (heading.position.start.line <= cursorLine) {
                currentHeading = heading;
                break;
            }
        }

        if (!currentHeading) {
            // 根级别：使用 "root"
            const counter = await this.getNextImageCounter(activeFile.path, 'root');
            return `root-${counter}.${extension}`;
        }

        // 2. 为每个标题计算绝对编号（多级列表）
        const counters = [];
        const headingToPath = new Map();
        for (const h of headings) {
            const level = h.level;
            while (counters.length < level) counters.push(0);
            if (counters.length > level) counters.length = level;
            counters[level - 1]++;
            const path = counters.slice(0, level).join('.');
            headingToPath.set(h, path);
        }

        let targetPath = headingToPath.get(currentHeading);
        if (!targetPath) {
            const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
            return `${timestamp}.${extension}`;
        }

        // 3. 限制最大深度
        const maxDepth = this.settings.maxHeadingDepth || 6;
        const parts = targetPath.split('.');
        if (parts.length > maxDepth) {
            targetPath = parts.slice(0, maxDepth).join('.');
        }

        // 4. 获取该路径下的图片计数器（基于笔记路径 + 层级路径）
        const notePath = activeFile.path;
        const counter = await this.getNextImageCounter(notePath, targetPath);

        // 5. 生成最终文件名
        const safePath = targetPath.replace(/[^0-9.]/g, '');
        return `${safePath}-${counter}.${extension}`;
    }

    // ========== 图片计数器（保存到设置中） ==========
    async getNextImageCounter(notePath, headingPath) {
        const key = `${notePath}|${headingPath}`;
        let current = this.settings.imageCounters?.[key] || 0;
        const next = current + 1;
        if (!this.settings.imageCounters) this.settings.imageCounters = {};
        this.settings.imageCounters[key] = next;
        await this.saveSettings();
        return next;
    }

    // ========== 确保文件夹存在 ==========
    async ensureFolderExists(folderPath) {
        if (!folderPath) return;
        try {
            await this.app.vault.createFolder(folderPath);
        } catch (_) {
            // 文件夹已存在则忽略
        }
    }

    // ========== （可选）重新整理当前笔记图片序号 ==========
    async reorderCurrentNoteImages() {
        // 这里可以后续实现，与 NotePix 的 reorder 类似，但先留空
        new Notice('此功能尚未实现。');
    }
}

// ========== 确认弹窗 ==========
class ConfirmationModal extends require('obsidian').Modal {
    constructor(app, title, message) {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmed = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.message });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('是').setCta().onClick(() => {
                this.confirmed = true;
                this.close();
            }))
            .addButton(btn => btn.setButtonText('否').onClick(() => {
                this.confirmed = false;
                this.close();
            }));
    }
}

// ========== 设置选项卡 ==========
class SettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('基础存储文件夹')
            .setDesc('图片将保存在此文件夹下，后接笔记的目录和文件名（例如 Assets/Image/DL/ANN/）。')
            .addText(text => text
                .setPlaceholder('Assets/Image')
                .setValue(this.plugin.settings.baseFolder)
                .onChange(async (value) => {
                    this.plugin.settings.baseFolder = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('标题层级最大深度')
            .setDesc('生成文件名时最多使用几级标题序号（1-6）。超出部分将被截断。')
            .addSlider(slider => slider
                .setLimits(1, 6, 1)
                .setValue(this.plugin.settings.maxHeadingDepth)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxHeadingDepth = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('粘贴图片行为')
            .setDesc('总是保存：粘贴时自动保存。每次询问：弹出确认窗口。')
            .addDropdown(dropdown => dropdown
                .addOption('always', '总是保存')
                .addOption('ask', '每次询问')
                .setValue(this.plugin.settings.uploadOnPaste)
                .onChange(async (value) => {
                    this.plugin.settings.uploadOnPaste = value;
                    await this.plugin.saveSettings();
                }));
    }
}

// ========== 导出插件 ==========
module.exports = LocalImageManager;