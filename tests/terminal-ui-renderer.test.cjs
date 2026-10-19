const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function createRenderer() {
  const listeners = new Map();
  const sent = [];
  const elements = new Map();
  const sessions = ['codex', 'agy', 'claude'];

  class Element {
    constructor({ textContent = '', dataset = {} } = {}) {
      this.textContent = textContent;
      this.dataset = dataset;
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.title = '';
      this.listeners = new Map();
      this.attributes = new Map();
      this.classes = new Set();
      this.classList = {
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
        add: name => this.classes.add(name),
        remove: name => this.classes.delete(name)
      };
    }
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) || [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }
    dispatch(type, event = {}) {
      return Promise.all((this.listeners.get(type) || []).map(callback => callback(event)));
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    querySelector(selector) { return selector === 'span' ? this.label : null; }
  }

  for (const id of ['status', 'agent-label', 'directory', 'start', 'stop', 'choose-directory', 'notice', 'terminals']) {
    elements.set(id, new Element());
  }
  const tabs = new Map();
  const panes = new Map();
  const statusLabels = new Map();
  const unreadLabels = new Map();
  const launchControls = [];
  for (const id of sessions) {
    const tab = new Element({ dataset: { sessionId: id } });
    tab.label = new Element({ textContent: id === 'agy' ? 'Antigravity' : id === 'claude' ? 'Claude Code' : 'Codex' });
    tab.dataset.sessionId = id;
    tabs.set(id, tab);
    panes.set(id, new Element());
    const status = new Element();
    statusLabels.set(id, status);
    const unread = new Element();
    unread.hidden = true;
    unreadLabels.set(id, unread);
    const control = new Element({ dataset: { launchSession: id } });
    launchControls.push(control);
  }

  const document = {
    getElementById(id) {
      if (id.startsWith('terminal-')) return panes.get(id.slice('terminal-'.length));
      return elements.get(id);
    },
    querySelectorAll(selector) {
      if (selector === 'button[data-session-id]' || selector === '[data-session-id]') return [...tabs.values()];
      if (selector === '[data-launch-session]') return launchControls;
      return [];
    },
    querySelector(selector) {
      let match = selector.match(/^\[data-status-for="([^"]+)"\]$/);
      if (match) return statusLabels.get(match[1]);
      match = selector.match(/^\[data-unread-for="([^"]+)"\]$/);
      if (match) return unreadLabels.get(match[1]);
      return null;
    }
  };

  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = sent;
      listeners.set('socket', this);
    }
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) || [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }
    dispatch(type, event = {}) {
      for (const callback of this.listeners.get(type) || []) callback(event);
    }
    open() { this.readyState = FakeWebSocket.OPEN; this.dispatch('open'); }
    receive(message) { this.dispatch('message', { data: JSON.stringify(message) }); }
    send(value) { sent.push(JSON.parse(value)); }
  }

  const terminals = new Map();
  class FakeTerminal {
    constructor() {
      this.cols = 80;
      this.rows = 24;
      this.output = [];
      this.dataListeners = [];
      terminals.set(FakeTerminal.instances++, this);
    }
    loadAddon(addon) { addon.terminal = this; }
    open() {}
    onData(callback) { this.dataListeners.push(callback); }
    onResize() {}
    write(data, callback) { this.output.push(data); callback?.(); }
    reset() { this.output = []; }
    focus() {}
  }
  FakeTerminal.instances = 0;
  class FakeFitAddon { fit() {} }
  class FakeResizeObserver { observe() {} }
  const window = {
    agentDock: { selectWorkingDirectory: async () => 'C:\\Projects\\AgentDock' },
    addEventListener() {}
  };
  const context = {
    document,
    window,
    location: { host: '127.0.0.1:43127' },
    WebSocket: FakeWebSocket,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFitAddon },
    ResizeObserver: FakeResizeObserver,
    URL,
    console
  };
  const source = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/app.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'app.js' });
  return { elements, tabs, panes, unreadLabels, launchControls, sent, socket: listeners.get('socket') };
}

test('background output marks only its tab unread and selecting that tab clears the marker', () => {
  const renderer = createRenderer();
  const { socket, tabs, unreadLabels, sent } = renderer;
  socket.open();
  socket.receive({
    type: 'snapshot',
    workspace: { cwd: 'C:\\Projects\\AgentDock', launchOnOpen: { codex: false, agy: false, claude: false }, directoryError: null },
    sessions: ['codex', 'agy', 'claude'].map(sessionId => ({
      sessionId,
      agent: sessionId,
      cwd: 'C:\\Projects\\AgentDock',
      launchOnOpen: false,
      runtime: { sessionId, runId: `run-${sessionId}`, seq: 0, status: 'running', error: null }
    }))
  });
  socket.receive({ type: 'output', sessionId: 'agy', runId: 'run-agy', seq: 1, data: 'background output' });

  assert.equal(unreadLabels.get('agy').hidden, false);
  assert.equal(unreadLabels.get('codex').hidden, true);
  assert.equal(unreadLabels.get('claude').hidden, true);
  assert.equal(sent.some(message => message.type === 'start' || message.type === 'input'), false);

  tabs.get('agy').dispatch('click');
  assert.equal(unreadLabels.get('agy').hidden, true);
  assert.equal(tabs.get('agy').attributes.get('aria-selected'), 'true');
});

test('desktop settings use only the selected directory and launchOnOpen bridge actions', async () => {
  const renderer = createRenderer();
  const { socket, elements, launchControls, sent } = renderer;
  socket.open();
  socket.receive({
    type: 'snapshot',
    workspace: { cwd: null, launchOnOpen: { codex: false, agy: false, claude: false }, directoryError: '请选择一个工作目录。' },
    sessions: ['codex', 'agy', 'claude'].map(sessionId => ({
      sessionId, agent: sessionId, cwd: null, launchOnOpen: false,
      runtime: { sessionId, runId: null, seq: 0, status: 'idle', error: null }
    }))
  });

  launchControls[1].checked = true;
  await launchControls[1].dispatch('change');
  await elements.get('choose-directory').dispatch('click');
  assert.deepEqual(sent.filter(message => ['launch-on-open', 'set-working-directory'].includes(message.type)), [
    { type: 'launch-on-open', sessionId: 'agy', enabled: true },
    { type: 'set-working-directory', sessionId: 'codex', cwd: 'C:\\Projects\\AgentDock' }
  ]);
});
