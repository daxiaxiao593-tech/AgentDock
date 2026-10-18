const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCliLaunch } = require('../app/runtime/cli-launch-resolver.cjs');

test('从 PATH 定位原生 Codex exe，不添加产品默认启动参数', () => {
  const launch = resolveCliLaunch('codex', 'D:\\项目\\站点', {
    env: { PATH: 'C:\\npm-global;C:\\Users\\me\\Codex\\bin' },
    fileExists: candidate => candidate === 'C:\\Users\\me\\Codex\\bin\\codex.exe'
  });

  assert.deepEqual(launch, {
    command: 'C:\\Users\\me\\Codex\\bin\\codex.exe',
    args: [],
    cwd: 'D:\\项目\\站点'
  });
});

test('PATH 找不到时回退到该工具的标准本机安装位置', () => {
  const launch = resolveCliLaunch('agy', 'D:\\repo', {
    env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    fileExists: candidate => candidate === 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe'
  });

  assert.equal(launch.command, 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe');
  assert.deepEqual(launch.args, []);
  assert.equal(launch.cwd, 'D:\\repo');
});

test('没有原生 exe 时拒绝解析，不回退到 shell 启动器', () => {
  assert.throws(() => resolveCliLaunch('claude', 'D:\\repo', {
    env: { PATH: 'C:\\Users\\me\\npm-global', USERPROFILE: 'C:\\Users\\me' },
    fileExists: () => false
  }), /native claude\.exe.*not found/i);
});

test('拒绝未知工具标识，且不触碰文件系统', () => {
  let checked = false;

  assert.throws(() => resolveCliLaunch('shell', 'D:\\repo', {
    env: {},
    fileExists: () => { checked = true; return true; }
  }), /unsupported CLI/i);
  assert.equal(checked, false);
});
