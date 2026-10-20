const fs = require('node:fs');
const path = require('node:path');
const { createDesktopServiceHost } = require('./service-host.cjs');
const { resolveDesktopPaths } = require('./runtime-path.cjs');

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);

function createDesktopApplication({
  electron,
  runtimePath,
  serviceEntryPath,
  preloadPath,
  startupTimeoutMs = 15000,
  fileSystem = fs,
  createServiceHost = createDesktopServiceHost
} = {}) {
  if (!electron?.app || !electron.BrowserWindow || !electron.dialog || !electron.ipcMain || !electron.session) {
    throw new Error('Electron main-process APIs are required');
  }
  const { app, BrowserWindow, dialog, ipcMain, session } = electron;
  app.setName('AgentDock');
  const userDataPath = app.getPath('userData');
  fileSystem.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { isPrimary: false, ready: Promise.resolve(false) };
  }

  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : path.resolve(__dirname, '../..');
  const paths = resolveDesktopPaths({
    isPackaged: app.isPackaged === true,
    appPath,
    resourcesPath: process.resourcesPath
  });
  runtimePath ||= paths.runtimePath;
  serviceEntryPath ||= paths.serviceEntryPath;
  preloadPath ||= paths.preloadPath;

  let mainWindow = null;
  let serviceHost = null;
  let serviceOrigin = null;
  let closingWindow = false;
  let allowWindowClose = false;
  let pendingFocus = false;
  let startupFailed = false;
  const runtimeStates = new Map();
  const securedWebContents = new WeakSet();

  function focusWindow() {
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      pendingFocus = true;
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function isApplicationUrl(value) {
    if (!serviceOrigin || typeof value !== 'string') return false;
    try {
      const parsed = new URL(value);
      return parsed.origin === serviceOrigin && parsed.pathname === '/' && !parsed.search && !parsed.hash;
    } catch {
      return false;
    }
  }

  function secureWebContents(contents) {
    if (securedWebContents.has(contents)) return;
    securedWebContents.add(contents);
    contents.on('will-navigate', (event, url) => {
      if (!isApplicationUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isApplicationUrl(url)) event.preventDefault();
    });
    contents.on('will-frame-navigate', (event, url) => {
      if (!isApplicationUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  function isTrustedRenderer(event) {
    const senderUrl = event.senderFrame?.url;
    let senderOrigin = null;
    try { senderOrigin = new URL(senderUrl).origin; } catch { /* rejected below */ }
    return Boolean(mainWindow && event.sender === mainWindow.webContents && senderOrigin === serviceOrigin);
  }

  app.on('web-contents-created', (_event, contents) => secureWebContents(contents));
  app.on('second-instance', focusWindow);
  app.on('window-all-closed', () => app.quit());

  ipcMain.handle('agentdock:select-working-directory', async event => {
    if (!isTrustedRenderer(event)) {
      throw new Error('Untrusted renderer cannot select a working directory');
    }
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作目录',
      defaultPath: path.join(app.getPath('home'), 'Documents'),
      properties: ['openDirectory']
    });
    if (selected.canceled || selected.filePaths.length === 0) return null;
    return selected.filePaths[0];
  });

  function reportServiceExit(result) {
    if (result.expected || startupFailed || !mainWindow || mainWindow.isDestroyed?.()) return;
    dialog.showErrorBox('AgentDock 服务异常', `本机终端服务已异常结束（退出码 ${result.code ?? '未知'}）。不会自动重启或重试 CLI 任务；请检查终端状态后重新打开 AgentDock。`);
  }

  async function closeApplication() {
    const activeCount = [...runtimeStates.values()].filter(state => ACTIVE_STATES.has(state.status)).length;
    if (activeCount > 0) {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '退出 AgentDock',
        message: `退出将结束 ${activeCount} 个终端。`,
        detail: '已启动的 CLI 任务会被停止。',
        buttons: ['退出并停止', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      if (result.response !== 0) {
        closingWindow = false;
        return;
      }
    }

    const stopped = await serviceHost.shutdown();
    if (!stopped) {
      closingWindow = false;
      dialog.showErrorBox('AgentDock 无法退出', '至少一个本应用启动的终端未能确认退出。AgentDock 保持打开，请查看终端错误并重试停止。');
      return;
    }
    allowWindowClose = true;
    mainWindow.close();
    app.quit();
  }

  async function startServiceAndWindow() {
    serviceHost = createServiceHost({ runtimePath, serviceEntryPath, userDataPath, startupTimeoutMs });
    serviceHost.on('session-state', state => {
      if (!state || typeof state.sessionId !== 'string' || !state.sessionId || !['idle', ...ACTIVE_STATES, 'stopped', 'failed'].includes(state.status)) return;
      runtimeStates.set(state.sessionId, { status: state.status, runId: state.runId ?? null });
    });
    serviceHost.on('exit', reportServiceExit);

    const ready = await serviceHost.start();
    serviceOrigin = ready.origin;
    await session.defaultSession.cookies.set({
      url: serviceOrigin,
      name: 'agentdock_ui',
      value: ready.token,
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/'
    });

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      show: false,
      backgroundColor: '#1d1d2d',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#1d1d2d', symbolColor: '#e9eaf3', height: 35 },
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });
    secureWebContents(mainWindow.webContents);
    mainWindow.on('close', event => {
      if (allowWindowClose) return;
      event.preventDefault();
      if (closingWindow) return;
      closingWindow = true;
      void closeApplication();
    });
    mainWindow.on('closed', () => { mainWindow = null; });

    await mainWindow.loadURL(serviceOrigin);
    mainWindow.show();
    if (pendingFocus) {
      pendingFocus = false;
      mainWindow.focus();
    }
    return true;
  }

  const ready = Promise.resolve(app.whenReady()).then(() => {
    return startServiceAndWindow();
  }).catch(error => {
    startupFailed = true;
    dialog.showErrorBox('AgentDock 启动失败', `无法启动隐藏的本机终端服务。\n\n${error instanceof Error ? error.message : String(error)}`);
    app.quit();
    return false;
  });

  return {
    isPrimary: true,
    ready,
    focus: focusWindow,
    get window() { return mainWindow; },
    get userDataPath() { return userDataPath; }
  };
}

if (process.versions.electron && process.type === 'browser') {
  const electron = require('electron');
  createDesktopApplication({ electron });
}

module.exports = { createDesktopApplication };
