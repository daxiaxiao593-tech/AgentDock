const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { createDesktopApplication } = require('../app/desktop/main.cjs');

const appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-main-test-'));
after(() => fs.rmSync(appDataRoot, { recursive: true, force: true }));

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = handler => { this.webContents.windowOpenHandler = handler; };
    this.webContents.session = { cookies: { set: async cookie => { this.cookie = cookie; } } };
    this.webContents.loadURL = async url => { this.loadedUrl = url; };
    this.webContents.isDestroyed = () => false;
    this.minimized = false;
    this.showCount = 0;
    this.focusCount = 0;
    this.restoreCount = 0;
  }

  async loadURL(url) { this.loadedUrl = url; }
  show() { this.showCount += 1; }
  focus() { this.focusCount += 1; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; this.restoreCount += 1; }
  close() {
    let prevented = false;
    this.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) this.emit('closed');
    return !prevented;
  }
}

function createHarness({ lock = true, closeResponses = [], openDialogResult = null, startError = null } = {}) {
  const app = new EventEmitter();
  const calls = { lock: 0, quit: 0, setName: [], setPath: [], getPath: [], hostFactory: 0, hostStart: 0, hostShutdown: 0, errors: [] };
  app.getPath = name => { calls.getPath.push(name); return name === 'userData' ? path.join(appDataRoot, 'AgentDock') : ''; };
  app.setName = name => calls.setName.push(name);
  app.setPath = (...args) => calls.setPath.push(args);
  app.requestSingleInstanceLock = () => { calls.lock += 1; return lock; };
  app.whenReady = () => Promise.resolve();
  app.quit = () => { calls.quit += 1; };
  const ipcMain = { handlers: new Map(), handle: (name, callback) => ipcMain.handlers.set(name, callback) };
  const dialog = {
    showOpenDialog: async (...args) => { dialog.openArgs = args; return openDialogResult; },
    showMessageBox: async () => ({ response: closeResponses.shift() ?? 1 }),
    showErrorBox: (...args) => calls.errors.push(args)
  };
  const windows = [];
  const BrowserWindow = class extends FakeWindow {
    constructor(options) { super(options); windows.push(this); }
  };
  const session = { defaultSession: { cookies: { set: async cookie => { session.cookie = cookie; } } } };
  const shell = { openExternal: () => { throw new Error('external navigation must not be opened'); } };
  const host = new EventEmitter();
  host.isReady = false;
  host.start = async () => {
    calls.hostStart += 1;
    if (startError) throw startError;
    host.isReady = true;
    return { origin: 'http://127.0.0.1:43127', token: 'T'.repeat(43) };
  };
  host.shutdown = async () => { calls.hostShutdown += 1; return true; };
  const controller = createDesktopApplication({
    electron: { app, BrowserWindow, dialog, ipcMain, session, shell },
    runtimePath: 'C:\\AgentDock\\runtime\\node.exe',
    serviceEntryPath: 'C:\\AgentDock\\app\\desktop\\service-entry.cjs',
    createServiceHost: () => { calls.hostFactory += 1; return host; }
  });
  return { controller, app, BrowserWindow, windows, dialog, ipcMain, session, host, calls };
}

test('the single-instance lock is obtained before the desktop service starts', async () => {
  const { controller, calls } = createHarness({ lock: false });
  await controller.ready;
  assert.equal(controller.isPrimary, false);
  assert.equal(calls.lock, 1);
  assert.equal(calls.hostFactory, 0);
  assert.equal(calls.hostStart, 0);
  assert.equal(calls.quit, 1);
});

test('the main window loads only after the hidden local service returns ready', async () => {
  const { controller, windows, calls, session } = createHarness();
  await controller.ready;
  assert.equal(calls.hostStart, 1);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].loadedUrl, 'http://127.0.0.1:43127');
  assert.equal(windows[0].showCount, 1);
  assert.equal(session.cookie.httpOnly, true);
  assert.equal(session.cookie.value, 'T'.repeat(43));
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
});

test('a service readiness timeout is shown clearly and does not open a window', async () => {
  const { controller, windows, calls } = createHarness({ startError: new Error('did not become ready within 15000 ms') });
  await controller.ready;
  assert.equal(windows.length, 0);
  assert.equal(calls.hostStart, 1);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0][1], /did not become ready within 15000 ms/);
  assert.equal(calls.quit, 1);
});

test('a second instance focuses the existing window without creating another service', async () => {
  const { controller, app, windows, calls } = createHarness();
  await controller.ready;
  const window = windows[0];
  window.minimized = true;
  app.emit('second-instance');
  assert.equal(window.restoreCount, 1);
  assert.equal(window.focusCount, 1);
  assert.equal(windows.length, 1);
  assert.equal(calls.hostStart, 1);
});

test('canceling the exit confirmation keeps sessions and the service running', async () => {
  const { controller, windows, host, calls } = createHarness({ closeResponses: [1, 0] });
  await controller.ready;
  host.emit('session-state', { sessionId: 'codex', runId: 'run-1', status: 'running' });

  windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.hostShutdown, 0);
  assert.equal(calls.quit, 0);

  windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.hostShutdown, 1);
  assert.equal(calls.quit, 1);
});

test('dynamic session ids participate in exit confirmation', async () => {
  const { controller, windows, host, calls } = createHarness({ closeResponses: [1] });
  await controller.ready;
  host.emit('session-state', { sessionId: 'session-random-uuid', runId: 'run-1', status: 'running' });
  windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.hostShutdown, 0);
  assert.equal(calls.quit, 0);
});

test('directory selection is limited to the current trusted window and returns one folder', async () => {
  const { controller, windows, ipcMain, dialog } = createHarness({ openDialogResult: { canceled: false, filePaths: ['C:\\Projects\\Agent Dock'] } });
  await controller.ready;
  const handler = ipcMain.handlers.get('agentdock:select-working-directory');
  const trustedEvent = { sender: windows[0].webContents, senderFrame: { url: 'http://127.0.0.1:43127/' } };
  assert.equal(await handler(trustedEvent), 'C:\\Projects\\Agent Dock');
  assert.deepEqual(dialog.openArgs[1].properties, ['openDirectory']);
  await assert.rejects(handler({ sender: {}, senderFrame: { url: 'http://127.0.0.1:43127/' } }), /untrusted renderer/i);
});

test('navigation and popup requests outside the application origin are denied', async () => {
  const { controller, windows } = createHarness();
  await controller.ready;
  const webContents = windows[0].webContents;
  let prevented = false;
  webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.com');
  assert.equal(prevented, true);
  assert.deepEqual(webContents.windowOpenHandler({ url: 'https://example.com' }), { action: 'deny' });
});

test('a service crash is visible and is never automatically restarted', async () => {
  const { controller, host, calls } = createHarness();
  await controller.ready;
  host.emit('exit', { code: 17, signal: null, expected: false });
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0][1], /本机终端服务已异常结束/);
  assert.equal(calls.hostStart, 1);
});

test('native window controls overlay shares the compact toolbar without an extra title or menu row', async () => {
  const { controller, windows } = createHarness();
  await controller.ready;
  const options = windows[0].options;
  assert.equal(options.titleBarStyle, 'hidden');
  assert.deepEqual(options.titleBarOverlay, { color: '#1d1d2d', symbolColor: '#e9eaf3', height: 35 });
  assert.equal(options.autoHideMenuBar, true);
  assert.equal(options.backgroundColor, '#1d1d2d');
  assert.notEqual(options.frame, false);
});
