const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const artifactDir = path.resolve(process.env.AGENTDOCK_TEST_RESULTS_DIR || path.join(root, 'test-results', 'multi-session-ui'));

function testExecutable() {
  const executable = process.env.AGENTDOCK_TEST_EXECUTABLE || require('electron');
  assert.ok(path.isAbsolute(executable) && fs.statSync(executable).isFile(), 'AGENTDOCK_TEST_EXECUTABLE must identify an existing absolute executable file');
  return executable;
}

async function waitFor(read, predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(value)}`);
}

async function reservePort() {
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function debugConnection(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Debugger closed')); }
    pending.clear();
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Debugger timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result?.value;
    },
    close() { socket.terminate(); }
  };
}

const instrumentation = `(() => {
  window.__terms = []; window.__wire = []; window.__sent = []; window.__sockets = [];
  let implementation;
  Object.defineProperty(window, 'Terminal', { configurable: true, get: () => implementation, set(value) {
    implementation = new Proxy(value, { construct(target, args) {
      const terminal = Reflect.construct(target, args);
      const open = terminal.open.bind(terminal);
      terminal.open = pane => { terminal.__sessionId = pane.dataset.terminalSession; return open(pane); };
      window.__terms.push(terminal); return terminal;
    }});
  }});
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      super(window.__blockReconnect ? String(url).replace('/terminal', '/unavailable-for-test') : url, protocols);
      window.__sockets.push(this);
      this.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'output') window.__wire.push({ type: message.type, sessionId: message.sessionId, runId: message.runId, seq: message.seq, bytes: new TextEncoder().encode(message.data).length, prefix: message.data.slice(0, 200) });
        else window.__wire.push(message);
      });
    }
    send(raw) {
      const message=JSON.parse(raw);
      if(message.type==='resume-output') {
        const terminal=window.__terms.find(t=>t.__sessionId===message.sessionId), buffer=terminal?.buffer.active;
        message.testGapVisible=Boolean(buffer && Array.from({length:buffer.length},(_,i)=>buffer.getLine(i).translateToString(true)).some(line=>line.includes('此处部分输出缺失')));
      }
      window.__sent.push(message); return super.send(raw);
    }
  };
})();`;

async function createFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'AgentDock-real-multi-'));
  const userData = path.join(temp, 'user-data');
  const bin = path.join(temp, 'fixture-bin');
  const logs = path.join(temp, 'fixture-logs');
  const dirs = [path.join(temp, '甲项目 workspace'), path.join(temp, '乙项目 workspace')];
  for (const dir of [userData, bin, logs, ...dirs]) fs.mkdirSync(dir, { recursive: true });
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  assert.ok(fs.existsSync(csc), 'The Windows C# compiler is required for the controlled native CLI fixture');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', `/out:${path.join(bin, 'codex.exe')}`, path.join(__dirname, 'fake-cli-multi-session.cs')], { windowsHide: true, stdio: 'pipe' });
  fs.copyFileSync(path.join(bin, 'codex.exe'), path.join(bin, 'agy.exe'));
  // PATH and both resolver fallback homes are isolated; a missing fixture cannot reach the user's CLI.
  const env = { ...process.env, PATH: bin, Path: bin, LOCALAPPDATA: path.join(temp, 'local-app-data'), USERPROFILE: path.join(temp, 'profile'), AGENTDOCK_TEST_LOG: logs };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const dir of [env.LOCALAPPDATA, env.USERPROFILE]) fs.mkdirSync(dir, { recursive: true });
  return { temp, userData, bin, logs, dirs, env, processes: [], targets: [], cleanup: [] };
}

async function launch(fixture) {
  const pagePort = await reservePort();
  const inspectPort = await reservePort();
  const output = [];
  const executable = testExecutable();
  const headless = process.env.AGENTDOCK_TEST_HEADLESS !== '0';
  const args = [...(headless ? ['--headless'] : []), `--user-data-dir=${fixture.userData}`, `--remote-debugging-port=${pagePort}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${inspectPort}`, root];
  const child = spawn(executable, args, {
    cwd: root, env: fixture.env, windowsHide: headless, stdio: ['ignore', 'pipe', 'pipe']
  });
  fixture.processes.push(child);
  fs.writeFileSync(path.join(fixture.temp, 'launch.json'), JSON.stringify({ pid: child.pid, pagePort, inspectPort }));
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  const target = await waitFor(async () => {
    assert.equal(child.exitCode, null, 'Electron exited before opening its page');
    try { return (await (await fetch(`http://127.0.0.1:${pagePort}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); }
    catch { return null; }
  }, Boolean, 'Electron page', 20000);
  const page = await debugConnection(target.webSocketDebuggerUrl);
  const mainUrl = await waitFor(() => output.join('').match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1], Boolean, 'main inspector');
  const main = await debugConnection(mainUrl);
  await main.evaluate(`globalThis.__electronTest = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('electron'); true`);
  const targetRuntime = await main.evaluate(`({ execPath: process.execPath, electron: process.versions.electron, isPackaged: __electronTest.app.isPackaged, version: __electronTest.app.getVersion(), resourcesPath: process.resourcesPath })`);
  assert.equal(fs.realpathSync.native(targetRuntime.execPath), fs.realpathSync.native(executable), 'The main inspector must identify the executable selected for this test');
  fixture.targets.push({ pid: child.pid, ...targetRuntime });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await waitFor(() => page.evaluate(`document.readyState === 'complete' && document.getElementById('connection')?.textContent === '本地已连接'`), Boolean, 'initial workspace load');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  await page.send('Page.reload', { ignoreCache: true });
  await waitFor(() => page.evaluate(`document.getElementById('connection')?.textContent`), value => value === '本地已连接', 'workspace connection');
  return { page, main, mainUrl, child, origin: new URL(target.url).origin, output };
}

async function closeApp(app, fixture) {
  if (app.child.exitCode === null && app.child.signalCode === null) {
    await app.main.evaluate('__electronTest.BrowserWindow.getAllWindows()[0].close(); true');
    app.main.close();
    try {
      await waitFor(() => app.child.exitCode !== null || app.child.signalCode !== null, Boolean, 'normal Electron exit', 15000);
    } catch (error) {
      let diagnostic;
      try {
        diagnostic = await debugConnection(app.mainUrl);
        app.closeDiagnostic = await diagnostic.evaluate(`({windows:__electronTest.BrowserWindow.getAllWindows().map(w=>({title:w.getTitle(),visible:w.isVisible(),destroyed:w.isDestroyed()})),resources:process.getActiveResourcesInfo()})`);
      } catch (inspectionError) { app.closeDiagnostic = { inspectionError: inspectionError.message }; }
      finally { diagnostic?.close(); }
      throw error;
    }
    assert.equal(app.child.exitCode, 0, 'Electron should exit normally');
  }
  app.page.close(); app.main.close();
  fixture.cleanup.push({ pid: app.child.pid, exitCode: app.child.exitCode });
  await waitFor(async () => {
    try { await fetch(app.origin, { signal: AbortSignal.timeout(200) }); return false; }
    catch { return true; }
  }, Boolean, 'owned hidden service exit');
}

async function cleanupFixture(fixture, app) {
  app?.page.close(); app?.main.close();
  for (const child of fixture.processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, Boolean, 'owned Electron cleanup', 10000);
    }
    fixture.cleanup.push({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode });
  }
  const fakePids = fs.readdirSync(fixture.logs).filter(name => /^\d+\.log$/.test(name)).map(name => Number(name.split('.')[0]));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => fakePids.filter(alive), ids => ids.length === 0, 'all owned native CLI fixture PIDs to exit', 10000);
  fixture.cleanup.push({ nativeFixturePids: fakePids, allExited: true });
  if (app) await waitFor(async () => { try { await fetch(app.origin, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; } }, Boolean, 'fixture service cleanup');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'integration-cleanup.json'), JSON.stringify(fixture.cleanup, null, 2));
  fs.rmSync(fixture.temp, { recursive: true, force: true });
}

module.exports = { root, artifactDir, testExecutable, waitFor, delay, createFixture, launch, closeApp, cleanupFixture };
