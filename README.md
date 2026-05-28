# 👂 xiaoer-ask

> Press a hotkey while reading anything on your Mac → AI sees your screen → instant answer in a floating panel.
>
> 在 Mac 上阅读任何内容时按一个快捷键 → AI 直接看你屏幕 → 浮窗里秒答。

---

**English** · [中文](#中文)

## What it does

You're reading a PDF / web page / PPTX / Word / any app. You hit an unfamiliar term. Normally you'd Cmd+C → switch to ChatGPT → paste → ask.

With xiaoer-ask:

1. **Select the term + press `Option+A`** → a floating panel pops up, the AI already sees your current page and selection, and starts streaming an explanation immediately.
2. **Drag-select another new term** (panel stays open) → it auto-explains the new term in the same conversation. No keystroke needed.
3. **Switch to a new page → type "what's this about" in the panel and hit Send** → it silently re-captures your screen and answers about the new page.
4. **Continue asking follow-ups** in the same conversation, jumping across pages and selections freely.

Built on macOS + [Hammerspoon](https://www.hammerspoon.org/) + Google's Gemini 2.5 Flash (native multimodal, sees screenshots directly).

## Requirements

- macOS (tested on 14+)
- [Hammerspoon](https://www.hammerspoon.org/) installed
- A free [Gemini API key](https://aistudio.google.com/apikey)

## Install

```bash
# 1. Clone
cd ~/projects   # or wherever
git clone https://github.com/Jane-xiaoer/xiaoer-ask.git
cd xiaoer-ask

# 2. Configure API key
cp .env.example .env
# edit .env, paste your GEMINI_API_KEY

# 3. Hook into Hammerspoon (~/.hammerspoon/init.lua)
echo "
dofile(\"$(pwd)/hammerspoon/xiaoer-ask.lua\")
" >> ~/.hammerspoon/init.lua

# 4. Reload Hammerspoon
hs -c 'hs.reload()'   # or click the menu bar icon → Reload Config
```

That's it. Open any document, select a word, press **Option+A**.

### First run permissions

macOS will ask Hammerspoon for:
- **Accessibility** (needed for hotkey + simulating ⌘C to grab selection)
- **Screen Recording** (needed to screenshot whatever you're reading)

Grant both. They only apply to Hammerspoon, not random apps.

## Customize

### Change the hotkey

Edit `hammerspoon/xiaoer-ask.lua`, find:

```lua
hs.hotkey.bind({"alt"}, "A", M.trigger)
```

Swap `"alt"` and `"A"` for whatever you like. Reload Hammerspoon.

### Switch model

Edit `webview/app.js`:

```js
const MODEL = "gemini-2.5-flash";
```

You can use `gemini-2.5-pro` for higher quality (slower, more tokens). The free tier covers Flash easily; Pro hits limits faster.

### Tweak the look

`webview/style.css` is a single readable file. Palette is `--bg` (electric blue) + `--accent` (lemon yellow). Change them and reopen the panel.

## How it works

```
Option+A
 ↓ Hammerspoon hotkey
 ↓ grab selection (⌘C save → simulate → read → restore clipboard)
 ↓ capture-context.sh
 │   ├─ Browser → AppleScript URL → fetch + readability
 │   └─ Other   → screencapture full screen
 ↓ hs.webview floating panel (480x620)
 ↓ inject context as JS globals
 ↓ Gemini 2.5 Flash multimodal streaming SSE
 ↓ stream answer into chat bubble
```

Full architecture notes in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT — see [LICENSE](LICENSE).

---

## 中文

### 这是什么

你在 Mac 上读 PDF / 网页 / PPTX / Word / 任何 app，遇到不懂的术语，正常流程是 ⌘C → 切到 ChatGPT → 粘贴 → 问。

xiaoer-ask 改成：

1. **选中术语 + 按 `Option+A`** → 浮窗弹出，AI 已经看到你当前页面 + 选中词，立刻开始流式解释
2. **拖动鼠标划另一个新词**（浮窗保持开着）→ 同一对话里自动解释新词，不用动手按任何键
3. **切到新页面 → 浮窗里输入"这页讲啥"点发送** → 自动重新抓屏 → AI 看新页面回答
4. **持续追问**——同一对话里可以跨页面、跨选词、连续学习

技术栈：macOS + [Hammerspoon](https://www.hammerspoon.org/) + Gemini 2.5 Flash（原生多模态，直接吃截图）。

### 环境要求

- macOS（14+ 测过）
- 安装 [Hammerspoon](https://www.hammerspoon.org/)
- 一个免费 [Gemini API key](https://aistudio.google.com/apikey)（日常用免费档够）

### 安装

```bash
# 1. 克隆
cd ~/projects   # 放哪都行
git clone https://github.com/Jane-xiaoer/xiaoer-ask.git
cd xiaoer-ask

# 2. 配置 API key
cp .env.example .env
# 编辑 .env，把 GEMINI_API_KEY 填进去

# 3. 接入 Hammerspoon
echo "
dofile(\"$(pwd)/hammerspoon/xiaoer-ask.lua\")
" >> ~/.hammerspoon/init.lua

# 4. 重载 Hammerspoon
hs -c 'hs.reload()'   # 或者点菜单栏小锤子 → Reload Config
```

完事。打开任意文档选词按 **Option+A**。

### 首次运行权限

macOS 会问 Hammerspoon 要：
- **辅助功能（Accessibility）**——快捷键 + 模拟 ⌘C 抓选中
- **屏幕录制（Screen Recording）**——截当前画面

全允许。只对 Hammerspoon 生效，不影响别的 app。

### 自定义

**改快捷键**：`hammerspoon/xiaoer-ask.lua` 里找 `hs.hotkey.bind({"alt"}, "A", M.trigger)`，改修饰键和字母。

**换模型**：`webview/app.js` 顶部 `const MODEL = "gemini-2.5-flash";` 改成 `gemini-2.5-pro` 获得更高质量（更慢更贵）。

**调外观**：`webview/style.css` 整文件可读。色板用 `--bg`（电讯蓝）+ `--accent`（柠檬黄）两个变量控制。

### 工作原理

```
Option+A
 ↓ Hammerspoon 热键
 ↓ 抓选中（⌘C 保存 → 模拟 → 读 → 恢复剪贴板）
 ↓ capture-context.sh
 │   ├─ 浏览器 → AppleScript 拿 URL → curl + readability 提正文
 │   └─ 其他   → screencapture 当前屏
 ↓ hs.webview 浮窗 (480x620)
 ↓ 把上下文注入 JS 全局
 ↓ Gemini 2.5 Flash 多模态流式 SSE
 ↓ 流式答案到对话气泡
```

详细架构看 [ARCHITECTURE.md](ARCHITECTURE.md)。

### License

MIT — see [LICENSE](LICENSE).

---

## 📱 关注作者 / Follow Me

如果这个仓库对你有帮助,欢迎关注我。后面我会持续更新更多 AI Skill、设计方法、网站美学和创意工作流。

If this repo helped you, follow me for more AI skills, design systems, web aesthetics, and creative workflows.

- X (Twitter): [@xiaoerzhan](https://x.com/xiaoerzhan)
- 微信公众号 / WeChat Official Account: 扫码关注 / Scan to follow

<p align="center">
  <img src="./follow-wechat-qrcode.jpg" alt="Jane WeChat Official Account QR code" width="300" />
</p>

<p align="center"><strong>中文:</strong>欢迎关注我的公众号,一起研究 AI Skill、设计原则、网站表达和创意工作流。</p>

<p align="center"><strong>English:</strong> Follow my WeChat Official Account for more AI skills, design principles, web aesthetics, and creative workflows.</p>
