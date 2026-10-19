const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SESSION_IDS = ['codex', 'agy', 'claude'];

function createDesktopWorkspaceStore({ userDataPath, fileSystem = fs } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new Error('An absolute userData path is required');
  }
  const filePath = path.join(userDataPath, 'workspace.json');

  function load() {
    let source;
    try { source = fileSystem.readFileSync(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return defaults();
      throw error;
    }
    try { return validateWorkspace(JSON.parse(source)); }
    catch (error) {
      throw new Error(`Invalid workspace configuration: ${error.message}`);
    }
  }

  function save(workspace) {
    const value = validateWorkspace(workspace);
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

  function setWorkingDirectory(cwd) {
    if (typeof cwd !== 'string' || !path.win32.isAbsolute(cwd)) {
      throw new Error('Working directory must be an absolute Windows path');
    }
    let stat;
    try { stat = fileSystem.statSync(cwd); }
    catch { throw new Error('Working directory must be an existing directory'); }
    if (!stat.isDirectory()) throw new Error('Working directory must be an existing directory');
    const workspace = load();
    workspace.cwd = cwd;
    return save(workspace);
  }

  function setLaunchOnOpen(sessionId, enabled) {
    if (!SESSION_IDS.includes(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    if (typeof enabled !== 'boolean') throw new Error('launchOnOpen must be a boolean');
    const workspace = load();
    workspace.launchOnOpen[sessionId] = enabled;
    return save(workspace);
  }

  return { filePath, load, save, setWorkingDirectory, setLaunchOnOpen };
}

function defaults() {
  return {
    schemaVersion: 1,
    cwd: null,
    launchOnOpen: { codex: false, agy: false, claude: false }
  };
}

function validateWorkspace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      !(value.cwd === null || (typeof value.cwd === 'string' && path.win32.isAbsolute(value.cwd))) ||
      !value.launchOnOpen || typeof value.launchOnOpen !== 'object' || Array.isArray(value.launchOnOpen) ||
      SESSION_IDS.some(id => typeof value.launchOnOpen[id] !== 'boolean')) {
    throw new Error('Unsupported workspace data');
  }
  return {
    schemaVersion: 1,
    cwd: value.cwd,
    launchOnOpen: Object.fromEntries(SESSION_IDS.map(id => [id, value.launchOnOpen[id]]))
  };
}

module.exports = { createDesktopWorkspaceStore };
