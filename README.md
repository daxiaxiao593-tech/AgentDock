# AgentDock

Windows AI 工作台。仓库保留第一阶段**可交互 Mock**，并提供一个浏览器版真实 CLI 终端原型，可从同一界面启动 Codex、Antigravity 和 Claude Code。

## 预览

直接用 Chrome 或 Edge 打开 [AgentDock Mock](Demo/agent-dock-mock.html)，也可双击根目录的 `预览 AgentDock.cmd`。无需安装依赖、构建或启动服务器。

首次打开显示两个项目、三个模拟会话。以后恢复浏览器保存的会话配置；刷新仅自动启动勾选的模拟会话，不恢复旧输出或重发指令。不同浏览器、用户资料及文件位置的存储相互独立。

已支持：按独立目录归组、新建与切换、后台输出和未读、草稿与滚动位置、启动/停止/移除/启动全部、随应用启动、配置保存及失败提示。会话菜单的“模拟故障与退出”用于体验启动失败、停止失败和异常退出。

## 真实 CLI 终端原型

在 Windows 终端运行：

```powershell
npm run terminal -- --cwd "D:\your\workspace"
```

打开命令输出的本机地址，即可在 Codex、Antigravity、Claude Code 三个标签间切换。每个标签拥有独立运行会话，三个会话可同时运行；启动按钮只启动当前标签，停止按钮只停止当前标签。三个 CLI 共用命令指定的工作目录，同时运行时可能修改同一文件。AgentDock 不预填任务或确认文本，也不修改 CLI 登录、模型、API 或权限配置。

CLI 启动依赖本机可解析到 `codex.exe`、`agy.exe`、`claude.exe`；AgentDock 不安装或配置这些 CLI。

## Windows 桌面版

开发态桌面外壳可用 `npm run desktop` 启动；安装包与桌面快捷方式属于任务 5，尚未实施。

## 文档与验证

- [现行方案索引](docs/README.md)：五份原文快照、资料来源和优先级。
- [开发记录](docs/开发记录.md)：实施范围、取舍和后续接入门槛。
- [Mock 验收](验收/Mock验收.md)：实际测试结果和已知限制。
- `npm test`：Node 内置测试运行器验证状态、目录、配置及迟到事件，不需要 `npm install`。
- `npm run test:browser`：Playwright + 本机 Chrome 验证页面实际交互；开发环境需能 `require('playwright')`，或设置 `AGENTDOCK_PLAYWRIGHT_PATH` 指向已有 Playwright 包目录。测试使用独立临时浏览器上下文，结果写入忽略的 `test-results/`。

根目录五份原资料、`历史版本/`、`讨论记录/` 和 `Demo/agent-desk-demo.html` 保持原样。旧原型不是本轮交付入口。原资料暂用名 Agent Desk 对应产品 AgentDock。

Agent Workbench 固定版本复用实验与 Electron 桌面外壳见现行实施方案与开发记录；安装包和桌面快捷方式待任务 5。
