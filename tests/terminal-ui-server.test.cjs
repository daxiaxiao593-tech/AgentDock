const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const { SessionRuntimeManager } = require('../app/runtime/session-runtime-manager.cjs');

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

  async function connect(app) {
    const { url } = await app.listen(0);
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
}
