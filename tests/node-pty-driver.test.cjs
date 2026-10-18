const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNodePtyDriver } = require('../app/runtime/node-pty-driver.cjs');

function fakeNodePty() {
  const calls = [];
  let dataListener;
  let exitListener;
  let exitValue;
  const terminal = {
    pid: 4312,
    onData(listener) {
      dataListener = listener;
      return { dispose() {} };
    },
    onExit(listener) {
      exitListener = listener;
      if (exitValue) listener(exitValue);
      return { dispose() {} };
    },
    write(data) { calls.push(['write', data]); },
    resize(columns, rows) { calls.push(['resize', columns, rows]); },
    kill() { calls.push(['kill']); }
  };
  const module = {
    spawn(command, args, options) {
      calls.push(['spawn', command, args, options]);
      return terminal;
    }
  };
  return {
    calls,
    module,
    emitData(data) { dataListener(data); },
    emitExit(value) {
      exitValue = value;
      if (exitListener) exitListener(value);
    }
  };
}

test('PTY 使用原始命令、参数和 cwd，不添加 CLI 权限参数', () => {
  const fake = fakeNodePty();
  const events = [];
  const spawnPty = createNodePtyDriver({ nodePty: fake.module, killProcess: terminal => terminal.kill() });
  const session = spawnPty({ command: 'C:\\Tools\\agy.exe', args: ['--safe', 'two words'], cwd: 'D:\\项目 目录' }, {
    onData: data => events.push(['data', data]),
    onExit: (...args) => events.push(['exit', ...args])
  });

  assert.deepEqual(fake.calls[0], ['spawn', 'C:\\Tools\\agy.exe', ['--safe', 'two words'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: 'D:\\项目 目录',
    handleFlowControl: true,
    ...(process.platform === 'win32' ? { useConpty: true, env: { ...process.env, TERM: 'xterm-256color' } } : {})
  }]);
  fake.emitData('output');
  assert.deepEqual(events, [['data', 'output']]);
  session.write('user input');
  session.resize(110, 35);
  assert.deepEqual(fake.calls.slice(1), [['write', 'user input'], ['resize', 110, 35]]);
});

test('Windows ConPTY 将 TERM 与配置的终端类型对齐', () => {
  const inheritedTerm = process.env.TERM;
  process.env.TERM = 'dumb';
  try {
    const fake = fakeNodePty();
    const spawnPty = createNodePtyDriver({ nodePty: fake.module, platform: 'win32', name: 'xterm-256color' });
    spawnPty({ command: 'C:\\Tools\\agy.exe', args: [], cwd: 'D:\\repo' }, {
      onData() {},
      onExit() {}
    });

    assert.equal(fake.calls[0][3].env.TERM, 'xterm-256color');
    const inheritedPath = Object.entries(fake.calls[0][3].env).find(([key]) => key.toLowerCase() === 'path')?.[1];
    assert.equal(inheritedPath, process.env.PATH);
  } finally {
    if (inheritedTerm === undefined) delete process.env.TERM;
    else process.env.TERM = inheritedTerm;
  }
});

test('stop 调用 PTY kill，但只在实际 onExit 后完成', async () => {
  const fake = fakeNodePty();
  let resolveStop;
  const spawnPty = createNodePtyDriver({ nodePty: fake.module, killProcess: terminal => terminal.kill() });
  const session = spawnPty({ command: 'fake-cli', args: [], cwd: 'D:\\repo' }, {
    onData() {},
    onExit: (exitCode, signal) => resolveStop([exitCode, signal])
  });
  const stopped = new Promise(resolve => { resolveStop = resolve; });
  const stopping = session.kill();
  let resolved = false;
  stopping.then(() => { resolved = true; });
  await Promise.resolve();

  assert.deepEqual(fake.calls.at(-1), ['kill']);
  assert.equal(resolved, false);
  fake.emitExit({ exitCode: 0, signal: 2 });
  assert.deepEqual(await stopped, [0, 2]);
  await stopping;
});

test('PTY 退出事件完成重复 stop，迟到输出不再转发', async () => {
  const fake = fakeNodePty();
  const events = [];
  const spawnPty = createNodePtyDriver({ nodePty: fake.module });
  const session = spawnPty({ command: 'fake-cli', args: [], cwd: 'D:\\repo' }, {
    onData: data => events.push(data),
    onExit: () => events.push('exit')
  });
  fake.emitExit({ exitCode: 3 });
  fake.emitData('late');

  assert.deepEqual(events, ['exit']);
  assert.equal(await session.kill(), undefined);
  assert.equal(fake.calls.filter(([type]) => type === 'kill').length, 0);
});

test('Windows 已验证 ConPTY 在自然退出后释放终端资源', () => {
  const fake = fakeNodePty();
  fake.module.supportsSafeWindowsProcessTreeCleanup = () => true;
  const spawnPty = createNodePtyDriver({ nodePty: fake.module, platform: 'win32' });
  spawnPty({ command: 'C:\\Tools\\agy.exe', args: [], cwd: 'D:\\repo' }, {
    onData() {},
    onExit() {}
  });

  fake.emitExit({ exitCode: 0 });

  assert.equal(fake.calls.filter(([type]) => type === 'kill').length, 1);
});

test('Windows 未注入已验证清理器时拒绝调用 node-pty kill', async () => {
  const fake = fakeNodePty();
  const spawnPty = createNodePtyDriver({ nodePty: fake.module, platform: 'win32' });
  const session = spawnPty({ command: 'fake-cli', args: [], cwd: 'D:\\repo' }, {
    onData() {},
    onExit() {}
  });

  await assert.rejects(session.kill(), /process-tree cleanup is not verified/);
  assert.equal(fake.calls.some(([type]) => type === 'kill'), false);
});

test('Windows 只在原生 Job Object 能力已验证时默认终止 PTY', async () => {
  const fake = fakeNodePty();
  fake.module.supportsSafeWindowsProcessTreeCleanup = () => true;
  const spawnPty = createNodePtyDriver({ nodePty: fake.module, platform: 'win32' });
  const session = spawnPty({ command: 'C:\\Tools\\agy.exe', args: [], cwd: 'D:\\repo' }, {
    onData() {},
    onExit() {}
  });

  assert.equal(fake.calls[0][3].useConpty, true);
  const stopping = session.kill();
  assert.equal(fake.calls.some(([type]) => type === 'kill'), true);
  fake.emitExit({ exitCode: 0 });
  await stopping;
});

test('Windows 不把 .cmd 或 .bat 启动器交给 PTY', () => {
  const fake = fakeNodePty();
  const spawnPty = createNodePtyDriver({ nodePty: fake.module, platform: 'win32' });

  for (const command of ['C:\\Tools\\agy.cmd', 'C:\\Tools\\agy.BAT']) {
    assert.throws(() => spawnPty({ command, args: [], cwd: 'D:\\repo' }, {
      onData() {},
      onExit() {}
    }), /native \.exe/);
  }
  assert.equal(fake.calls.length, 0);
});
