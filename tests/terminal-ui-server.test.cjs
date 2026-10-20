const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { SessionRuntimeManager } = require('../app/runtime/session-runtime-manager.cjs');
const { createDesktopWorkspaceStore, normalizeWorkspace } = require('../app/desktop/desktop-workspace.cjs');

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

  for (const route of ['/unavailable-for-test', '/terminal']) {
    test(`shutdown closes its owned ${route === '/terminal' ? 'accepted upgrade without close reply' : 'rejected half-open upgrade'} transport`, { timeout: 3000 }, async t => {
      const manager = new SessionRuntimeManager({ sessions: [] });
      const app = createTerminalUiServer({ manager, sessions: [] });
      let socket, closing, timeout;
      t.after(async () => { clearTimeout(timeout); socket?.destroy(); if (closing) await closing; else await app.close(); });
      const { url, token } = await app.listen();
      const address = new URL(url);
      socket = net.connect({ host: '127.0.0.1', port: Number(address.port), allowHalfOpen: true });
      await once(socket, 'connect');
      const response = once(socket, 'data');
      const ended = route === '/unavailable-for-test' ? once(socket, 'end') : null;
      socket.write(`GET ${route} HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${url}\r\nCookie: agentdock_ui=${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      assert.match((await response)[0].toString(), route === '/terminal' ? /101 Switching Protocols/ : /403 Forbidden/);
      if (ended) await ended;
      assert.equal(socket.writableEnded, false);
      closing = app.close();
      await Promise.race([closing, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Shutdown did not close its owned upgrade transport')), 500); })]);
      clearTimeout(timeout);
      await assert.rejects(fetch(url));
    });
  }

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
      const onError = error => reject(error);
      waiters.push({ predicate, resolve: message => { socket.off('error', onError); resolve(message); } });
      socketWaiters.set(socket, waiters);
      socket.once('error', onError);
    });
  }

  test('resume-output reconnects a paused run using its announced output boundary despite newer status events', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-resume-output-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const writes = [];
    let handlers, failStop = true, spawns = 0;
    const manager = new SessionRuntimeManager({ sessions: [{ id: 's', agent: 'codex', cwd: root }], resolveLaunch: async s => s, createRunId: () => 'one-run', outputFlow: { highWatermark: 8, lowWatermark: 2 }, spawnPty: (_launch, callbacks) => { handlers = callbacks; spawns++; return { write: data => writes.push(data), resize() {}, async kill() { if (failStop) throw new Error('stop refused'); } }; } });
    const app = createTerminalUiServer({ manager, sessions: [{ sessionId: 's', agent: 'Codex', cwd: root }] });
    t.after(async () => { failStop = false; await app.close(); });
    const first = await connect(app); t.after(() => first.socket.close());
    assert.equal((await nextMessage(first.socket, m => m.type === 'snapshot')).sessions[0].runtime.outputSeq, 0);
    async function sendAndFlush(socket, fields) {
      const pong = once(socket, 'pong');
      socket.send(JSON.stringify({ sessionId: 's', runId: 'one-run', ...fields }));
      socket.ping('processed'); await pong;
    }
    await manager.start('s');
    handlers.onData('drawn');
    const drawn = await nextMessage(first.socket, m => m.type === 'output');
    await sendAndFlush(first.socket, { type: 'ack', seq: drawn.seq });
    first.socket.close(); await once(first.socket, 'close');
    handlers.onData('12345678');
    assert.equal(writes.at(-1), '\x13');
    assert.equal(await manager.stop('s', 'one-run'), false);
    const second = await connect(app, first.url); t.after(() => second.socket.close());
    const resumed = (await nextMessage(second.socket, m => m.type === 'snapshot')).sessions[0].runtime;
    assert.equal(resumed.runId, 'one-run');
    assert.ok(resumed.seq > resumed.outputSeq);
    await sendAndFlush(second.socket, { type: 'ack', seq: drawn.seq });
    assert.deepEqual(writes, ['\x13']);
    handlers.onData('new!');
    const fresh = await nextMessage(second.socket, m => m.type === 'output' && m.seq > resumed.outputSeq);
    for (const fields of [{ seq: resumed.seq }, { seq: fresh.seq }, { seq: fresh.seq + 100 }, { seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: resumed.outputSeq, runId: 'old-run' }]) {
      await sendAndFlush(second.socket, { type: 'resume-output', ...fields });
    }
    assert.deepEqual(writes, ['\x13']);
    await sendAndFlush(second.socket, { type: 'resume-output', seq: resumed.outputSeq });
    const flow = manager.runtimes.get('s').outputFlow.snapshot();
    assert.equal(flow.outstandingBytes, 4);
    assert.equal(flow.paused, true);
    await sendAndFlush(second.socket, { type: 'ack', seq: fresh.seq });
    assert.deepEqual(writes, ['\x13', '\x11']);
    handlers.onData('continued');
    const continued = await nextMessage(second.socket, m => m.type === 'output' && m.data === 'continued');
    await sendAndFlush(second.socket, { type: 'ack', seq: continued.seq });
    assert.equal(manager.getRuntime('s').runId, 'one-run');
    assert.equal(spawns, 1);
    assert.ok(writes.every(data => data === '\x13' || data === '\x11'));
  });

  test('resume-output requires a checkpoint on this connection and workspace can announce a newer run', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-resume-workspace-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let value = { schemaVersion: 2, projects: [{ id: 'p', rootPath: root, collapsed: false }], sessions: [{ id: 's', projectId: 'p', agent: 'codex', name: 'session', launchOnOpen: false }], selectedSessionId: 's' };
    const writes = [];
    const handlers = [];
    let nextRun = 0;
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async s => s, createRunId: () => `run-${++nextRun}`, outputFlow: { highWatermark: 8, lowWatermark: 2 }, spawnPty: (_launch, callbacks) => { handlers.push(callbacks); return { write: data => writes.push(data), resize() {}, async kill() {} }; } });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: { load: () => structuredClone(value), save: updated => (value = structuredClone(updated)) } });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    const initial = (await nextMessage(socket, m => m.type === 'snapshot')).sessions[0].runtime;
    assert.equal(initial.outputSeq, 0);
    async function resume(runId, seq) { const pong = once(socket, 'pong'); socket.send(JSON.stringify({ type: 'resume-output', sessionId: 's', runId, seq })); socket.ping('processed'); await pong; }
    await manager.start('s');
    handlers[0].onData('12345678');
    const firstOutput = await nextMessage(socket, m => m.type === 'output');
    await resume('run-1', firstOutput.seq);
    assert.deepEqual(writes, ['\x13']);
    socket.send(JSON.stringify({ type: 'rename-session', requestId: 'checkpoint-first', sessionId: 's', name: 'renamed' }));
    const checkpoint = (await nextMessage(socket, m => m.type === 'workspace')).sessions[0].runtime;
    assert.equal(checkpoint.outputSeq, firstOutput.seq);
    await resume('run-1', checkpoint.outputSeq);
    assert.deepEqual(writes, ['\x13', '\x11']);
    await manager.stop('s', 'run-1'); await manager.start('s');
    socket.send(JSON.stringify({ type: 'select-session', requestId: 'checkpoint-empty', sessionId: 's' }));
    const emptyCheckpoint = (await nextMessage(socket, m => m.type === 'workspace')).sessions[0].runtime;
    assert.equal(emptyCheckpoint.runId, 'run-2');
    assert.equal(emptyCheckpoint.outputSeq, 0);
    await resume('run-2', 0);
    assert.deepEqual(writes, ['\x13', '\x11']);
    handlers[1].onData('abcdefgh');
    const secondOutput = await nextMessage(socket, m => m.type === 'output' && m.runId === 'run-2');
    await resume('run-1', firstOutput.seq);
    await resume('run-2', secondOutput.seq);
    assert.deepEqual(writes, ['\x13', '\x11', '\x13']);
    socket.send(JSON.stringify({ type: 'select-session', requestId: 'checkpoint-second', sessionId: 's' }));
    const newCheckpoint = (await nextMessage(socket, m => m.type === 'workspace')).sessions[0].runtime;
    await resume('run-2', newCheckpoint.outputSeq);
    assert.deepEqual(writes, ['\x13', '\x11', '\x13', '\x11']);
  });

  test('resume-output alone unpauses missed disconnected output and the same PTY continues', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-resume-continue-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const writes = [];
    let callbacks, spawns = 0;
    const manager = new SessionRuntimeManager({ sessions: [{ id: 's', agent: 'codex', cwd: root }], resolveLaunch: async s => s, outputFlow: { highWatermark: 8, lowWatermark: 2 }, spawnPty: (_launch, handlers) => { callbacks = handlers; spawns++; return { write: data => writes.push(data), resize() {}, async kill() {} }; } });
    const app = createTerminalUiServer({ manager, sessions: [{ sessionId: 's', agent: 'Codex', cwd: root }] });
    t.after(() => app.close());
    const first = await connect(app); t.after(() => first.socket.close());
    await manager.start('s');
    const runId = manager.getRuntime('s').runId;
    first.socket.close(); await once(first.socket, 'close');
    callbacks.onData('12345678');
    assert.deepEqual(writes, ['\x13']);
    const second = await connect(app, first.url); t.after(() => second.socket.close());
    const checkpoint = (await nextMessage(second.socket, m => m.type === 'snapshot')).sessions[0].runtime;
    const pong = once(second.socket, 'pong');
    second.socket.send(JSON.stringify({ type: 'resume-output', sessionId: 's', runId, seq: checkpoint.outputSeq }));
    second.socket.ping('resumed'); await pong;
    assert.deepEqual(writes, ['\x13', '\x11']);
    assert.equal(manager.runtimes.get('s').outputFlow.snapshot().outstandingBytes, 0);
    callbacks.onData('new');
    assert.equal((await nextMessage(second.socket, m => m.type === 'output')).data, 'new');
    assert.equal(manager.getRuntime('s').runId, runId);
    assert.equal(spawns, 1);
  });

  test('pending create retries stay deduplicated when completed result cache is trimmed', { timeout: 15000 }, async t => {
    let value = { schemaVersion: 2, projects: [{ id: 'p', rootPath: process.cwd(), collapsed: false }], sessions: ['a', 'b', 'keep'].map(id => ({ id, projectId: 'p', agent: 'codex', name: id, launchOnOpen: false })), selectedSessionId: 'keep' };
    const store = { load: () => structuredClone(value), save: updated => (value = structuredClone(updated)) };
    const kills = new Map();
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async session => session, spawnPty: session => ({ write() {}, resize() {}, kill: () => new Promise(resolve => kills.set(session.id, resolve)) }) });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: store });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    await manager.start('a'); await manager.start('b');
    socket.send(JSON.stringify({ type: 'remove-session', requestId: 'remove-a', sessionId: 'a', runId: manager.getRuntime('a').runId }));
    await nextMessage(socket, m => m.type === 'status' && m.sessionId === 'a' && m.status === 'stopping');
    socket.send(JSON.stringify({ type: 'remove-session', requestId: 'remove-b', sessionId: 'b', runId: manager.getRuntime('b').runId }));
    const create = { type: 'create-session', requestId: 'create-once', agent: 'codex', cwd: process.cwd(), name: 'should exist once', start: false };
    socket.send(JSON.stringify(create));
    for (let i = 0; i < 256; i++) socket.send(JSON.stringify({ type: 'select-session', requestId: `select-${i}`, sessionId: 'keep' }));
    await new Promise(resolve => socket.ping('queued', resolve));
    await once(socket, 'pong');
    kills.get('a')();
    await nextMessage(socket, m => m.type === 'status' && m.sessionId === 'b' && m.status === 'stopping');
    socket.send(JSON.stringify(create));
    await new Promise(resolve => socket.ping('retried', resolve));
    await once(socket, 'pong');
    kills.get('b')();
    const first = await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'create-once');
    const second = await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'create-once');
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(value.sessions.filter(session => session.name === 'should exist once').length, 1);
  });

  test('configuration queue rejects excess new requests while retaining accepted pending retries', { timeout: 15000 }, async t => {
    let value = { schemaVersion: 2, projects: [{ id: 'p', rootPath: process.cwd(), collapsed: false }], sessions: ['a', 'keep'].map(id => ({ id, projectId: 'p', agent: 'codex', name: id, launchOnOpen: false })), selectedSessionId: 'keep' };
    let finishKill;
    const store = { load: () => structuredClone(value), save: updated => (value = structuredClone(updated)) };
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async session => session, spawnPty: () => ({ write() {}, resize() {}, kill: () => new Promise(resolve => { finishKill = resolve; }) }) });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: store });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    await manager.start('a');
    socket.send(JSON.stringify({ type: 'remove-session', requestId: 'remove-a', sessionId: 'a', runId: manager.getRuntime('a').runId }));
    await nextMessage(socket, m => m.type === 'status' && m.sessionId === 'a' && m.status === 'stopping');
    for (let i = 0; i < 511; i++) socket.send(JSON.stringify({ type: 'select-session', requestId: `pending-${i}`, sessionId: 'keep' }));
    socket.send(JSON.stringify({ type: 'create-session', requestId: 'overflow', agent: 'codex', cwd: process.cwd(), name: 'must reject', start: false }));
    const rejection = nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'overflow');
    await new Promise(resolve => socket.ping('queued', resolve));
    await once(socket, 'pong');
    socket.send(JSON.stringify({ type: 'select-session', requestId: 'pending-0', sessionId: 'keep' }));
    await new Promise(resolve => socket.ping('retried-at-capacity', resolve));
    await once(socket, 'pong');
    finishKill();
    assert.equal((await rejection).ok, false);
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'pending-0')).ok, true);
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'pending-0')).ok, true);
    assert.equal(value.sessions.some(session => session.name === 'must reject'), false);
  });

  test('dynamic workspace commands persist independent projects and same-tool sessions, deduplicate creation, and preserve failed writes', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-dynamic-ui-'));
    const first = path.join(root, '中文 workspace'), second = path.join(root, 'other');
    fs.mkdirSync(first); fs.mkdirSync(second);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: path.join(root, 'data') });
    let failSave = false;
    const savingStore = { load: store.load, save: value => { if (failSave) throw new Error('disk full'); return store.save(value); } };
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async s => ({ command: s.agent, cwd: s.cwd }), spawnPty: () => ({ write() {}, resize() {}, async kill() {} }) });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: savingStore });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    assert.deepEqual((await nextMessage(socket, m => m.type === 'snapshot')).sessions, []);
    let nextId = 0;
    async function command(fields, requestId = `request-${++nextId}`) {
      socket.send(JSON.stringify({ ...fields, requestId }));
      return nextMessage(socket, m => m.type === 'command-result' && m.requestId === requestId);
    }
    assert.equal((await command({ type: 'create-session', agent: 'codex', cwd: first, name: 'first', start: false, launchOnOpen: false }, 'create-first')).ok, true);
    const id = store.load().sessions[0].id;
    assert.equal((await command({ type: 'create-session', agent: 'codex', cwd: first, name: 'first', start: false }, 'create-first')).ok, true);
    assert.equal(store.load().sessions.length, 1);
    await command({ type: 'create-session', agent: 'codex', cwd: second, name: 'second', start: false, launchOnOpen: false });
    await command({ type: 'create-session', agent: 'claude', cwd: path.join(first, '.'), name: 'third', start: false, launchOnOpen: false });
    assert.equal(store.load().projects.length, 2);
    assert.equal(store.load().sessions.length, 3);
    assert.equal(manager.sessions.get(id).cwd, fs.realpathSync.native(first));
    assert.equal(new Set([...manager.sessions.values()].map(s => s.cwd)).size, 2);
    const p = store.load().projects[0].id;
    await command({ type: 'rename-session', sessionId: id, name: 'renamed' });
    await command({ type: 'select-session', sessionId: id });
    await command({ type: 'set-project-collapsed', projectId: p, collapsed: true });
    await command({ type: 'launch-on-open', sessionId: id, enabled: true });
    assert.equal(store.load().selectedSessionId, id);
    assert.equal(store.load().projects[0].collapsed, true);
    assert.equal(manager.sessions.get(id).name, 'renamed');
    assert.equal(manager.sessions.get(id).launchOnOpen, true);
    const before = store.load(); failSave = true;
    assert.equal((await command({ type: 'rename-session', sessionId: id, name: 'lost' })).ok, false);
    assert.equal((await command({ type: 'create-session', agent: 'agy', cwd: second, start: false })).ok, false);
    assert.equal((await command({ type: 'launch-on-open', sessionId: id, enabled: false })).ok, false);
    assert.deepEqual(store.load(), before);
    assert.equal(manager.sessions.get(id).name, 'renamed');
    assert.equal(manager.sessions.get(id).launchOnOpen, true);
    assert.equal(manager.sessions.size, 3);
    assert.equal((await command({ type: 'remove-session', sessionId: id, runId: null })).ok, false);
    assert.equal(manager.sessions.has(id), true);
    assert.deepEqual(store.load(), before);
    failSave = false;
    assert.equal((await command({ type: 'create-session', agent: 'powershell', cwd: first })).ok, false);
    assert.equal((await command({ type: 'create-session', agent: 'codex', cwd: path.join(root, 'missing') })).ok, false);
    await command({ type: 'remove-session', sessionId: id, runId: null });
    assert.equal(store.load().sessions.some(s => s.id === id), false);
    assert.equal(fs.statSync(first).isDirectory(), true);
    const event = await nextMessage(socket, m => m.type === 'workspace' && m.sessions?.some(s => s.name === 'renamed'));
    assert.equal(event.sessions.find(s => s.sessionId === id).agentId, 'codex');
  });

  test('a stopped session can move to a separate directory while a running session and sibling sessions stay unchanged', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-session-directory-'));
    const first = path.join(root, 'first'), second = path.join(root, '第二个 workspace');
    fs.mkdirSync(first); fs.mkdirSync(second);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: path.join(root, 'data') });
    store.save(normalizeWorkspace({ schemaVersion: 1, cwd: first, launchOnOpen: { codex: false, agy: false, claude: false } }));
    let failSave = false;
    const savingStore = { load: store.load, save: value => { if (failSave) throw new Error('disk full'); return store.save(value); } };
    const launches = [];
    const manager = new SessionRuntimeManager({
      sessions: store.load().sessions.map(session => ({ ...session, cwd: first })),
      resolveLaunch: async session => { launches.push({ id: session.id, cwd: session.cwd }); return { command: session.agent, cwd: session.cwd }; },
      spawnPty: (_launch, handlers) => ({ write() {}, resize() {}, async kill() { handlers.onExit(0, null); } })
    });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: savingStore });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    await nextMessage(socket, message => message.type === 'snapshot');
    async function command(fields, requestId) {
      socket.send(JSON.stringify({ ...fields, requestId }));
      return nextMessage(socket, message => message.type === 'command-result' && message.requestId === requestId);
    }

    await manager.start('codex');
    const runId = manager.getRuntime('codex').runId;
    const runningMove = await command({ type: 'change-session-directory', sessionId: 'codex', cwd: second }, 'move-running');
    assert.equal(runningMove.ok, false);
    assert.match(runningMove.message, /先停止/);
    assert.equal(store.load().projects.length, 1);

    await manager.stop('codex', runId);
    const move = await command({ type: 'change-session-directory', sessionId: 'codex', cwd: second }, 'move-stopped');
    assert.equal(move.ok, true);
    const moved = store.load();
    const codex = moved.sessions.find(session => session.id === 'codex');
    assert.equal(moved.projects.length, 2);
    assert.equal(moved.projects.find(project => project.id === codex.projectId).rootPath, fs.realpathSync.native(second));
    assert.equal(moved.sessions.find(session => session.id === 'agy').projectId, 'legacy-project');
    assert.equal(moved.sessions.find(session => session.id === 'claude').projectId, 'legacy-project');
    assert.equal(moved.selectedSessionId, 'codex');
    assert.equal(manager.sessions.get('codex').cwd, fs.realpathSync.native(second));
    const updatedWorkspace = await nextMessage(socket, message => message.type === 'workspace' && message.sessions?.some(session => session.sessionId === 'codex' && session.cwd === fs.realpathSync.native(second)));
    assert.equal(updatedWorkspace.workspace.projects.find(project => project.id === codex.projectId).rootPath, fs.realpathSync.native(second));
    assert.equal((await command({ type: 'change-session-directory', sessionId: 'claude', cwd: second }, 'move-into-existing-project')).ok, true);
    assert.equal(store.load().sessions.find(session => session.id === 'claude').projectId, codex.projectId);
    assert.equal(store.load().projects.length, 2);
    const invalidMove = await command({ type: 'change-session-directory', sessionId: 'agy', cwd: path.join(root, 'missing') }, 'move-invalid');
    assert.equal(invalidMove.ok, false);
    assert.equal(manager.sessions.get('agy').cwd, fs.realpathSync.native(first));

    failSave = true;
    const failedMove = await command({ type: 'change-session-directory', sessionId: 'codex', cwd: first }, 'move-save-fails');
    assert.equal(failedMove.ok, false);
    assert.equal(manager.sessions.get('codex').cwd, fs.realpathSync.native(second));
    assert.equal(store.load().projects.find(project => project.id === codex.projectId).rootPath, fs.realpathSync.native(second));
    failSave = false;
    await manager.start('codex');
    assert.equal(launches.at(-1).cwd, fs.realpathSync.native(second));
    assert.equal(manager.sessions.get('agy').cwd, fs.realpathSync.native(first));
  });

  test('removal requires exact run and successful stop and cannot delete an interleaved restart', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-remove-ui-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: path.join(root, 'data') });
    store.save(normalizeWorkspace({ schemaVersion: 1, cwd: root, launchOnOpen: { codex: false, agy: false, claude: false } }));
    let killFails = true, restartOnStop = false;
    const manager = new SessionRuntimeManager({ sessions: store.load().sessions.map(s => ({ ...s, cwd: root })), resolveLaunch: async s => ({ command: s.agent, cwd: s.cwd }), spawnPty: () => ({ write() {}, resize() {}, async kill() { if (killFails) throw new Error('stop refused'); } }) });
    manager.on('event', e => { if (restartOnStop && e.type === 'status' && e.status === 'stopped') { restartOnStop = false; void manager.start(e.sessionId); } });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: store });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    await manager.start('codex');
    const runId = manager.getRuntime('codex').runId;
    async function remove(requestId, run) { socket.send(JSON.stringify({ type: 'remove-session', requestId, sessionId: 'codex', runId: run })); return nextMessage(socket, m => m.type === 'command-result' && m.requestId === requestId); }
    assert.equal((await remove('stale', 'wrong')).ok, false);
    assert.equal((await remove('failed', runId)).ok, false);
    assert.equal(store.load().sessions.length, 3);
    killFails = false; restartOnStop = true;
    assert.equal((await remove('race', runId)).ok, false);
    assert.notEqual(manager.getRuntime('codex').runId, runId);
    assert.equal(store.load().sessions.length, 3);
    assert.equal((await remove('success', manager.getRuntime('codex').runId)).ok, true);
    assert.equal(manager.sessions.has('codex'), false);
    assert.equal(store.load().selectedSessionId, 'agy');
  });

  test('configuration commands queued behind an asynchronous stop preserve every subsequent update', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-queue-ui-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: path.join(root, 'data') });
    store.save(normalizeWorkspace({ schemaVersion: 1, cwd: root, launchOnOpen: { codex: false, agy: false, claude: false } }));
    let finishKill;
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async s => ({ command: s.agent, cwd: s.cwd }), spawnPty: () => ({ write() {}, resize() {}, kill: () => new Promise(resolve => { finishKill = resolve; }) }) });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: store });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    await manager.start('codex');
    socket.send(JSON.stringify({ type: 'remove-session', requestId: 'remove', sessionId: 'codex', runId: manager.getRuntime('codex').runId }));
    await nextMessage(socket, m => m.type === 'status' && m.status === 'stopping');
    socket.send(JSON.stringify({ type: 'create-session', requestId: 'create', agent: 'codex', cwd: root, name: 'new', start: false }));
    socket.send(JSON.stringify({ type: 'rename-session', requestId: 'rename-old', sessionId: 'codex', name: 'should not resurrect' }));
    socket.send(JSON.stringify({ type: 'set-project-collapsed', requestId: 'collapse', projectId: store.load().projects[0].id, collapsed: true }));
    finishKill();
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'remove')).ok, true);
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'create')).ok, true);
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'rename-old')).ok, false);
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'collapse')).ok, true);
    assert.equal(store.load().sessions.length, 3);
    assert.equal(store.load().sessions.some(s => s.id === 'codex'), false);
    assert.equal(store.load().sessions.some(s => s.name === 'new'), true);
    assert.equal(store.load().projects[0].collapsed, true);
  });

  test('removing the selected final session selects its adjacent session', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-adjacent-ui-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: path.join(root, 'data') });
    const config = normalizeWorkspace({ schemaVersion: 1, cwd: root, launchOnOpen: { codex: false, agy: false, claude: false } });
    config.selectedSessionId = 'claude'; store.save(config);
    const manager = new SessionRuntimeManager({ sessions: [] });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: store });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    socket.send(JSON.stringify({ type: 'remove-session', requestId: 'remove-final', sessionId: 'claude', runId: null }));
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'remove-final')).ok, true);
    assert.equal(store.load().selectedSessionId, 'agy');
  });

  test('a missing saved directory is scoped to its session while other auto-start sessions run', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-missing-ui-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: path.join(root, 'data') });
    store.save({ schemaVersion: 2, projects: [{ id: 'missing', rootPath: path.join(root, 'gone'), collapsed: false }, { id: 'valid', rootPath: root, collapsed: false }], sessions: [{ id: 'bad', projectId: 'missing', agent: 'codex', name: 'missing directory', launchOnOpen: true }, { id: 'good', projectId: 'valid', agent: 'codex', name: 'valid directory', launchOnOpen: true }], selectedSessionId: 'bad' });
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async s => { if (!fs.statSync(s.cwd).isDirectory()) throw new Error('bad directory'); return { command: s.agent, cwd: s.cwd }; }, spawnPty: () => ({ write() {}, resize() {}, async kill() {} }) });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: store });
    t.after(() => app.close());
    const { socket } = await connect(app); t.after(() => socket.close());
    const snapshot = await nextMessage(socket, m => m.type === 'snapshot');
    assert.match(snapshot.sessions.find(s => s.sessionId === 'bad').directoryError, /工作目录/);
    assert.equal(snapshot.sessions.find(s => s.sessionId === 'good').directoryError, null);
    await nextMessage(socket, m => m.type === 'status' && m.sessionId === 'good' && m.status === 'running');
    assert.equal(manager.getRuntime('bad').status, 'failed');
    socket.send(JSON.stringify({ type: 'rename-session', requestId: 'rename-missing', sessionId: 'bad', name: 'still saved' }));
    assert.equal((await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'rename-missing')).ok, true);
    assert.equal(store.load().sessions[0].name, 'still saved');
  });

  test('three CLI sessions run concurrently and route input, output, ACK, resize, and stop by session', { timeout: 15000 }, async t => {
    const { manager, ptys } = createRuntime();
    const app = createTerminalUiServer({ manager, sessions });
    t.after(() => app.close());

    const { html, socket } = await connect(app);
    t.after(() => socket.close());
    assert.match(html, /id="project-tree"/);
    assert.match(html, /id="create-form"/);
    assert.match(html, /src="\/app\.js"/);
    assert.match(html, /src="\/vendor\/xterm\.js"/);

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

    const icon = await fetch(`${url}/agentdock-icon.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()), fs.readFileSync(path.join(__dirname, '../app/terminal/ui/agentdock-icon.png')));

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
    const writes = [];
    const manager = new SessionRuntimeManager({
      sessions: [{ id: 'codex', agent: 'codex', cwd }],
      resolveLaunch: async session => ({ command: 'codex.exe', args: [], cwd: session.cwd }),
      spawnPty: () => ({
        write(data) { writes.push(data); }, resize() {},
        async kill() {
          killCount += 1;
          if (killCount === 1) throw new Error('owned process did not exit');
        }
      })
    });
    const app = createTerminalUiServer({ manager, sessions: [{ sessionId: 'codex', agent: 'Codex', cwd }] });
    t.after(async () => { await app.close().catch(() => {}); });
    const { url } = await app.listen(0);
    const { socket } = await connect(app, url);
    t.after(() => socket.close());
    await manager.start('codex');

    await assert.rejects(app.close(), /could not stop.*codex/i);
    assert.equal(manager.getRuntime('codex').status, 'running');
    assert.equal((await fetch(url)).status, 200);
    assert.equal(socket.readyState, WebSocket.OPEN);
    const pong = once(socket, 'pong');
    socket.send(JSON.stringify({ type: 'input', sessionId: 'codex', runId: manager.getRuntime('codex').runId, data: 'still-running\r' }));
    socket.ping('still-usable'); await pong;
    assert.deepEqual(writes, ['still-running\r']);

    assert.equal(await app.close(), true);
    assert.equal(manager.getRuntime('codex').status, 'stopped');
  });

  test('shutdown keeps start and create guarded while waiting for an owned PTY to stop', { timeout: 3000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-shutdown-guard-'));
    let value = { schemaVersion: 2, projects: [{ id: 'p', rootPath: root, collapsed: false }], sessions: ['running', 'idle'].map(id => ({ id, projectId: 'p', agent: 'codex', name: id, launchOnOpen: false })), selectedSessionId: 'running' };
    let finishStop, closing, saveCount = 0, spawnCount = 0;
    const manager = new SessionRuntimeManager({ sessions: [], resolveLaunch: async s => s, spawnPty: () => { spawnCount++; return { write() {}, resize() {}, kill: () => new Promise(resolve => { finishStop = resolve; }) }; } });
    const app = createTerminalUiServer({ manager, sessions: [], workspaceStore: { load: () => structuredClone(value), save: updated => { saveCount++; return (value = structuredClone(updated)); } } });
    let socket;
    t.after(async () => { finishStop?.(); socket?.close(); if (closing) await closing; else await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
    ({ socket } = await connect(app));
    await manager.start('running');
    closing = app.close();
    await nextMessage(socket, m => m.type === 'status' && m.status === 'stopping');
    socket.send(JSON.stringify({ type: 'start', sessionId: 'idle' }));
    socket.send(JSON.stringify({ type: 'start-all' }));
    socket.send(JSON.stringify({ type: 'create-session', requestId: 'closing-create', agent: 'codex', cwd: root, start: true }));
    const rejection = await nextMessage(socket, m => m.type === 'command-result' && m.requestId === 'closing-create');
    assert.equal(rejection.ok, false);
    assert.match(rejection.message, /closing/i);
    assert.equal(manager.getRuntime('idle').status, 'idle');
    assert.equal(spawnCount, 1);
    assert.equal(saveCount, 0);
    assert.equal(value.sessions.length, 2);
    finishStop();
    assert.equal(await closing, true);
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
    store.save(normalizeWorkspace({ schemaVersion: 1, cwd: firstCwd, launchOnOpen: { codex: false, agy: false, claude: false } }));
    store.setLaunchOnOpen('claude', true);
    const config = store.load();
    const appSessions = [
      { id: 'codex', agent: 'codex', label: 'Codex', cwd: config.projects[0].rootPath, launchOnOpen: config.sessions.find(s => s.id === 'codex').launchOnOpen },
      { id: 'agy', agent: 'agy', label: 'Antigravity', cwd: config.projects[0].rootPath, launchOnOpen: config.sessions.find(s => s.id === 'agy').launchOnOpen },
      { id: 'claude', agent: 'claude', label: 'Claude Code', cwd: config.projects[0].rootPath, launchOnOpen: config.sessions.find(s => s.id === 'claude').launchOnOpen }
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
    assert.equal(snapshot.workspace.projects[0].rootPath, fs.realpathSync.native(firstCwd));
    assert.deepEqual(snapshot.sessions.map(s => s.launchOnOpen), [false, false, true]);
    await manager.startAuto();
    assert.deepEqual(ptys.map(pty => pty.command), ['claude.exe']);
    await manager.stop('claude', manager.getRuntime('claude').runId);

    socket.send(JSON.stringify({ type: 'launch-on-open', requestId: 'enable-codex', sessionId: 'codex', enabled: true }));
    const launchChanged = await nextMessage(socket, message => message.type === 'workspace');
    assert.equal(launchChanged.workspace.sessions.find(s => s.id === 'codex').launchOnOpen, true);
    assert.equal(store.load().sessions.find(s => s.id === 'codex').launchOnOpen, true);

    socket.send(JSON.stringify({ type: 'create-session', requestId: 'new-project', agent: 'codex', cwd: nextCwd, name: 'new project session', start: false }));
    const directoryChanged = await nextMessage(socket, message => message.type === 'workspace');
    assert.equal(directoryChanged.workspace.projects[1].rootPath, fs.realpathSync.native(nextCwd));
    assert.ok(appSessions.every(session => session.cwd === fs.realpathSync.native(firstCwd)));
    const newId = directoryChanged.workspace.selectedSessionId;

    socket.send(JSON.stringify({ type: 'start', sessionId: newId }));
    await nextMessage(socket, message => message.type === 'status' && message.sessionId === newId && message.status === 'running');
    assert.equal(ptys.at(-1).cwd, nextCwd);
  });

  test('configured desktop sessions start after the first renderer connects and stream startup output', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-autostart-ui-'));
    const userData = path.join(root, 'user-data');
    const workdir = path.join(root, 'workspace');
    fs.mkdirSync(workdir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const store = createDesktopWorkspaceStore({ userDataPath: userData });
    store.save(normalizeWorkspace({ schemaVersion: 1, cwd: workdir, launchOnOpen: { codex: false, agy: false, claude: false } }));
    store.setLaunchOnOpen('codex', true);
    const config = store.load();
    const appSessions = [
      { id: 'codex', agent: 'codex', label: 'Codex', cwd: config.projects[0].rootPath, launchOnOpen: config.sessions.find(s => s.id === 'codex').launchOnOpen },
      { id: 'agy', agent: 'agy', label: 'Antigravity', cwd: config.projects[0].rootPath, launchOnOpen: config.sessions.find(s => s.id === 'agy').launchOnOpen },
      { id: 'claude', agent: 'claude', label: 'Claude Code', cwd: config.projects[0].rootPath, launchOnOpen: config.sessions.find(s => s.id === 'claude').launchOnOpen }
    ];
    const ptys = [];
    const manager = new SessionRuntimeManager({
      sessions: appSessions,
      resolveLaunch: async session => ({ command: `${session.agent}.exe`, args: [], cwd: session.cwd }),
      spawnPty: (launch, handlers) => {
        const pty = { write() {}, resize() {}, async kill() { handlers.onExit(0, null); } };
        ptys.push({ command: launch.command, handlers });
        setImmediate(() => handlers.onData('startup output marker'));
        return pty;
      },
      createRunId: () => 'auto-start-ui-run'
    });
    const app = createTerminalUiServer({
      manager,
      sessions: appSessions.map(session => ({ sessionId: session.id, agent: session.label, cwd: session.cwd, launchOnOpen: session.launchOnOpen })),
      workspaceStore: store
    });
    t.after(() => app.close());
    const { url } = await app.listen(0);
    assert.equal(ptys.length, 0);

    const first = await connect(app, url);
    t.after(() => first.socket.close());
    const snapshot = await nextMessage(first.socket, message => message.type === 'snapshot');
    assert.equal(snapshot.sessions.find(session => session.sessionId === 'codex').runtime.status, 'idle');
    let startTimeout;
    const started = await Promise.race([
      nextMessage(first.socket, message => message.type === 'status' && message.sessionId === 'codex' && message.status === 'running'),
      new Promise(resolve => { startTimeout = setTimeout(() => resolve(null), 500); })
    ]);
    clearTimeout(startTimeout);
    assert.ok(started, 'the enabled CLI should start after the renderer connects');
    assert.equal(started.runId, 'auto-start-ui-run');
    const output = await nextMessage(first.socket, message => message.type === 'output' && message.sessionId === 'codex');
    assert.equal(output.data, 'startup output marker');
    assert.deepEqual(ptys.map(pty => pty.command), ['codex.exe']);

    first.socket.close();
    await once(first.socket, 'close');
    await manager.stop('codex', started.runId);
    const second = await connect(app, url);
    t.after(() => second.socket.close());
    const resumed = await nextMessage(second.socket, message => message.type === 'snapshot');
    assert.equal(resumed.sessions.find(session => session.sessionId === 'codex').runtime.status, 'stopped');
    assert.equal(ptys.length, 1);
  });

  test('the UI server creates another project while an existing CLI remains active', { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-workspace-active-'));
    const userData = path.join(root, 'user-data');
    const cwdA = path.join(root, 'active');
    const cwdB = path.join(root, 'other');
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDesktopWorkspaceStore({ userDataPath: userData });
    store.save(normalizeWorkspace({ schemaVersion: 1, cwd: cwdA, launchOnOpen: { codex: false, agy: false, claude: false } }));
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
    socket.send(JSON.stringify({ type: 'create-session', requestId: 'while-active', agent: 'codex', cwd: cwdB, start: false }));
    const result = await nextMessage(socket, message => message.type === 'command-result' && message.requestId === 'while-active');
    assert.equal(result.ok, true);
    assert.equal(store.load().projects.length, 2);
    assert.equal(manager.sessions.get('codex').cwd, cwdA);
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
