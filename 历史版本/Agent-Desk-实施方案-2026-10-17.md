# Agent Desk Implementation Plan

> **For agentic workers:** 实施时使用 superpowers:executing-plans，按任务执行与核验；本轮仅交付方案，不启动实现。

**Goal:** 先交付可体验的三工具 Mock 工作台，再按验证结果接入本机真实 CLI。

**Architecture:** 项目由目录标识，会话独立选择并绑定项目。Mock 使用浏览器内状态与计时器；真实版本由 Electron 主进程管理独立 PTY，渲染进程展示项目树和 xterm，通过受限 IPC 转发输入、输出和尺寸变化。

**Tech Stack:** 第一阶段 HTML / CSS / JavaScript / localStorage；第二阶段 Electron / React / TypeScript / xterm.js / node-pty / JSON。版本在兼容性实验后固定，保存锁文件。

**Spec:** [产品与交互设计稿](./Agent-Desk-产品与交互设计稿-2026-10-17.md)。实施时必须同时阅读。

## Global Constraints

- 首版面向用户当前 Windows 电脑，仅支持 `codex`、`agy`、`claude`。
- 每次创建会话独立选目录，按目录自动归组；创建后不改变该会话 cwd。
- 项目和会话全部在左侧；切换会话不停止后台会话。
- Mock 必须持续显示“模拟演示”，不启动真实 CLI、不读项目内容。
- 复用 CLI 现有认证；不复制密钥、不接自建模型网关、不新增云后端。
- 应用重开恢复配置与启动进程，不自动续聊或重发历史指令。
- 首版不持久化终端全文，不做托盘、守护进程、编辑器、分屏或团队协作。
- 终端回滚上限 5000 行；真实桌面最小窗口 960×640。
- 本轮只新增文稿，现有 Demo 未修改；下列文件和命令都是未来实施计划。

## Review Focus

| 高风险条件 | 用户应看到的行为 | 负责验证的任务 |
|---|---|---|
| A 发出请求后立即切到 B | A 输出只落在 A，不抢 B 焦点 | 任务 1、4 |
| 停止后迅速重新启动 | 旧运行的迟到事件不能污染新运行 | 任务 1、4 |
| 中文、空格、同名目录、失效路径 | 目录归组正确；启动位置准确；不存在则报错 | 任务 1、3 |
| 同时开启两个同种 CLI | 进程和输入互不干扰，停止一方不误杀另一方 | 任务 3、5 |
| TUI 重绘、缩放、中文输入法 | 无串行、错位、双重输入或滚动跳动 | 任务 3、4 |

## 1. 实施顺序与交付门槛

```text
任务 1：修正 Mock → 任务 2：完整交互验收 → 用户体验反馈
                                               ↓
任务 3：Windows PTY 实验 → 任务 4：真实桌面壳 → 任务 5：保存、退出与打包
```

任务 1–2 是下一步范围。任务 3–5 是后续路线，不能把“能看模拟界面”当成真实 CLI 接入完成。

| 阶段 | 可交付成果 | 进入下一阶段的条件 |
|---|---|---|
| Mock | 一份可直接预览的 HTML，三种模拟终端，完整生命周期与配置恢复 | 产品稿第 7 节验收通过，收集用户体验反馈 |
| 兼容性实验 | 三种本机 CLI 的启动、输入、resize、退出证据 | 当前电脑可用，终端退出不遗留本应用任务进程 |
| 真实桌面 | 同样交互的独立 Windows 窗口 | 配置恢复、独立会话、原生选目录与安装包验证通过 |

## 2. 文件与职责

第一阶段保留单文件交付，不先建立完整桌面工程：

```text
outputs/agent-desk-demo.html              布局、Mock 状态、交互、配置保存
work/qa/demo-interaction-results.md       手工与浏览器交互验收结果
```

HTML 内明确分为 `state`、`mockRuntime`、`persistence`、`render` 四块；不继续让散落的 DOM 回调持有过期会话对象。

第二阶段验证通过后，创建独立工程：

```text
agent-desk/
  package.json                           开发、构建、打包与测试命令
  src/shared/contracts.ts                会话定义、状态、事件、IPC 类型
  src/main/main.ts                       Electron 窗口及应用生命周期
  src/main/cli-launcher.ts               解析三种命令与构建启动参数
  src/main/projects.ts                   原生选目录与目录身份校验
  src/main/sessions.ts                   PTY 生命周期和进程清理
  src/main/settings.ts                   配置读写
  src/preload/index.ts                   白名单桥接 API
  src/renderer/App.tsx                   布局、左侧树与会话操作
  src/renderer/NewSessionDialog.tsx      工具与目录选择
  src/renderer/TerminalPane.tsx          xterm 实例、输入、resize、焦点
  src/renderer/state.ts                  按 ID 管理配置与运行状态
  src/renderer/styles.css                产品稿视觉规范
  tests/session-routing.test.ts          串台和迟到事件回归
  tests/projects.test.ts                 目录绑定与规范化
  tests/settings.test.ts                 保存恢复与无效路径
  tests/windows-pty-smoke.md              当前机器/版本/三种 CLI 实测记录
```

## 3. 数据与接口约定

以下是第二阶段共享 TypeScript 类型；第一阶段使用同名字段的普通 JS 对象。运行状态与保存配置分离。

```ts
type AgentKind = 'codex' | 'agy' | 'claude';
type SessionStatus =
  | 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

interface Project {
  id: string;
  name: string;
  rootPath: string;
  pathKey: string;
}
interface SessionDefinition {
  id: string;
  projectId: string;
  agent: AgentKind;
  name: string;
  launchOnOpen: boolean;
}
interface SavedWorkspace {
  schemaVersion: 1;
  projects: Project[];
  sessions: SessionDefinition[];
  activeSessionId: string | null;
}
interface SessionRuntime {
  sessionId: string;
  runId: string;
  status: SessionStatus;
  exitCode?: number;
  error?: string;
}
type TerminalEvent =
  | { type: 'data'; sessionId: string; runId: string; data: string }
  | { type: 'state'; runtime: SessionRuntime };
```

- `rootPath` 固定；`session.projectId` 固定。创建时先找到或创建项目，再绑定会话。
- 保存 `SavedWorkspace`，不保存 PID、进程句柄、运行状态、终端输出或登录信息。
- 每次启动生成新的 `runId`。所有异步输出和退出事件按 `sessionId + runId` 匹配，不能查“当前激活会话”再写入。
- 每个 Mock 会话持有自己的输出与草稿；真实版持有自己的 Terminal 实例。切换只改变可见项。
- 重复启动应幂等：starting / running / stopping 期间不创建第二个运行实例。

真实版 preload 仅暴露：

```ts
interface DesktopBridge {
  chooseDirectory(): Promise<string | null>;
  loadWorkspace(): Promise<SavedWorkspace | null>;
  saveWorkspace(value: SavedWorkspace): Promise<void>;
  start(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  write(sessionId: string, runId: string, data: string): void;
  resize(sessionId: string, runId: string, cols: number, rows: number): void;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
}
```

主进程从已验证配置读取 Agent 与 cwd，不允许渲染层传入任意 shell 命令。状态改变由事件通知；`start()` 返回不等于 CLI 已登录。`stop()` 在目标运行完成清理后才 resolve；失败则 reject，界面显示原因。

## 4. 任务 1：修正模拟会话与目录逻辑

**文件：**修改 `outputs/agent-desk-demo.html`。

**接口：**`createSession({agent, directory, name, launchOnOpen}) → sessionId`；`startSession(sessionId)`；`stopSession(sessionId)`；`removeSession(sessionId)`；`selectSession(sessionId)`；`emit(event)`。Mock 方法由按钮调用，输出统一经 `emit` 路由。

- [ ] 先重现现有 Demo 的四个问题：活动会话浅拷贝、共享目录被修改、延迟输出串台、“更换目录”实际创建会话但文案不清晰；记录前后复现步骤。
- [ ] 将项目和会话按 ID 存储；创建时独立输入目录，相同规范化模拟目录归入同组，取消修改共享 project.path 的逻辑。
- [ ] 建立 `mockRuntime`，按会话保存计时器和 runId；停止取消计时器，迟到事件核对 runId 后丢弃。
- [ ] 接通新建、选择、启动、停止、移除和“启动全部”；设置 starting / running / stopping / stopped 的可见反馈与按钮禁用态。
- [ ] 完成搜索、展开、选中、后台输出提示、输入草稿与滚动位置保留；新输出不抢焦点。
- [ ] 顶栏目录操作改为“在其他目录新建会话”；Mock 选目录明确标注模拟，移除对上传文件夹控件的依赖。
- [ ] 用 localStorage 保存 `SavedWorkspace`，区分“没有保存记录”和“已保存空列表”；保存失败提示用户。
- [ ] 检查 Mock 标签、运行状态文案和示例内容，去掉伪真实额度、版本、提交或测试成功声明。

**验证：**在浏览器执行产品稿第 7 节的 8 个步骤；特别重复“发送→切换”和“停止→重启”各 5 次，确认无串台和迟到写入。页面刷新保留配置，运行状态重新生成。

**独立交付：**继续是一份可预览 HTML，任何操作都不启动本机 CLI。

## 5. 任务 2：交互验收与反馈

**文件：**`work/qa/demo-interaction-results.md`；如发现缺陷，只修改 Demo 对应逻辑。

**接口：**使用任务 1 的可见 UI，不添加新功能。

- [ ] 在 1440×900、960×640 检查布局；浏览器窄屏可通过按钮打开项目侧栏。
- [ ] 用 `D:\项目\我的网站`、`D:\Other\我的网站` 验证同名项目的区分和长路径展示。
- [ ] 验证新建取消、重复点击启动、停止取消、删除当前项与最后一项、搜索无结果。
- [ ] 验证键盘焦点、模态框关闭后焦点返回触发按钮、文字状态与颜色同时存在。
- [ ] 记录每项通过/失败及截图；修正失败项后只重测相关操作。
- [ ] 打开 Demo 给用户体验；根据反馈决定是否调整布局及进入真实接入。

**通过条件：**核心 8 步全部通过，无阻断交互；报告明确所有输出均为模拟，未验证真实 CLI。

## 6. 任务 3：Windows 与三种 CLI 兼容性实验

**文件：**先在 `work/pty-spike/` 做小实验，通过后形成 `agent-desk/src/main/cli-launcher.ts`、`projects.ts` 和 `tests/windows-pty-smoke.md`。

**接口：**`resolveLaunch(agent: AgentKind): Promise<{file: string; args: string[]}>`；`resolveProject(directory: string): Promise<Project>`。`cwd` 单独传给 PTY，不能拼接进 shell 命令字符串。

- [ ] 重查本机 CLI 的实际入口与版本。已发现 codex 是 PowerShell wrapper、claude 是原生 exe、agy 是本机 exe；这些是探测线索，不把旧版本路径硬编码进应用。
- [ ] 固定实验 Electron、node-pty 与 xterm 版本；验证原生模块 ABI、开发运行及打包加载。构建机可能需要编译工具，不能让用户安装包运行时临时编译。
- [ ] 使用稳定入口启动 CLI；exe 直接调用，必须使用脚本 shim 时使用可验证的脚本启动方式与参数引用规则。验证中文、空格及特殊字符路径不会改变参数含义。
- [ ] 规范化目录并检查存在性；处理盘符及末尾分隔符，验证同目录不会重复分组。遇到大小写敏感目录、链接路径时依据 Windows 实际文件身份处理，不能简单将整个路径小写。
- [ ] 分别测试三种 CLI 的交互启动、原生登录提示、回车、Ctrl+C、粘贴、中文输入和 resize；不擅自添加未验证的 resume/模型/权限参数。
- [ ] 同时开两个同种 CLI；对其中一个停止，确认另一个继续运行。另用可控测试子进程验证嵌套进程清理。
- [ ] 验证从桌面入口启动应用也能发现 CLI，缺失则显示明确错误，不能只在开发 shell 的 PATH 中可用。

**通过条件：**三种 CLI 均在目标目录可交互，打包可加载 PTY；本应用持有的目标进程树可以清理，其他终端不受影响。

**失败处理：**记录具体 CLI、版本和复现，不绕过权限或改变全局终端配置。某工具失败应单独报错，不把整个工作台标为可用。

## 7. 任务 4：接入真实终端与桌面界面

**文件：**工程文件结构中的 `contracts.ts`、`main.ts`、`sessions.ts`、`preload/index.ts` 以及 renderer 文件；`tests/session-routing.test.ts`、`tests/projects.test.ts`。

**接口：**完整实现第 3 节 `DesktopBridge`；复用任务 3 的目录与命令解析。

- [ ] 为输出路由写测试：A/B 独立写入、旧 runId 被忽略、重复 start 不增实例、删除会话后迟到事件不重建会话。先确认测试能捕获这些错误，再实现。
- [ ] 主进程建立 sessionId → PTY/运行状态映射，绑定 data/exit 事件并附加 runId；初始化后由主进程发送实际状态。
- [ ] preload 只暴露白名单接口，启用 contextIsolation、关闭 renderer 的 nodeIntegration；主进程校验 ID、状态及窗口来源。
- [ ] 将已确认的 Mock 布局搬到 React；目录选择使用原生对话框，不携带 Mock 生成输出的逻辑。
- [ ] 每个会话一个 xterm 实例，切换时隐藏而不销毁；设置 scrollback=5000，移除时释放订阅与实例。
- [ ] 在显示或窗口变化后执行 fit 并将 cols/rows 送往 PTY；后台隐藏容器不能计算成零尺寸。中文输入遵循 xterm 原生处理，不额外捕获并重复发送文本。
- [ ] Ctrl+C 只转发输入；停止触发明确的进程结束流程。等待退出与清理完成再置为 stopped；失败保留可读错误。

**验证：**工程定义 `npm test` 和 `npm run typecheck`，两者成功退出；随后按实验记录在真实三种 CLI 中复测切换、中文输入、resize、停止与双实例隔离。

## 8. 任务 5：保存、启动恢复、退出与打包

**文件：**`settings.ts`、`main.ts`、`tests/settings.test.ts`、`package.json` 的构建配置与使用说明。

**接口：**实现 `loadWorkspace()` / `saveWorkspace()`；应用关闭流程等待所有属于本应用的终端退出。

- [ ] 为配置读写建立测试：空列表不重置为示例、launchOnOpen 保留、无效目录不回退、运行时句柄不被保存。
- [ ] 配置写入 Electron userData 目录，采用临时文件后替换，写失败通知用户；不包含认证信息及终端全文。
- [ ] 应用启动加载定义，仅启动 launchOnOpen=true 的会话；不把上次 running 状态当成真实状态，不重放提示词。
- [ ] 关闭窗口有活动进程时显示确认，取消则保留窗口与进程；确认后清理本应用记录的进程树，失败则显示原因并提供重试，不静默退出留后台任务。
- [ ] 依据实验确定的机制完成 Windows 子进程清理；只针对本应用创建的进程，不按 codex/node 等名称批量终止。
- [ ] 构建本地安装包，从桌面入口启动并完成三种 CLI 实测，记录 Windows/CLI/依赖版本和退出结果。
- [ ] 附简短说明：如何选目录、开三种会话、启动全部、停止、重新打开，以及历史对话恢复边界。

**验证：**`npm test`、`npm run typecheck`、`npm run build`、`npm run dist` 均成功；再执行安装包实际启动与退出检查。构建成功本身不能代替安装包验收。

## 9. 方案评审结论与待验证项

本方案结合了与实际 Antigravity CLI 的两轮评审，采纳其会话隔离、持久化边界、路径和进程清理意见。我们进一步缩小为“目录即项目”，保留最少的操作。

已确认的是设计与本机命令存在；**尚未验证** node-pty 打包、三种 CLI 的完整 TUI 兼容性、Windows 子进程退出和稳定的 CLI 恢复参数。任务 3 专门解决这些问题，不在设计稿里做虚假承诺。

自检映射：布局与目录 → 任务 1/4；后台与生命周期 → 任务 1/3/4；保存与重开 → 任务 1/5；视觉与操作验收 → 任务 2；五类高风险场景均有对应验证。没有把完整真实应用建设混入下一步的 Mock 交付。

参考技术依据：[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[xterm.js](https://xtermjs.org/)、[node-pty](https://github.com/microsoft/node-pty)。实施时以选定版本的官方文档与本机测试结果为准。
