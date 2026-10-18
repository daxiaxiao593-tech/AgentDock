const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodePty = require('node-pty');

const fixture = path.join(__dirname, 'fake-cli-process-tree.cjs');

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for process state');
}

async function waitForPid(filePath) {
  return Number(await waitFor(() => fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8')));
}

async function waitForPtyExit(pty, message) {
  let timeout;
  let exitSubscription;
  try {
    return await Promise.race([
      new Promise(resolve => { exitSubscription = pty.onExit(resolve); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 10000); })
    ]);
  } finally {
    clearTimeout(timeout);
    if (exitSubscription) exitSubscription.dispose();
  }
}

test('Windows PTY stop kills detached descendants and preserves unrelated processes', {
  skip: process.platform !== 'win32',
  timeout: 15000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-pty-job-'));
  const sessionState = path.join(root, 'session.pid');
  const sessionStop = path.join(root, 'session.stop');
  const controlState = path.join(root, 'control.pid');
  const controlStop = path.join(root, 'control.stop');
  let control;
  let controlPid;
  let sessionChildPid;
  let pty;

  try {
    assert.equal(nodePty.supportsSafeWindowsProcessTreeCleanup(), true);
    control = spawn(process.execPath, [fixture, 'worker', controlState, controlStop], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    control.unref();
    controlPid = await waitForPid(controlState);

    pty = nodePty.spawn(process.execPath, [fixture, 'root', sessionState, sessionStop], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      useConpty: true,
      handleFlowControl: false
    });
    sessionChildPid = await waitForPid(sessionState);
    pty.kill();
    await waitForPtyExit(pty, 'PTY process did not exit');
    await waitFor(() => !isProcessRunning(sessionChildPid), 3000);

    assert.equal(isProcessRunning(sessionChildPid), false);
    assert.equal(isProcessRunning(controlPid), true);
  } finally {
    if (pty) pty.kill();
    fs.writeFileSync(sessionStop, 'stop');
    fs.writeFileSync(controlStop, 'stop');
    await waitFor(() => (!sessionChildPid || !isProcessRunning(sessionChildPid)) && (!controlPid || !isProcessRunning(controlPid)), 4000).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows PTY natural root exit kills detached descendants', {
  skip: process.platform !== 'win32',
  timeout: 15000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-pty-exit-'));
  const sessionState = path.join(root, 'session.pid');
  const sessionStop = path.join(root, 'session.stop');
  const rootExit = path.join(root, 'root.exit');
  let sessionChildPid;
  let pty;

  try {
    assert.equal(nodePty.supportsSafeWindowsProcessTreeCleanup(), true);
    pty = nodePty.spawn(process.execPath, [fixture, 'root-exit', sessionState, sessionStop, rootExit], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      useConpty: true,
      handleFlowControl: false
    });
    sessionChildPid = await waitForPid(sessionState);
    fs.writeFileSync(rootExit, 'exit');
    const exitEvent = await waitForPtyExit(pty, 'PTY root did not exit naturally');

    assert.equal(exitEvent.exitCode, 23);
    await waitFor(() => !isProcessRunning(sessionChildPid), 3000);
    assert.equal(isProcessRunning(sessionChildPid), false);
  } finally {
    if (pty) pty.kill();
    fs.writeFileSync(sessionStop, 'stop');
    if (sessionChildPid) await waitFor(() => !isProcessRunning(sessionChildPid), 4000).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows PTY job rejects CREATE_BREAKAWAY_FROM_JOB for an owned descendant', {
  skip: process.platform !== 'win32',
  timeout: 15000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-pty-breakaway-'));
  const workerState = path.join(root, 'breakaway.pid');
  const workerStop = path.join(root, 'breakaway.stop');
  const attemptResult = path.join(root, 'breakaway-result.txt');
  let pty;
  let workerPid;

  try {
    assert.equal(nodePty.supportsSafeWindowsProcessTreeCleanup(), true);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = path.join(__dirname, 'fake-cli-breakaway-create.ps1');
    pty = nodePty.spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      process.execPath, fixture, workerState, workerStop, attemptResult
    ], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      useConpty: true,
      handleFlowControl: false
    });

    const attempt = await waitFor(() => fs.existsSync(attemptResult) && fs.readFileSync(attemptResult, 'utf8'));
    const match = attempt.match(/^in-job:(true|false);created:(true|false);error:(\d+);pid:(\d+)$/);
    assert.ok(match, `Unexpected breakaway probe result: ${attempt}`);
    assert.equal(match[1], 'true');
    if (match[2] === 'false') {
      assert.equal(Number(match[3]), 5);
      assert.equal(Number(match[4]), 0);
      assert.equal(fs.existsSync(workerState), false);
    } else {
      assert.equal(Number(match[3]), 0);
      workerPid = Number(match[4]);
      await waitFor(() => fs.existsSync(workerState), 3000);
      assert.equal(Number(fs.readFileSync(workerState, 'utf8')), workerPid);
    }

    pty.kill();
    await waitForPtyExit(pty, 'PTY process did not exit after the breakaway probe');
    await waitFor(() => !isProcessRunning(pty.pid), 3000);
    assert.equal(isProcessRunning(pty.pid), false);
    if (workerPid) {
      await waitFor(() => !isProcessRunning(workerPid), 3000);
      assert.equal(isProcessRunning(workerPid), false);
    }
  } finally {
    if (pty && isProcessRunning(pty.pid)) {
      pty.kill();
      await waitForPtyExit(pty, 'PTY process did not exit during cleanup').catch(() => {});
    }
    fs.writeFileSync(workerStop, 'stop');
    if (!workerPid && fs.existsSync(attemptResult)) {
      const match = fs.readFileSync(attemptResult, 'utf8').match(/;pid:(\d+)$/);
      if (match && Number(match[1]) > 0) workerPid = Number(match[1]);
    }
    if (!workerPid && fs.existsSync(workerState)) workerPid = Number(fs.readFileSync(workerState, 'utf8'));
    if (workerPid && isProcessRunning(workerPid)) {
      try { process.kill(workerPid); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await waitFor(() => !workerPid || !isProcessRunning(workerPid), 4000).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
