const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function createRenderer({ delayedWrites = false, realParser = false } = {}) {
  const sent = [], sockets = [], timers = new Map(), terminals = [];
  let timerId = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
      this.hidden = false; this.disabled = false; this.checked = false; this.value = '';
      this._text = ''; this.className = ''; this.title = ''; this.open = false;
      this.classList = { toggle: (name, enabled) => {
        const set = new Set(this.className.split(' ').filter(Boolean));
        (enabled ?? !set.has(name)) ? set.add(name) : set.delete(name);
        this.className = [...set].join(' ');
      }, add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false) };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = value;
      if (name === 'class') this.className = value;
      if (name === 'value') this.value = value;
      if (name === 'hidden') this.hidden = true;
      if (name === 'checked') this.checked = true;
      if (name === 'disabled') this.disabled = true;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
    async dispatch(type, event = {}) {
      const e = { preventDefault() {}, stopPropagation() {}, target: this, ...event };
      return Promise.all((this.listeners.get(type) || []).map(fn => fn(e)));
    }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
      const match = selector.match(/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (match) return (!match[1] || this.tagName === match[1].toUpperCase()) && this.attributes.has(match[2]) && (match[3] === undefined || this.attributes.get(match[2]) === match[3]);
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(other) { return this === other || this.children.some(child => child.contains(other)); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    getBoundingClientRect() { return { width: this.hidden ? 0 : 1100, height: this.hidden ? 0 : 800 }; }
  }
  const root = new Element('document'), stack = [root];
  const html = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/index.html'), 'utf8');
  for (const token of html.match(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<!')) continue;
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const el = new Element(tag);
      for (const attr of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).append(el);
      if (!['meta', 'link', 'input', 'br', 'hr'].includes(tag)) stack.push(el);
    } else stack.at(-1)._text += token.trim();
  }
  const document = {
    activeElement: null, createElement: tag => new Element(tag),
    getElementById: id => root.querySelector('#' + id),
    querySelector: selector => root.querySelector(selector), querySelectorAll: selector => root.querySelectorAll(selector),
    addEventListener() {}
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.listeners = new Map(); sockets.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    open() { this.readyState = 1; this.listeners.get('open')?.(); }
    receive(message) { this.listeners.get('message')?.({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.listeners.get('close')?.(); }
    send(value) { sent.push(JSON.parse(value)); }
  }
  class FakeTerminal {
    constructor(options) {
      this.options = options; this.cols = 80; this.rows = 24; this.output = [];
      this.callbacks = []; this.fits = 0; this.focusCount = 0; this.selection = '';
      this.buffer = { active: { baseY: 0, viewportY: 0, length: 24,
        getLine: index => ({ translateToString: () => this.output.join('').split(/\r?\n/)[index] || '' }) } }; terminals.push(this);
    }
    loadAddon(addon) { addon.terminal = this; }
    open(pane) { this.pane = pane; }
    onData(fn) { this.data = fn; }
    onResize(fn) { this.resize = fn; }
    onScroll(fn) { this.scroll = fn; }
    attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
    hasSelection() { return Boolean(this.selection); }
    getSelection() { return this.selection; }
    write(data, callback) { this.output.push(data); if (callback) delayedWrites ? this.callbacks.push(callback) : callback(); }
    flush() { this.callbacks.shift()?.(); }
    focus() { this.focusCount++; document.activeElement = this.pane; }
    dispose() { this.disposed = true; }
    scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; this.scroll?.(); }
  }
  class FakeFitAddon { fit() { assert.equal(this.terminal.pane.hidden, false, 'hidden terminal must never be fitted'); this.terminal.fits++; } }
  let TerminalClass = FakeTerminal;
  if (realParser) {
    TerminalClass = class extends require('@xterm/xterm').Terminal {
      constructor(options) { super(options); this.output = []; terminals.push(this); }
      loadAddon(addon) { addon.terminal = this; }
      open(pane) { this.pane = pane; }
      focus() {}
      write(data, callback) { this.output.push(data); super.write(data, callback); }
    };
  }
  const clipboardWrites = [];
  const window = { innerWidth: 1440, agentDock: { selectWorkingDirectory: async () => 'C:\\New 项目', writeClipboardText: text => { clipboardWrites.push(text); return Promise.resolve(true); } }, addEventListener() {} };
  const context = { document, window, location: { host: '127.0.0.1:43127' }, WebSocket: FakeWebSocket,
    Terminal: TerminalClass, FitAddon: { FitAddon: FakeFitAddon }, ResizeObserver: class { observe() {} },
    navigator: { clipboard: { writeText: async () => {} } }, crypto: { randomUUID: () => 'request-' + (++timerId) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/terminal/ui/app.js'), 'utf8'), context, { filename: 'app.js' });
  return { document, window, sent, sockets, terminals, timers, clipboardWrites,
    get socket() { return sockets.at(-1); }, el: id => document.getElementById(id),
    row: id => document.querySelector(`[data-session-id="${id}"]`),
    command(type) { return sent.filter(m => m.type === type).at(-1); },
    result(request, ok = true, message = '') { this.socket.receive({ type: 'command-result', requestId: request.requestId, ok, message }); },
    snapshot(sessions = fixture(), selected = sessions[0]?.sessionId ?? null, type = 'snapshot') {
      const projects = [...new Map(sessions.map(s => [s.projectId, { id: s.projectId, rootPath: s.cwd, collapsed: false }])).values()];
      this.socket.receive({ type, sessions, workspace: { schemaVersion: 2, projects, sessions: sessions.map(s => ({ id: s.sessionId, projectId: s.projectId, agent: s.agentId, name: s.name, launchOnOpen: s.launchOnOpen })), selectedSessionId: selected } });
    }
  };
}
function fixture() {
  return [
    { sessionId: 'alpha', projectId: 'p1', agent: 'Codex', agentId: 'codex', name: '设计', cwd: 'C:\\Work\\Demo', launchOnOpen: true, directoryError: null, runtime: { status: 'running', runId: 'r1', seq: 0, error: null } },
    { sessionId: 'beta', projectId: 'p1', agent: 'Codex', agentId: 'codex', name: '审查', cwd: 'C:\\Work\\Demo', launchOnOpen: false, directoryError: null, runtime: { status: 'running', runId: 'r2', seq: 0, error: null } },
    { sessionId: 'gamma', projectId: 'p2', agent: 'Claude Code', agentId: 'claude', name: '文档', cwd: 'D:\\Other\\Demo', launchOnOpen: false, directoryError: null, runtime: { status: 'idle', runId: null, seq: 0, error: null } }
  ];
}
function output(r, sessionId = 'beta', runId = 'r2', seq = 1, data = '后台输出') { r.socket.receive({ type: 'output', sessionId, runId, seq, data }); }
async function tick() { await Promise.resolve(); await Promise.resolve(); }

test('legacy xterm viewport fills unused pixels with the terminal theme without a second native scrollbar', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  const rule = css.match(/\.xterm\s+\.xterm-viewport\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /background-color:\s*#1d1d2d\s*;/, 'legacy viewport must override the vendor black background');
  assert.match(rule, /overflow:\s*hidden\s*;/, 'legacy viewport must suppress both native scrollbar axes');
  assert.doesNotMatch(rule, /display:\s*none|visibility:\s*hidden/, 'the node remains available to xterm renderers');
  assert.doesNotMatch(css, /\.xterm-scrollable-element[^{}]*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/);
});

test('reference terminal density uses the calibrated line height while retaining font and scrollback', () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  const options = r.terminals[0].options;
  assert.equal(options.lineHeight, 1.1);
  assert.equal(options.fontSize, 24);
  assert.equal(options.scrollback, 5000);
  assert.equal(options.theme.background, '#1d1d2d');
});

test('terminal panel keeps the reference left inset while preserving its other padding', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  const rule = css.match(/\.terminal-panel\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /padding:\s*8px 12px 8px 28px\s*;/);
});

test('compact shell aligns the toolbar and project tree with the reference geometry', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  const body = css.match(/^body\s*\{([^}]+)\}/m)?.[1] || '';
  const toolbar = css.match(/\.toolbar\s*\{([^}]+)\}/)?.[1] || '';
  const windowLabel = css.match(/\.window-label\s*\{([^}]+)\}/)?.[1] || '';
  const divider = css.match(/\.toolbar::after\s*\{([^}]+)\}/)?.[1] || '';
  const brand = css.match(/\.brand\s*\{([^}]+)\}/)?.[1] || '';
  const treeHeading = css.match(/\.tree-heading\s*\{([^}]+)\}/)?.[1] || '';
  const sessionConnector = css.match(/\.session-row::after\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(body, /grid-template-rows:\s*35px\s+minmax\(0,\s*1fr\)/);
  assert.match(toolbar, /height:\s*35px\s*;/);
  assert.match(windowLabel, /width:\s*74px\s*;/);
  assert.match(windowLabel, /font-size:\s*0\s*;/);
  assert.match(windowLabel, /white-space:\s*nowrap\s*;/);
  assert.match(divider, /top:\s*34px\s*;/);
  assert.match(brand, /height:\s*80px\s*;/);
  assert.match(brand, /flex-direction:\s*column\s*;/);
  assert.match(brand, /gap:\s*4px\s*;/);
  assert.match(brand, /padding-top:\s*8px\s*;/);
  assert.match(treeHeading, /margin-bottom:\s*0\s*;/);
  assert.match(treeHeading, /border-bottom:\s*1px solid #292a39\s*;/);
  assert.match(sessionConnector, /width:\s*28px\s*;/);
});

test('topbar keeps the repeated app label compact and improves directory and action readability', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  const directory = css.match(/\.directory\s*\{([^}]+)\}/)?.[1] || '';
  const status = css.match(/(?:^|\r?\n)#status\s*\{([^}]+)\}/m)?.[1] || '';
  const actions = css.match(/#change-directory,\s*#start,\s*#stop,\s*#status\s*\{([^}]+)\}/)?.[1] || '';
  const treeHeading = css.match(/\.tree-heading\s*\{([^}]+)\}/)?.[1] || '';
  const projectName = css.match(/\.project-name\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(directory, /font-size:\s*13px\s*;/);
  assert.match(directory, /font-family:\s*Consolas,\s*"Cascadia Mono",\s*monospace\s*;/);
  assert.match(directory, /flex:\s*0\s+1\s+300px\s*;/);
  assert.match(status, /margin-left:\s*auto\s*;/);
  assert.match(actions, /font-size:\s*13px\s*;/);
  assert.doesNotMatch(css, /\.tree-heading strong::after\s*\{/);
  assert.match(projectName, /color:\s*#b8d7b1\s*;/);
});

test('running session status text uses the same green emphasis as its status dot', () => {
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  const rule = css.match(/\.session-status\[data-status="running"\]\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /color:\s*#83dbad\s*;/);
});

test('sidebar brand uses the local AgentDock application icon', () => {
  const document = createRenderer().document;
  const icon = document.querySelector('.brand-icon');
  const tagline = document.querySelector('.brand-tagline');
  const imagePath = path.join(__dirname, '../app/terminal/ui/agentdock-icon.png');
  const image = fs.readFileSync(imagePath);
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  assert.equal(icon.tagName, 'IMG');
  assert.equal(icon.getAttribute('src'), '/agentdock-icon.png');
  assert.equal(icon.getAttribute('alt'), '');
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(image.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16), 64);
  assert.equal(image.readUInt32BE(20), 64);
  assert.match(css, /\.brand-icon\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/);
  assert.ok(tagline, 'sidebar brand must expose its reference tagline');
  assert.equal(tagline.textContent, 'All agents in one.');
  assert.match(css, /\.brand-tagline\s*\{[^}]*font-size:\s*11px;[^}]*line-height:\s*16px;/);
});

test('empty workspace has no placeholder terminals and dynamic repeated tools form distinct project groups', () => {
  const r = createRenderer(); r.socket.open(); r.snapshot([]);
  assert.equal(r.document.querySelectorAll('[data-session-id]').length, 0);
  assert.equal(r.terminals.length, 0);
  assert.equal(r.el('empty-state').hidden, false);
  r.snapshot();
  assert.equal(r.document.querySelectorAll('[data-session-id]').length, 3);
  assert.equal(r.document.querySelectorAll('[data-project-id]').length, 2);
  assert.match(r.el('project-tree').textContent, /C:\\Work/);
  assert.match(r.el('project-tree').textContent, /D:\\Other/);
  assert.equal(r.el('shared-warning').hidden, false);
  assert.match(r.el('shared-warning').textContent, /可能同时修改同一文件/);
});

test('idle selected session offers a start action only while its terminal buffer is empty and no CLI error exists', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot(fixture(), 'gamma');
  const empty = r.el('session-empty-state');
  assert.ok(empty, 'selected sessions need an explicit empty state');
  assert.equal(empty.hidden, false);
  assert.deepEqual(r.terminals[0].output, [], 'the empty state must not invent terminal output');
  assert.equal(r.el('session-empty-start').textContent, '启动此会话');
  await r.el('session-empty-start').dispatch('click');
  assert.deepEqual(r.command('start'), { type: 'start', sessionId: 'gamma' });

  r.socket.receive({ type: 'status', sessionId: 'gamma', runId: 'first', status: 'starting', seq: 1 });
  r.socket.receive({ type: 'status', sessionId: 'gamma', runId: 'first', status: 'running', seq: 2 });
  assert.equal(empty.hidden, true);
  output(r, 'gamma', 'first', 3, 'CLI_OUTPUT');
  r.socket.receive({ type: 'status', sessionId: 'gamma', runId: 'first', status: 'stopped', seq: 4 });
  assert.equal(empty.hidden, true);

  const errored = fixture(); errored[2].runtime.status = 'failed'; errored[2].runtime.error = 'CLI error';
  r.snapshot(errored, 'gamma');
  assert.equal(empty.hidden, true);
});

test('tool rows use decorative local SVG logos instead of text approximations', () => {
  const r = createRenderer(); r.socket.open(); const sessions = fixture();
  sessions[1].agentId = 'agy'; sessions[1].agent = 'Antigravity'; r.snapshot(sessions);
  const css = fs.readFileSync(path.join(__dirname, '../app/terminal/ui/style.css'), 'utf8');
  const officialHashes = {
    codex: '468ebe03b0504e3e40be53e6c1f4b5b80c00d94ea4ad07b913ae41073638ae90',
    agy: 'd775965ea1f8060538c15f758a3e22487317211fcb6051333b5e023f35aa726f',
    claude: '6d53db4be375e899c937c26cf16684a80d6e869b1928d72b37748bef2560e219'
  };
  for (const [sessionId, agentId] of [['alpha', 'codex'], ['beta', 'agy'], ['gamma', 'claude']]) {
    const icon = r.row(sessionId).querySelector('.agent-icon');
    assert.equal(icon.textContent, '', `${agentId} must not display a substitute glyph`);
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    const rule = css.match(new RegExp(`\\.agent-icon\\.${agentId}\\s*\\{([^}]+)\\}`));
    const payload = rule?.[1].match(/background-image:\s*url\("data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"\)/)?.[1];
    assert.ok(payload, `${agentId} logo must load offline from its local stylesheet`);
    assert.equal(require('node:crypto').createHash('sha256').update(Buffer.from(payload, 'base64')).digest('hex'), officialHashes[agentId]);
    const svg = Buffer.from(payload, 'base64').toString('utf8');
    assert.match(svg, /<svg\b/); assert.match(svg, /<path\b/);
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|(?:href|src)=["']https?:/i);
  }
});

test('create uses native picker, preserves cancellation, explicit auto-start, and blocks double submission until its correlated result', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  await r.el('new-session').dispatch('click');
  assert.equal(r.el('create-launch').checked, true);
  await r.el('choose-directory').dispatch('click');
  const chosen = r.el('create-cwd').value;
  r.window.agentDock.selectWorkingDirectory = async () => null;
  await r.el('choose-directory').dispatch('click');
  assert.equal(r.el('create-cwd').value, chosen);
  r.el('create-name').value = '新的 Codex'; r.el('create-agent').value = 'codex';
  const pending = r.el('create-form').dispatch('submit');
  await r.el('create-form').dispatch('submit');
  assert.equal(r.sent.filter(m => m.type === 'create-session').length, 1);
  const request = r.command('create-session');
  assert.equal(request.cwd, 'C:\\New 项目'); assert.equal(request.launchOnOpen, true); assert.equal(request.start, true);
  assert.equal(r.el('create-submit').disabled, true);
  r.result({ requestId: 'unrelated' }); await tick(); assert.equal(r.el('create-dialog').open, true);
  r.result(request, false, '磁盘无法保存'); await pending;
  assert.equal(r.el('create-dialog').open, true); assert.match(r.el('create-error').textContent, /磁盘无法保存/);
  assert.equal(r.el('directory').title, 'C:\\Work\\Demo');
});

test('selection is persisted and failed selection does not change the current terminal', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  const pending = r.row('gamma').dispatch('click');
  const request = r.command('select-session'); assert.equal(request.sessionId, 'gamma'); assert.ok(request.requestId);
  r.result(request, false, '配置保存失败'); await pending;
  assert.equal(r.row('alpha').getAttribute('aria-selected'), 'true');
  assert.match(r.el('notice').textContent, /配置保存失败/);
});

test('background output is ACKed without hidden fit or focus and selection keeps the same terminal and clears unread', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  const focused = r.document.activeElement; output(r);
  assert.equal(r.document.activeElement, focused);
  assert.equal(r.document.querySelector('[data-unread-for="beta"]').hidden, false);
  assert.equal(r.command('ack').seq, 1);
  const terminal = r.terminals.find(t => t.output.includes('后台输出'));
  assert.equal(terminal.fits, 0);
  const pending = r.row('beta').dispatch('click'); const request = r.command('select-session');
  r.snapshot(fixture(), 'beta', 'workspace'); r.result(request); await pending;
  assert.equal(terminal.pane.hidden, false); assert.equal(terminal.fits > 0, true);
  assert.equal(r.document.querySelector('[data-unread-for="beta"]').hidden, true);
  assert.equal(r.terminals.filter(t => t.pane === terminal.pane).length, 1);
});

test('run and seq filter stale output, retain old screen with separator, and never ACK an old writing run', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot();
  output(r, 'alpha', 'r1', 1, 'old screen'); const terminal = r.terminals[0];
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'starting' });
  output(r, 'alpha', 'r1', 2, 'stale'); output(r, 'alpha', 'new-run', 1, 'new screen');
  terminal.flush(); terminal.flush();
  output(r, 'alpha', 'new-run', 1, 'duplicate');
  assert.ok(terminal.output.includes('old screen')); assert.ok(terminal.output.includes('new screen'));
  assert.equal(terminal.output.includes('stale'), false); assert.equal(terminal.output.includes('duplicate'), false);
  assert.match(terminal.output.join(''), /新一轮/);
  assert.equal(r.sent.some(m => m.type === 'ack' && m.runId === 'r1'), false);
});

test('same-page reconnect retains output, draft input and pending writes without consuming snapshot seq or resending input', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; terminal.data('draft'); output(r, 'alpha', 'r1', 1, 'first');
  r.socket.close();
  for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); const sessions = fixture(); sessions[0].runtime.seq = 3; r.snapshot(sessions);
  output(r, 'alpha', 'r1', 2, 'queued second'); output(r, 'alpha', 'r1', 3, 'queued third');
  terminal.flush(); terminal.flush(); terminal.flush();
  assert.equal(r.terminals[0], terminal); assert.deepEqual(terminal.output, ['first', 'queued second', 'queued third']);
  assert.equal(r.sent.filter(m => m.type === 'input').length, 1);
  assert.equal(r.command('ack').seq, 3); assert.match(r.el('notice').textContent, /保留/);
});

test('fresh page explains missing running screen and Ctrl+C leaves selected text to xterm but forwards ETX without selection', () => {
  const r = createRenderer(); r.socket.open(); const sessions = fixture(); sessions[0].runtime.seq = 8; r.snapshot(sessions);
  assert.match(r.el('notice').textContent, /无法恢复/);
  const terminal = r.terminals[0]; terminal.selection = 'selected text';
  assert.equal(terminal.keyHandler({ type: 'keydown', ctrlKey: true, key: 'c', shiftKey: false, altKey: false }), false);
  assert.deepEqual(r.clipboardWrites, []);
  assert.equal(r.sent.some(m => m.type === 'input'), false);
  terminal.selection = '';
  assert.equal(terminal.keyHandler({ type: 'keydown', ctrlKey: true, key: 'c', shiftKey: false, altKey: false }), true);
  terminal.data('\u0003'); assert.equal(r.command('input').data, '\u0003');
});

test('stop and removal require named confirmation and failed removal preserves terminal', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  await r.el('stop').dispatch('click'); assert.equal(r.command('stop'), undefined);
  assert.match(r.el('confirm-message').textContent, /设计/);
  await r.el('confirm-cancel').dispatch('click'); assert.equal(r.command('stop'), undefined);
  await r.el('stop').dispatch('click'); await r.el('confirm-submit').dispatch('click');
  assert.equal(r.command('stop').runId, 'r1');
  await r.el('remove-session').dispatch('click'); assert.match(r.el('confirm-submit').textContent, /停止并移除/);
  const pending = r.el('confirm-submit').dispatch('click'); const request = r.command('remove-session');
  assert.equal(request.runId, 'r1'); r.result(request, false, '无法停止'); await pending;
  assert.ok(r.row('alpha')); assert.equal(r.terminals[0].disposed, undefined);
  assert.match(r.el('confirm-error').textContent, /无法停止/);
});

test('rename and launch settings wait for success, retain failures, and start-all is explicit', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  await r.el('rename-session').dispatch('click'); r.el('rename-name').value = '新名称';
  const rename = r.el('rename-form').dispatch('submit'); const request = r.command('rename-session');
  assert.equal(request.name, '新名称'); r.result(request, false, '只读磁盘'); await rename;
  assert.match(r.row('alpha').textContent, /设计/); assert.match(r.el('rename-error').textContent, /只读磁盘/);
  r.el('launch-on-open').checked = false;
  const launch = r.el('launch-on-open').dispatch('change'); const setting = r.command('launch-on-open');
  assert.equal(setting.enabled, false); r.result(setting, false, '保存失败'); await launch;
  assert.equal(r.el('launch-on-open').checked, true);
  await r.el('start-all').dispatch('click'); assert.equal(r.sent.filter(m => m.type === 'start-all').length, 1);
});

test('project collapse persists, search finds paths and sessions, and other-directory create never changes existing cwd', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  const collapse = r.document.querySelector('[data-collapse-project="p1"]').dispatch('click');
  const request = r.command('set-project-collapsed'); assert.equal(request.collapsed, true); r.result(request); await collapse;
  r.el('search').value = '文档'; await r.el('search').dispatch('input');
  assert.equal(r.row('alpha'), null); assert.ok(r.row('gamma'));
  r.el('search').value = 'not-found'; await r.el('search').dispatch('input'); assert.match(r.el('project-tree').textContent, /没有匹配/);
  await r.el('new-other-directory').dispatch('click'); assert.equal(r.el('create-cwd').value, '');
  assert.equal(r.el('directory').title, 'C:\\Work\\Demo');
});

test('return to latest follows scroll state and a deleted selected session disposes only its terminal', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot(); const terminal = r.terminals[0];
  terminal.buffer.active.baseY = 100; terminal.buffer.active.viewportY = 20; terminal.scroll();
  assert.equal(r.el('latest').hidden, false); await r.el('latest').dispatch('click');
  assert.equal(terminal.buffer.active.viewportY, 100); assert.equal(r.el('latest').hidden, true);
  output(r); const other = r.terminals[1]; r.snapshot(fixture().slice(1), 'beta', 'workspace');
  assert.equal(terminal.disposed, true); assert.equal(other.disposed, undefined);
});

test('launch setting cannot be submitted again while persistence is pending', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  r.el('launch-on-open').checked = false;
  const pending = r.el('launch-on-open').dispatch('change');
  assert.equal(r.el('launch-on-open').disabled, true);
  await r.el('launch-on-open').dispatch('change');
  assert.equal(r.sent.filter(m => m.type === 'launch-on-open').length, 1);
  r.result(r.command('launch-on-open')); await pending;
});

test('successful creation clears the search and expands a collapsed destination before focusing its terminal', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  r.el('search').value = '文档'; await r.el('search').dispatch('input');
  await r.el('new-session').dispatch('click'); await r.el('choose-directory').dispatch('click');
  const pending = r.el('create-form').dispatch('submit'); const request = r.command('create-session');
  assert.equal(request.name, 'Codex');
  const sessions = fixture(); sessions.push({ ...sessions[0], sessionId: 'created', name: 'Codex', runtime: { status: 'idle', runId: null, seq: 0, error: null } });
  const workspace = { projects: [{ id: 'p1', rootPath: sessions[0].cwd, collapsed: true }, { id: 'p2', rootPath: sessions[2].cwd, collapsed: false }], sessions: [], selectedSessionId: 'created' };
  r.socket.receive({ type: 'workspace', sessions, workspace });
  r.socket.receive({ type: 'command-result', requestId: request.requestId, ok: true, sessionId: 'created' }); await tick();
  const expand = r.command('set-project-collapsed'); assert.equal(expand.collapsed, false);
  workspace.projects[0].collapsed = false; r.socket.receive({ type: 'workspace', sessions, workspace }); r.result(expand); await pending;
  assert.equal(r.el('search').value, ''); assert.ok(r.row('created')); assert.equal(r.el('create-dialog').open, false);
});

test('normal status seq does not turn an intact same-page reconnect into missing-output warning', () => {
  const r = createRenderer(); r.socket.open(); r.snapshot(); output(r, 'alpha', 'r1', 1, 'complete');
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'r1', seq: 2, status: 'stopped' });
  r.socket.close(); for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); const sessions = fixture(); sessions[0].runtime = { status: 'stopped', runId: 'r1', seq: 2, error: null }; r.snapshot(sessions);
  assert.match(r.el('notice').textContent, /已保留/); assert.doesNotMatch(r.el('notice').textContent, /可能缺失/);
});

test('confirmation from an earlier run never stops or removes the replacement run', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot(); await r.el('remove-session').dispatch('click');
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'replacement', status: 'starting', seq: 1 });
  await r.el('confirm-submit').dispatch('click');
  assert.equal(r.command('remove-session'), undefined); assert.match(r.el('confirm-error').textContent, /已发生变化/);
});

test('disconnect disables commands, rejects pending configuration visibly and never retries creation automatically', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot(); await r.el('new-session').dispatch('click'); await r.el('choose-directory').dispatch('click');
  const pending = r.el('create-form').dispatch('submit'); r.socket.close(); await pending;
  assert.equal(r.el('create-submit').disabled, true); assert.equal(r.el('new-session').disabled, true);
  assert.match(r.el('create-error').textContent, /未确认/);
  for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); r.snapshot();
  assert.equal(r.sent.filter(m => m.type === 'create-session').length, 1);
});

test('dialog primary actions explain disconnected and pending states through visible accessible descriptions', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  await r.el('new-other-directory').dispatch('click');
  r.socket.close();
  for (const prefix of ['create', 'rename', 'confirm']) {
    const button = r.el(prefix + '-submit');
    assert.equal(button.disabled, true);
    assert.match(button.title, /等待本地终端服务连接/);
    const description = r.el(button.getAttribute('aria-describedby'));
    assert.ok(description, prefix + ' must expose an accessible description');
    assert.equal(description.hidden, false);
    assert.match(description.textContent, /等待本地终端服务连接/);
  }
  for (const id of ['session-menu-toggle', 'launch-on-open']) assert.match(r.el(id).title, /等待本地终端服务连接/);
  for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); r.snapshot();
  assert.equal(r.el('create-disabled-reason').hidden, true);
  let resolvePicker;
  r.window.agentDock.selectWorkingDirectory = () => new Promise(resolve => { resolvePicker = resolve; });
  const picking = r.el('choose-directory').dispatch('click');
  assert.match(r.el('create-disabled-reason').textContent, /正在选择目录/);
  assert.match(r.el('choose-directory').title, /正在选择目录/);
  resolvePicker('C:\\New 项目'); await picking;
  const creating = r.el('create-form').dispatch('submit');
  assert.match(r.el('create-disabled-reason').textContent, /正在创建/);
  assert.match(r.el('create-cancel').title, /正在创建/);
  r.result(r.command('create-session'), false, '测试保存失败'); await creating;
  assert.equal(r.el('create-disabled-reason').hidden, true);
});

test('empty workspace and stopping session controls explain why their primary action is disabled', () => {
  const r = createRenderer(); r.socket.open(); r.snapshot([]);
  assert.match(r.el('start-all').title, /没有可启动的会话/);
  assert.match(r.el('start').title, /请先选择或新建会话/);
  assert.match(r.el('session-menu-toggle').title, /请先选择或新建会话/);
  const sessions = fixture(); sessions[0].runtime.status = 'stopping'; r.snapshot(sessions);
  assert.equal(r.el('stop').disabled, true);
  assert.match(r.el('stop').title, /正在停止/);
});

test('directory control visibly explains missing selection', () => {
  const r = createRenderer(); r.socket.open(); r.snapshot([]);
  assert.match(r.el('directory').textContent, /请先选择或新建会话/);
  assert.match(r.el('directory').title, /请先选择或新建会话/);
  assert.equal(r.el('change-directory').disabled, true);
  assert.match(r.el('change-directory').title, /请先选择或新建会话/);
  r.socket.close();
  assert.equal(r.el('change-directory').disabled, true);
  assert.match(r.el('change-directory').title, /等待本地终端服务连接/);
  for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open();
  r.snapshot();
  assert.equal(r.el('directory').textContent, 'C:\\Work\\Demo');
  assert.equal(r.el('change-directory').disabled, false);
});

test('topbar directory action opens a same-tool session in another directory without stopping the current run', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  assert.ok(r.el('change-directory'));
  assert.equal(r.el('change-directory').textContent, '在其他目录新建会话');
  let pickerCalls = 0;
  r.window.agentDock.selectWorkingDirectory = async () => { pickerCalls++; return 'C:\\New 项目'; };
  await r.el('change-directory').dispatch('click');
  assert.equal(pickerCalls, 1);
  assert.equal(r.el('create-dialog').open, true);
  assert.equal(r.el('create-agent').value, 'codex');
  assert.equal(r.el('create-cwd').value, 'C:\\New 项目');
  assert.equal(r.el('create-context').hidden, false);
  assert.match(r.el('create-context').textContent, /新建.*独立会话.*当前会话继续在原目录运行/);
  assert.match(r.el('change-directory').title, /选择另一个目录并新建会话.*当前会话继续在原目录运行/);
  assert.equal(r.row('alpha').getAttribute('aria-selected'), 'true');
  assert.equal(r.sent.some(message => ['stop', 'remove-session'].includes(message.type)), false);
});

test('a stopped session can change its own directory and a running session explains how to enable the action', async () => {
  const r = createRenderer(); r.socket.open();
  const sessions = fixture();
  sessions[2].runtime.status = 'stopped';
  r.snapshot(sessions, 'gamma');
  await r.el('session-menu-toggle').dispatch('click');
  const action = r.el('change-session-directory');
  assert.ok(action, 'session menu must expose a directory change action');
  assert.equal(action.disabled, false);
  let pickerCalls = 0;
  r.window.agentDock.selectWorkingDirectory = async () => { pickerCalls++; return 'C:\\New 项目'; };
  const pending = action.dispatch('click');
  await tick();
  const request = r.command('change-session-directory');
  assert.equal(pickerCalls, 1);
  assert.deepEqual(request, { type: 'change-session-directory', requestId: request.requestId, sessionId: 'gamma', cwd: 'C:\\New 项目' });
  assert.equal(action.disabled, true);
  r.result(request);
  await pending;
  const movedSessions = fixture();
  movedSessions[2].runtime.status = 'stopped';
  movedSessions[2].projectId = 'p3';
  movedSessions[2].cwd = 'C:\\New 项目';
  r.snapshot(movedSessions, 'gamma', 'workspace');
  assert.equal(r.el('directory').textContent, 'C:\\New 项目');

  const running = fixture(); r.snapshot(running, 'alpha');
  await r.el('session-menu-toggle').dispatch('click');
  assert.equal(action.disabled, true);
  assert.match(action.title, /先停止此会话/);
  await action.dispatch('click');
  assert.equal(pickerCalls, 1);
  assert.equal(r.sent.filter(message => message.type === 'change-session-directory').length, 1);
});

test('project add explains disconnection across tree rerenders', async () => {
  const r = createRenderer(); r.socket.open(); r.snapshot();
  assert.equal(r.document.querySelector('.project-add').disabled, false);
  r.socket.close();
  for (const renderAgain of [false, true]) {
    if (renderAgain) { r.el('search').value = 'Demo'; await r.el('search').dispatch('input'); }
    for (const button of r.document.querySelectorAll('.project-add')) {
      assert.equal(button.disabled, true);
      assert.match(button.title, /等待本地终端服务连接/);
      const reason = r.el(button.getAttribute('aria-describedby'));
      assert.ok(reason); assert.equal(reason.hidden, false);
      assert.match(reason.textContent, /等待本地终端服务连接/);
    }
  }
  for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); r.snapshot();
  assert.equal(r.el('project-create-disabled-reason').hidden, true);
  const add = r.document.querySelector('.project-add');
  assert.equal(add.disabled, false); await add.dispatch('click');
  assert.equal(r.el('create-dialog').open, true);
  assert.equal(r.el('create-cwd').value, 'C:\\Work\\Demo');
});

test('single session directory hides shared warning and invalid directory blocks only that start', async () => {
  const r = createRenderer(); r.socket.open(); const sessions = fixture(); sessions[2].directoryError = '保存的工作目录不存在';
  r.snapshot(sessions, 'gamma');
  assert.equal(r.el('shared-warning').hidden, true); assert.equal(r.el('start').disabled, true);
  assert.match(r.el('notice').textContent, /目录不存在/);
  r.snapshot(sessions, 'alpha', 'workspace'); assert.equal(r.el('stop').disabled, false);
});

test('reconnect queues a missing-output marker after received writes and resumes only its real output boundary', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; output(r, 'alpha', 'r1', 1, 'already received');
  r.socket.close(); for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); const sessions = fixture(); sessions[0].runtime.seq = 6; sessions[0].runtime.outputSeq = 4; r.snapshot(sessions);
  output(r, 'alpha', 'r1', 7, 'after reconnect');
  assert.equal(r.command('resume-output'), undefined);
  assert.deepEqual(terminal.output, ['already received']);
  terminal.flush();
  assert.match(terminal.output[1], /输出缺失/); assert.equal(r.command('resume-output'), undefined);
  terminal.flush();
  assert.deepEqual(r.command('resume-output'), { type: 'resume-output', sessionId: 'alpha', runId: 'r1', seq: 4 });
  assert.equal(terminal.output[2], 'after reconnect'); terminal.flush(); assert.equal(r.command('ack').seq, 7);
  assert.equal(r.sent.some(m => (m.type === 'ack' || m.type === 'resume-output') && m.seq === 6), false);
});

test('new-run replacement drops a queued gap and never resumes the earlier run', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; output(r, 'alpha', 'r1', 1, 'received');
  const sessions = fixture(); sessions[0].runtime.seq = 8; sessions[0].runtime.outputSeq = 7; r.snapshot(sessions);
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'starting', seq: 1 });
  terminal.flush();
  assert.equal(r.command('resume-output'), undefined);
});

test('an open reconnect sends no terminal progress or resize until its snapshot confirms the session still exists', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; output(r, 'alpha', 'r1', 1, 'pending output');
  r.socket.close(); for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); const count = r.sent.length;
  terminal.resize({ cols: 100, rows: 40 }); terminal.flush();
  assert.deepEqual(r.sent.slice(count), []);
  r.snapshot(fixture().slice(1), 'beta');
  terminal.resize({ cols: 90, rows: 30 }); terminal.data('stale terminal');
  assert.equal(r.sent.slice(count).some(m => m.sessionId === 'alpha'), false);
});

test('output completed before reconnect snapshot is re-ACKed only after the same run is confirmed', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot();
  output(r, 'alpha', 'r1', 1, 'pending'); const terminal = r.terminals[0];
  r.socket.close(); for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); const count = r.sent.length; terminal.flush();
  assert.deepEqual(r.sent.slice(count), []);
  const sessions = fixture(); sessions[0].runtime.seq = 1; sessions[0].runtime.outputSeq = 1; r.snapshot(sessions);
  assert.deepEqual(r.command('ack'), { type: 'ack', sessionId: 'alpha', runId: 'r1', seq: 1 });
});

test('gap consumed before reconnect snapshot is resumed only after the same run is confirmed', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open();
  const sessions = fixture(); sessions[0].runtime.seq = 6; sessions[0].runtime.outputSeq = 4; r.snapshot(sessions);
  const terminal = r.terminals[0]; r.socket.close();
  for (const [id, fn] of [...r.timers]) { r.timers.delete(id); fn(); }
  r.socket.open(); const count = r.sent.length; terminal.flush();
  assert.deepEqual(r.sent.slice(count), []);
  r.snapshot(sessions);
  assert.deepEqual(r.command('resume-output'), { type: 'resume-output', sessionId: 'alpha', runId: 'r1', seq: 4 });
});

test('real xterm CSI 6n reply from an in-flight old run is never sent to the replacement run', async t => {
  const r = createRenderer({ realParser: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; t.after(() => r.terminals.forEach(term => term.dispose()));
  output(r, 'alpha', 'r1', 1, 'old screen\x1b[6n');
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'starting', seq: 1 });
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'running', seq: 2 });
  await new Promise(resolve => terminal.write('', resolve));
  assert.deepEqual(r.sent.filter(m => m.type === 'input'), []);
  assert.match(terminal.buffer.active.getLine(0).translateToString(), /old screen/);
  terminal.input('new user input', true);
  assert.deepEqual(r.command('input'), { type: 'input', sessionId: 'alpha', runId: 'new-run', data: 'new user input' });
  output(r, 'alpha', 'new-run', 3, '\x1b[6n');
  await new Promise(resolve => terminal.write('', resolve));
  assert.match(r.command('input').data, /^\x1b\[\d+;\d+R$/);
  assert.equal(r.command('input').runId, 'new-run');
  assert.equal(r.terminals[0], terminal);
});

test('callbacks from a disposed terminal cannot send into a later instance with the same session and run ids', () => {
  const r = createRenderer({ delayedWrites: true }); r.socket.open(); r.snapshot(); const old = r.terminals[0];
  output(r, 'alpha', 'r1', 1, 'old pending'); r.snapshot([], null, 'workspace'); r.snapshot(fixture(), 'alpha', 'workspace');
  const count = r.sent.length; old.data('old input'); old.resize({ cols: 100, rows: 40 }); old.flush();
  assert.deepEqual(r.sent.slice(count), []);
});

async function waitForAck(renderer, runId, seq) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (renderer.sent.some(message => message.type === 'ack' && message.runId === runId && message.seq === seq)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`renderer did not finish ${runId}/${seq}`);
}
function normalBufferText(terminal) {
  const buffer = terminal.buffer.normal;
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true)).join('\n');
}
function conptyStartup(rows) {
  return '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H' + '\r\n'.repeat(rows) + '\x1b[H\x1b]0;fixture\x07\x1b[?25hFIXTURE_READY';
}

test('real xterm restart archives every old viewport row and divider before ConPTY clear-screen startup', async t => {
  for (const rows of [7, 24]) {
    const r = createRenderer({ realParser: true }); r.socket.open(); r.snapshot();
    const terminal = r.terminals[0]; t.after(() => r.terminals.forEach(term => term.dispose())); terminal.resize(80, rows);
    const lines = Array.from({ length: 100 }, (_, index) => `SCROLL_${String(index).padStart(4, '0')}`);
    output(r, 'alpha', 'r1', 1, lines.join('\r\n')); await waitForAck(r, 'r1', 1);
    r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'r1', status: 'stopped', seq: 2 });
    r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'starting', seq: 1 });
    r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'running', seq: 2 });
    output(r, 'alpha', 'new-run', 3, conptyStartup(rows)); await waitForAck(r, 'new-run', 3);
    const text = normalBufferText(terminal);
    for (const line of lines) assert.ok(text.includes(line), `${line} lost at ${rows} rows`);
    assert.match(text, /新一轮会话/); assert.match(text, /FIXTURE_READY/);
    const buffer = terminal.buffer.normal;
    const scrollback = Array.from({ length: buffer.baseY }, (_, index) => buffer.getLine(index).translateToString(true)).join('\n');
    assert.match(scrollback, /SCROLL_0099/); assert.match(scrollback, /新一轮会话/);
    assert.equal(r.terminals[0], terminal);
  }
});

test('restart drains already received old-run writes before archiving without replying or ACKing the old run', async t => {
  const r = createRenderer({ realParser: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; t.after(() => r.terminals.forEach(term => term.dispose()));
  output(r, 'alpha', 'r1', 1, 'IN_FLIGHT\x1b[6n');
  output(r, 'alpha', 'r1', 2, '\r\nQUEUED_OLD_TAIL\x1b[6n');
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'starting', seq: 1 });
  r.socket.receive({ type: 'status', sessionId: 'alpha', runId: 'new-run', status: 'running', seq: 2 });
  output(r, 'alpha', 'new-run', 3, conptyStartup(terminal.rows)); await waitForAck(r, 'new-run', 3);
  const text = normalBufferText(terminal);
  assert.match(text, /QUEUED_OLD_TAIL/); assert.match(text, /IN_FLIGHT/);
  // New-run DECSET 1004 reports focus; neither old CSI 6n may produce a cursor reply.
  assert.deepEqual(r.sent.filter(m => m.type === 'input'), [
    { type: 'input', sessionId: 'alpha', runId: 'new-run', data: '\x1b[O' }
  ]);
  assert.equal(r.sent.some(m => m.type === 'ack' && m.runId === 'r1'), false);
  assert.ok(text.indexOf('QUEUED_OLD_TAIL') < text.indexOf('新一轮会话'));
});

test('background alternate screen keeps its final visible text as an explicitly labelled snapshot on restart', async t => {
  const r = createRenderer({ realParser: true }); r.socket.open(); r.snapshot();
  output(r, 'beta', 'r2', 1, 'NORMAL_BEFORE_ALT'); await waitForAck(r, 'r2', 1);
  const terminal = r.terminals[1]; t.after(() => r.terminals.forEach(term => term.dispose())); terminal.resize(60, 7);
  const alt = '\x1b[?1049h' + Array.from({ length: 7 }, (_, index) => `\x1b[${index + 1};1HALT_ROW_${index}`).join('');
  output(r, 'beta', 'r2', 2, alt); await waitForAck(r, 'r2', 2); assert.equal(terminal.buffer.active.type, 'alternate');
  r.socket.receive({ type: 'status', sessionId: 'beta', runId: 'beta-new', status: 'starting', seq: 1 });
  r.socket.receive({ type: 'status', sessionId: 'beta', runId: 'beta-new', status: 'running', seq: 2 });
  output(r, 'beta', 'beta-new', 3, conptyStartup(7)); await waitForAck(r, 'beta-new', 3);
  const text = normalBufferText(terminal);
  for (let index = 0; index < 7; index++) assert.match(text, new RegExp(`ALT_ROW_${index}`));
  assert.match(text, /NORMAL_BEFORE_ALT/); assert.match(text, /备用屏幕.*末屏文字/); assert.match(text, /新一轮会话/);
  assert.equal(terminal.pane.hidden, true); assert.equal(terminal.fits, undefined);
});

test('first start of an idle terminal adds no artificial previous-run archive', async t => {
  const r = createRenderer({ realParser: true }); r.socket.open(); r.snapshot(fixture(), 'gamma');
  const terminal = r.terminals[0]; t.after(() => r.terminals.forEach(term => term.dispose()));
  r.socket.receive({ type: 'status', sessionId: 'gamma', runId: 'first', status: 'starting', seq: 1 });
  r.socket.receive({ type: 'status', sessionId: 'gamma', runId: 'first', status: 'running', seq: 2 });
  output(r, 'gamma', 'first', 3, conptyStartup(terminal.rows)); await waitForAck(r, 'first', 3);
  assert.doesNotMatch(normalBufferText(terminal), /新一轮会话|备用屏幕/);
});

test('successive restarts archive received runs in order while only the latest run can ACK or reply', async t => {
  const r = createRenderer({ realParser: true }); r.socket.open(); r.snapshot();
  const terminal = r.terminals[0]; t.after(() => r.terminals.forEach(term => term.dispose())); terminal.resize(80, 7);
  output(r, 'alpha', 'r1', 1, 'FIRST_RUN\x1b[6n');
  for (const [runId, label] of [['middle', 'MIDDLE_RUN'], ['latest', 'LATEST_RUN']]) {
    r.socket.receive({ type: 'status', sessionId: 'alpha', runId, status: 'starting', seq: 1 });
    r.socket.receive({ type: 'status', sessionId: 'alpha', runId, status: 'running', seq: 2 });
    output(r, 'alpha', runId, 3, conptyStartup(7).replace('FIXTURE_READY', label) + '\x1b[6n');
  }
  await waitForAck(r, 'latest', 3);
  const text = normalBufferText(terminal);
  assert.ok(text.indexOf('FIRST_RUN') >= 0 && text.indexOf('FIRST_RUN') < text.indexOf('MIDDLE_RUN'));
  assert.ok(text.indexOf('MIDDLE_RUN') < text.indexOf('LATEST_RUN'));
  assert.equal((text.match(/新一轮会话/g) || []).length, 2);
  assert.ok(r.sent.filter(message => message.type === 'ack' || message.type === 'input').every(message => message.runId === 'latest'));
  assert.equal(r.sent.filter(message => message.type === 'input' && /R$/.test(message.data)).length, 1);
});
