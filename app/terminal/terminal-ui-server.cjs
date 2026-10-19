const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const uiRoot = path.join(__dirname, 'ui');
const xtermFile = require.resolve('@xterm/xterm');
const fitFile = require.resolve('@xterm/addon-fit');
const xtermRoot = path.dirname(path.dirname(xtermFile));
const assetFiles = new Map([
  ['/app.js', [path.join(uiRoot, 'app.js'), 'text/javascript; charset=utf-8']],
  ['/style.css', [path.join(uiRoot, 'style.css'), 'text/css; charset=utf-8']],
  ['/vendor/xterm.js', [xtermFile, 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', [path.join(xtermRoot, 'css', 'xterm.css'), 'text/css; charset=utf-8']],
  ['/vendor/addon-fit.js', [fitFile, 'text/javascript; charset=utf-8']]
]);

function createTerminalUiServer({ manager, sessions, workspaceStore }) {
  if (!manager || typeof manager.on !== 'function' || typeof manager.getRuntime !== 'function') {
    throw new Error('A session runtime manager is required');
  }
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('Session UI metadata is required');

  const sessionMap = new Map();
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId ||
        typeof session.agent !== 'string' || !session.agent ||
        !(typeof session.cwd === 'string' || (workspaceStore && session.cwd === null)) ||
        !manager.sessions.has(session.sessionId) || sessionMap.has(session.sessionId)) {
      throw new Error('Session UI metadata is required');
    }
    sessionMap.set(session.sessionId, {
      sessionId: session.sessionId,
      agent: session.agent,
      cwd: session.cwd,
      launchOnOpen: session.launchOnOpen === true
    });
  }

  function getWorkspace() {
    const saved = workspaceStore?.load();
    const cwd = saved?.cwd ?? [...sessionMap.values()][0].cwd;
    const launchOnOpen = saved?.launchOnOpen || Object.fromEntries(
      [...sessionMap.values()].map(session => [session.sessionId, session.launchOnOpen])
    );
    let directoryError = null;
    if (workspaceStore) {
      if (!cwd) directoryError = '请选择一个工作目录。';
      else {
        try {
          if (!fs.statSync(cwd).isDirectory()) directoryError = '保存的工作目录不存在或不是文件夹，请重新选择。';
        } catch {
          directoryError = '保存的工作目录不存在或不是文件夹，请重新选择。';
        }
      }
    }
    return { cwd, launchOnOpen, directoryError };
  }

  function broadcastWorkspace() {
    const event = { type: 'workspace', workspace: getWorkspace() };
    for (const client of webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) send(client, event);
    }
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

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false
  });

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
    send(client, {
      type: 'snapshot',
        workspace: getWorkspace(),
      sessions: [...sessionMap.values()].map(session => ({
        ...session,
        runtime: manager.getRuntime(session.sessionId)
      }))
    });
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
      handleMessage(manager, sessionMap, client, message, {
        workspaceStore,
        getWorkspace,
        broadcastWorkspace
      });
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
        throw new Error(`Could not stop terminal sessions: ${active.join(', ') || 'unknown session'}`);
      }
      manager.off('event', forwardEvent);
      for (const client of webSocketServer.clients) client.close(1001, 'Server closed');
      if (listening) {
        await new Promise(resolve => server.close(resolve));
        listening = false;
      }
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

function handleMessage(manager, sessions, client, message, workspace) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
    client.close(1008, 'Invalid message');
    return;
  }
  const sessionId = message.sessionId;
  if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
    client.close(1008, 'Unknown session');
    return;
  }
  switch (message.type) {
    case 'start':
      if (workspace.workspaceStore) {
        const state = workspace.getWorkspace();
        if (state.directoryError) {
          send(client, { type: 'workspace-error', message: state.directoryError });
          return;
        }
      }
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
    case 'set-working-directory':
      if (!workspace.workspaceStore || typeof message.cwd !== 'string') {
        send(client, { type: 'workspace-error', message: '无法更改工作目录。' });
        return;
      }
      if ([...sessions.keys()].some(id => ['starting', 'running', 'stopping'].includes(manager.getRuntime(id).status))) {
        send(client, { type: 'workspace-error', message: '请先停止所有终端，再更改工作目录。' });
        return;
      }
      try {
        const updated = workspace.workspaceStore.setWorkingDirectory(message.cwd);
        for (const [id, session] of sessions) {
          session.cwd = updated.cwd;
          manager.sessions.get(id).cwd = updated.cwd;
        }
        workspace.broadcastWorkspace();
      } catch (error) {
        send(client, { type: 'workspace-error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    case 'launch-on-open':
      if (!workspace.workspaceStore || typeof message.enabled !== 'boolean') {
        send(client, { type: 'workspace-error', message: '无法保存启动选项。' });
        return;
      }
      try {
        const updated = workspace.workspaceStore.setLaunchOnOpen(sessionId, message.enabled);
        sessions.get(sessionId).launchOnOpen = updated.launchOnOpen[sessionId];
        manager.sessions.get(sessionId).launchOnOpen = updated.launchOnOpen[sessionId];
        workspace.broadcastWorkspace();
      } catch (error) {
        send(client, { type: 'workspace-error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    default:
      client.close(1008, 'Unsupported message type');
  }
}

module.exports = { createTerminalUiServer };
