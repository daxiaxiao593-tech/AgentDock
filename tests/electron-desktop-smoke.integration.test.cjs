const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const WebSocket = require('ws');
const { createDesktopWorkspaceStore } = require('../app/desktop/desktop-workspace.cjs');
const { artifactDir, testExecutable } = require('./multi-session-electron-helper.cjs');

async function reservePort() {
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForTarget(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before opening DevTools (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      child.targets = targets;
      const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
      if (target) return target;
    } catch { /* Electron has not opened its DevTools endpoint yet. */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for the Electron window. Targets: ${JSON.stringify(child.targets || [])}. Output: ${child.output.join('')}`);
}

async function waitForInspector(output, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before opening its main inspector (${child.exitCode})`);
    const url = output.join('').match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
    if (url) return url;
    await delay(100);
  }
  throw new Error(`Timed out waiting for the Electron main inspector. Output: ${output.join('')}`);
}

async function waitForServiceExit(origin, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error('The hidden local service remained available after its owner exited');
}

async function waitForEvaluation(debuggerClient, expression, predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await debuggerClient.evaluate(expression);
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(value)}`);
}

function connectDebugger(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  const opened = once(socket, 'open');
  return {
    socket,
    async ready() { await opened; },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
  };
}

function waitForExit(child, message, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(message));
    }, timeoutMs);
    const onExit = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    child.once('exit', onExit);
  });
}

test('Electron desktop shell opens only after service readiness, survives a second launch, and exits its owned service', { timeout: 60000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-electron-smoke-'));
  const userDataPath = path.join(tempRoot, 'user-data');
  const projectFixtures = [
    { id: 'smoke-project-aitutorial', name: 'aitutorial', sessions: [{ id: 'smoke-codex', agent: 'codex', name: '高强度重构方案' }] },
    { id: 'smoke-project-video', name: 'video-killer-v3', sessions: [{ id: 'smoke-video-agy', agent: 'agy', name: 'Shell' }, { id: 'smoke-video-codex-1', agent: 'codex', name: 'commit' }, { id: 'smoke-video-codex-2', agent: 'codex', name: '重构规划' }] },
    { id: 'smoke-project-cli', name: 'cli-agents', sessions: [{ id: 'smoke-cli-agy-1', agent: 'agy', name: 'Antigravity' }, { id: 'smoke-cli-claude', agent: 'claude', name: 'Claude' }, { id: 'smoke-cli-codex', agent: 'codex', name: 'commit' }, { id: 'smoke-cli-agy-2', agent: 'agy', name: '新会话' }] },
    { id: 'smoke-project-writer', name: 'wx-writer', sessions: [{ id: 'smoke-writer-codex-1', agent: 'codex', name: 'Codex-c2' }, { id: 'smoke-writer-codex-2', agent: 'codex', name: '新会话' }] }
  ];
  const workspacePath = path.join(tempRoot, projectFixtures[0].name);
  const projects = projectFixtures.map(project => {
    const rootPath = path.join(tempRoot, project.name);
    fs.mkdirSync(rootPath, { recursive: true });
    return { id: project.id, rootPath, collapsed: false };
  });
  const store = createDesktopWorkspaceStore({ userDataPath });
  store.save({
    schemaVersion: 2,
    projects,
    sessions: projectFixtures.flatMap(project => project.sessions.map(session => ({ ...session, projectId: project.id, launchOnOpen: false }))),
    selectedSessionId: 'smoke-codex'
  });
  const primaryPort = await reservePort();
  const inspectorPort = await reservePort();
  const electronPath = testExecutable();
  const env = { ...process.env };
  const electronOutput = [];
  const primary = spawn(electronPath, ['--headless', `--user-data-dir=${userDataPath}`, `--remote-debugging-port=${primaryPort}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${inspectorPort}`, root], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  primary.output = electronOutput;
  primary.stdout.on('data', data => electronOutput.push(data.toString()));
  primary.stderr.on('data', data => electronOutput.push(data.toString()));
  const ownedChildren = [primary];
  let debuggerClient;
  let mainDebuggerClient;
  let serverOrigin;
  t.after(async () => {
    debuggerClient?.socket.terminate();
    mainDebuggerClient?.socket.terminate();
    for (const child of ownedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = waitForExit(child, `Owned Electron PID ${child.pid} did not exit during cleanup`, 10000);
        child.kill();
        await exited;
      }
    }
    if (serverOrigin) await waitForServiceExit(serverOrigin);
    t.diagnostic('Owned Electron cleanup: ' + JSON.stringify(ownedChildren.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }))));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const target = await waitForTarget(primaryPort, primary);
  debuggerClient = connectDebugger(target.webSocketDebuggerUrl);
  await debuggerClient.ready();
  mainDebuggerClient = connectDebugger(await waitForInspector(electronOutput, primary));
  await mainDebuggerClient.ready();
  await debuggerClient.send('Page.enable');
  await debuggerClient.send('Runtime.enable');
  const initial = await waitForEvaluation(debuggerClient, `({
    href: location.href,
    title: document.title,
    directory: document.querySelector('#directory').textContent,
    statuses: [...document.querySelectorAll('.session-status')].map(item => item.textContent),
    launchOnOpen: [...document.querySelectorAll('#launch-on-open')].map(item => item.checked),
    bridge: Object.keys(window.agentDock || {})
  })`, value => value.title === 'AgentDock' && value.directory === workspacePath, 'the saved workspace snapshot');
  serverOrigin = new URL(initial.href).origin;
  assert.equal(initial.title, 'AgentDock');
  assert.equal(initial.directory, workspacePath);
  assert.deepEqual(initial.statuses, Array(10).fill('未启动'));
  assert.deepEqual(initial.launchOnOpen, [false]);
  assert.deepEqual(initial.bridge, ['selectWorkingDirectory']);

  const nativeContentSize = await mainDebuggerClient.evaluate(`(() => {
    const electron = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('electron');
    const window = electron.BrowserWindow.getAllWindows()[0];
    window.setContentSize(1440, 904);
    return window.getContentSize();
  })()`);
  assert.deepEqual(nativeContentSize, [1440, 904]);

  const comparisonLayout = await debuggerClient.evaluate('({width:document.documentElement.clientWidth,height:document.documentElement.clientHeight,scrollWidth:document.documentElement.scrollWidth,pixelRatio:devicePixelRatio})');
  assert.deepEqual(comparisonLayout, { width: 1440, height: 904, scrollWidth: 1440, pixelRatio: 1 });
  const comparisonScreenshot = await debuggerClient.send('Page.captureScreenshot', { format: 'png' });
  const comparisonPath = path.join(artifactDir, 'application-normalized-1440x904.png');
  fs.mkdirSync(path.dirname(comparisonPath), { recursive: true });
  fs.writeFileSync(comparisonPath, Buffer.from(comparisonScreenshot.data, 'base64'));
  await debuggerClient.send('Page.reload', { ignoreCache: true });
  const afterReload = await waitForEvaluation(debuggerClient, '({origin: location.origin, directory: document.querySelector("#directory")?.textContent ?? null})', value => value.origin === serverOrigin && value.directory === workspacePath, 'the reloaded workspace snapshot');
  assert.equal(afterReload.directory, workspacePath);

  await debuggerClient.send('Network.enable');
  await debuggerClient.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0
  });
  await delay(300);
  assert.equal(await debuggerClient.evaluate("document.querySelector('#status').textContent"), '未启动');
  assert.equal(await debuggerClient.evaluate("document.querySelector('#start').disabled"), false);
  assert.equal((await fetch(serverOrigin)).status, 200);
  await debuggerClient.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: 10_000_000,
    uploadThroughput: 10_000_000
  });
  await delay(300);
  assert.equal(await debuggerClient.evaluate("document.querySelector('#status').textContent"), '未启动');
  await debuggerClient.send('Page.reload', { ignoreCache: true });
  await waitForEvaluation(debuggerClient, 'location.origin', value => value === serverOrigin, 'the online page reload');
  await waitForEvaluation(debuggerClient, '[...document.querySelectorAll(".session-status")].map(item => item.textContent)', value => value.length === 10 && value.every(status => status === '未启动'), 'idle session states after reload');
  assert.deepEqual(await debuggerClient.evaluate("[...document.querySelectorAll('.session-status')].map(item => item.textContent)"), Array(10).fill('未启动'));

  for (const scale of [1.25, 1.5]) {
    await debuggerClient.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 820,
      deviceScaleFactor: scale,
      mobile: false
    });
    const layout = await debuggerClient.evaluate('({width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, pixelRatio: devicePixelRatio})');
    assert.ok(layout.scrollWidth <= layout.width, `horizontal overflow at emulated scale ${scale}`);
    assert.equal(layout.pixelRatio, scale);
  }
  await debuggerClient.send('Emulation.clearDeviceMetricsOverride');

  const second = spawn(electronPath, ['--headless', `--user-data-dir=${userDataPath}`, root], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  ownedChildren.push(second);
  const secondExit = waitForExit(second, 'Second Electron instance did not exit after losing the single-instance lock');
  const [secondExitCode] = await secondExit;
  assert.equal(secondExitCode, 0);
  assert.equal(primary.exitCode, null);
  assert.equal(await debuggerClient.evaluate('location.origin'), serverOrigin);

  mainDebuggerClient.socket.terminate();
  mainDebuggerClient = undefined;
  const primaryExit = waitForExit(primary, 'Electron did not complete normal shutdown');
  void debuggerClient.send('Page.close').catch(() => {});
  const [primaryExitCode] = await primaryExit;
  assert.equal(primaryExitCode, 0);
  await assert.rejects(fetch(serverOrigin));
});

test('the hidden local service closes after an unexpected Electron main-process exit', { timeout: 30000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-electron-crash-'));
  const userDataPath = path.join(tempRoot, 'user-data');
  const port = await reservePort();
  const electronPath = testExecutable();
  const primary = spawn(electronPath, ['--headless', `--user-data-dir=${userDataPath}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', root], {
    cwd: root,
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  let debuggerClient;
  let origin;
  t.after(async () => {
    debuggerClient?.socket.terminate();
    if (primary.exitCode === null && primary.signalCode === null) {
      const exited = waitForExit(primary, 'Electron did not exit during test cleanup', 10000);
      primary.kill();
      await exited;
    }
    if (origin) await waitForServiceExit(origin);
    t.diagnostic('Owned Electron cleanup: ' + JSON.stringify([{ pid: primary.pid, exitCode: primary.exitCode, signal: primary.signalCode }]));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const target = await waitForTarget(port, primary);
  origin = new URL(target.url).origin;
  debuggerClient = connectDebugger(target.webSocketDebuggerUrl);
  await debuggerClient.ready();
  assert.equal((await fetch(origin)).status, 200);

  primary.kill();
  await waitForExit(primary, 'Electron main process did not terminate after the test crash signal');
  await waitForServiceExit(origin);
});
