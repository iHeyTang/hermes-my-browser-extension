# Hermes Browser Extension — 安装说明（给 Hermes Agent 执行）

> **Canonical raw URL（README 整段里末尾的安装文档链接）：**  
> `https://raw.githubusercontent.com/iHeyTang/hermes-my-browser-extension/main/docs/AGENT_INSTALL.md`

你是操作用户本机的助手。用户已在使用 Hermes。请**先完整阅读本文**，再按顺序执行；任一步失败时根据终端输出排错，并向用户说明原因与已做修改。

---

## 0. 先决条件

在终端中确认可用（版本满足即可，不必完全一致）：

- `hermes`（Hermes CLI）
- `node` ≥ 20、`pnpm`
- Google Chrome 或 Chromium（用户稍后需在浏览器里手动点几下）

若有缺失，列出缺项并请用户安装后再继续。

---

## 1. 安装插件目录 + Python 依赖（一条命令）

在用户 shell 中执行（`&&` 连接的两行是一条命令）：

```bash
hermes plugins install iHeyTang/hermes-my-browser-extension && \
  "${HOME}/.hermes/hermes-agent/venv/bin/python" -m pip install -e "${HOME}/.hermes/plugins/hermes-my-browser-extension"
```

若第二步报错没有 `pip`，先执行一次：

```bash
"${HOME}/.hermes/hermes-agent/venv/bin/python" -m ensurepip --upgrade
```

然后**重新执行**上面整条 `hermes plugins install && … pip install -e …`。

（可选）若用户已克隆本仓库且插件目录已存在，也可在仓库根目录执行：`bash scripts/bootstrap-hermes-python.sh` 或 `bash scripts/bootstrap-hermes-python.sh "$(pwd)"`（等价于对指定目录 `pip install -e`）。

---

## 2. 在 Hermes 里启用该插件

```bash
hermes plugins enable hermes-my-browser-extension
```

若用户希望用交互界面，可说明其也可运行 `hermes plugins` 勾选启用。

---

## 3. 构建 Chrome 扩展（前端）

```bash
cd "${HOME}/.hermes/plugins/hermes-my-browser-extension/extension" && pnpm install && pnpm build
```

成功标志：存在目录  
`~/.hermes/plugins/hermes-my-browser-extension/extension/build/chrome-mv3-prod/`  
（路径写全称时用 `$HOME` 展开）。

---

## 4. Chrome 中「加载已解压扩展」（必须由用户点击完成）

你无法替用户点 Chrome UI。请**明确告诉用户**：

1. 打开 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择文件夹：  
   `~/.hermes/plugins/hermes-my-browser-extension/extension/build/chrome-mv3-prod`

完成后用户应能在工具栏看到扩展图标。

---

## 5. Gateway：写入 `~/.hermes/.env` 并重启

若 `~/.hermes/.env` 中尚未配置下列项，请用终端**追加**（勿覆盖用户已有其它配置；若已存在同名变量则不要重复追加）：

```bash
{ echo 'API_SERVER_ENABLED=true'
  grep -q '^API_SERVER_KEY=' "${HOME}/.hermes/.env" 2>/dev/null || echo "API_SERVER_KEY=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)"
  grep -q '^API_SERVER_CORS_ORIGINS=' "${HOME}/.hermes/.env" 2>/dev/null || echo 'API_SERVER_CORS_ORIGINS=*'
} >> "${HOME}/.hermes/.env"
hermes gateway restart
```

然后从 `~/.hermes/.env` 读出 **`API_SERVER_KEY` 的实际值**，告诉用户：

- 打开扩展 **选项 → Settings**
- 将 **API key** 字段设为与 `API_SERVER_KEY` **完全相同**
- （如需要）在 Settings 里用 `@my_browser_chat_url` 或说明中的 base URL 填好 **API base URL**（通常形如 `http://127.0.0.1:8642/v1`）

---

## 6. 连接与验证

请用户：

1. 执行或确认已执行：`hermes gateway restart`
2. 点击扩展图标打开侧边栏，在状态条上点 **● 离线** 直到变为 **● 在线**
3. 在 Hermes 里试：`@my_browser_connect`，再 `@my_browser_navigate url=https://example.com`，再 `@my_browser_get_text selector=h1`

若侧栏对话报 401/403，优先检查 `API_SERVER_KEY` 是否与扩展 Settings 一致、以及 `API_SERVER_CORS_ORIGINS=*` 是否已写入并重启 gateway。

---

## 7. 汇报

结束时用简短条目列出：已执行的命令、Chrome 是否已加载扩展、`.env` 是否已追加、用户还需手动完成的事项（若有）。

---

更多「装好之后怎么用」：  
https://github.com/iHeyTang/hermes-my-browser-extension/blob/main/after-install.md  

架构与打包：  
https://github.com/iHeyTang/hermes-my-browser-extension/blob/main/DEVELOPER.md
