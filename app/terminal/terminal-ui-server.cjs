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

function createTerminalUiServer({ manager, sessions }) {
  if (!manager || typeof manager.on !== 'function' || typeof manager.getRuntime !== 'function') {
    throw new Error('A session runtime manager is required');
  }
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('Session UI metadata is required');

  const sessionMap = new Map();
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId ||
        typeof session.agent !== 'string' || !session.agent || typeof session.cwd !== 'string' ||
        !manager.sessions.has(session.sessionId) || sessionMap.has(session.sessionId)) {
      throw new Error('Session UI metadata is required');
    }
    sessionMap.set(session.sessionId, {
      sessionId: session.sessionId,
      agent: session.agent,
      cwd: session.cwd
    });
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
      handleMessage(manager, sessionMap, client, message);
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
          resolve({ url: `http://127.0.0.1:${server.address().port}` });
        });
      });
    },
    async close() {
      manager.off('event', forwardEvent);
      await Promise.all([...sessionMap.keys()].map(async sessionId => {
        const runtime = manager.getRuntime(sessionId);
        if (['starting', 'running', 'stopping'].includes(runtime.status)) {
          await manager.stop(sessionId, runtime.runId);
        }
      }));
      for (const client of webSocketServer.clients) client.close(1001, 'Server closed');
      if (listening) {
        await new Promise(resolve => server.close(resolve));
        listening = false;
      }
      await new Promise(resolve => webSocketServer.close(resolve));
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

function handleMessage(manager, sessions, client, message) {
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
