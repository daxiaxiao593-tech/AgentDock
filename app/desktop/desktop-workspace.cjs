const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const AGENTS = Object.freeze({ codex: 'Codex', agy: 'Antigravity', claude: 'Claude Code' });
const SESSION_IDS = Object.keys(AGENTS);
const absolutePath = value => typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value));

function canonicalDirectory(cwd, fileSystem = fs) {
  if (!absolutePath(cwd)) throw new Error('Working directory must be an absolute path');
  try {
    if (!fileSystem.statSync(cwd).isDirectory()) throw new Error('not a directory');
    return fileSystem.realpathSync.native ? fileSystem.realpathSync.native(cwd) : fileSystem.realpathSync(cwd);
  } catch {
    throw new Error('Working directory must be an existing directory');
  }
}

function normalizeWorkspace(value) {
  const invalid = () => { throw new Error('Unsupported workspace data'); };
  const flagsValid = flags => flags && typeof flags === 'object' && !Array.isArray(flags) && SESSION_IDS.every(id => typeof flags[id] === 'boolean');
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (value.schemaVersion === 1) {
    if (!(value.cwd === null || absolutePath(value.cwd)) || !flagsValid(value.launchOnOpen)) invalid();
    if (value.cwd === null) return { schemaVersion: 2, projects: [], sessions: [], selectedSessionId: null, legacyLaunchOnOpen: { ...value.launchOnOpen } };
    return {
      schemaVersion: 2,
      projects: [{ id: 'legacy-project', rootPath: value.cwd, collapsed: false }],
      sessions: SESSION_IDS.map(id => ({ id, projectId: 'legacy-project', agent: id, name: AGENTS[id], launchOnOpen: value.launchOnOpen[id] })),
      selectedSessionId: 'codex'
    };
  }
  if (value.schemaVersion !== 2 || !Array.isArray(value.projects) || !Array.isArray(value.sessions)) invalid();
  const projects = [], projectIds = new Set(), roots = new Set();
  for (const project of value.projects) {
    if (!project || typeof project.id !== 'string' || !project.id || projectIds.has(project.id) || !absolutePath(project.rootPath) || typeof project.collapsed !== 'boolean' || roots.has(project.rootPath)) invalid();
    projectIds.add(project.id); roots.add(project.rootPath);
    projects.push({ id: project.id, rootPath: project.rootPath, collapsed: project.collapsed });
  }
  const sessions = [], ids = new Set();
  for (const session of value.sessions) {
    if (!session || typeof session.id !== 'string' || !session.id || ids.has(session.id) || !projectIds.has(session.projectId) || !Object.hasOwn(AGENTS, session.agent) || typeof session.name !== 'string' || !session.name.trim() || session.name.length > 120 || typeof session.launchOnOpen !== 'boolean') invalid();
    ids.add(session.id);
    sessions.push({ id: session.id, projectId: session.projectId, agent: session.agent, name: session.name.trim(), launchOnOpen: session.launchOnOpen });
  }
  if (!(value.selectedSessionId === null || ids.has(value.selectedSessionId)) || (sessions.length && value.selectedSessionId === null)) invalid();
  const result = { schemaVersion: 2, projects, sessions, selectedSessionId: value.selectedSessionId };
  if (value.legacyLaunchOnOpen !== undefined) {
    if (!flagsValid(value.legacyLaunchOnOpen)) invalid();
    result.legacyLaunchOnOpen = Object.fromEntries(SESSION_IDS.map(id => [id, value.legacyLaunchOnOpen[id]]));
  }
  return result;
}

function createDesktopWorkspaceStore({ userDataPath, fileSystem = fs } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('An absolute userData path is required');
  const filePath = path.join(userDataPath, 'workspace.json');
  function load() {
    let source;
    try { source = fileSystem.readFileSync(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 2, projects: [], sessions: [], selectedSessionId: null };
      throw error;
    }
    try { return normalizeWorkspace(JSON.parse(source)); }
    catch (error) { throw new Error(`Invalid workspace configuration: ${error.message}`); }
  }
  function save(workspace) {
    const value = normalizeWorkspace(workspace);
    fileSystem.mkdirSync(userDataPath, { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      fileSystem.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { fileSystem.rmSync(temporaryPath, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
    return value;
  }
  function setLaunchOnOpen(sessionId, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('launchOnOpen must be a boolean');
    const workspace = load();
    const session = workspace.sessions.find(session => session.id === sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    session.launchOnOpen = enabled;
    return save(workspace);
  }
  return { filePath, load, save, setLaunchOnOpen };
}

module.exports = { createDesktopWorkspaceStore, normalizeWorkspace, canonicalDirectory, AGENTS };
