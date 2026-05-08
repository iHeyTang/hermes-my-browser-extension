# hermes-my-browser-extension

让 Hermes Agent 在你**正在用的同一个 Chrome 浏览器**里干活——不需要 `--remote-debugging-port`，不需要重启浏览器，**也不会有"正在调试此浏览器"的提示条**，更**不会抢你正在用的标签页焦点**。

## 设计

```
你的 Chrome 浏览器 (一个 profile)
├── 主窗口 (你在用)               ← Hermes 永远不碰
│   ├── tab: GitHub
│   ├── tab: 文档
│   └── tab: 邮箱  ← active
└── Agent 窗口 (Connect 时新开)    ← Hermes 只在这里操作
    └── tab: 当前任务页
```

实现：扩展全程使用 `chrome.tabs` / `chrome.scripting` / `chrome.cookies` 这些常规 API，**完全不用 `chrome.debugger`**。所以：

- ❌ 没有"扩展正在调试此浏览器"提示条
- ❌ 不抢焦点（截图、点击、跑 JS 都在 agent 窗口里完成）
- ❌ 不动你主窗口的任何 tab
- ✅ 共享同一个 profile（cookies / 登录态 / 收藏夹都在）

数据流：

```
Hermes 工具 ──ws──► bridge/server.py ──ws──► 扩展 background.js ──► chrome.tabs/scripting/cookies
       (intent JSON)        (轻量 relay)                      (操作 agent 窗口/tab)
```

## 安装

```bash
hermes plugins install <YOUR_USER>/hermes-my-browser-extension
```

装完会自动渲染 [`after-install.md`](./after-install.md) 的指引——按里面三步走（装 `websockets`、加载 Chrome 扩展、`hermes gateway restart`）就能用了。

> 想换源 / 私有仓库时，identifier 也接受完整 git URL：
> `hermes plugins install git@github.com:foo/hermes-my-browser-extension.git`

## 工具

| 工具 | 功能 |
|------|------|
| `my_browser_connect` | 打开/接管 agent 窗口（不抢焦点） |
| `my_browser_disconnect` | 关掉 agent 窗口、断开 bridge |
| `my_browser_status` | bridge 连接状态 + agent 窗口 URL/title |
| `my_browser_navigate` | 在 agent tab 里跳转 URL，默认等加载完成 |
| `my_browser_screenshot` | 截 agent tab 视口（PNG/JPEG） |
| `my_browser_eval` | 在 agent tab 里跑 JS，返回结果 |
| `my_browser_click` | 按 CSS selector 点击元素 |
| `my_browser_type` | 按 selector 输入文本（触发 input/change 事件） |
| `my_browser_get_html` | 拿 outerHTML（整页或选定元素） |
| `my_browser_get_text` | 拿 innerText（整页或选定元素） |
| `my_browser_session_save` | 保存 cookies + localStorage 快照 |
| `my_browser_session_restore` | 恢复指定快照 |

## 取舍

相对于"用 chrome.debugger 透传 CDP"的实现：

**得**：
- 用户主窗口零打扰，零提示条
- 截图不抢焦点（`chrome.tabs.captureVisibleTab` 在 agent 窗口里独立工作）
- 多窗口隔离干净

**失**：
- 不再支持任意 CDP 命令（`Network.setRequestInterception`、`Emulation.*`、Performance trace 这些没有了）
- 截图退化成 viewport（不是全页）
- 严格 CSP 页面 `my_browser_eval` 默认会被拒（用 `world="ISOLATED"` 解决大部分情况）

如果你需要完整 CDP 能力，请用直接走 `chrome --remote-debugging-port` 那条路（不在本插件范围）。

## 卸载

```bash
hermes plugins remove hermes-my-browser-extension
# 同时在 chrome://extensions/ 里移除扩展
```

## 本地开发

软链 + enable，改动免重装：

```bash
ln -sf "$(pwd)" ~/.hermes/plugins/hermes-my-browser-extension
hermes plugins enable hermes-my-browser-extension
hermes gateway restart
```

调试日志：
- bridge 端：`~/.hermes/logs/my-browser-bridge.log`
- 扩展端：`chrome://extensions/` → 找到 Hermes Browser Bridge → 点击 service worker

## 依赖

- Hermes Agent ≥ 0.11.0
- `websockets >= 12`（用 Hermes 的 venv 装：`~/.hermes/hermes-agent/venv/bin/pip install 'websockets>=12'`）
- Chrome / Chromium（开发者模式加载 `extension/`）

## License

MIT
