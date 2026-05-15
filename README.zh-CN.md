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

## Inbox —— 跨 channel 的统一产出层

新标签页的 **Inbox** 是本扩展给 Hermes 核心补的一层：Hermes 自己能跑定时
任务、能在飞书/Telegram/Slack 等多个 channel 收发消息，但**没有内建机制
让一个 channel 的 agent 看到另一个 channel 产生的东西**。Inbox 就是这个
缺口的答案——它是一个由本插件托管的统一公告板，写进来的东西在新标签页
UI 和**任意 Hermes session（通过下面三个工具）**都能读到。

三个独立层次——**Inbox 是聚合层，不是存储**：

```
   独立机制                              聚合层              消费方
   (各自持有存储)                       (本插件)

  ┌─────────────────────────┐                                ┌─────────────────┐
  │ Cronjob 机制            │                                │ 新标签页 Home   │
  │  (Hermes 核心持有)      │                                │ (渲染卡片)      │
  │                         │                                └─────────────────┘
  │ 存: $HERMES_HOME/       │ ──►                                     ▲
  │   cron/output/{job}/    │     ┌──────────────────────┐            │
  │   *.md                  │     │                      │            │
  └─────────────────────────┘     │  Inbox 聚合层        │ ───────────┤
                                  │  (本插件)            │            │
  ┌─────────────────────────┐     │                      │   ┌────────┴────────┐
  │ Agent 卡片机制          │ ──► │  - 读所有源          │   │ 任意 channel 里 │
  │  (本插件持有，与         │     │  - 合成统一卡片流    │   │ 的 Agent        │
  │   cronjob 平级)         │     └──────────────────────┘   │ (my_browser_    │
  │                         │                                │  inbox_list/    │
  │ 写: my_browser_         │                                │  read 工具)     │
  │   card_push 工具        │                                └─────────────────┘
  │ 存: $HERMES_HOME/       │
  │   agent_cards/          │
  │   cards.json            │
  └─────────────────────────┘
```

### 什么会进 Inbox

1. **每一次 cron 运行，自动进入。** Hermes 始终把每次运行的 markdown 写到
   `$HERMES_HOME/cron/output/{job_id}/{时间戳}.md`；扩展索引这个目录，
   把每一条运行结果折进 Inbox，**与 `deliver` 字段无关**。`deliver` 只
   控制在 Inbox 之上**额外**推送到哪个 channel（飞书 / Telegram / …）。
2. **Agent 卡片** —— 通过 `my_browser_card_push`。这是一个**独立机制**
   （概念上跟 cronjob 平级，**不属于 Inbox 内部**）：Hermes 进程里任何
   地方都能给用户留一张结构化卡片，存到 `$HERMES_HOME/agent_cards/cards.json`。
   Inbox 只是聚合这个源的一个消费者，未来其他消费者（比如飞书机器人定时
   摘要）也可以读同一个源。

### Agent 工具（跨 channel）

三个工具注册在 `my-browser-extension` toolset 下，只要本插件启用，**任意
channel 的 Hermes session 都可用**：

- **`my_browser_card_push`** —— 给用户留一张结构化卡片
  （headline + tldr + actions + urgency）。**这是 agent-cards 机制的写口，
  不是 Inbox 的写口**——卡片写到 `$HERMES_HOME/agent_cards/`，Inbox 作
  为其中一个聚合消费者会读到它。在事后想让用户知道某件事时主动调用。
- **`my_browser_inbox_list`** —— 翻 Inbox 列表。可按 `kind`
  （cron-result / agent-card / all）、`source` 子串、`since_ms` 游标、
  `limit`、`include_silent` 过滤；返回单行预览，session 可以据此决定
  要打开哪一条。
- **`my_browser_inbox_read`** —— 用 id 拉取某条的完整内容。cron 条目
  返回完整运行 markdown；agent 卡片返回完整结构化 synthesis。

典型用法（飞书 session 里）："今早那些 cron 跑出啥了？" → Agent 调
`inbox_list` 传一个早上的 `since_ms` → 选几条用 `inbox_read` 读详细 →
汇报回来。**不需要文件系统访问**，工具直接读 `$HERMES_HOME`。

### 新标签页 UI

Home 页左栏把 Inbox 渲染成卡片流：未读的浮到顶部、错误带强调左边框、
点开一张卡直接显示完整内容。Cron 卡片显示**完整运行原文**（不截断、
不再依赖"Hermes Card" 合成块）；Agent 推送的卡片显示其结构化 synthesis。

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
