(() => {
  const $ = id => document.getElementById(id);
  const states = new Map();
  const pendingCommands = new Map();
  const labels = { idle: '未启动', starting: '正在启动', running: '运行中', stopping: '正在停止', stopped: '已停止', failed: '启动失败' };
  const agents = { codex: 'Codex', agy: 'Antigravity', claude: 'Claude Code' };
  let workspace = { projects: [], sessions: [], selectedSessionId: null };
  let activeSessionId = null;
  let socket, ready = false, hadSnapshot = false, reconnectDelay = 700;
  let connectionNotice = '正在连接本地终端服务…', workspaceError = '';
  let createBusy = false, pickerBusy = false, directoryChangeBusy = false, renameBusy = false, confirmBusy = false, launchBusy = false;
  let renameTarget = null, confirmation = null;

  function connected() { return ready && socket?.readyState === WebSocket.OPEN; }
  function current() { return states.get(activeSessionId); }
  function active(state) { return ['starting', 'running', 'stopping'].includes(state?.runtimeStatus); }
  function setError(id, text) { $(id).textContent = text; $(id).hidden = !text; }
  function send(message, state) {
    if (!connected()) return false;
    if (state && (states.get(state.sessionId) !== state || message.runId !== state.runId)) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function command(type, fields) {
    if (!connected()) return Promise.reject(new Error('连接已断开，请等待重新连接。'));
    const requestId = crypto.randomUUID();
    workspaceError = '';
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(requestId);
        reject(new Error('操作结果未确认，请先检查会话列表再重试。'));
        refresh();
      }, 20000);
      pendingCommands.set(requestId, { resolve, reject, timer });
      send({ type, requestId, ...fields });
    });
    refresh();
    return result;
  }
  function reportError(error) {
    workspaceError = error instanceof Error ? error.message : String(error);
    refresh();
  }
  function refresh() {
    const state = current();
    $('connection').textContent = connected() ? '本地已连接' : '连接中';
    $('agent-label').textContent = state?.agent || '工作区';
    $('session-name').textContent = state?.name || '';
    $('directory').textContent = state?.cwd || '请先选择或新建会话';
    $('directory').title = state ? `${state.cwd}` : '请先选择或新建会话后查看工作目录';
    $('change-directory').disabled = !connected() || !state || createBusy || pickerBusy;
    $('change-directory').title = !connected() ? '等待本地终端服务连接后才能新建会话' : !state ? '请先选择或新建会话' : createBusy ? '正在创建并启动会话，请稍候' : pickerBusy ? '正在选择目录，请稍候' : `为当前 ${state.agent} 选择另一个目录并新建会话；当前会话继续在原目录运行`;
    $('status').textContent = state ? labels[state.runtimeStatus] || '未启动' : '';
    $('start').disabled = !connected() || !state || active(state) || Boolean(state.directoryError);
    $('start').title = !connected() ? '等待本地终端服务连接' : !state ? '请先选择或新建会话' : state.directoryError || (active(state) ? '此会话已经启动' : '启动当前会话');
    $('stop').disabled = !connected() || !state || !['starting', 'running'].includes(state.runtimeStatus);
    $('stop').title = !connected() ? '等待本地终端服务连接' : state?.runtimeStatus === 'stopping' ? '正在停止此会话，请稍候' : '停止当前会话（需要确认）';
    $('start').hidden = Boolean(state && active(state));
    $('stop').hidden = !state || !active(state);
    $('session-menu-toggle').disabled = !connected() || !state;
    $('session-menu-toggle').title = !connected() ? '等待本地终端服务连接' : !state ? '请先选择或新建会话' : '会话操作';
    $('change-session-directory').disabled = !connected() || !state || active(state) || directoryChangeBusy || !window.agentDock?.selectWorkingDirectory;
    $('change-session-directory').title = !connected() ? '等待本地终端服务连接' : !state ? '请先选择或新建会话' : active(state) ? '请先停止此会话，再更改工作目录；运行中的其他会话不受影响' : directoryChangeBusy ? '正在更改此会话目录，请稍候' : !window.agentDock?.selectWorkingDirectory ? '请在 AgentDock 桌面应用中选择目录' : '只更改当前会话；其他会话的目录不变';
    for (const id of ['new-session', 'empty-create', 'start-all']) {
      $(id).disabled = !connected() || (id === 'start-all' && !states.size);
      $(id).title = !connected() ? '等待本地终端服务连接' : id === 'start-all' && !states.size ? '没有可启动的会话，请先新建会话' : '';
    }
    setError('project-create-disabled-reason', !connected() && workspace.projects.length ? '等待本地终端服务连接后才能在项目中新建会话。' : '');
    for (const add of document.querySelectorAll('.project-add')) {
      add.disabled = !connected();
      add.title = connected() ? `在 ${add.dataset.directory} 新建会话` : '等待本地终端服务连接后才能新建会话';
    }
    $('launch-on-open').checked = state?.launchOnOpen === true;
    $('launch-on-open').disabled = !connected() || !state || launchBusy;
    $('launch-on-open').title = !connected() ? '等待本地终端服务连接' : !state ? '请先选择或新建会话' : launchBusy ? '正在保存启动设置，请稍候' : '';
    $('shared-warning').hidden = !state || [...states.values()].filter(s => s.projectId === state.projectId).length < 2;
    $('remove-session').textContent = active(state) ? '停止并移除会话…' : '移除会话…';
    $('empty-state').hidden = states.size > 0;
    const showSessionEmpty = Boolean(state && !active(state) && !state.error && !state.directoryError && !terminalHasContent(state));
    $('session-empty-state').hidden = !showSessionEmpty;
    $('session-empty-start').disabled = !connected() || !state || active(state) || Boolean(state.directoryError);
    $('session-empty-start').title = !connected() ? '等待本地终端服务连接' : !state ? '请先选择或新建会话' : state.directoryError || (active(state) ? '此会话已经启动' : '启动当前会话');
    $('workspace-count').textContent = `${workspace.projects.length} 个项目 · ${states.size} 个会话`;
    $('save-status').textContent = workspaceError ? '保存失败 / 未确认' : pendingCommands.size ? '正在保存…' : hadSnapshot ? '设置已同步' : '尚未连接';
    $('save-status').setAttribute('data-error', String(Boolean(workspaceError)));
    $('save-status').title = workspaceError;
    const notice = connectionNotice || workspaceError || state?.directoryError || state?.error || state?.screenNotice || '';
    setError('notice', notice);
    const createReason = !connected() ? '等待本地终端服务连接后才能创建并启动会话。' : createBusy ? '正在创建并启动会话，请稍候。' : pickerBusy ? '正在选择目录，请完成或取消目录选择。' : '';
    const renameReason = !connected() ? '等待本地终端服务连接后才能保存名称。' : renameBusy ? '正在保存名称，请稍候。' : '';
    const confirmReason = !connected() ? '等待本地终端服务连接后才能确认操作。' : confirmBusy ? '正在处理此操作，请稍候。' : '';
    for (const [prefix, reason] of [['create', createReason], ['rename', renameReason], ['confirm', confirmReason]]) {
      $(prefix + '-submit').disabled = Boolean(reason);
      $(prefix + '-submit').title = reason;
      setError(prefix + '-disabled-reason', reason);
    }
    $('create-cancel').disabled = createBusy;
    $('create-cancel').title = createBusy ? '正在创建并启动会话，请稍候' : '';
    $('choose-directory').disabled = createBusy || pickerBusy || !window.agentDock?.selectWorkingDirectory;
    $('choose-directory').title = createBusy ? '正在创建并启动会话，请稍候' : pickerBusy ? '正在选择目录，请完成或取消目录选择' : !window.agentDock?.selectWorkingDirectory ? '请在 AgentDock 桌面应用中选择目录' : '';
    $('create-agent').disabled = createBusy; $('create-name').disabled = createBusy; $('create-launch').disabled = createBusy;
    $('rename-cancel').disabled = renameBusy; $('rename-cancel').title = renameBusy ? '正在保存名称，请稍候' : '';
    $('confirm-cancel').disabled = confirmBusy; $('confirm-cancel').title = confirmBusy ? '正在处理此操作，请稍候' : '';
    for (const s of states.values()) refreshRow(s);
    updateLatest();
  }
  function refreshRow(state) {
    if (!state.row) return;
    state.row.classList.toggle('active', state.sessionId === activeSessionId);
    state.row.setAttribute('aria-selected', String(state.sessionId === activeSessionId));
    state.row.setAttribute('aria-label', `${state.agent}，${state.name}，${labels[state.runtimeStatus]}${state.unread ? '，有新输出' : ''}`);
    state.statusLabel.textContent = labels[state.runtimeStatus] || '未启动';
    state.statusLabel.setAttribute('data-status', state.runtimeStatus);
    state.unreadLabel.hidden = !state.unread;
  }
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function renderTree() {
    const host = $('project-tree');
    host.replaceChildren();
    const query = $('search').value.trim().toLocaleLowerCase();
    const basenames = workspace.projects.map(p => p.rootPath.split(/[\\/]/).filter(Boolean).at(-1) || p.rootPath);
    let shown = 0;
    for (const state of states.values()) state.row = null;
    for (const [index, project] of workspace.projects.entries()) {
      const name = basenames[index];
      const sessions = [...states.values()].filter(s => s.projectId === project.id);
      const projectMatches = `${name} ${project.rootPath}`.toLocaleLowerCase().includes(query);
      const matches = sessions.filter(s => projectMatches || `${s.name} ${s.agent}`.toLocaleLowerCase().includes(query));
      if (query && !matches.length) continue;
      shown++;
      const group = element('section', 'project-group'); group.setAttribute('data-project-id', project.id);
      const header = element('div', 'project-header');
      const toggle = element('button', 'project-toggle'); toggle.type = 'button'; toggle.title = project.rootPath;
      toggle.setAttribute('data-collapse-project', project.id); toggle.setAttribute('aria-expanded', String(query ? true : !project.collapsed));
      toggle.append(element('span', 'project-chevron', project.collapsed && !query ? '›' : '⌄'), element('span', 'folder-icon'));
      const title = element('span', 'project-label'); title.append(element('span', 'project-name', name));
      if (basenames.filter(n => n === name).length > 1) title.append(element('span', 'project-path', project.rootPath));
      toggle.append(title, element('span', 'project-count', String(sessions.length)));
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try { await command('set-project-collapsed', { projectId: project.id, collapsed: !project.collapsed }); }
        catch (error) { reportError(error); }
        finally { toggle.disabled = false; }
      });
      const add = element('button', 'project-add', '+'); add.type = 'button'; add.disabled = !connected();
      add.dataset.directory = project.rootPath;
      add.title = connected() ? `在 ${project.rootPath} 新建会话` : '等待本地终端服务连接后才能新建会话';
      add.setAttribute('aria-describedby', 'project-create-disabled-reason');
      add.setAttribute('aria-label', `在 ${name} 新建会话`); add.addEventListener('click', () => openCreate(project.rootPath));
      header.append(toggle, add); group.append(header);
      const children = element('div', 'project-sessions'); children.hidden = project.collapsed && !query;
      for (const state of matches) {
        const row = element('button', 'session-row'); row.type = 'button'; row.setAttribute('data-session-id', state.sessionId);
        row.setAttribute('role', 'tab'); row.title = `${state.name}\n${state.cwd}`;
        const icon = element('span', `agent-icon ${state.agentId}`); icon.setAttribute('aria-hidden', 'true');
        const copy = element('span', 'session-copy'); const first = element('span', 'session-first-line');
        const status = element('span', 'session-status');
        first.append(element('span', 'session-agent', state.agent), status);
        copy.append(first, element('span', 'session-subtitle', state.name));
        const unread = element('span', 'unread'); unread.setAttribute('data-unread-for', state.sessionId); unread.title = '有新输出';
        row.append(icon, copy, unread);
        state.row = row; state.statusLabel = status; state.unreadLabel = unread;
        row.addEventListener('click', async () => {
          if (activeSessionId === state.sessionId) { focusTerminal(state); return; }
          row.disabled = true;
          try { await command('select-session', { sessionId: state.sessionId }); if (current() === state) focusTerminal(state); }
          catch (error) { reportError(error); }
          finally { row.disabled = false; }
        });
        children.append(row); refreshRow(state);
      }
      children.setAttribute('role', 'tablist'); children.setAttribute('aria-label', name);
      group.append(children); host.append(group);
    }
    if (!shown) host.append(element('p', 'tree-empty', query ? '没有匹配的项目或会话' : '尚无会话。点击 + 选择目录并开始。'));
  }
  function ensureTerminal(state) {
    if (state.terminal) return;
    state.terminal = new Terminal({ cursorBlink: true, allowProposedApi: false, fontFamily: 'Cascadia Mono, Consolas, Microsoft YaHei UI, monospace',
      fontSize: window.innerWidth <= 1100 ? 18 : 24, lineHeight: 1.1, scrollback: 5000,
      theme: { background: '#1d1d2d', foreground: '#e9eaf3', cursor: '#c4dcff', selectionBackground: '#41465f' } });
    state.fitAddon = new FitAddon.FitAddon(); state.terminal.loadAddon(state.fitAddon); state.terminal.open(state.pane);
    state.terminal.attachCustomKeyEventHandler(event => {
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c' && state.terminal.hasSelection()) {
        // Returning false leaves xterm's native copy handling intact and prevents ETX from reaching the CLI.
        return false;
      }
      return true;
    });
    state.terminal.onData(data => {
      // onData also includes parser-generated replies; an old write must never answer a new run.
      if (state.writingOutput && state.writingRunId !== state.runId) return;
      if (state.runId && state.runtimeStatus === 'running') send({ type: 'input', sessionId: state.sessionId, runId: state.runId, data }, state);
    });
    state.terminal.onResize(({ cols, rows }) => {
      if (state.sessionId === activeSessionId && !state.pane.hidden && state.runtimeStatus === 'running') send({ type: 'resize', sessionId: state.sessionId, runId: state.runId, columns: cols, rows }, state);
    });
    state.terminal.onScroll(() => { if (state === current()) updateLatest(); });
  }
  function resizeTerminal() {
    const state = current();
    if (!state || state.pane.hidden) return;
    const bounds = state.pane.getBoundingClientRect();
    if (bounds.width < 10 || bounds.height < 10) return;
    ensureTerminal(state);
    const size = window.innerWidth <= 1100 ? 18 : 24;
    if (state.terminal.options.fontSize !== size) state.terminal.options.fontSize = size;
    state.fitAddon.fit();
    if (state.runId && state.runtimeStatus === 'running') send({ type: 'resize', sessionId: state.sessionId, runId: state.runId, columns: state.terminal.cols, rows: state.terminal.rows }, state);
  }
  function updateLatest() {
    const buffer = current()?.terminal?.buffer.active;
    $('latest').hidden = !buffer || buffer.viewportY >= buffer.baseY;
  }
  function terminalHasContent(state) {
    const buffer = state.terminal?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== 'function') return false;
    for (let row = 0; row < buffer.length; row++) {
      if (buffer.getLine(row)?.translateToString(true).trim()) return true;
    }
    return false;
  }
  function focusTerminal(state) {
    if (!state || $('create-dialog').open || $('rename-dialog').open || $('confirm-dialog').open) return;
    ensureTerminal(state); state.terminal.focus();
  }
  function adoptRun(state, runId) {
    if (state.runId === runId) return;
    state.runId = runId; state.receivedSeq = 0; state.seenSeq = 0; state.ackedSeq = 0; state.gapSeq = 0; state.resumedSeq = 0;
    state.pendingOutput = state.pendingOutput.filter(message => !message.gap); state.screenNotice = '';
    if (state.terminal && state.writingOutput) state.terminal.options.disableStdin = state.writingRunId !== runId;
  }
  function flushOutput(state) {
    if (state.writingOutput || !state.pendingOutput.length || states.get(state.sessionId) !== state) return;
    const message = state.pendingOutput.shift();
    if (message.gap && message.runId !== state.runId) { flushOutput(state); return; }
    ensureTerminal(state);
    state.writingOutput = true;
    state.writingRunId = message.runId;
    const finish = () => {
      state.writingOutput = false;
      state.writingRunId = null;
      if (states.get(state.sessionId) !== state) return;
      state.terminal.options.disableStdin = false;
      if (message.runId === state.runId) {
        if (message.gap) {
          state.resumedSeq = message.seq;
          send({ type: 'resume-output', sessionId: state.sessionId, runId: message.runId, seq: message.seq }, state);
        } else {
          state.ackedSeq = message.seq;
          send({ type: 'ack', sessionId: state.sessionId, runId: message.runId, seq: message.seq }, state);
        }
      }
      flushOutput(state); updateLatest();
    };
    const writeMessage = () => {
      if (states.get(state.sessionId) !== state) return;
      state.lastWrittenRunId = message.runId;
      state.terminal.options.disableStdin = message.runId !== state.runId;
      state.terminal.write(message.data, finish);
    };
    if (state.lastWrittenRunId && state.lastWrittenRunId !== message.runId) {
      const terminal = state.terminal, buffer = terminal.buffer.active;
      let alternateSnapshot = '';
      if (buffer.type === 'alternate') {
        alternateSnapshot = '──── 上一轮备用屏幕末屏文字（无历史与样式） ────\r\n';
        for (let row = 0; row < terminal.rows; row++) alternateSnapshot += (buffer.getLine(buffer.baseY + row)?.translateToString(true) || '') + '\r\n';
      }
      // Archive the old viewport before the new process can clear/repaint it. CAN ends any unfinished old ANSI sequence.
      const archive = `\x18\x1b[0m\x1b[?1049l\x1b[r\x1b[?6l\x1b[?7h\x1b[${terminal.rows};1H\r\n`
        + alternateSnapshot + '──── 新一轮会话 ────' + '\r\n'.repeat(terminal.rows) + '\x1b[H';
      terminal.options.disableStdin = true;
      terminal.write(archive, writeMessage);
    } else writeMessage();
  }
  function applyWorkspace(message) {
    const reconnect = message.type === 'snapshot' && hadSnapshot;
    ready = false;
    workspace = message.workspace;
    const ids = new Set(message.sessions.map(s => s.sessionId));
    for (const [id, state] of states) {
      if (!ids.has(id)) { state.terminal?.dispose(); state.pane.remove(); states.delete(id); }
    }
    for (const session of message.sessions) {
      let state = states.get(session.sessionId);
      if (!state) {
        const pane = element('section', 'terminal-panel'); pane.hidden = true; pane.setAttribute('aria-label', `${session.agent} 终端`);
        pane.setAttribute('data-terminal-session', session.sessionId); $('terminals').append(pane);
        state = { sessionId: session.sessionId, pane, terminal: null, runId: null, receivedSeq: 0, seenSeq: 0, ackedSeq: 0, gapSeq: 0, resumedSeq: 0, unread: false, pendingOutput: [], writingOutput: false, screenNotice: '' };
        states.set(state.sessionId, state);
      }
      const previousRun = state.runId;
      adoptRun(state, session.runtime.runId);
      Object.assign(state, { projectId: session.projectId, agent: session.agent, agentId: session.agentId, name: session.name, cwd: session.cwd,
        launchOnOpen: session.launchOnOpen, directoryError: session.directoryError, runtimeStatus: session.runtime.status, error: session.runtime.error });
      if (message.type === 'snapshot' && session.runtime.seq > state.seenSeq) {
        state.screenNotice = reconnect && previousRun === state.runId && state.terminal
          ? '已保留当前页面的终端画面；断连期间的输出可能缺失，未自动重发任何输入。'
          : '当前页面没有此会话此前的显示缓冲，无法恢复旧画面；后续输出会继续显示。';
      } else if (reconnect && previousRun === state.runId && state.terminal && !state.screenNotice) {
        state.screenNotice = '已重新连接，当前页面的终端画面已保留，未自动重发任何输入。';
      }
      // A snapshot reports production, not consumption. Only re-ACK completed writes.
      state.seenSeq = Math.max(state.seenSeq, session.runtime.seq);
      if (message.type === 'snapshot' && Number.isSafeInteger(session.runtime.outputSeq)) {
        if (session.runtime.outputSeq > Math.max(state.receivedSeq, state.gapSeq)) {
          state.gapSeq = session.runtime.outputSeq;
          state.pendingOutput.push({ gap: true, runId: state.runId, seq: state.gapSeq, data: '\r\n\x1b[0m──── 此处部分输出缺失，后续输出继续 ────\r\n' });
          state.screenNotice = state.terminal
            ? '当前页面已显示的画面保留；断连期间部分输出缺失，已标明缺失位置，后续输出会继续。'
            : '当前页面没有旧显示缓冲，无法恢复旧画面；已标明缺失位置，后续输出会继续。';
        }
      }
    }
    activeSessionId = states.has(workspace.selectedSessionId) ? workspace.selectedSessionId : states.keys().next().value ?? null;
    for (const state of states.values()) { state.pane.hidden = state.sessionId !== activeSessionId; if (!state.pane.hidden) state.unread = false; }
    hadSnapshot = true; ready = true; connectionNotice = '';
    if (reconnect) {
      for (const session of message.sessions) {
        const state = states.get(session.sessionId);
        if (state.ackedSeq) send({ type: 'ack', sessionId: state.sessionId, runId: state.runId, seq: state.ackedSeq }, state);
        if (state.resumedSeq && Number.isSafeInteger(session.runtime.outputSeq)) send({ type: 'resume-output', sessionId: state.sessionId, runId: state.runId, seq: state.resumedSeq }, state);
      }
    }
    renderTree(); refresh(); resizeTerminal();
    for (const state of states.values()) flushOutput(state);
  }
  function handleMessage(message) {
    if (message.type === 'command-result') {
      const pending = pendingCommands.get(message.requestId); if (!pending) return;
      clearTimeout(pending.timer); pendingCommands.delete(message.requestId);
      message.ok ? pending.resolve(message) : pending.reject(new Error(message.message || '无法保存设置。'));
      refresh(); return;
    }
    if (message.type === 'snapshot' || message.type === 'workspace') { applyWorkspace(message); return; }
    if (message.type === 'workspace-error') { reportError(new Error(message.message || '无法保存设置。')); return; }
    const state = states.get(message.sessionId); if (!state) return;
    if (message.type === 'status') {
      if (message.status === 'starting' && message.runId !== state.runId) adoptRun(state, message.runId);
      if (message.runId !== state.runId) return;
      if (Number.isSafeInteger(message.seq)) state.seenSeq = Math.max(state.seenSeq, message.seq);
      state.runtimeStatus = message.status; state.error = message.error || null;
      refresh(); if (state === current() && message.status === 'running') resizeTerminal(); return;
    }
    if (message.runId !== state.runId) return;
    if (Number.isSafeInteger(message.seq)) state.seenSeq = Math.max(state.seenSeq, message.seq);
    if (message.type === 'output' && Number.isSafeInteger(message.seq) && message.seq > state.receivedSeq) {
      state.receivedSeq = message.seq; state.pendingOutput.push(message);
      if (state !== current()) state.unread = true;
      refreshRow(state); flushOutput(state);
    }
    if (message.type === 'exit') { state.runtimeStatus = 'stopped'; refresh(); }
  }
  function openCreate(cwd = '', agent = 'codex', otherDirectory = false) {
    if (!connected() || createBusy) return;
    closeMenu(); $('create-cwd').value = cwd; $('create-cwd').title = cwd;
    $('create-agent').value = agent; $('create-name').value = ''; $('create-launch').checked = true; setError('create-error', '');
    $('create-title').textContent = otherDirectory ? '在其他目录新建会话' : '新建会话';
    $('create-context').textContent = otherDirectory ? '这会新建当前工具的独立会话；当前会话继续在原目录运行。' : '';
    $('create-context').hidden = !otherDirectory;
    $('create-dialog').showModal(); refresh();
  }
  async function createInOtherDirectory() {
    const state = current();
    if (!connected() || !state || createBusy || pickerBusy || !window.agentDock?.selectWorkingDirectory) return;
    closeMenu(); pickerBusy = true; refresh();
    try {
      const cwd = await window.agentDock.selectWorkingDirectory();
      if (cwd) openCreate(cwd, state.agentId, true);
    } catch (error) { setError('notice', error.message || String(error)); }
    finally { pickerBusy = false; refresh(); }
  }
  function closeMenu() { $('session-menu').hidden = true; $('session-menu-toggle').setAttribute('aria-expanded', 'false'); }
  function askConfirmation(type) {
    const state = current(); if (!state || !connected()) return;
    closeMenu(); confirmation = { type, sessionId: state.sessionId, runId: state.runId };
    const removal = type === 'remove-session';
    $('confirm-title').textContent = removal ? '移除会话' : '停止会话';
    $('confirm-message').textContent = removal
      ? `移除“${state.name}”（${state.agent}）？\n${active(state) ? '将先停止此会话的 CLI，停止成功后再移除。' : ''}项目文件不会删除。\n${state.cwd}`
      : `停止“${state.name}”（${state.agent}）？\n此会话正在执行的 CLI 任务会结束。\n${state.cwd}`;
    $('confirm-submit').textContent = removal ? active(state) ? '停止并移除' : '移除会话' : '停止会话';
    setError('confirm-error', ''); $('confirm-dialog').showModal(); refresh();
  }

  $('search').addEventListener('input', renderTree);
  $('new-session').addEventListener('click', () => openCreate());
  $('empty-create').addEventListener('click', () => openCreate());
  $('change-directory').addEventListener('click', createInOtherDirectory);
  $('new-other-directory').addEventListener('click', () => openCreate('', current()?.agentId, true));
  $('create-cancel').addEventListener('click', () => { if (!createBusy) $('create-dialog').close(); });
  $('create-dialog').addEventListener('cancel', event => { if (createBusy) event.preventDefault(); });
  $('choose-directory').addEventListener('click', async () => {
    if (pickerBusy || createBusy || !window.agentDock?.selectWorkingDirectory) return;
    pickerBusy = true; refresh();
    try {
      const cwd = await window.agentDock.selectWorkingDirectory();
      if (cwd && $('create-dialog').open) { $('create-cwd').value = cwd; $('create-cwd').title = cwd; setError('create-error', ''); }
    } catch (error) { setError('create-error', error.message || String(error)); }
    finally { pickerBusy = false; refresh(); }
  });
  $('create-form').addEventListener('submit', async event => {
    event.preventDefault(); if (createBusy || pickerBusy) return;
    const cwd = $('create-cwd').value;
    if (!cwd) { setError('create-error', '请选择一个真实工作目录。'); return; }
    createBusy = true; setError('create-error', ''); refresh();
    try {
      const result = await command('create-session', { agent: $('create-agent').value, cwd, name: $('create-name').value.trim() || agents[$('create-agent').value], launchOnOpen: $('create-launch').checked, start: true });
      $('create-dialog').close();
      $('search').value = ''; renderTree();
      const created = states.get(result.sessionId);
      const project = workspace.projects.find(p => p.id === created?.projectId);
      if (project?.collapsed) await command('set-project-collapsed', { projectId: project.id, collapsed: false });
      if (created === current()) focusTerminal(created);
    } catch (error) { setError('create-error', error.message); reportError(error); }
    finally { createBusy = false; refresh(); }
  });
  function startCurrentSession() { const state = current(); if (connected() && state && !active(state) && !state.directoryError) send({ type: 'start', sessionId: state.sessionId }); }
  $('start').addEventListener('click', startCurrentSession);
  $('session-empty-start').addEventListener('click', startCurrentSession);
  $('start-all').addEventListener('click', () => { if (connected()) send({ type: 'start-all' }); });
  $('stop').addEventListener('click', () => askConfirmation('stop'));
  $('remove-session').addEventListener('click', () => askConfirmation('remove-session'));
  $('confirm-cancel').addEventListener('click', () => { if (!confirmBusy) $('confirm-dialog').close(); });
  $('confirm-dialog').addEventListener('cancel', event => { if (confirmBusy) event.preventDefault(); });
  $('confirm-submit').addEventListener('click', async () => {
    if (!confirmation || confirmBusy || !connected()) return;
    const action = confirmation, state = states.get(action.sessionId);
    if (!state || state.runId !== action.runId) { setError('confirm-error', '会话已发生变化，请关闭确认框后重试。'); return; }
    confirmBusy = true; refresh();
    try {
      if (action.type === 'stop') send({ type: 'stop', sessionId: action.sessionId, runId: action.runId });
      else await command('remove-session', { sessionId: action.sessionId, runId: action.runId });
      $('confirm-dialog').close();
    } catch (error) { setError('confirm-error', error.message); reportError(error); }
    finally { confirmBusy = false; refresh(); }
  });
  $('rename-session').addEventListener('click', () => {
    const state = current(); if (!state) return;
    closeMenu(); renameTarget = state.sessionId; $('rename-name').value = state.name; setError('rename-error', ''); $('rename-dialog').showModal();
  });
  $('rename-cancel').addEventListener('click', () => { if (!renameBusy) $('rename-dialog').close(); });
  $('rename-dialog').addEventListener('cancel', event => { if (renameBusy) event.preventDefault(); });
  $('rename-form').addEventListener('submit', async event => {
    event.preventDefault(); if (renameBusy) return;
    const name = $('rename-name').value.trim(); if (!name) { setError('rename-error', '请输入会话名称。'); return; }
    renameBusy = true; refresh();
    try { await command('rename-session', { sessionId: renameTarget, name }); $('rename-dialog').close(); }
    catch (error) { setError('rename-error', error.message); reportError(error); }
    finally { renameBusy = false; refresh(); }
  });
  $('launch-on-open').addEventListener('change', async () => {
    const state = current(); if (!state || launchBusy) return;
    const enabled = $('launch-on-open').checked;
    launchBusy = true;
    try { await command('launch-on-open', { sessionId: state.sessionId, enabled }); }
    catch (error) { reportError(error); }
    finally { launchBusy = false; refresh(); }
  });
  $('change-session-directory').addEventListener('click', async () => {
    const state = current();
    if (!connected() || !state || active(state) || directoryChangeBusy || !window.agentDock?.selectWorkingDirectory) return;
    closeMenu(); directoryChangeBusy = true; refresh();
    try {
      const cwd = await window.agentDock.selectWorkingDirectory();
      if (cwd) await command('change-session-directory', { sessionId: state.sessionId, cwd });
    } catch (error) { reportError(error); }
    finally { directoryChangeBusy = false; refresh(); }
  });
  async function copyDirectory() {
    if (!current()) return;
    try { await navigator.clipboard.writeText(current().cwd); closeMenu(); }
    catch (error) { reportError(new Error(`无法复制目录：${error.message}`)); }
  }
  $('copy-directory').addEventListener('click', copyDirectory);
  $('session-menu-toggle').addEventListener('click', () => { $('session-menu').hidden = !$('session-menu').hidden; $('session-menu-toggle').setAttribute('aria-expanded', String(!$('session-menu').hidden)); });
  document.addEventListener('click', event => { if (!$('session-menu').contains(event.target) && !$('session-menu-toggle').contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  $('latest').addEventListener('click', () => { current()?.terminal?.scrollToBottom(); updateLatest(); });
  window.addEventListener('resize', resizeTerminal); new ResizeObserver(resizeTerminal).observe($('terminals'));
  function connect() {
    socket = new WebSocket(`ws://${location.host}/terminal`);
    socket.addEventListener('open', () => { reconnectDelay = 700; refresh(); });
    socket.addEventListener('message', event => {
      try { handleMessage(JSON.parse(event.data)); }
      catch (error) { connectionNotice = `无法处理终端事件：${error.message}`; refresh(); }
    });
    socket.addEventListener('close', () => {
      ready = false; connectionNotice = '与本地终端服务的连接已断开，正在重连；当前画面保留，输入不会自动重发。';
      for (const pending of pendingCommands.values()) { clearTimeout(pending.timer); pending.reject(new Error('连接中断，操作结果未确认；请先检查会话列表再重试。')); }
      pendingCommands.clear(); closeMenu(); refresh();
      setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    socket.addEventListener('error', () => { connectionNotice = '暂时无法连接本地终端服务，正在等待重连。'; refresh(); });
  }
  renderTree(); refresh(); connect();
})();
