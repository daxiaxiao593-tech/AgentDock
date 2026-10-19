const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { SessionRuntimeManager } = require('../app/runtime/session-runtime-manager.cjs');
const { createDesktopWorkspaceStore } = require('../app/desktop/desktop-workspace.cjs');

let createTerminalUiServer;
try {
  ({ createTerminalUiServer } = require('../app/terminal/terminal-ui-server.cjs'));
} catch {}

test('terminal UI server exposes the local runtime bridge', () => {
  assert.equal(typeof createTerminalUiServer, 'function');
});

if (typeof createTerminalUiServer === 'function') {
  const WebSocket = require('ws');
  const socketMessages = new WeakMap();
  const socketWaiters = new WeakMap();
  const cwd = path.win32.join('C:\\AgentDock Temp 中文', 'workspace');
  const sessions = [
    { sessionId: 'codex', agent: 'Codex', cwd },
    { sessionId: 'agy', agent: 'Antigravity', cwd },
    { sessionId: 'claude', agent: 'Claude Code', cwd }
  ];

  function createRuntime() {
    const ptys = [];
    let nextRunId = 0;
    const manager = new SessionRuntimeManager({
      sessions: sessions.map(session => ({
        id: session.sessionId,
        agent: session.sessionId,
        cwd,
        launchOnOpen: false
      })),
      resolveLaunch: async session => ({ command: `${session.agent}.exe`, args: [], cwd: session.cwd }),
      spawnPty: (launch, handlers) => {
        const pty = {
          writes: [],
          sizes: [],
          write(data) { this.writes.push(data); },
          resize(columns, rows) { this.sizes.push([columns, rows]); },
          async kill() { handlers.onExit(0, null); }
        };
        ptys.push({ sessionId: launch.command.replace('.exe', ''), ...pty, handlers });
        return pty;
      },
      outputFlow: { highWatermark: 8, lowWatermark: 3 },
      createRunId: () => `run-ui-test-${++nextRunId}`
    });
    return { manager, ptys };
  }

  async function connect(app, existingUrl) {
    const { url } = existingUrl ? { url: existingUrl } : await app.listen(0);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    const cookie = response.headers.get('set-cookie').split(';', 1)[0];
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/terminal`, {
      headers: { Origin: url, Cookie: cookie }
    });
    const messages = [];
    const waiters = [];
    socketMessages.set(socket, messages);
    socketWaiters.set(socket, waiters);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
      if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0].resolve(message);
      else messages.push(message);
    });
    await once(socket, 'open');
    return { url, html, socket };
  }

  function nextMessage(socket, predicate = () => true) {
    const messages = socketMessages.get(socket) || [];
    const matchIndex = messages.findIndex(predicate);
    if (matchIndex >= 0) return Promise.resolve(messages.splice(matchIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiters = socketWaiters.get(socket) || [];
      waiters.push({ predicate, resolve });
      socketWaiters.set(socket, waiters);
      socket.once('error', reject);
    });
  }

  test('three CLI sessions run concurrently and route input, output, ACK, resize, and stop by session', { timeout: 15000 }, async t => {
    const { manager, ptys } = createRuntime();
    const app = createTerminalUiServer({ manager, sessions });
    t.after(() => app.close());

    const { html, socket } = await connect(app);
    t.after(() => socket.close());
    assert.match(html, /id="tab-codex"/);
    assert.match(html, /id="tab-agy"/);
    assert.match(html, /id="tab-claude"/);
    assert.match(html, /三个终端共享此工作目录/);

    const initial = await nextMessage(socket, message => message.type === 'snapshot');
    assert.deepEqual(initial.sessions.map(session => session.sessionId), ['codex', 'agy', 'claude']);
    assert.ok(initial.sessions.every(session => session.cwd === cwd && session.runtime.status === 'idle'));
    assert.equal(ptys.length, 0);

    socket.send(JSON.stringify({ type: 'start', sessionId: 'codex' }));
    const codexRunningEvent = await nextMessage(socket, message => message.type === 'status' && message.sessionId === 'codex' && message.status === 'running');
    socket.send(JSON.stringify({ type: 'start', sessionId: 'agy' }));
    const agyRunningEvent = await nextMessage(socket, message => message.type === 'status' && message.sessionId === 'agy' && message.status === 'running');
    assert.notEqual(codexRunningEvent.runId, agyRunningEvent.runId);
    assert.equal(ptys.length, 2);
    const codexPty = ptys.find(pty => pty.sessionId === 'codex');
    const agyPty = ptys.find(pty => pty.sessionId === 'agy');

    const codexOutputEvent = nextMessage(socket, message => message.type === 'output' && message.sessionId === 'codex');
    codexPty.handlers.onData('12345678');
    const codexOutput = await codexOutputEvent;
    assert.equal(codexOutput.runId, codexRunningEvent.runId);
    assert.ok(codexPty.writes.includes('\x13'));

    const agyOutputEvent = nextMessage(socket, message => message.type === 'output' && message.sessionId === 'agy');
    agyPty.handlers.onData('abcdefgh');
    const agyOutput = await agyOutputEvent;
    assert.equal(agyOutput.runId, agyRunningEvent.runId);

    socket.send(JSON.stringify({ type: 'ack', sessionId: 'agy', runId: codexRunningEvent.runId, seq: codexOutput.seq }));
    socket.send(JSON.stringify({ type: 'ack', sessionId: 'codex', runId: agyRunningEvent.runId, seq: agyOutput.seq }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(codexPty.writes.includes('\x11'), false);
    assert.equal(agyPty.writes.includes('\x11'), false);

    socket.send(JSON.stringify({ type: 'ack', sessionId: 'codex', runId: codexRunningEvent.runId, seq: codexOutput.seq }));
    socket.send(JSON.stringify({ type: 'ack', sessionId: 'agy', runId: agyRunningEvent.runId, seq: agyOutput.seq }));
    socket.send(JSON.stringify({ type: 'input', sessionId: 'codex', runId: codexRunningEvent.runId, data: '中文\r' }));
    socket.send(JSON.stringify({ type: 'resize', sessionId: 'codex', runId: codexRunningEvent.runId, columns: 113, rows: 37 }));
    socket.send(JSON.stringify({ type: 'input', sessionId: 'agy', runId: agyRunningEvent.runId, data: 'agy\r' }));
    socket.send(JSON.stringify({ type: 'resize', sessionId: 'agy', runId: agyRunningEvent.runId, columns: 91, rows: 29 }));
    socket.send(JSON.stringify({ type: 'input', sessionId: 'codex', runId: 'stale-run', data: 'must not be written' }));
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.ok(codexPty.writes.includes('\x11'));
    assert.equal(codexPty.writes.at(-1), '中文\r');
    assert.equal(codexPty.writes.includes('must not be written'), false);
    assert.deepEqual(codexPty.sizes, [[113, 37]]);
    assert.equal(agyPty.writes.at(-1), 'agy\r');
    assert.deepEqual(agyPty.sizes, [[91, 29]]);

    const codexStoppedEvent = nextMessage(socket, message => message.type === 'status' && message.sessionId === 'codex' && message.status === 'stopped');
    socket.send(JSON.stringify({ type: 'stop', sessionId: 'codex', runId: codexRunningEvent.runId }));
    assert.equal((await codexStoppedEvent).runId, codexRunningEvent.runId);
    assert.equal(manager.getRuntime('codex').status, 'stopped');
    assert.equal(manager.getRuntime('agy').status, 'running');

    const agyStoppedEvent = nextMessage(socket, message => message.type === 'status' && message.sessionId === 'agy' && message.status === 'stopped');
    socket.send(JSON.stringify({ type: 'stop', sessionId: 'agy', runId: agyRunningEvent.runId }));
    await agyStoppedEvent;
  });

  test('the UI server serves local-only terminal assets and rejects a foreign WebSocket origin', { timeout: 15000 }, async t => {
    const { manager } = createRuntime();
    const app = createTerminalUiServer({ manager, sessions });
    t.after(() => app.close());

    const { url } = await app.listen(0);
    const response = await fetch(`${url}/app.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /terminal\.write\(message\.data/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);

    const page = await fetch(url);
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/terminal`, {
      headers: { Origin: 'https://untrusted.example', Cookie: cookie }
    });
    const status = await new Promise(resolve => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.once('open', () => resolve(101));
      socket.once('error', () => {});
    });
    socket.terminate();
    assert.equal(status, 403);
  });

  test('closing the terminal server stays open when an owned PTY refuses to stop', async t => {
    let killCount = 0;
    const manager = new SessionRuntimeManager({
      sessions: [{ id: 'codex', agent: 'codex', cwd }],
      resolveLaunch: async session => ({ command: 'codex.exe', args: [], cwd: session.cwd }),
      spawnPty: () => ({
        write() {}, resize() {},
        async kill() {
          killCount += 1;
          if (killCount === 1) throw new Error('owned process did not exit');
        }
      })
    });
    const app = createTerminalUiServer({ manager, sessions: [{ sessionId: 'codex', agent: 'Codex', cwd }] });
    t.after(async () => { await app.close().catch(() => {}); });
    const { url } = await app.listen(0);
    await manager.start('codex');

    await assert.rejects(app.close(), /could not stop.*codex/i);
    assert.equal(manager.getRuntime('codex').status, 'running');
    assert.equal((await fetch(url)).status, 200);

    assert.equal(await app.close(), true);
    assert.equal(manager.getRuntime('codex').status, 'stopped');
  });

  test('the desktop UI restores saved directory settings and starts only enabled CLIs', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-workspace-ui-'));
    const userData = path.join(root, 'user-data');
    const firstCwd = path.join(root, 'first workspace');
    const nextCwd = path.join(root, 'next workspace');
    fs.mkdirSync(firstCwd);
    fs.mkdirSync(nextCwd);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const store = createDesktopWorkspaceStore({ userDataPath: userData });
    store.setWorkingDirectory(firstCwd);
    store.setLaunchOnOpen('claude', true);
    const config = store.load();
    const appSessions = [
      { id: 'codex', agent: 'codex', label: 'Codex', cwd: config.cwd, launchOnOpen: config.launchOnOpen.codex },
      { id: 'agy', agent: 'agy', label: 'Antigravity', cwd: config.cwd, launchOnOpen: config.launchOnOpen.agy },
      { id: 'claude', agent: 'claude', label: 'Claude Code', cwd: config.cwd, launchOnOpen: config.launchOnOpen.claude }
    ];
    const ptys = [];
    const manager = new SessionRuntimeManager({
      sessions: appSessions,
      resolveLaunch: async session => ({ command: `${session.agent}.exe`, args: [], cwd: session.cwd }),
      spawnPty: (launch, handlers) => {
        const pty = { write() {}, resize() {}, async kill() { handlers.onExit(0, null); } };
        ptys.push({ cwd: launch.cwd, command: launch.command, handlers });
        return pty;
      }
    });
    const app = createTerminalUiServer({
      manager,
      sessions: appSessions.map(session => ({ sessionId: session.id, agent: session.label, cwd: session.cwd, launchOnOpen: session.launchOnOpen })),
      workspaceStore: store
    });
    t.after(() => app.close());
    const { socket } = await connect(app);
    t.after(() => socket.close());

    const snapshot = await nextMessage(socket, message => message.type === 'snapshot');
    assert.equal(snapshot.workspace.cwd, firstCwd);
    assert.deepEqual(snapshot.workspace.launchOnOpen, { codex: false, agy: false, claude: true });
    await manager.startAuto();
    assert.deepEqual(ptys.map(pty => pty.command), ['claude.exe']);
    await manager.stop('claude', manager.getRuntime('claude').runId);

    socket.send(JSON.stringify({ type: 'launch-on-open', sessionId: 'codex', enabled: true }));
    const launchChanged = await nextMessage(socket, message => message.type === 'workspace');
    assert.equal(launchChanged.workspace.launchOnOpen.codex, true);
    assert.equal(store.load().launchOnOpen.codex, true);

    socket.send(JSON.stringify({ type: 'set-working-directory', sessionId: 'codex', cwd: nextCwd }));
    const directoryChanged = await nextMessage(socket, message => message.type === 'workspace');
    assert.equal(directoryChanged.workspace.cwd, nextCwd);
    assert.ok(appSessions.every(session => session.cwd === nextCwd));

    socket.send(JSON.stringify({ type: 'start', sessionId: 'codex' }));
    await nextMessage(socket, message => message.type === 'status' && message.sessionId === 'codex' && message.status === 'running');
    assert.equal(ptys.at(-1).cwd, nextCwd);
  });

  test('the UI server refuses a directory change while any CLI is active', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-workspace-active-'));
    const userData = path.join(root, 'user-data');
    const cwdA = path.join(root, 'active');
    const cwdB = path.join(root, 'other');
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: userData });
    store.setWorkingDirectory(cwdA);
    const activeSessions = sessions.map(session => ({
      id: session.sessionId, agent: session.sessionId, cwd: cwdA, launchOnOpen: false
    }));
    const { manager, ptys } = createRuntime();
    for (const session of activeSessions) manager.sessions.set(session.id, session);
    const app = createTerminalUiServer({
      manager,
      sessions: activeSessions.map(session => ({ sessionId: session.id, agent: session.agent, cwd: session.cwd })),
      workspaceStore: store
    });
    t.after(() => app.close());
    const { socket } = await connect(app);
    t.after(() => socket.close());
    await nextMessage(socket, message => message.type === 'snapshot');

    socket.send(JSON.stringify({ type: 'start', sessionId: 'codex' }));
    await nextMessage(socket, message => message.type === 'status' && message.sessionId === 'codex' && message.status === 'running');
    socket.send(JSON.stringify({ type: 'set-working-directory', sessionId: 'codex', cwd: cwdB }));
    const error = await nextMessage(socket, message => message.type === 'workspace-error');
    assert.match(error.message, /停止所有终端/);
    assert.equal(store.load().cwd, cwdA);
    assert.equal(manager.getRuntime('codex').status, 'running');
    assert.equal(ptys.length, 1);
  });

  test('a renderer reconnect receives the same run snapshot without starting or resending input', { timeout: 15000 }, async t => {
    const { manager, ptys } = createRuntime();
    const app = createTerminalUiServer({ manager, sessions });
    t.after(() => app.close());
    const first = await connect(app);
    const firstSocket = first.socket;
    t.after(() => firstSocket.close());
    await nextMessage(firstSocket, message => message.type === 'snapshot');

    firstSocket.send(JSON.stringify({ type: 'start', sessionId: 'codex' }));
    const started = await nextMessage(firstSocket, message => message.type === 'status' && message.sessionId === 'codex' && message.status === 'running');
    firstSocket.send(JSON.stringify({ type: 'input', sessionId: 'codex', runId: started.runId, data: 'user-owned prompt\r' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ptys.length, 1);
    assert.deepEqual(ptys[0].writes, ['user-owned prompt\r']);

    firstSocket.close();
    await once(firstSocket, 'close');
    const second = await connect(app, first.url);
    t.after(() => second.socket.close());
    const resumed = await nextMessage(second.socket, message => message.type === 'snapshot');
    const codex = resumed.sessions.find(session => session.sessionId === 'codex');
    assert.equal(codex.runtime.runId, started.runId);
    assert.equal(codex.runtime.status, 'running');
    assert.equal(ptys.length, 1);
    assert.deepEqual(ptys[0].writes, ['user-owned prompt\r']);
  });
}
