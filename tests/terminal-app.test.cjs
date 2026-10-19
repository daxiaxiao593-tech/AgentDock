const { test } = require('node:test');
const assert = require('node:assert/strict');

let createTerminalApp;
let parseWorkingDirectory;
try {
  ({ createTerminalApp, parseWorkingDirectory } = require('../app/terminal/terminal-app.cjs'));
} catch {}

test('terminal app requires an explicit Windows absolute cwd', () => {
  assert.equal(typeof parseWorkingDirectory, 'function');
  assert.equal(parseWorkingDirectory(['--cwd', 'D:\\Agent Dock\\temp']), 'D:\\Agent Dock\\temp');
  assert.throws(() => parseWorkingDirectory([]), /--cwd/);
  assert.throws(() => parseWorkingDirectory(['--cwd', 'relative']), /absolute/i);
  assert.throws(() => parseWorkingDirectory(['--cwd', 'D:\\temp', '--other']), /usage/i);
});

test('terminal app exposes independent idle sessions for all three CLIs in one workspace', () => {
  assert.equal(typeof createTerminalApp, 'function');
  const cwd = 'D:\\Agent Dock\\temp';
  const app = createTerminalApp({ cwd });
  assert.deepEqual(app.sessions.map(session => [session.id, session.agent, session.cwd]), [
    ['codex', 'codex', cwd],
    ['agy', 'agy', cwd],
    ['claude', 'claude', cwd]
  ]);
  for (const session of app.sessions) {
    assert.equal(app.manager.getRuntime(session.id).status, 'idle');
  }
});

test('desktop terminal app restores the configured shared directory and per-CLI launchOnOpen flags', () => {
  const config = {
    schemaVersion: 1,
    cwd: 'C:\\AgentDock\\saved workspace',
    launchOnOpen: { codex: true, agy: false, claude: true }
  };
  const app = createTerminalApp({ workspaceStore: { load: () => config }, platform: 'linux' });
  assert.deepEqual(app.sessions.map(session => [session.id, session.cwd, session.launchOnOpen]), [
    ['codex', config.cwd, true],
    ['agy', config.cwd, false],
    ['claude', config.cwd, true]
  ]);
  assert.equal(app.manager.sessions.get('agy').launchOnOpen, false);
});
