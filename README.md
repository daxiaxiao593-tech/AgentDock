# AgentDock

Windows AI 工作台。在同一个 Electron 窗口中管理 Codex、Antigravity 和 Claude Code 的真实终端，支持独立项目目录和同工具多会话。仓库同时保留第一阶段的可交互 Mock 与浏览器调试入口。

## 预览

直接用 Chrome 或 Edge 打开 [AgentDock Mock](Demo/agent-dock-mock.html)，也可双击根目录的 `预览 AgentDock.cmd`。无需安装依赖、构建或启动服务器。

首次打开显示两个项目、三个模拟会话。以后恢复浏览器保存的会话配置；刷新仅自动启动勾选的模拟会话，不恢复旧输出或重发指令。不同浏览器、用户资料及文件位置的存储相互独立。

已支持：按独立目录归组、新建与切换、后台输出和未读、草稿与滚动位置、启动/停止/移除/启动全部、随应用启动、配置保存及失败提示。会话菜单的“模拟故障与退出”用于体验启动失败、停止失败和异常退出。

## 真实 CLI 终端原型

在 Windows 终端运行：

```powershell
npm run terminal -- --cwd "D:\your\workspace"
```

打开命令输出的本机地址，左侧项目树提供 Codex、Antigravity、Claude Code 三条初始会话，均绑定命令指定的目录。可分别启动、停止和切换；同时使用该目录时可能修改同一文件。浏览器入口用于调试，原生目录选择与持久配置请使用桌面版。AgentDock 不预填任务或确认文本，也不修改 CLI 登录、模型、API 或权限配置。

CLI 启动依赖本机可解析到 `codex.exe`、`agy.exe`、`claude.exe`；AgentDock 不安装或配置这些 CLI。

## Windows 桌面版

### 使用

1. 安装后**双击**桌面 `AgentDock` 快捷方式。
2. 点击左侧 `+`，选择工具、工作目录和会话名称，再点击“创建并启动”。同一种工具可以创建多条会话。
3. 单击左侧会话切换画面，其他会话继续运行。每条会话绑定自己的目录；同一项目内多会话可能同时修改同一文件。
4. 要更改现有会话的目录，先停止该会话，再打开“会话设置” → “更改此会话目录…”。只移动这一条会话到对应项目组，其他会话继续留在各自目录。
5. 一个会话运行时想在另一个目录继续工作，点击顶部“在其他目录新建会话”，选择目录后创建；原会话会继续运行在原目录。
6. “启动全部”启动所有未运行会话；“停止”和运行中的“移除”需确认。移除会话保留项目文件。

“打开 AgentDock 时启动此会话”指每次打开软件后自动启动这一条会话。设置会保存，其他未勾选的会话保持未启动。使用安装版无需先打开终端、IDE 或开发服务器，也不依赖 Windows Terminal。

同一窗口内切换会话保留终端画面、草稿和滚动位置。断线重连会保留当前页面已显示内容，并标明无法恢复的缺失输出；不会重新发送输入。关闭应用或重载页面后不能还原旧画面。重启会话会保留有界的旧输出并加分隔线；备用屏幕仅归档末屏文字，CLI 主动清除历史仍可能移除它。

### 构建

构建 Windows x64 安装包需使用仓库锁定的 Node.js `24.22.0` 与 npm `11.11.0`，并安装 node-pty 原生构建所需的 Python 和 Visual Studio C++ Build Tools：

```powershell
npm ci
npm run dist:win
```

安装包输出到 `dist\AgentDock-Setup-<version>.exe`。安装时会在 Windows 当前用户的 Desktop Known Folder 创建 `AgentDock` 快捷方式；安装后的入口固定为 `AgentDock.exe`。用户需自行安装要使用的 CLI，并按其自身说明完成登录或 API 配置；AgentDock 不自动安装或配置这些工具。

AgentDock 设置保存在 Windows 用户配置目录中，升级会沿用该设置；0.2.5 已实测卸载与重装，workspace、项目及 CLI 用户数据目录的元数据保留。卸载检查期间仍有 Codex 进程，Codex 目录大小增加 5,814 bytes；只比较元数据，未读取文件内容，因此不代表所有数据逐字节不变。当前构建未配置代码签名，Windows 可能显示未识别发布者提示。安装包包含 [第三方组件版本与许可说明](THIRD-PARTY-NOTICES.md)。

## 文档与验证

- [现行方案索引](docs/README.md)：五份原文快照、资料来源和优先级。
- [实施方案](docs/current/02-实施方案.md)：当前架构、约束、验收范围和阶段进度。
- [开发记录](docs/开发记录.md)：实施范围、取舍和后续接入门槛。
- [后续开发交接与建议](docs/后续开发交接.md)：当前版本基线、待办优先级和交接阅读顺序。
- [Mock 验收](验收/Mock验收.md)：实际测试结果和已知限制。
- `npm test`：安装依赖后，验证状态、独立目录、配置迁移、输出流控与迟到事件隔离。
- `npm run test:desktop`：顺序运行两项桌面生命周期和三项真实多会话集成，使用隔离配置及受控原生测试 CLI。覆盖 xterm、ConPTY、Windows 剪贴板、重连、重启和项目文件保留，不调用真实 AI。可通过 `AGENTDOCK_TEST_EXECUTABLE` 指定打包后的 EXE，复用整组验收；默认使用开发态 Electron。
- `npm run verify:package`：检查安装资源、包版本和源码哈希，并用随包 Node 实际加载匹配 ABI 的 node-pty。
- `npm run test:browser`：Playwright + 本机 Chrome 验证页面实际交互；开发环境需能 `require('playwright')`，或设置 `AGENTDOCK_PLAYWRIGHT_PATH` 指向已有 Playwright 包目录。测试使用独立临时浏览器上下文，结果写入忽略的 `test-results/`。

根目录五份原资料、`历史版本/`、`讨论记录/` 和 `Demo/agent-desk-demo.html` 保持原样。旧原型不是本轮交付入口。原资料暂用名 Agent Desk 对应产品 AgentDock。

Agent Workbench 固定版本复用实验、Electron 桌面外壳、EXE、桌面快捷方式和单实例验收记录见现行实施方案与开发记录。
