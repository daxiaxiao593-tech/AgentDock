const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { parseServiceArgs, startDesktopService } = require('../app/desktop/service-entry.cjs');

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.messages = [];
    this.exitCodes = [];
  }

  send(message, callback) {
    this.messages.push(message);
    callback?.();
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }

  exit(code) {
    this.exitCodes.push(code);
  }
}

test('desktop service arguments require one absolute userData path', () => {
  assert.equal(parseServiceArgs(['--user-data', 'C:\\Users\\test\\AppData\\AgentDock']), 'C:\\Users\\test\\AppData\\AgentDock');
  assert.throws(() => parseServiceArgs([]), /--user-data/);
  assert.throws(() => parseServiceArgs(['--user-data', 'relative']), /absolute/i);
});

test('the hidden service announces a random loopback endpoint and exits when its parent disconnects', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-service-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processLike = new FakeProcess();
  const service = await startDesktopService({ userDataPath: path.join(root, 'user-data'), processLike });
  t.after(() => service.app.server.close().catch(() => {}));

  const ready = processLike.messages.find(message => message.type === 'ready');
  assert.ok(ready);
  assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(ready.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await fetch(ready.origin)).status, 200);

  processLike.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(processLike.exitCodes, [0]);
  await assert.rejects(fetch(ready.origin));
});
