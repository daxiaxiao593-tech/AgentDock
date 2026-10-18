const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionRuntimeManager } = require('../app/runtime/session-runtime-manager.cjs');
const { createNodePtyDriver } = require('../app/runtime/node-pty-driver.cjs');

function setup(options = {}) {
  const sessions = [
    { id: 'session-a', agent: 'codex', cwd: 'E:\\repo-a', launchOnOpen: true },
    { id: 'session-b', agent: 'claude', cwd: 'E:\\repo-b', launchOnOpen: false }
  ];
  const spawned = [];
  const resolveLaunch = options.resolveLaunch || (async session => ({
    command: 'fake-cli',
    args: [],
    cwd: session.cwd
  }));
  const spawnPty = (launch, handlers) => {
    const pty = {
      launch,
      handlers,
      writes: [],
      sizes: [],
      killCount: 0,
      write(data) { this.writes.push(data); },
      resize(columns, rows) { this.sizes.push([columns, rows]); },
      async kill() {
        this.killCount += 1;
        handlers.onExit(0, null);
      }
    };
    spawned.push(pty);
    return pty;
  };
  const runIds = ['run-a1', 'run-a2', 'run-b1'];
  const manager = new SessionRuntimeManager({
    sessions,
    resolveLaunch,
    spawnPty: options.spawnPty || spawnPty,
    outputFlow: options.outputFlow,
    createRunId: () => runIds.shift() || `run-${runIds.length}`
  });
  return { manager, spawned, sessions };
}

test('同一会话启动幂等，不同会话拥有独立运行与 cwd', async () => {
  const { manager, spawned } = setup();

  await Promise.all([manager.start('session-a'), manager.start('session-a')]);
  const first = manager.getRuntime('session-a');
  await manager.start('session-b');
  const second = manager.getRuntime('session-b');

  assert.equal(spawned.length, 2);
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'running');
  assert.notEqual(first.runId, second.runId);
  assert.equal(spawned[0].launch.cwd, 'E:\\repo-a');
  assert.equal(spawned[1].launch.cwd, 'E:\\repo-b');
});

test('每个事件带 runId 和递增序号，旧 run 的迟到输出与退出被忽略', async () => {
  const { manager, spawned } = setup();
  const events = [];
  manager.on('event', event => events.push(event));

  await manager.start('session-a');
  const firstRunId = manager.getRuntime('session-a').runId;
  const previousPty = spawned[0];
  previousPty.handlers.onData('first output');
  await manager.stop('session-a', firstRunId);
  await manager.start('session-a');
  const currentRunId = manager.getRuntime('session-a').runId;
  previousPty.handlers.onData('late output');
  previousPty.handlers.onExit(9, null);

  const outputs = events.filter(event => event.type === 'output');
  assert.deepEqual(outputs.map(event => event.data), ['first output']);
  assert.equal(outputs[0].runId, firstRunId);
  assert.ok(events.every(event => typeof event.runId === 'string' && Number.isInteger(event.seq)));
  assert.ok(events.filter(event => event.runId === firstRunId).every((event, index, runEvents) => index === 0 || event.seq > runEvents[index - 1].seq));
  assert.equal(manager.getRuntime('session-a').runId, currentRunId);
  assert.equal(manager.getRuntime('session-a').status, 'running');
});

test('写入和 resize 必须匹配当前 runId', async () => {
  const { manager, spawned } = setup();
  await manager.start('session-a');
  const firstRunId = manager.getRuntime('session-a').runId;
  await manager.stop('session-a', firstRunId);
  await manager.start('session-a');
  const currentRunId = manager.getRuntime('session-a').runId;

  assert.equal(manager.write('session-a', firstRunId, 'stale'), false);
  assert.equal(manager.resize('session-a', firstRunId, 80, 24), false);
  assert.equal(manager.write('session-a', currentRunId, 'current'), true);
  assert.equal(manager.resize('session-a', currentRunId, 100, 40), true);
  assert.deepEqual(spawned[1].writes, ['current']);
  assert.deepEqual(spawned[1].sizes, [[100, 40]]);
});

test('启动解析未完成时停止，不会在解析返回后创建进程', async () => {
  let resolveLaunch;
  const pendingLaunch = new Promise(resolve => { resolveLaunch = resolve; });
  const { manager, spawned } = setup({ resolveLaunch: () => pendingLaunch });
  const starting = manager.start('session-a');
  const runId = manager.getRuntime('session-a').runId;

  assert.equal(await manager.stop('session-a', runId), true);
  resolveLaunch({ command: 'fake-cli', args: [], cwd: 'E:\\repo-a' });
  assert.equal((await starting).status, 'stopped');
  assert.equal(spawned.length, 0);
});

test('自动启动只启动已勾选会话', async () => {
  const { manager, spawned } = setup();

  await manager.startAuto();

  assert.equal(spawned.length, 1);
  assert.equal(manager.getRuntime('session-a').status, 'running');
  assert.equal(manager.getRuntime('session-b').status, 'idle');
});

test('启动失败可见且不阻止启动全部中的其他会话', async () => {
  const { manager, spawned } = setup({
    resolveLaunch: async session => {
      if (session.id === 'session-a') throw new Error('CLI not found');
      return { command: 'fake-cli', args: [], cwd: session.cwd };
    }
  });

  await manager.startAll();

  assert.equal(manager.getRuntime('session-a').status, 'failed');
  assert.match(manager.getRuntime('session-a').error, /CLI not found/);
  assert.equal(manager.getRuntime('session-b').status, 'running');
  assert.equal(spawned.length, 1);
});

test('停止失败保留运行实例，重试成功后才结束', async () => {
  let pty;
  const { manager } = setup({
    spawnPty: (launch, handlers) => {
      pty = {
        writes: [],
        sizes: [],
        killCount: 0,
        write(data) { this.writes.push(data); },
        resize(columns, rows) { this.sizes.push([columns, rows]); },
        async kill() {
          this.killCount += 1;
          if (this.killCount === 1) throw new Error('process did not stop');
          handlers.onExit(0, null);
        }
      };
      return pty;
    }
  });
  await manager.start('session-a');
  const runId = manager.getRuntime('session-a').runId;

  assert.equal(await manager.stop('session-a', runId), false);
  assert.equal(manager.getRuntime('session-a').status, 'running');
  assert.match(manager.getRuntime('session-a').error, /process did not stop/);
  assert.equal(await manager.stop('session-a', runId), true);
  assert.equal(manager.getRuntime('session-a').status, 'stopped');
  assert.equal(pty.killCount, 2);
});

test('输出 ACK 与 runId 绑定，旧会话运行不能恢复新运行的流控', async () => {
  const { manager, spawned } = setup({ outputFlow: { highWatermark: 8, lowWatermark: 3 } });
  const events = [];
  manager.on('event', event => events.push(event));

  await manager.start('session-a');
  const firstRunId = manager.getRuntime('session-a').runId;
  spawned[0].handlers.onData('12345678');
  const firstOutput = events.find(event => event.type === 'output');
  assert.equal(spawned[0].writes.at(-1), '\x13');
  assert.equal(await manager.stop('session-a', firstRunId), true);

  await manager.start('session-a');
  const currentRunId = manager.getRuntime('session-a').runId;
  spawned[1].handlers.onData('abcdefgh');
  const outputs = events.filter(event => event.type === 'output');

  assert.equal(firstOutput.runId, firstRunId);
  assert.equal(await manager.ack('session-a', firstRunId, firstOutput.seq), false);
  assert.deepEqual(spawned[1].writes, ['\x13']);
  assert.equal(await manager.ack('session-a', currentRunId, outputs[1].seq), true);
  assert.deepEqual(spawned[1].writes, ['\x13', '\x11']);
  assert.ok(events.every((event, index, allEvents) => index === 0 || event.runId !== allEvents[index - 1].runId || event.seq > allEvents[index - 1].seq));
});

test('Windows 清理边界未验证时停止显示失败并保留会话运行态', async () => {
  let killCount = 0;
  const nodePty = {
    spawn() {
      return {
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() { killCount += 1; }
      };
    }
  };
  const { manager } = setup({
    spawnPty: createNodePtyDriver({ nodePty, platform: 'win32' })
  });
  await manager.start('session-a');
  const runId = manager.getRuntime('session-a').runId;

  assert.equal(await manager.stop('session-a', runId), false);
  assert.equal(manager.getRuntime('session-a').status, 'running');
  assert.match(manager.getRuntime('session-a').error, /process-tree cleanup is not verified/);
  assert.equal(killCount, 0);
});
