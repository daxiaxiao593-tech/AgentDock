# AgentDock 第三方组件与许可

安装包依赖的版本由根目录 `package-lock.json` 固定。安装后的 `resources/THIRD-PARTY-NOTICES.md` 与本文件内容相同；组件原始许可文件也随组件资源保留。Node.js 的版本化许可文件位于 `resources/agentdock-runtime/LICENSE`。Electron 发行包中的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html` 随 Electron 文件一并分发。

## 安装后包含的组件

| 组件 | 上游版本 | 许可 | 上游 / 说明 |
|---|---:|---|---|
| Electron | 44.9.0 | MIT；Chromium 组件许可见随包 `LICENSES.chromium.html` | [electron/electron](https://github.com/electron/electron) |
| Node.js Windows x64 Runtime | 24.22.0 | MIT 及 Node.js 发行包所列第三方许可 | [nodejs/node v24.22.0](https://github.com/nodejs/node/tree/v24.22.0)；版本化许可文件随包提供 |
| node-pty | 1.1.0 | MIT | [microsoft/node-pty v1.1.0](https://github.com/microsoft/node-pty/tree/v1.1.0)；保留其包内许可文件 |
| xterm.js | 6.0.0 | MIT | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) |
| xterm.js Fit Addon | 0.11.0 | MIT | [xtermjs/xterm.js addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) |
| ws | 8.22.0 | MIT | [websockets/ws](https://github.com/websockets/ws) |

## 构建工具

| 工具 | 锁定版本 | 许可 | 是否随安装后的应用运行 |
|---|---:|---|---|
| npm | 11.11.0 | npm 项目自身许可 | 否，仅构建时使用 |
| electron-builder | 26.15.3 | MIT | 否，仅构建时使用 |
| NSIS | 3.0.4.1 | zlib/libpng；随该发行包启用的 LZMA 模块依照 CPL 1.0 | 仅安装器引导程序包含；不安装到应用目录 |

Node.js 许可文件来自 [nodejs/node v24.22.0](https://github.com/nodejs/node/blob/v24.22.0/LICENSE)，并随包复制。Electron 二进制随包保留 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。NSIS 许可条款见其[官方许可附录](https://nsis.sourceforge.io/Docs/AppendixI.html)。

## 本项目的上游改动与来源

- `node-pty@1.1.0` 使用 `patches/node-pty+1.1.0.patch`。改动为：Windows ConPTY 所属进程树使用 Job Object 清理；移除按控制台 PID 列表清理的路径；增加原生模块能力标记和句柄同步。补丁用于限制清理范围到 AgentDock 创建的 Job Object。
- `node-pty` 由锁定的 Node.js `24.22.0` 运行时构建，Node module ABI 为 `137`；打包阶段关闭 Electron ABI 原生模块重编，避免覆盖服务运行时所需的模块。
- Agent Workbench 固定审计版本为 `856cc9713322875be02fda730f10de78ac95b1aa`（`0.6.0`，MIT）。复用边界报告裁定不采用整体 fork；其源码未复制到 AgentDock。
- AgentDock 安装器、桌面外壳与服务资源布局由本项目维护；未包含 Codex、Antigravity 或 Claude Code 的程序、历史、认证资料或配置。

## 工具识别图标与商标

以下图标仅在会话列表中识别相应第三方工具。AgentDock 的主品牌仍为 AgentDock；这些图标不表示任何权利方与 AgentDock 存在合作、赞助或背书关系。图标及相关商标的权利归各自权利方，不因随本项目提供而转为本项目所有或适用本项目代码许可。

| 图标 | 权利方 | 官方来源与处理 |
|---|---|---|
| OpenAI Blossom（Codex 会话） | OpenAI | 从 [OpenAI Codex 官方开发者页](https://developers.openai.com/codex) 提取原始 inline SVG，保留原始字节；仅以 CSS 将默认黑色显示为白色。遵循 [OpenAI 品牌与商标使用说明](https://openai.com/brand/)，不作为 AgentDock 主标识。 |
| Antigravity 全彩标识 | Google LLC | [官方新闻素材](https://antigravity.google/press)提供的 [Full Color SVG](https://antigravity.google/assets/image/brand/antigravity-icon__full-color.svg)，未修改图形或颜色。 |
| Claude Spark（Claude Code 会话） | Anthropic PBC | [Anthropic 官方媒体包](https://anthropic.com/press-kit)中的 `Claude Spark - Clay.svg`，未修改图形或颜色；媒体包入口来自 [Anthropic Newsroom](https://www.anthropic.com/news)。 |
| AgentDock 主界面图标 | Electron 项目 | 从本项目既有 Windows EXE 内嵌的 Electron 默认应用图标资源提取并保存为 64×64 PNG，用于左侧栏品牌图标；未重绘图形。Electron 随包许可文件见上文。 |

取得日期：2026-10-19。三份原始 SVG 均以 Base64 嵌入本地样式表，无运行时外部请求，无图形重绘或格式转换。Claude 资源在官方媒体包中的路径为 `Anthropic media resources/Anthropic logos/Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg`。

原始 SVG 字节的 SHA-256：

```text
OpenAI      468ebe03b0504e3e40be53e6c1f4b5b80c00d94ea4ad07b913ae41073638ae90
Antigravity d775965ea1f8060538c15f758a3e22487317211fcb6051333b5e023f35aa726f
Claude      6d53db4be375e899c937c26cf16684a80d6e869b1928d72b37748bef2560e219
```
