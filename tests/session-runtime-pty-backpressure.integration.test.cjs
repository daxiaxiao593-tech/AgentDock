const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodePty = require('node-pty');
const { SessionRuntimeManager } = require('../app/runtime/session-runtime-manager.cjs');
const { createNodePtyDriver } = require('../app/runtime/node-pty-driver.cjs');

const fixture = path.join(__dirname, 'fake-cli-pty-burst.cjs');
const totalRows = 65536;
const highWatermark = 64 * 1024;
const lowWatermark = 16 * 1024;

test('Runtime and ConPTY bound unacknowledged burst output and resume without loss', {
  skip: process.platform !== 'win32',
  timeout: 30000
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'AgentDock PTY burst 中文-'));
  let output = '';
  let outputBytes = 0;
  let lastOutputSeq = 0;
  let manager;
  let runId;
  let exitEvent;
  let session;
  let signalError;
  const signals = [];
  const outputEvents = [];

  try {
    assert.equal(nodePty.supportsSafeWindowsProcessTreeCleanup(), true);
    const driver = createNodePtyDriver({ nodePty, platform: 'win32' });
    manager = new SessionRuntimeManager({
      sessions: [{ id: 'burst', agent: 'fake', cwd, launchOnOpen: false }],
      resolveLaunch: async () => ({ command: process.execPath, args: [fixture, String(totalRows)], cwd }),
      spawnPty: (launch, handlers) => {
        const pty = driver(launch, {
          onData: handlers.onData,
          onExit: (code, nativeSignal) => handlers.onExit(code, nativeSignal)
        });
        session = pty;
        const writeControl = pty.write.bind(pty);
        pty.write = value => {
          if (value === '\x13' || value === '\x11') signals.push(value);
          try {
            return writeControl(value);
          } catch (error) {
            signalError = error;
            throw error;
          }
        };
        return pty;
      },
      outputFlow: { highWatermark, lowWatermark }
    });
    manager.on('event', event => {
      if (event.type === 'output') {
        outputEvents.push(event);
        output += event.data;
        outputBytes += Buffer.byteLength(event.data, 'utf8');
        lastOutputSeq = event.seq;
      }
      if (event.type === 'exit') exitEvent = event;
    });

    const started = await manager.start('burst');
    runId = started.runId;
    assert.equal(started.status, 'running');

    const waitFor = async (predicate, description, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${description}; received ${outputBytes} bytes`);
    };

    await waitFor(() => outputBytes >= highWatermark && signals.includes('\x13'), 'high-watermark pause');
    const pausedByteCount = outputBytes;
    await delay(250);
    assert.ok(outputBytes <= pausedByteCount + 256 * 1024, `output grew from ${pausedByteCount} to ${outputBytes} bytes while ACKs were withheld`);
    assert.equal(signals.filter(signal => signal === '\x13').length, 1);
    assert.equal(manager.ack('burst', `stale-${runId}`, lastOutputSeq), false);

    while (!exitEvent) {
      if (signalError) throw signalError;
      assert.ok(manager.ack('burst', runId, lastOutputSeq), 'the current output sequence should be acknowledged');
      const previousBytes = outputBytes;
      await waitFor(() => outputBytes > previousBytes || exitEvent, 'output after ACK', 8000);
    }

    assert.equal(exitEvent.exitCode, 0);
    assert.equal(manager.getRuntime('burst').status, 'stopped');
    const normalizedOutput = output
      .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
    const markerIndex = normalizedOutput.indexOf('AGENTDOCK_BURST_DONE');
    assert.notEqual(markerIndex, -1);
    const rows = normalizedOutput.slice(0, markerIndex).trimEnd().split('\n');
    assert.equal(rows.length, totalRows);
    for (let rowNumber = 0; rowNumber < rows.length; rowNumber += 1) {
      const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const expectedPayload = Array.from({ length: 56 }, (_, offset) => characters[(rowNumber + offset) % characters.length]).join('');
      assert.equal(rows[rowNumber], `${String(rowNumber).padStart(6, '0')}:${expectedPayload}`, `output row ${rowNumber} was lost, duplicated, reordered, or corrupted`);
    }
    assert.ok(signals.includes('\x11'), 'ACKs should resume the ConPTY output socket');
    assert.equal(signals.at(-1), '\x11');
    assert.ok(outputEvents.every((event, index) => event.runId === runId && (index === 0 || event.seq > outputEvents[index - 1].seq)));
    assert.ok(session);
  } finally {
    if (manager && runId && manager.getRuntime('burst').status === 'running') {
      await manager.stop('burst', runId);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
