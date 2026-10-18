const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodePty = require('node-pty');
const { createNodePtyDriver } = require('../app/runtime/node-pty-driver.cjs');

const fixture = path.join(__dirname, 'fake-cli-pty-io.cjs');

test('Windows ConPTY routes input/output and preserves a Chinese spaced cwd', {
  skip: process.platform !== 'win32',
  timeout: 15000
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'AgentDock 中文 cwd-'));
  let output = '';
  let session;
  let exitEvent;

  try {
    assert.equal(nodePty.supportsSafeWindowsProcessTreeCleanup(), true);
    const driver = createNodePtyDriver({ nodePty, platform: 'win32' });
    const exited = new Promise(resolve => {
      session = driver({ command: process.execPath, args: [fixture], cwd }, {
        onData: data => { output += data; },
        onExit: (code, signal) => resolve({ exitCode: code, signal })
      });
    });

    const waitForOutput = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate(output)) return output;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for PTY output: ${output}`);
    };

    await waitForOutput(text => text.includes('AGENTDOCK_READY'));
    assert.ok(output.includes(`AGENTDOCK_CWD:${cwd}`));
    assert.equal(output.includes('AGENTDOCK_INPUT:'), false);

    session.write('你好 AgentDock\r');
    await waitForOutput(text => text.includes('AGENTDOCK_INPUT:你好 AgentDock'));
    session.write('exit\r');

    let timeout;
    exitEvent = await Promise.race([
      exited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('ConPTY fixture did not exit')), 5000); })
    ]).finally(() => clearTimeout(timeout));

    assert.equal(exitEvent.exitCode, 0);
  } finally {
    if (session && !exitEvent) await session.kill().catch(() => {});
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
