const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDesktopWorkspaceStore, normalizeWorkspace, canonicalDirectory } = require('../app/desktop/desktop-workspace.cjs');

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
    schemaVersion: 2,
    projects: [], sessions: [], selectedSessionId: null
  });
}));

test('workspace directory and launchOnOpen settings persist across store instances', () => withTemporaryDirectories(({ userData, workspace }) => {
  const first = createDesktopWorkspaceStore({ userDataPath: userData });
  first.save(normalizeWorkspace({ schemaVersion: 1, cwd: workspace, launchOnOpen: { codex: false, agy: false, claude: false } }));
  first.setLaunchOnOpen('claude', true);

  const second = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.deepEqual(second.load(), {
    schemaVersion: 2,
    projects: [{ id: second.load().projects[0].id, rootPath: fs.realpathSync.native(workspace), collapsed: false }],
    sessions: ['codex', 'agy', 'claude'].map(id => ({ id, projectId: second.load().projects[0].id, agent: id, name: { codex: 'Codex', agy: 'Antigravity', claude: 'Claude Code' }[id], launchOnOpen: id === 'claude' })),
    selectedSessionId: 'codex'
  });
}));

test('an invalid directory does not replace the saved working directory', () => withTemporaryDirectories(({ userData, workspace }) => {
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  store.save(normalizeWorkspace({ schemaVersion: 1, cwd: workspace, launchOnOpen: { codex: false, agy: false, claude: false } }));
  assert.throws(() => canonicalDirectory(path.join(workspace, 'missing')), /existing directory/i);
  assert.equal(store.load().projects[0].rootPath, fs.realpathSync.native(workspace));
}));

test('launchOnOpen only accepts known CLI ids and boolean values', () => withTemporaryDirectories(({ userData }) => {
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.throws(() => store.setLaunchOnOpen('powershell', true), /unknown session/i);
  assert.throws(() => store.setLaunchOnOpen('codex', 'yes'), /boolean/i);
  assert.equal(store.load().sessions.length, 0);
}));

test('schema 1 migrates without overwriting source and preserves all launch flags', () => withTemporaryDirectories(({ userData, workspace }) => {
  fs.mkdirSync(userData);
  const file = path.join(userData, 'workspace.json');
  const source = JSON.stringify({ schemaVersion: 1, cwd: workspace, launchOnOpen: { codex: true, agy: false, claude: true } });
  fs.writeFileSync(file, source);
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  const loaded = store.load();
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(loaded.sessions.map(s => [s.id, s.launchOnOpen]), [['codex', true], ['agy', false], ['claude', true]]);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  store.save(loaded);
  assert.equal(JSON.parse(fs.readFileSync(file)).schemaVersion, 2);
}));

test('null legacy directory preserves launch intent without placeholder sessions', () => withTemporaryDirectories(({ userData }) => {
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'workspace.json'), JSON.stringify({ schemaVersion: 1, cwd: null, launchOnOpen: { codex: true, agy: false, claude: true } }));
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  const loaded = store.load();
  assert.deepEqual(loaded.sessions, []);
  assert.deepEqual(loaded.legacyLaunchOnOpen, { codex: true, agy: false, claude: true });
  assert.deepEqual(store.save(loaded).legacyLaunchOnOpen, loaded.legacyLaunchOnOpen);
}));

test('schema2 loads missing directories and rejects orphan sessions or invalid selection', () => withTemporaryDirectories(({ userData, workspace }) => {
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  const value = { schemaVersion: 2, projects: [{ id: 'p', rootPath: path.join(workspace, 'missing'), collapsed: true }], sessions: [{ id: 's', projectId: 'p', agent: 'codex', name: '任务', launchOnOpen: true }], selectedSessionId: 's' };
  assert.deepEqual(store.save(value), value);
  assert.throws(() => store.save({ ...value, selectedSessionId: 'no' }), /workspace/i);
  assert.throws(() => store.save({ ...value, projects: [] }), /workspace/i);
}));

test('a corrupt workspace file remains untouched and is not replaced with defaults', () => withTemporaryDirectories(({ userData }) => {
  fs.mkdirSync(userData, { recursive: true });
  const filePath = path.join(userData, 'workspace.json');
  fs.writeFileSync(filePath, '{bad json');
  const store = createDesktopWorkspaceStore({ userDataPath: userData });
  assert.throws(() => store.load(), /invalid workspace configuration/i);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{bad json');
}));

test('an atomic rename failure keeps the original configuration and removes the temporary file', () => withTemporaryDirectories(({ userData, workspace }) => {
  const original = createDesktopWorkspaceStore({ userDataPath: userData });
  original.save(normalizeWorkspace({ schemaVersion: 1, cwd: workspace, launchOnOpen: { codex: false, agy: false, claude: false } }));
  const contents = fs.readFileSync(original.filePath, 'utf8');
  const failing = createDesktopWorkspaceStore({ userDataPath: userData, fileSystem: { ...fs, renameSync() { throw new Error('disk rename refused'); } } });
  const changed = original.load(); changed.sessions[0].name = 'new name';
  assert.throws(() => failing.save(changed), /rename refused/);
  assert.equal(fs.readFileSync(original.filePath, 'utf8'), contents);
  assert.deepEqual(fs.readdirSync(userData), ['workspace.json']);
}));

test('directory aliases use native realpath without changing the returned directory case', () => withTemporaryDirectories(({ root, workspace }) => {
  const alias = path.join(root, 'alias');
  fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canonicalDirectory(alias), fs.realpathSync.native(workspace));
  const fileSystem = { statSync: () => ({ isDirectory: () => true }), realpathSync: Object.assign(() => 'C:\\MixedCase\\Folder', { native: () => 'C:\\MixedCase\\Folder' }) };
  assert.equal(canonicalDirectory('C:\\alias', fileSystem), 'C:\\MixedCase\\Folder');
}));
