# Hermes Browser Extension

[English](README.md) | **简体中文**

Hermes 在你**日常使用的 Chrome 配置**里驱动一个**独立 Agent 窗口**（无自动化调试条、不抢你当前标签焦点）。本仓库提供 Plasmo 扩展与小型 Python bridge。

扩展提供四个使用入口：

- **侧边栏** — 贴着当前网页对话。
- **Home 页** — 替换 Chrome 新标签页，作为 Hermes 启动入口（问候语、输入框、最近会话）。
- **全屏聊天** — 独立标签页内打开，左侧会话列表 + 可调宽度的消息列。
- **配置页** — 管理 Gateway、模型、Skills、Memory、Cron 与 Userscripts。

### 侧边栏 — 与网页同屏

![侧边栏与正在浏览的网页同屏](docs/sidepanel-demo.png)

### Home 页 — 新标签页启动器

![Hermes Home 替换新标签页](docs/home-newtab.png)

### 全屏聊天 — 独立标签页

![全屏 Hermes 聊天页，含会话列表](docs/chat-fullscreen.png)

---

## 用 Hermes 安装（推荐）

**把下面整段复制**给 **Hermes Agent**：

```
请根据以下链接中的文档，在本机安装并配置 Hermes Browser Extension：

https://raw.githubusercontent.com/iHeyTang/hermes-my-browser-extension/main/docs/AGENT_INSTALL.md
```

---

## 安装好之后怎么用

简明说明见 [`after-install.md`](./after-install.md)。

打包、bridge、与 Hermes 集成细节见 [`DEVELOPER.md`](./DEVELOPER.md)。

## 卸载

```bash
hermes plugins remove hermes-my-browser-extension
"${HOME}/.hermes/hermes-agent/venv/bin/python" -m pip uninstall hermes-my-browser-extension
```

并在 `chrome://extensions/` 中移除扩展。

## 许可证

MIT
