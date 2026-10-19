const fs = require('node:fs');
const path = require('node:path');
const { createDesktopWorkspaceStore } = require('./desktop-workspace.cjs');
const { createTerminalApp } = require('../terminal/terminal-app.cjs');

function parseServiceArgs(args = process.argv.slice(2)) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--user-data' ||
      typeof args[1] !== 'string' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: service-entry --user-data <absolute userData directory>');
  }
  return args[1];
}

async function startDesktopService({ userDataPath, processLike = process, fileSystem = fs } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('An absolute userData path is required');
  const workspaceStore = createDesktopWorkspaceStore({ userDataPath, fileSystem });
  const app = createTerminalApp({ workspaceStore });
  let serverListening = false;
  let shuttingDown = false;
  let shutdownPromise = null;
  let parentGone = processLike.connected === false;

  function send(message, callback) {
    if (parentGone || processLike.connected === false || typeof processLike.send !== 'function') return false;
    processLike.send(message, callback);
    return true;
  }

  app.manager.on('event', event => {
    if (event.type === 'status') {
      send({
        type: 'session-state',
        state: { sessionId: event.sessionId, runId: event.runId, status: event.status }
      });
    }
  });

  async function shutdown(fromParentLoss = false) {
    if (shutdownPromise) return shutdownPromise;
    if (!serverListening) {
      if (fromParentLoss || parentGone) processLike.exit?.(0);
      return false;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      try {
        await app.server.close();
        if (fromParentLoss || parentGone) {
          processLike.exit?.(0);
          return true;
        }
        const sent = send({ type: 'stopped' }, () => processLike.disconnect?.());
        if (!sent) processLike.exit?.(0);
        return true;
      } catch (error) {
        shuttingDown = false;
        shutdownPromise = null;
        if (fromParentLoss || parentGone) {
          processLike.exit?.(1);
          return false;
        }
        send({ type: 'shutdown-failed', message: error instanceof Error ? error.message : String(error) });
        return false;
      }
    })();
    return shutdownPromise;
  }

  processLike.on?.('message', message => {
    if (message?.type === 'shutdown' && !shuttingDown) void shutdown();
  });
  processLike.on?.('disconnect', () => {
    parentGone = true;
    if (serverListening) void shutdown(true);
  });

  const ready = await app.server.listen(0);
  serverListening = true;
  if (parentGone) {
    await shutdown(true);
    return { app, workspaceStore, shutdown };
  }

  const workspace = workspaceStore.load();
  let hasWorkingDirectory = false;
  if (workspace.cwd) {
    try { hasWorkingDirectory = fileSystem.statSync(workspace.cwd).isDirectory(); }
    catch { hasWorkingDirectory = false; }
  }
  if (hasWorkingDirectory) await app.manager.startAuto();
  send({ type: 'ready', origin: ready.origin || ready.url, token: ready.token });

  return { app, workspaceStore, shutdown };
}

if (require.main === module) {
  try {
    const userDataPath = parseServiceArgs();
    startDesktopService({ userDataPath }).catch(error => {
      if (process.connected && process.send) {
        process.send({ type: 'startup-error', message: error.message }, () => process.exit(1));
      } else process.exit(1);
    });
  } catch (error) {
    if (process.connected && process.send) {
      process.send({ type: 'startup-error', message: error.message }, () => process.exit(1));
    } else process.exit(1);
  }
}

module.exports = { parseServiceArgs, startDesktopService };
