const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { randomUUID } = require('node:crypto');

function setup(saved) {
  const source = readFileSync(join(__dirname, '../Demo/agent-dock-mock.html'), 'utf8');
  const code = source.match(/<script id="mock-engine">([\s\S]*?)<\/script>/)[1];
  const context = { crypto: { randomUUID }, setTimeout, clearTimeout };
  runInNewContext(code, context);
  let currentTime = 0;
  let timerId = 0;
  const timers = new Map();
  const storage = {
    value: saved,
    getItem() { return this.value ?? null; },
    setItem(key, value) { this.value = value; }
  };
  const clock = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, time: currentTime + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(duration) {
      const targetTime = currentTime + duration;
      while (true) {
        const next = [...timers].sort((left, right) => left[1].time - right[1].time)[0];
        if (!next || next[1].time > targetTime) break;
        currentTime = next[1].time;
        timers.delete(next[0]);
        next[1].callback();
      }
      currentTime = targetTime;
    }
  };
  const engine = new context.AgentDockEngine(storage, clock);
  return { engine, storage, clock };
}

test('首次种子互相独立，保存空列表后不重新填充', () => {
  const first = setup();
  const second = setup();
  first.engine.workspace.sessions[0].name = '修改过';
  assert.notEqual(second.engine.workspace.sessions[0].name, '修改过');
  const empty = setup(JSON.stringify({ schemaVersion: 1, projects: [], sessions: [], activeSessionId: null }));
  assert.equal(empty.engine.workspace.sessions.length, 0);
});

test('独立目录归组不改写原项目；盘符、分隔符和点路径归一', () => {
  const { engine } = setup();
  const originalPath = engine.workspace.projects[0].rootPath;
  const added = engine.create({ agent: 'codex', rootPath: 'e:/新项目/../新项目/网站/', name: '新目录', launchOnOpen: true });
  const sibling = engine.create({ agent: 'claude', rootPath: 'E:\\新项目\\网站', name: '同目录', launchOnOpen: false });
  assert.equal(added.projectId, sibling.projectId);
  assert.equal(engine.workspace.projects[0].rootPath, originalPath);
  assert.equal(engine.workspace.projects.length, 3);
  const sameName = engine.create({ agent: 'agy', rootPath: 'F:\\其他位置\\网站', name: '', launchOnOpen: true });
  assert.notEqual(sameName.projectId, added.projectId);
  assert.throws(() => engine.create({ agent: 'codex', rootPath: 'relative/path' }), /绝对路径/);
});

test('Windows 大小写敏感目录不被全路径小写合并', () => {
  const { engine } = setup();
  const upper = engine.create({ agent: 'codex', rootPath: 'E:\\Case', launchOnOpen: true });
  const lower = engine.create({ agent: 'codex', rootPath: 'E:\\case', launchOnOpen: true });
  assert.notEqual(upper.projectId, lower.projectId);
});

test('启动全部幂等，启动中不会重复运行', () => {
  const { engine, clock } = setup();
  engine.startAll();
  const runIds = engine.workspace.sessions.map(session => engine.runtime(session.id).runId);
  engine.startAll();
  assert.deepEqual(engine.workspace.sessions.map(session => engine.runtime(session.id).runId), runIds);
  clock.advance(500);
  assert.equal(engine.workspace.sessions.filter(session => engine.runtime(session.id).status === 'running').length, 3);
});

test('A 任务后台回复只写入 A，保留 B 草稿与状态', () => {
  const { engine, clock } = setup();
  engine.startAll(); clock.advance(500);
  const [first, second] = engine.workspace.sessions;
  engine.send(first.id, '仅属于 A 的任务');
  engine.select(second.id);
  engine.runtime(second.id).draft = 'B 的草稿';
  clock.advance(2000);
  assert.equal(engine.runtime(first.id).unread, true);
  assert.ok(engine.runtime(first.id).lines.some(line => line.text.includes('仅属于 A')));
  assert.ok(!engine.runtime(second.id).lines.some(line => line.text.includes('仅属于 A')));
  assert.equal(engine.runtime(second.id).draft, 'B 的草稿');
  assert.equal(engine.runtime(second.id).status, 'running');
  engine.select(first.id);
  assert.equal(engine.runtime(first.id).unread, false);
});

test('停止中拒绝旧任务；重启隔离迟到输出与退出', async () => {
  const { engine, clock } = setup();
  const session = engine.workspace.sessions[0];
  engine.start(session.id); clock.advance(500);
  const previousRun = engine.runtime(session.id).runId;
  engine.send(session.id, '将被取消的任务');
  const stopping = engine.stop(session.id);
  assert.equal(engine.runtime(session.id).status, 'stopping');
  assert.equal(engine.output(session.id, previousRun, '不应出现'), false);
  clock.advance(500); await stopping;
  assert.equal(engine.runtime(session.id).status, 'stopped');
  engine.start(session.id); clock.advance(2000);
  const currentRun = engine.runtime(session.id).runId;
  assert.notEqual(currentRun, previousRun);
  assert.equal(engine.output(session.id, previousRun, '迟到输出'), false);
  assert.equal(engine.exit(session.id, previousRun, 1), false);
  assert.equal(engine.runtime(session.id).status, 'running');
  assert.ok(!engine.runtime(session.id).lines.some(line => /迟到输出|不应出现/.test(line.text)));
});

test('启动中停止，不会被启动回调复活', async () => {
  const { engine, clock } = setup();
  const session = engine.workspace.sessions[0];
  engine.start(session.id);
  const stopping = engine.stop(session.id);
  clock.advance(3000); await stopping;
  assert.equal(engine.runtime(session.id).status, 'stopped');
});

test('单会话启动失败不影响启动全部，失败可重试', () => {
  const { engine, clock } = setup();
  const session = engine.workspace.sessions[0];
  engine.runtime(session.id).failNextStart = true;
  engine.startAll(); clock.advance(500);
  assert.equal(engine.runtime(session.id).status, 'failed');
  assert.equal(engine.runtime(engine.workspace.sessions[1].id).status, 'running');
  engine.start(session.id); clock.advance(500);
  assert.equal(engine.runtime(session.id).status, 'running');
});

test('停止失败保留运行与配置，之后可再次停止并移除', async () => {
  const { engine, clock } = setup();
  const session = engine.workspace.sessions[0];
  engine.start(session.id); clock.advance(500);
  engine.runtime(session.id).failNextStop = true;
  const removing = engine.remove(session.id);
  clock.advance(500);
  assert.equal(await removing, false);
  assert.ok(engine.session(session.id));
  assert.equal(engine.runtime(session.id).status, 'running');
  assert.match(engine.runtime(session.id).error, /停止失败/);
  const retry = engine.remove(session.id);
  clock.advance(500);
  assert.equal(await retry, true);
  assert.equal(engine.session(session.id), undefined);
});

test('移除当前选中相邻；最后会话移除后清理空项目', async () => {
  const { engine } = setup();
  const firstId = engine.workspace.sessions[0].id;
  await engine.remove(firstId);
  assert.ok(engine.workspace.activeSessionId);
  for (const session of [...engine.workspace.sessions]) await engine.remove(session.id);
  assert.equal(engine.workspace.activeSessionId, null);
  assert.equal(engine.workspace.projects.length, 0);
});

test('刷新仅恢复定义和自动启动，不保存输出/草稿/runId，不重放提示', () => {
  const { engine, clock, storage } = setup();
  const session = engine.workspace.sessions[0];
  engine.setLaunchOnOpen(session.id, false);
  engine.start(session.id); clock.advance(500);
  engine.send(session.id, '不能重放的历史提示');
  engine.runtime(session.id).draft = '不能持久化的草稿';
  const restored = setup(storage.value);
  restored.engine.startAuto(); restored.clock.advance(500);
  assert.equal(restored.engine.runtime(session.id).status, 'idle');
  assert.equal(restored.engine.runtime(session.id).lines.length, 0);
  assert.ok(!storage.value.includes('不能'));
  assert.ok(!storage.value.includes('runId'));
});

test('保存失败可见并可重试；损坏配置不被示例覆盖', () => {
  const { engine, storage } = setup();
  const originalSave = storage.setItem;
  storage.setItem = () => { throw new Error('quota'); };
  engine.setLaunchOnOpen(engine.workspace.sessions[0].id, false);
  assert.match(engine.saveError, /配置未保存/);
  storage.setItem = originalSave;
  engine.save();
  assert.equal(engine.saveError, '');
  const broken = setup('{broken');
  assert.equal(broken.engine.workspace.sessions.length, 0);
  assert.match(broken.engine.saveError, /配置读取失败/);
  assert.equal(broken.storage.value, '{broken');
});

test('异常自然退出记录退出码；每次运行有唯一 runId', () => {
  const { engine, clock } = setup();
  const session = engine.workspace.sessions[0];
  engine.start(session.id); clock.advance(500);
  const runId = engine.runtime(session.id).runId;
  assert.equal(engine.exit(session.id, runId, 7), true);
  assert.equal(engine.runtime(session.id).status, 'stopped');
  assert.equal(engine.runtime(session.id).exitCode, 7);
  engine.start(session.id);
  assert.notEqual(engine.runtime(session.id).runId, runId);
});

test('回滚有界，查看旧内容时新增输出不强制跟随', () => {
  const { engine, clock } = setup();
  const session = engine.workspace.sessions[0];
  engine.start(session.id); clock.advance(500);
  const runtime = engine.runtime(session.id);
  runtime.follow = false;
  for (let index = 0; index < 5100; index++) engine.output(session.id, runtime.runId, `模拟行 ${index}`);
  assert.equal(runtime.lines.length, 5000);
  assert.equal(runtime.follow, false);
});
