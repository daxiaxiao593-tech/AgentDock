const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createDesktopServiceHost } = require('../app/desktop/service-host.cjs');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.killed = 0;
    this.connected = true;
  }

  send(message, callback) {
    this.messages.push(message);
    callback?.();
  }

  kill() {
    this.killed += 1;
    this.connected = false;
    this.emit('exit', 1, null);
    return true;
  }
}

function createHarness(options = {}) {
  const child = new FakeChild();
  const calls = [];
  const host = createDesktopServiceHost({
    runtimePath: 'C:\\AgentDock\\runtime\\node.exe',
    serviceEntryPath: 'C:\\AgentDock\\app\\service-entry.cjs',
    userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\AgentDock',
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    forkProcess: (...args) => { calls.push(args); return child; },
    ...options
  });
  return { host, child, calls };
}

test('desktop service starts with the fixed runtime hidden and waits for a private ready message', async () => {
  const { host, child, calls } = createHarness();
  const starting = host.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'C:\\AgentDock\\app\\service-entry.cjs');
  assert.equal(calls[0][1][0], '--user-data');
  assert.equal(calls[0][2].execPath, 'C:\\AgentDock\\runtime\\node.exe');
  assert.equal(calls[0][2].windowsHide, true);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'ignore', 'ignore', 'ipc']);

  child.emit('message', { type: 'ready', origin: 'http://127.0.0.1:43127', token: 'A'.repeat(43) });
  assert.deepEqual(await starting, { origin: 'http://127.0.0.1:43127', token: 'A'.repeat(43) });
  assert.equal(host.isReady, true);
});

test('desktop service rejects a ready message outside the loopback origin boundary', async () => {
  const { host, child } = createHarness();
  const starting = host.start();
  child.emit('message', { type: 'ready', origin: 'http://localhost:43127', token: 'A'.repeat(43) });
  await assert.rejects(starting, /invalid ready message/i);
  assert.equal(child.killed, 1);
});

test('desktop service startup timeout terminates only its owned child process', async () => {
  const { host, child } = createHarness({ startupTimeoutMs: 10 });
  await assert.rejects(host.start(), /did not become ready.*within/i);
  assert.equal(child.killed, 1);
});

test('normal shutdown waits for stopped, and a cancellation or failed stop leaves the service available', async () => {
  const { host, child } = createHarness();
  const starting = host.start();
  child.emit('message', { type: 'ready', origin: 'http://127.0.0.1:43127', token: 'B'.repeat(43) });
  await starting;

  const stopping = host.shutdown();
  assert.deepEqual(child.messages.at(-1), { type: 'shutdown' });
  child.emit('message', { type: 'shutdown-failed', message: 'PTY did not exit' });
  assert.equal(await stopping, false);
  assert.equal(host.isReady, true);
  assert.equal(child.killed, 0);
});

test('an unexpected service exit is reported without an automatic restart', async () => {
  const { host, child, calls } = createHarness();
  const starting = host.start();
  child.emit('message', { type: 'ready', origin: 'http://127.0.0.1:43127', token: 'C'.repeat(43) });
  await starting;
  const exits = [];
  host.on('exit', result => exits.push(result));
  child.emit('exit', 17, null);
  assert.deepEqual(exits, [{ code: 17, signal: null, expected: false }]);
  assert.equal(calls.length, 1);
  assert.equal(host.isReady, false);
});
