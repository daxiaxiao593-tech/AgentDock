const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { normalizeWorkspace, canonicalDirectory, AGENTS } = require('../desktop/desktop-workspace.cjs');
const { WebSocketServer, WebSocket } = require('ws');

const uiRoot = path.join(__dirname, 'ui');
const xtermFile = require.resolve('@xterm/xterm');
const fitFile = require.resolve('@xterm/addon-fit');
const xtermRoot = path.dirname(path.dirname(xtermFile));
const assetFiles = new Map([
  ['/app.js', [path.join(uiRoot, 'app.js'), 'text/javascript; charset=utf-8']],
  ['/style.css', [path.join(uiRoot, 'style.css'), 'text/css; charset=utf-8']],
  ['/agentdock-icon.png', [path.join(uiRoot, 'agentdock-icon.png'), 'image/png']],
  ['/vendor/xterm.js', [xtermFile, 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', [path.join(xtermRoot, 'css', 'xterm.css'), 'text/css; charset=utf-8']],
  ['/vendor/addon-fit.js', [fitFile, 'text/javascript; charset=utf-8']]
]);

function createTerminalUiServer({ manager, sessions, workspaceStore }) {
  if (!manager || typeof manager.on !== 'function' || typeof manager.getRuntime !== 'function') {
    throw new Error('A session runtime manager is required');
  }
  if (!Array.isArray(sessions)) throw new Error('Session UI metadata is required');

  let currentWorkspace = workspaceStore ? normalizeWorkspace(workspaceStore.load()) : {
    schemaVersion: 2,
    projects: [...new Set(sessions.map(s => s.cwd))].map((rootPath, index) => ({ id: 'project-' + index, rootPath, collapsed: false })),
    sessions: sessions.map(s => ({ id: s.sessionId, projectId: 'project-' + [...new Set(sessions.map(item => item.cwd))].indexOf(s.cwd), agent: s.agentId || manager.sessions.get(s.sessionId)?.agent, name: s.name || s.agent, launchOnOpen: s.launchOnOpen === true })),
    selectedSessionId: sessions[0]?.sessionId ?? null
  };
  let commandQueue = Promise.resolve();
  let closing = false;
  const pendingCommands = new Map();
  const commandResults = new Map();
  const outputCheckpoints = new WeakMap();

  const sessionMap = new Map();
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId ||
        typeof session.agent !== 'string' || !session.agent ||
        !(typeof session.cwd === 'string' || (workspaceStore && session.cwd === null)) ||
        !manager.sessions.has(session.sessionId) || sessionMap.has(session.sessionId)) {
      throw new Error('Session UI metadata is required');
    }
    sessionMap.set(session.sessionId, { ...session, agentId: session.agentId || manager.sessions.get(session.sessionId).agent, name: session.name || session.agent, launchOnOpen: session.launchOnOpen === true });
  }

  function applyWorkspace(updated) {
    currentWorkspace = updated;
    sessionMap.clear();
    for (const session of updated.sessions) {
      const cwd = updated.projects.find(project => project.id === session.projectId).rootPath;
      const definition = { ...session, cwd, label: AGENTS[session.agent] };
      const existing = manager.sessions.get(session.id);
      if (existing) Object.assign(existing, definition);
      else manager.registerSession(definition);
      sessionMap.set(session.id, { sessionId: session.id, projectId: session.projectId, agent: AGENTS[session.agent], agentId: session.agent, name: session.name, cwd, launchOnOpen: session.launchOnOpen });
    }
  }
  if (currentWorkspace) applyWorkspace(currentWorkspace);

  function sessionSnapshots() {
    return [...sessionMap.values()].map(session => {
      let directoryError = null;
      try { canonicalDirectory(session.cwd); }
      catch { directoryError = '保存的工作目录不存在或不是文件夹。'; }
      return { ...session, directoryError, runtime: manager.getRuntime(session.sessionId) };
    });
  }

  function getWorkspace() {
    return structuredClone(currentWorkspace);
  }

  function broadcastWorkspace() {
    const event = { type: 'workspace', workspace: getWorkspace(), sessions: sessionSnapshots() };
    for (const client of webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) sendWorkspaceSnapshot(client, event);
    }
  }

  function sendWorkspaceSnapshot(client, message) {
    outputCheckpoints.set(client, new Map(message.sessions.map(session => [session.sessionId, { runId: session.runtime.runId, seq: session.runtime.outputSeq }])));
    send(client, message);
  }

  async function configurationCommand(message) {
    if (!workspaceStore || !currentWorkspace) throw new Error('Workspace configuration is unavailable');
    const updated = structuredClone(currentWorkspace);
    const session = updated.sessions.find(s => s.id === message.sessionId);
    let removedRun = null;
    let createdId = null;
    switch (message.type) {
      case 'create-session': {
        if (!Object.hasOwn(AGENTS, message.agent)) throw new Error('Unsupported agent');
        const cwd = canonicalDirectory(message.cwd);
        if (message.launchOnOpen !== undefined && typeof message.launchOnOpen !== 'boolean') throw new Error('launchOnOpen must be a boolean');
        if (message.start !== undefined && typeof message.start !== 'boolean') throw new Error('start must be a boolean');
        let project = updated.projects.find(p => {
          try { return canonicalDirectory(p.rootPath) === cwd; } catch { return p.rootPath === cwd; }
        });
        if (!project) {
          project = { id: randomUUID(), rootPath: cwd, collapsed: false };
          updated.projects.push(project);
        }
        createdId = randomUUID();
        updated.sessions.push({ id: createdId, projectId: project.id, agent: message.agent, name: message.name === undefined ? AGENTS[message.agent] : message.name, launchOnOpen: message.launchOnOpen ?? updated.legacyLaunchOnOpen?.[message.agent] ?? false });
        updated.selectedSessionId = createdId;
        break;
      }
      case 'set-project-collapsed': {
        const project = updated.projects.find(p => p.id === message.projectId);
        if (!project || typeof message.collapsed !== 'boolean') throw new Error('Invalid project state');
        project.collapsed = message.collapsed;
        break;
      }
      case 'change-session-directory': {
        if (!session) throw new Error('Unknown session');
        if (['starting', 'running', 'stopping'].includes(manager.getRuntime(session.id).status)) throw new Error('请先停止此会话，再更改工作目录');
        const cwd = canonicalDirectory(message.cwd);
        const previousProjectId = session.projectId;
        let project = updated.projects.find(p => {
          try { return canonicalDirectory(p.rootPath) === cwd; } catch { return p.rootPath === cwd; }
        });
        if (!project) {
          project = { id: randomUUID(), rootPath: cwd, collapsed: false };
          updated.projects.push(project);
        }
        session.projectId = project.id;
        if (previousProjectId !== project.id && !updated.sessions.some(item => item.id !== session.id && item.projectId === previousProjectId)) {
          updated.projects = updated.projects.filter(item => item.id !== previousProjectId);
        }
        break;
      }
      case 'remove-session': {
        if (!session) throw new Error('Unknown session');
        const runtime = manager.getRuntime(session.id);
        if (message.runId !== runtime.runId) throw new Error('Session run changed; refresh before removing');
        removedRun = runtime.runId;
        if (['starting', 'running', 'stopping'].includes(runtime.status) && !await manager.stop(session.id, removedRun)) throw new Error('Could not stop session; configuration was preserved');
        const stopped = manager.getRuntime(session.id);
        if (stopped.runId !== removedRun || ['starting', 'running', 'stopping'].includes(stopped.status)) throw new Error('Session restarted; configuration was preserved');
        const removedIndex = updated.sessions.findIndex(s => s.id === session.id);
        updated.sessions = updated.sessions.filter(s => s.id !== session.id);
        if (!updated.sessions.some(s => s.projectId === session.projectId)) updated.projects = updated.projects.filter(p => p.id !== session.projectId);
        if (updated.selectedSessionId === session.id) updated.selectedSessionId = updated.sessions[Math.min(removedIndex, updated.sessions.length - 1)]?.id ?? null;
        break;
      }
      case 'rename-session':
        if (!session) throw new Error('Unknown session');
        session.name = message.name;
        break;
      case 'select-session':
        if (!session) throw new Error('Unknown session');
        updated.selectedSessionId = session.id;
        break;
      case 'launch-on-open':
        if (!session || typeof message.enabled !== 'boolean') throw new Error('Invalid launch setting');
        session.launchOnOpen = message.enabled;
        break;
      default: throw new Error('Unsupported configuration command');
    }
    const saved = workspaceStore.save(normalizeWorkspace(updated));
    if (message.type === 'remove-session') manager.removeSession(session.id, removedRun);
    applyWorkspace(saved);
    broadcastWorkspace();
    if (createdId && message.start === true) void manager.start(createdId);
    return createdId ? { sessionId: createdId } : {};
  }

  function enqueueConfiguration(client, message) {
    if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 200) {
      send(client, { type: 'command-result', requestId: message.requestId ?? null, ok: false, message: 'A requestId is required' });
      return;
    }
    const pending = pendingCommands.get(message.requestId);
    if (pending) { void pending.then(result => send(client, result)); return; }
    const cached = commandResults.get(message.requestId);
    if (cached) { send(client, cached); return; }
    if (pendingCommands.size >= 512) {
      send(client, { type: 'command-result', requestId: message.requestId, ok: false, message: 'Too many pending configuration requests; retry after they finish' });
      return;
    }
    const result = commandQueue.then(async () => {
      try {
        if (closing) throw new Error('Server is closing');
        return { type: 'command-result', requestId: message.requestId, ok: true, ...await configurationCommand(message) };
      } catch (error) {
        return { type: 'command-result', requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    });
    pendingCommands.set(message.requestId, result);
    commandQueue = result.then(value => {
      pendingCommands.delete(message.requestId);
      commandResults.set(message.requestId, value);
      while (commandResults.size > 256) commandResults.delete(commandResults.keys().next().value);
    });
    void result.then(value => send(client, value));
  }

  const token = randomBytes(32).toString('base64url');
  const server = http.createServer((request, response) => {
    const port = server.address()?.port;
    const expectedHost = `127.0.0.1:${port}`;
    if (!port || request.headers.host !== expectedHost) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (request.url === '/') {
      const content = fs.readFileSync(path.join(uiRoot, 'index.html'));
      response.writeHead(200, {
        ...responseHeaders(port),
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `agentdock_ui=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`
      });
      response.end(content);
      return;
    }

    const asset = assetFiles.get(request.url);
    if (!asset) {
      response.writeHead(404, responseHeaders(port)).end();
      return;
    }
    response.writeHead(200, {
      ...responseHeaders(port),
      'Content-Type': asset[1],
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(asset[0]).pipe(response);
  });
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false
  });
  let autoStartTriggered = false;

  server.on('upgrade', (request, socket, head) => {
    const port = server.address()?.port;
    const origin = `http://127.0.0.1:${port}`;
    const hasClient = [...webSocketServer.clients].some(client => client.readyState === WebSocket.OPEN);
    if (!port || request.headers.host !== `127.0.0.1:${port}` || request.url !== '/terminal' ||
        request.headers.origin !== origin || !hasToken(request.headers.cookie, token) || hasClient) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, client => {
      webSocketServer.emit('connection', client, request);
    });
  });

  webSocketServer.on('connection', client => {
    sendWorkspaceSnapshot(client, {
      type: 'snapshot',
        workspace: getWorkspace(),
      sessions: sessionSnapshots()
    });
    if (!autoStartTriggered) {
      autoStartTriggered = true;
      void manager.startAuto();
    }
    client.on('message', (raw, isBinary) => {
      if (isBinary) {
        client.close(1003, 'Text messages required');
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        client.close(1008, 'Invalid message');
        return;
      }
      if (['create-session', 'change-session-directory', 'rename-session', 'remove-session', 'select-session', 'set-project-collapsed', 'launch-on-open'].includes(message?.type)) {
        enqueueConfiguration(client, message);
        return;
      }
      if (message?.type === 'start-all') { if (!closing) void manager.startAll(); return; }
      if (closing) return;
      handleMessage(manager, sessionMap, client, message, outputCheckpoints.get(client));
    });
  });

  const forwardEvent = event => {
    if (!sessionMap.has(event.sessionId)) return;
    for (const client of webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) send(client, event);
    }
  };
  manager.on('event', forwardEvent);

  let listening = false;
  return {
    listen(port = 0) {
      if (listening) throw new Error('Terminal UI server is already listening');
      return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          listening = true;
          const url = `http://127.0.0.1:${server.address().port}`;
          resolve({ url, origin: url, token });
        });
      });
    },
    async close() {
      closing = true;
      await commandQueue;
      const results = await Promise.all([...sessionMap.keys()].map(async sessionId => {
        const runtime = manager.getRuntime(sessionId);
        if (['starting', 'running', 'stopping'].includes(runtime.status)) {
          return manager.stop(sessionId, runtime.runId);
        }
        return true;
      }));
      const active = [...sessionMap.keys()].filter(sessionId => {
        const runtime = manager.getRuntime(sessionId);
        return ['starting', 'running', 'stopping'].includes(runtime.status);
      });
      if (active.length > 0 || results.some(result => result === false)) {
        closing = false;
        throw new Error(`Could not stop terminal sessions: ${active.join(', ') || 'unknown session'}`);
      }
      manager.off('event', forwardEvent);
      const serverClosed = listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      for (const client of webSocketServer.clients) client.close(1001, 'Server closed');
      for (const socket of connections) socket.destroy();
      await serverClosed;
      listening = false;
      await new Promise(resolve => webSocketServer.close(resolve));
      return true;
    }
  };
}

function responseHeaders(port) {
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  };
}

function hasToken(cookieHeader, token) {
  return typeof cookieHeader === 'string' && cookieHeader.split(';').some(value => value.trim() === `agentdock_ui=${token}`);
}

function send(client, message) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function handleMessage(manager, sessions, client, message, outputCheckpoints) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
    client.close(1008, 'Invalid message');
    return;
  }
  const sessionId = message.sessionId;
  if (message.type === 'resume-output') {
    const checkpoint = outputCheckpoints?.get(sessionId);
    if (sessions.has(sessionId) && checkpoint && typeof message.runId === 'string' &&
        message.runId === checkpoint.runId && Number.isSafeInteger(message.seq) &&
        message.seq >= 0 && message.seq <= checkpoint.seq) {
      manager.ack(sessionId, message.runId, message.seq);
    }
    return;
  }
  if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
    client.close(1008, 'Unknown session');
    return;
  }
  switch (message.type) {
    case 'start':
      void manager.start(sessionId);
      return;
    case 'stop':
      if (typeof message.runId === 'string') void manager.stop(sessionId, message.runId);
      return;
    case 'input':
      if (typeof message.runId === 'string' && typeof message.data === 'string' && Buffer.byteLength(message.data, 'utf8') <= 32 * 1024) {
        manager.write(sessionId, message.runId, message.data);
      }
      return;
    case 'resize':
      if (typeof message.runId === 'string' && Number.isInteger(message.columns) && Number.isInteger(message.rows) &&
          message.columns >= 2 && message.columns <= 500 && message.rows >= 1 && message.rows <= 200) {
        manager.resize(sessionId, message.runId, message.columns, message.rows);
      }
      return;
    case 'ack':
      if (typeof message.runId === 'string' && Number.isSafeInteger(message.seq)) {
        manager.ack(sessionId, message.runId, message.seq);
      }
      return;
    default:
      client.close(1008, 'Unsupported message type');
  }
}

module.exports = { createTerminalUiServer };
