const { Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile } = require('obsidian');

// ========== 默认设置 ==========
const DEFAULT_SETTINGS = {
    baseFolder: 'Assets/Image',
    maxHeadingDepth: 6,
    uploadOnPaste: 'always',
};

// ========== 主插件类 ==========
class LocalImageManager extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SettingTab(this.app, this));
        this.registerEvent(this.app.workspace.on('editor-paste', this.handlePaste.bind(this)));
        this.registerEvent(this.app.workspace.on('editor-drop', this.handleDrop.bind(this)));
        this.addCommand({
            id: 'reorder-images',
            name: '重新整理当前笔记的图片序号',
            callback: () => this.reorderCurrentNoteImages(),
        });
    }

    onunload() { }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ========== 处理粘贴 ==========
    async handlePaste(evt) {
        const files = evt.clipboardData?.files;
        if (!files || files.length === 0) return;
        const imageFile = Array.from(files).find(file => file.type.startsWith('image/'));
        if (!imageFile) return;

        if (this.settings.uploadOnPaste === 'ask') {
            const confirmed = await new Promise(resolve => {
                const modal = new ConfirmationModal(this.app, '保存图片到本地？', '是否将图片保存到本地并插入链接？');
                modal.open();
                modal.onClose = () => resolve(modal.confirmed);
            });
            if (!confirmed) return;
        }

        evt.preventDefault();
        await this.saveImageLocally(imageFile);
    }
    // ========== 处理拖拽图片 ==========
    async handleDrop(evt) {
        // 从拖拽事件中获取文件列表
        const files = evt.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const imageFile = Array.from(files).find(file => file.type.startsWith('image/'));
        if (!imageFile) return;

        // 与粘贴相同的确认逻辑（如果设置 ask）
        if (this.settings.uploadOnPaste === 'ask') {
            const confirmed = await new Promise(resolve => {
                const modal = new ConfirmationModal(this.app, '保存图片到本地？', '是否将图片保存到本地并插入链接？');
                modal.open();
                modal.onClose = () => resolve(modal.confirmed);
            });
            if (!confirmed) return;
        }

        evt.preventDefault(); // 阻止浏览器默认行为（如在新标签页打开）
        await this.saveImageLocally(imageFile);
    }

    // ========== 保存图片 ==========
    async saveImageLocally(imageFile) {
        const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
        if (!activeView) {
            new Notice('没有打开的编辑器。');
            return;
        }
        const editor = activeView.editor;
        const noteFile = activeView.file;
        if (!noteFile) return;

        // 1. 生成文件名（返回 { fileName, usedFallback }）
        const extension = imageFile.name.split('.').pop() || 'png';
        const noteBasename = noteFile.basename;
        let newFileName, usedFallback;
        try {
            const result = await this.generateFileNameFromHeading(editor, noteBasename, extension);
            newFileName = result.fileName;
            usedFallback = result.usedFallback;
        } catch (err) {
            console.error('生成文件名失败，使用时间戳', err);
            const fallback = this.fallbackFileName(extension, noteBasename);
            newFileName = fallback;
            usedFallback = true;
        }

        // 如果使用了 fallback，给出提示
        if (usedFallback) {
            new Notice('当前光标位置无有效标题，建议在标题层级下粘贴图片以获得有序命名。', 5000);
        }

        // 2. 确定存储路径（按笔记路径存放）
        const notePath = noteFile.path;
        const baseFolder = this.settings.baseFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const noteName = noteFile.basename;
        const noteDir = notePath.substring(0, notePath.lastIndexOf('/') + 1);
        let targetFolder = baseFolder;
        if (noteDir) targetFolder = `${targetFolder}/${noteDir}`.replace(/\/$/, '');
        if (noteName) targetFolder = `${targetFolder}/${noteName}`;
        targetFolder = targetFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

        await this.ensureFolderExists(targetFolder);

        // 3. 保存图片（处理重名）
        const arrayBuffer = await imageFile.arrayBuffer();
        let targetPath = `${targetFolder}/${newFileName}`;
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

        // 4. 插入 Wiki 链接
        const linkPath = this.app.metadataCache.fileToLinktext(noteFile, finalPath);
        const linkText = `![[${linkPath}]]`;
        editor.replaceSelection(linkText);

        new Notice(`图片已保存到: ${finalPath}`);
    }

    // ========== 生成基于标题层级的文件名（返回对象） ==========
    async generateFileNameFromHeading(editor, noteBasename, extension) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            return { fileName: this.fallbackFileName(extension, noteBasename), usedFallback: true };
        }

        const cache = this.app.metadataCache.getFileCache(activeFile, true);
        const headings = cache?.headings;
        if (!headings || headings.length === 0) {
            return { fileName: this.fallbackFileName(extension, noteBasename), usedFallback: true };
        }

        const cursor = editor.getCursor();
        const cursorLine = cursor.line;

        // 找到光标所在标题
        let currentHeading = null;
        for (let i = headings.length - 1; i >= 0; i--) {
            const heading = headings[i];
            if (heading.position.start.line <= cursorLine) {
                currentHeading = heading;
                break;
            }
        }

        if (!currentHeading) {
            return { fileName: this.fallbackFileName(extension, noteBasename), usedFallback: true };
        }

        // 计算编号
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
            return { fileName: this.fallbackFileName(extension, noteBasename), usedFallback: true };
        }

        // 限制最大深度
        const maxDepth = this.settings.maxHeadingDepth || 6;
        const parts = targetPath.split('.');
        if (parts.length > maxDepth) {
            targetPath = parts.slice(0, maxDepth).join('.');
        }

        // 获取计数器
        const notePath = activeFile.path;
        const counter = await this.getNextImageCounter(notePath, targetPath);

        const safePath = targetPath.replace(/[^0-9.]/g, '');
        const fileName = `${safePath}-${counter}.${extension}`;
        return { fileName, usedFallback: false };
    }

    // ========== 后备文件名 ==========
    fallbackFileName(extension, noteName = 'image') {
        const dateStr = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
        return `${noteName}-${dateStr}.${extension}`;
    }

    // ========== 图片计数器 ==========
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
        } catch (_) { }
    }

    // ========== 尚未实现 ==========
    async reorderCurrentNoteImages() {
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

module.exports = LocalImageManager;