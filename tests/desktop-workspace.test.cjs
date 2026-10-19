const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDesktopWorkspaceStore } = require('../app/desktop/desktop-workspace.cjs');

function withTemporaryDirectories(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-desktop-workspace-'));
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, '项目 workspace');
  fs.mkdirSync(workspace);
  try { return run({ root, userData, workspace }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a new userData directory loads isolated defaults with every CLI disabled', () => withTemporaryDirectories(({ userData }) => {
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.deepEqual(store.load(), {
    schemaVersion: 1,
    cwd: null,
    launchOnOpen: { codex: false, agy: false, claude: false }
  });
}));

test('workspace directory and launchOnOpen settings persist across store instances', () => withTemporaryDirectories(({ userData, workspace }) => {
  const first = createDesktopWorkspaceStore({ userDataPath: userData });
  first.setWorkingDirectory(workspace);
  first.setLaunchOnOpen('claude', true);

  const second = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.deepEqual(second.load(), {
    schemaVersion: 1,
    cwd: workspace,
    launchOnOpen: { codex: false, agy: false, claude: true }
  });
}));

test('an invalid directory does not replace the saved working directory', () => withTemporaryDirectories(({ userData, workspace }) => {
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  store.setWorkingDirectory(workspace);
  assert.throws(() => store.setWorkingDirectory(path.join(workspace, 'missing')), /existing directory/i);
  assert.equal(store.load().cwd, workspace);
}));

test('launchOnOpen only accepts known CLI ids and boolean values', () => withTemporaryDirectories(({ userData }) => {
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.throws(() => store.setLaunchOnOpen('powershell', true), /unknown session/i);
  assert.throws(() => store.setLaunchOnOpen('codex', 'yes'), /boolean/i);
  assert.equal(store.load().launchOnOpen.codex, false);
}));

test('a corrupt workspace file remains untouched and is not replaced with defaults', () => withTemporaryDirectories(({ userData }) => {
  fs.mkdirSync(userData, { recursive: true });
  const filePath = path.join(userData, 'workspace.json');
  fs.writeFileSync(filePath, '{bad json');
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.throws(() => store.load(), /invalid workspace configuration/i);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{bad json');
}));
