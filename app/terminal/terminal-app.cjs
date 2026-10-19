const fs = require('node:fs');
const path = require('node:path');
const { SessionRuntimeManager } = require('../runtime/session-runtime-manager.cjs');
const { resolveCliLaunch } = require('../runtime/cli-launch-resolver.cjs');
const { createNodePtyDriver } = require('../runtime/node-pty-driver.cjs');
const { createTerminalUiServer } = require('./terminal-ui-server.cjs');

const cliDefinitions = [
  { id: 'codex', agent: 'codex', label: 'Codex' },
  { id: 'agy', agent: 'agy', label: 'Antigravity' },
  { id: 'claude', agent: 'claude', label: 'Claude Code' }
];

const emptyLaunchOnOpen = Object.freeze({ codex: false, agy: false, claude: false });

function parseWorkingDirectory(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--cwd' || typeof args[1] !== 'string' || !args[1]) {
    throw new Error('Usage: npm run terminal -- --cwd <absolute Windows directory>');
  }
  if (!path.win32.isAbsolute(args[1])) throw new Error('--cwd must be an absolute Windows path');
  return args[1];
}

function createTerminalApp({ cwd, launchOnOpen = emptyLaunchOnOpen, workspaceStore, env = process.env, nodePty, platform = process.platform, killProcess, outputFlow } = {}) {
  const workspace = workspaceStore?.load();
  const workingDirectory = workspace ? workspace.cwd : cwd;
  const launchSettings = workspace?.launchOnOpen || launchOnOpen;
  if (!workspaceStore && (typeof workingDirectory !== 'string' || !path.win32.isAbsolute(workingDirectory))) {
    throw new Error('An absolute Windows working directory is required');
  }
  if (workingDirectory !== null && (typeof workingDirectory !== 'string' || !path.win32.isAbsolute(workingDirectory))) {
    throw new Error('An absolute Windows working directory is required');
  }
  const sessions = cliDefinitions.map(definition => ({
    ...definition,
    cwd: workingDirectory,
    launchOnOpen: launchSettings[definition.id] === true
  }));
  const manager = new SessionRuntimeManager({
    sessions,
    resolveLaunch: current => resolveCliLaunch(current.agent, current.cwd, { env }),
    spawnPty: createNodePtyDriver({ nodePty, platform, killProcess }),
    outputFlow
  });
  const server = createTerminalUiServer({
    manager,
    sessions: sessions.map(session => ({
      sessionId: session.id,
      agent: session.label,
      cwd: session.cwd,
      launchOnOpen: session.launchOnOpen
    })),
    workspaceStore
  });
  return { sessions, manager, server };
}

async function run(args = process.argv.slice(2)) {
  const cwd = parseWorkingDirectory(args);
  let stat;
  try { stat = fs.statSync(cwd); }
  catch { throw new Error('--cwd must be an existing directory'); }
  if (!stat.isDirectory()) throw new Error('--cwd must be an existing directory');

  const app = createTerminalApp({ cwd });
  const { url } = await app.server.listen(0);
  process.stdout.write(`AgentDock terminal: ${url}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.server.close();
  };
  process.once('SIGINT', () => { void shutdown().then(() => { process.exitCode = 0; }); });
  process.once('SIGTERM', () => { void shutdown().then(() => { process.exitCode = 0; }); });
  return app;
}

if (require.main === module) {
  run().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseWorkingDirectory, createTerminalApp, run };
