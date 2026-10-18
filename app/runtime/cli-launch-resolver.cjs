const fs = require('node:fs');
const path = require('node:path');

const executables = {
  codex: 'codex.exe',
  agy: 'agy.exe',
  claude: 'claude.exe'
};

function resolveCliLaunch(tool, cwd, { env = process.env, fileExists = isFile } = {}) {
  const executable = executables[tool];
  if (!executable) throw new Error(`Unsupported CLI: ${tool}`);
  if (typeof cwd !== 'string' || !path.win32.isAbsolute(cwd)) throw new Error('A Windows absolute working directory is required');

  const pathEntries = typeof env.PATH === 'string' ? env.PATH.split(';') : [];
  const candidates = pathEntries
    .filter(entry => entry && path.win32.isAbsolute(entry))
    .map(entry => path.win32.join(entry, executable));

  const defaultDirectory = tool === 'codex'
    ? env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')
    : tool === 'agy'
      ? env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'agy', 'bin')
      : env.USERPROFILE && path.win32.join(env.USERPROFILE, '.local', 'bin');
  if (defaultDirectory && path.win32.isAbsolute(defaultDirectory)) {
    candidates.push(path.win32.join(defaultDirectory, executable));
  }

  const checked = new Set();
  const args = [];
  for (const candidate of candidates) {
    const normalized = path.win32.normalize(candidate);
    const key = normalized.toLowerCase();
    if (checked.has(key)) continue;
    checked.add(key);
    if (path.win32.isAbsolute(normalized) && path.win32.extname(normalized).toLowerCase() === '.exe' && fileExists(normalized)) {
      return { command: normalized, args, cwd };
    }
  }

  throw new Error(`Native ${executable} not found; Windows .cmd and .bat launchers are not supported`);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

module.exports = { resolveCliLaunch };
