const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionRuntimeManager } = require('../app/runtime/session-runtime-manager.cjs');
const { createNodePtyDriver } = require('../app/runtime/node-pty-driver.cjs');

function createStreamPtyModule() {
  return {
    spawn(command, args, options) {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: 'pipe',
        windowsHide: true
      });
      return {
        onData(listener) {
          const receive = data => listener(data.toString('utf8'));
          child.stdout.on('data', receive);
          return { dispose: () => child.stdout.off('data', receive) };
        },
        onExit(listener) {
          const receive = (exitCode, signal) => listener({ exitCode, signal });
          child.once('exit', receive);
          return { dispose: () => child.off('exit', receive) };
        },
        write(data) { child.stdin.write(data); },
        resize() {},
        kill() { child.kill(); }
      };
    }
  };
}

function waitForOutput(outputState, expected) {
  if (outputState.value.includes(expected)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 3000);
    const check = () => {
      if (!outputState.value.includes(expected)) return;
      clearTimeout(deadline);
      outputState.waiters.delete(check);
      resolve();
    };
    outputState.waiters.add(check);
  });
}

test('假 CLI 启动无自动输入，人工输入按当前 run 路由且只停止测试子进程', async () => {
  const fixture = path.join(__dirname, 'fake-cli-fixture.cjs');
  const outputState = { value: '', waiters: new Set() };
  const manager = new SessionRuntimeManager({
    sessions: [{ id: 'fake-session', cwd: __dirname, launchOnOpen: false }],
    resolveLaunch: async session => ({ command: process.execPath, args: [fixture], cwd: session.cwd }),
    spawnPty: createNodePtyDriver({
      nodePty: createStreamPtyModule(),
      platform: 'win32',
      killProcess: terminal => terminal.kill()
    })
  });
  manager.on('event', event => {
    if (event.type === 'output' && event.sessionId === 'fake-session') {
      outputState.value += event.data;
      for (const check of outputState.waiters) check();
    }
  });

  const ready = waitForOutput(outputState, 'FAKE CLI READY');
  const started = await manager.start('fake-session');
  await ready;
  const runId = started.runId;
  assert.doesNotMatch(outputState.value, /INPUT:/);

  const response = waitForOutput(outputState, 'INPUT:manual test input');
  assert.equal(manager.write('fake-session', runId, 'manual test input\n'), true);
  await response;

  assert.equal(await manager.stop('fake-session', runId), true);
  assert.equal(manager.getRuntime('fake-session').status, 'stopped');
});
