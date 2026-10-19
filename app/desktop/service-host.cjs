const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

function createDesktopServiceHost({
  runtimePath,
  serviceEntryPath,
  userDataPath,
  startupTimeoutMs = 15000,
  shutdownTimeoutMs = 30000,
  forkProcess = fork
} = {}) {
  for (const [name, value] of Object.entries({ runtimePath, serviceEntryPath, userDataPath })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`An absolute ${name} is required`);
  }

  const events = new EventEmitter();
  let child = null;
  let readyInfo = null;
  let exited = false;
  let stopped = false;
  let shutdownRequested = false;
  let startupTimer = null;
  let shutdownTimer = null;
  let resolveReady;
  let rejectReady;
  let resolveShutdown;
  let startPromise = null;
  let shutdownPromise = null;

  function start() {
    if (child) throw new Error('Desktop service has already been started');
    startPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    child = forkProcess(serviceEntryPath, ['--user-data', userDataPath], {
      execPath: runtimePath,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.on('message', onMessage);
    child.on('error', error => failStartup(error));
    child.on('exit', (code, signal) => {
      exited = true;
      readyInfo = null;
      clearTimeout(startupTimer);
      clearTimeout(shutdownTimer);
      if (!startPromiseSettled()) rejectReady?.(new Error(`Desktop service exited before ready (${code ?? signal ?? 'unknown'})`));
      if (resolveShutdown) resolveShutdown(false);
      events.emit('exit', { code, signal, expected: shutdownRequested && stopped });
    });
    startupTimer = setTimeout(() => failStartup(new Error(`Desktop service did not become ready within ${startupTimeoutMs} ms`)), startupTimeoutMs);
    return startPromise;
  }

  function onMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'ready') {
      if (readyInfo) return;
      const candidate = validateReadyMessage(message);
      if (!candidate) {
        failStartup(new Error('Desktop service sent an invalid ready message'));
        return;
      }
      clearTimeout(startupTimer);
      readyInfo = candidate;
      resolveReady?.(candidate);
      resolveReady = null;
      rejectReady = null;
      events.emit('ready', candidate);
      return;
    }
    if (message.type === 'startup-error') {
      failStartup(new Error(typeof message.message === 'string' ? message.message : 'Desktop service failed to start'));
      return;
    }
    if (message.type === 'session-state') {
      events.emit('session-state', message.state);
      return;
    }
    if (message.type === 'shutdown-failed') {
      clearTimeout(shutdownTimer);
      const resolve = resolveShutdown;
      resolveShutdown = null;
      shutdownPromise = null;
      events.emit('shutdown-failed', typeof message.message === 'string' ? message.message : 'A terminal session could not be stopped');
      resolve?.(false);
      return;
    }
    if (message.type === 'stopped') {
      clearTimeout(shutdownTimer);
      stopped = true;
      readyInfo = null;
      const resolve = resolveShutdown;
      resolveShutdown = null;
      events.emit('stopped');
      resolve?.(true);
    }
  }

  function failStartup(error) {
    if (!startPromise || readyInfo || exited) return;
    clearTimeout(startupTimer);
    const reject = rejectReady;
    resolveReady = null;
    rejectReady = null;
    reject?.(error);
    if (child?.connected) child.kill();
  }

  function startPromiseSettled() {
    return Boolean(readyInfo || exited || !rejectReady);
  }

  function shutdown() {
    if (!child || exited || stopped) return Promise.resolve(true);
    if (shutdownPromise) return shutdownPromise;
    if (!readyInfo || !child.connected) return Promise.resolve(false);
    shutdownRequested = true;
    shutdownPromise = new Promise(resolve => {
      resolveShutdown = resolve;
      shutdownTimer = setTimeout(() => {
        resolveShutdown = null;
        shutdownPromise = null;
        events.emit('shutdown-failed', `Desktop service did not stop within ${shutdownTimeoutMs} ms`);
        resolve(false);
      }, shutdownTimeoutMs);
      child.send({ type: 'shutdown' }, error => {
        if (!error) return;
        clearTimeout(shutdownTimer);
        resolveShutdown = null;
        shutdownPromise = null;
        events.emit('shutdown-failed', error.message);
        resolve(false);
      });
    });
    return shutdownPromise;
  }

  return {
    start,
    shutdown,
    get isReady() { return Boolean(readyInfo && !exited && !stopped); },
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args)
  };
}

function validateReadyMessage(message) {
  if (typeof message.origin !== 'string' || typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) return null;
  let origin;
  try { origin = new URL(message.origin); }
  catch { return null; }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
  return { origin: origin.origin, token: message.token };
}

module.exports = { createDesktopServiceHost, validateReadyMessage };
