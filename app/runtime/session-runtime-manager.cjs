const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { OutputFlowController } = require('./output-flow-controller.cjs');

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);

class SessionRuntimeManager extends EventEmitter {
  constructor({ sessions, resolveLaunch, spawnPty, createRunId = randomUUID, outputFlow = {} }) {
    super();
    this.sessions = new Map(sessions.map(session => [session.id, session]));
    this.resolveLaunch = resolveLaunch;
    this.spawnPty = spawnPty;
    this.createRunId = createRunId;
    this.outputFlow = {
      highWatermark: outputFlow.highWatermark ?? 262144,
      lowWatermark: outputFlow.lowWatermark ?? 65536
    };
    this.runtimes = new Map();
  }

  getRuntime(sessionId) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return { sessionId, runId: null, seq: 0, status: 'idle', exitCode: null, error: null };
    return this.snapshot(runtime);
  }

  async start(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    const current = this.runtimes.get(sessionId);
    if (current && ACTIVE_STATES.has(current.status)) return this.snapshot(current);

    const runtime = {
      sessionId,
      runId: this.createRunId(),
      seq: 0,
      status: 'starting',
      exitCode: null,
      error: null,
      pty: null,
      outputFlow: null,
      stopPromise: null,
      exitObserved: false
    };
    this.runtimes.set(sessionId, runtime);
    this.publish(runtime, 'status', { status: 'starting' });

    try {
      const launch = await this.resolveLaunch(session);
      if (!this.isCurrent(runtime) || runtime.status !== 'starting') return this.snapshot(runtime);
      const pty = this.spawnPty(launch, {
        onData: data => this.onData(runtime, data),
        onExit: (exitCode, signal) => this.onExit(runtime, exitCode, signal)
      });
      if (!this.isCurrent(runtime) || runtime.status !== 'starting') {
        if (!runtime.exitObserved) void Promise.resolve(pty.kill()).catch(() => undefined);
        return this.snapshot(runtime);
      }
      runtime.pty = pty;
      runtime.outputFlow = new OutputFlowController({
        sessionId,
        runId: runtime.runId,
        ...this.outputFlow,
        nextSeq: () => ++runtime.seq,
        send: event => {
          if (this.isCurrent(runtime) && !['stopped', 'failed'].includes(runtime.status)) this.emit('event', event);
        },
        writeControl: data => runtime.pty.write(data)
      });
      runtime.status = 'running';
      this.publish(runtime, 'status', { status: 'running' });
    } catch (error) {
      if (this.isCurrent(runtime) && runtime.status === 'starting') {
        runtime.status = 'failed';
        runtime.error = this.errorMessage(error);
        this.publish(runtime, 'status', { status: 'failed', error: runtime.error });
      }
    }

    return this.snapshot(runtime);
  }

  async startAll() {
    return Promise.all([...this.sessions.keys()].map(sessionId => this.start(sessionId)));
  }

  async startAuto() {
    return Promise.all([...this.sessions.values()]
      .filter(session => session.launchOnOpen)
      .map(session => this.start(session.id)));
  }

  async stop(sessionId, runId) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.runId !== runId) return false;
    if (runtime.status === 'stopped' || runtime.status === 'failed') return false;
    if (runtime.status === 'stopping') return runtime.stopPromise;
    if (runtime.status === 'starting') {
      runtime.status = 'stopped';
      this.publish(runtime, 'status', { status: 'stopped' });
      return true;
    }
    if (runtime.status !== 'running' || !runtime.pty) return false;

    runtime.status = 'stopping';
    this.publish(runtime, 'status', { status: 'stopping' });
    runtime.stopPromise = Promise.resolve()
      .then(() => runtime.pty.kill())
      .then(() => {
        if (this.isCurrent(runtime) && runtime.status === 'stopping') this.onExit(runtime, 0, null);
        return true;
      })
      .catch(error => {
        if (this.isCurrent(runtime) && runtime.status === 'stopping') {
          runtime.status = 'running';
          runtime.error = this.errorMessage(error);
          this.publish(runtime, 'status', { status: 'running', error: runtime.error });
        }
        return false;
      })
      .finally(() => { runtime.stopPromise = null; });
    return runtime.stopPromise;
  }

  write(sessionId, runId, data) {
    const runtime = this.currentRunning(sessionId, runId);
    if (!runtime) return false;
    try {
      runtime.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(sessionId, runId, columns, rows) {
    const runtime = this.currentRunning(sessionId, runId);
    if (!runtime) return false;
    try {
      runtime.pty.resize(columns, rows);
      return true;
    } catch {
      return false;
    }
  }

  ack(sessionId, runId, seq) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.runId !== runId || !runtime.outputFlow) return false;
    if (!['running', 'stopping'].includes(runtime.status)) return false;
    return runtime.outputFlow.ack(runId, seq);
  }

  currentRunning(sessionId, runId) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.runId !== runId || runtime.status !== 'running' || !runtime.pty) return null;
    return runtime;
  }

  onData(runtime, data) {
    if (!this.isCurrent(runtime) || ['stopped', 'failed'].includes(runtime.status)) return;
    if (runtime.outputFlow) {
      runtime.outputFlow.onData(data);
      return;
    }
    this.publish(runtime, 'output', { data });
  }

  onExit(runtime, exitCode, signal) {
    if (!this.isCurrent(runtime) || ['stopped', 'failed'].includes(runtime.status)) return;
    runtime.exitObserved = true;
    runtime.status = 'stopped';
    runtime.exitCode = exitCode;
    runtime.pty = null;
    if (runtime.outputFlow) runtime.outputFlow.close();
    runtime.outputFlow = null;
    this.publish(runtime, 'exit', { exitCode, signal });
    this.publish(runtime, 'status', { status: 'stopped', exitCode });
  }

  publish(runtime, type, fields) {
    const event = {
      type,
      sessionId: runtime.sessionId,
      runId: runtime.runId,
      seq: ++runtime.seq,
      ...fields
    };
    this.emit('event', event);
    return event;
  }

  isCurrent(runtime) {
    return this.runtimes.get(runtime.sessionId) === runtime;
  }

  snapshot(runtime) {
    return {
      sessionId: runtime.sessionId,
      runId: runtime.runId,
      seq: runtime.seq,
      status: runtime.status,
      exitCode: runtime.exitCode,
      error: runtime.error
    };
  }

  errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
}

module.exports = { SessionRuntimeManager };
