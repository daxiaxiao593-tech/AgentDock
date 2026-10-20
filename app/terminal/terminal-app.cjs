const path = require('node:path');
const { SessionRuntimeManager } = require('../runtime/session-runtime-manager.cjs');
const { resolveCliLaunch } = require('../runtime/cli-launch-resolver.cjs');
const { createNodePtyDriver } = require('../runtime/node-pty-driver.cjs');
const { createTerminalUiServer } = require('./terminal-ui-server.cjs');
const { normalizeWorkspace, canonicalDirectory, AGENTS } = require('../desktop/desktop-workspace.cjs');

function parseWorkingDirectory(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--cwd' || typeof args[1] !== 'string' || !args[1]) throw new Error('Usage: npm run terminal -- --cwd <absolute Windows directory>');
  if (!path.win32.isAbsolute(args[1])) throw new Error('--cwd must be an absolute Windows path');
  return args[1];
}

function createTerminalApp({ cwd, launchOnOpen = { codex: false, agy: false, claude: false }, workspaceStore, env = process.env, nodePty, platform = process.platform, killProcess, outputFlow } = {}) {
  if (!workspaceStore && (typeof cwd !== 'string' || !path.win32.isAbsolute(cwd))) throw new Error('An absolute Windows working directory is required');
  const workspace = normalizeWorkspace(workspaceStore ? workspaceStore.load() : { schemaVersion: 1, cwd, launchOnOpen });
  const sessions = workspace.sessions.map(session => ({
    ...session, label: AGENTS[session.agent], cwd: workspace.projects.find(p => p.id === session.projectId).rootPath
  }));
  const manager = new SessionRuntimeManager({
    sessions,
    resolveLaunch: current => {
      canonicalDirectory(current.cwd);
      return resolveCliLaunch(current.agent, current.cwd, { env });
    },
    spawnPty: createNodePtyDriver({ nodePty, platform, killProcess }),
    outputFlow
  });
  const server = createTerminalUiServer({
    manager,
    sessions: sessions.map(session => ({ sessionId: session.id, projectId: session.projectId, agent: session.label, agentId: session.agent, name: session.name, cwd: session.cwd, launchOnOpen: session.launchOnOpen })),
    workspaceStore
  });
  return { sessions, manager, server };
}

async function run(args = process.argv.slice(2)) {
  const cwd = parseWorkingDirectory(args);
  canonicalDirectory(cwd);
  const app = createTerminalApp({ cwd });
  const { url } = await app.server.listen(0);
  process.stdout.write(`AgentDock terminal: ${url}\n`);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await app.server.close(); };
  process.once('SIGINT', () => { void shutdown().then(() => { process.exitCode = 0; }); });
  process.once('SIGTERM', () => { void shutdown().then(() => { process.exitCode = 0; }); });
  return app;
}
if (require.main === module) run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { parseWorkingDirectory, createTerminalApp, run };
