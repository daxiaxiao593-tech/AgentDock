(() => {
  const statusElement = document.getElementById('status');
  const agentLabelElement = document.getElementById('agent-label');
  const directoryElement = document.getElementById('directory');
  const startButton = document.getElementById('start');
  const stopButton = document.getElementById('stop');
  const noticeElement = document.getElementById('notice');
  const terminalHost = document.getElementById('terminals');
  const tabButtons = [...document.querySelectorAll('[data-session-id]')];
  const sessionStates = new Map();
  const tabStatusLabels = {
    idle: '未启动', starting: '正在启动', running: '运行中',
    stopping: '正在停止', stopped: '已停止', failed: '启动失败'
  };

  for (const tab of tabButtons) {
    const sessionId = tab.dataset.sessionId;
    sessionStates.set(sessionId, {
      sessionId,
      agent: tab.querySelector('span').textContent,
      cwd: '',
      runtimeStatus: 'idle',
      runId: null,
      lastOutputSeq: 0,
      pendingOutput: [],
      writingOutput: false,
      clearBeforeNextRunOutput: false,
      screenUnavailable: false,
      error: null,
      terminal: null,
      fitAddon: null,
      pane: document.getElementById(`terminal-${sessionId}`),
      statusLabel: document.querySelector(`[data-status-for="${sessionId}"]`),
      tab
    });
  }

  let socket;
  let activeSessionId = 'codex';
  let connectionNotice = '';

  function showNotice(text) {
    noticeElement.textContent = text;
    noticeElement.hidden = !text;
  }

  function refreshNotice() {
    const state = sessionStates.get(activeSessionId);
    const notice = connectionNotice || state?.error || (state?.screenUnavailable
      ? '此 CLI 已在后台运行，但当前终端画面无法恢复；可以继续输入或停止该会话。'
      : '');
    showNotice(notice);
  }

  function updateDirectory() {
    const state = sessionStates.get(activeSessionId);
    directoryElement.textContent = state?.cwd || '';
    directoryElement.title = state?.cwd || '';
    agentLabelElement.textContent = state?.agent || '';
  }

  function updateControls() {
    const state = sessionStates.get(activeSessionId);
    const connected = socket && socket.readyState === WebSocket.OPEN && Boolean(state);
    const active = state && ['starting', 'running', 'stopping'].includes(state.runtimeStatus);
    startButton.disabled = !connected || active;
    stopButton.disabled = !connected || !state || !['running', 'stopping'].includes(state.runtimeStatus);
    startButton.textContent = `启动 ${state?.agent || ''}`;
    const globalStatus = {
      idle: '未启动', starting: '正在启动', running: '运行中',
      stopping: '正在停止', stopped: '已停止', failed: '启动失败', disconnected: '已断开'
    };
    statusElement.textContent = globalStatus[state?.runtimeStatus] || '连接中';
    for (const current of sessionStates.values()) {
      current.statusLabel.textContent = tabStatusLabels[current.runtimeStatus] || '未启动';
      current.tab.setAttribute('aria-label', `${current.agent}，${tabStatusLabels[current.runtimeStatus] || '未启动'}`);
    }
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function ensureTerminal(state) {
    if (state.terminal) return;
    state.terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, Microsoft YaHei UI, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#12151d', foreground: '#d6ddeb', cursor: '#91b4ff' }
    });
    state.fitAddon = new FitAddon.FitAddon();
    state.terminal.loadAddon(state.fitAddon);
    state.terminal.open(state.pane);
    state.terminal.onData(data => {
      if (state.runId && state.runtimeStatus === 'running') {
        send({ type: 'input', sessionId: state.sessionId, runId: state.runId, data });
      }
    });
    state.terminal.onResize(({ cols, rows }) => {
      if (state.runId && state.runtimeStatus === 'running') {
        send({ type: 'resize', sessionId: state.sessionId, runId: state.runId, columns: cols, rows });
      }
    });
  }

  function resizeTerminal(sessionId) {
    const state = sessionStates.get(sessionId);
    if (!state) return;
    ensureTerminal(state);
    state.fitAddon.fit();
    if (state.runId && state.runtimeStatus === 'running') {
      send({ type: 'resize', sessionId, runId: state.runId, columns: state.terminal.cols, rows: state.terminal.rows });
    }
  }

  function flushOutput(state) {
    if (state.writingOutput || state.pendingOutput.length === 0) return;
    const message = state.pendingOutput.shift();
    if (message.runId !== state.runId) {
      flushOutput(state);
      return;
    }
    ensureTerminal(state);
    if (state.clearBeforeNextRunOutput) {
      state.terminal.reset();
      state.clearBeforeNextRunOutput = false;
    }
    state.writingOutput = true;
    state.terminal.write(message.data, () => {
      state.writingOutput = false;
      if (message.runId === state.runId) {
        send({ type: 'ack', sessionId: state.sessionId, runId: message.runId, seq: message.seq });
      }
      flushOutput(state);
    });
  }

  function activateSession(sessionId, focus = false) {
    const state = sessionStates.get(sessionId);
    if (!state) return;
    activeSessionId = sessionId;
    for (const current of sessionStates.values()) {
      const active = current.sessionId === sessionId;
      current.tab.classList.toggle('active', active);
      current.tab.setAttribute('aria-selected', String(active));
      current.pane.hidden = !active;
      current.pane.classList.toggle('active', active);
    }
    updateDirectory();
    updateControls();
    refreshNotice();
    resizeTerminal(sessionId);
    if (focus) state.terminal.focus();
  }

  function handleMessage(message) {
    if (message.type === 'snapshot') {
      for (const session of message.sessions) {
        const state = sessionStates.get(session.sessionId);
        if (!state) continue;
        state.agent = session.agent;
        state.cwd = session.cwd;
        state.runtimeStatus = session.runtime.status;
        state.runId = session.runtime.runId;
        state.lastOutputSeq = session.runtime.seq;
        state.error = session.runtime.error;
        state.screenUnavailable = state.runtimeStatus === 'running';
      }
      activateSession(activeSessionId);
      return;
    }

    const state = sessionStates.get(message.sessionId);
    if (!state) return;
    if (message.type === 'status') {
      if (message.status === 'starting' && message.runId !== state.runId) {
        state.runId = message.runId;
        state.lastOutputSeq = 0;
        state.pendingOutput = [];
        state.clearBeforeNextRunOutput = true;
        state.screenUnavailable = false;
      }
      if (message.runId !== state.runId) return;
      state.runtimeStatus = message.status;
      state.error = message.error || null;
      if (message.status === 'running') state.screenUnavailable = false;
      if (message.status === 'running') resizeTerminal(state.sessionId);
      updateControls();
      refreshNotice();
      return;
    }
    if (message.runId !== state.runId) return;
    if (message.type === 'output' && Number.isSafeInteger(message.seq) && message.seq > state.lastOutputSeq) {
      state.lastOutputSeq = message.seq;
      state.pendingOutput.push(message);
      flushOutput(state);
    }
    if (message.type === 'exit') {
      state.runtimeStatus = 'stopped';
      updateControls();
      refreshNotice();
    }
  }

  for (const tab of tabButtons) {
    tab.addEventListener('click', () => activateSession(tab.dataset.sessionId, true));
  }
  startButton.addEventListener('click', () => send({ type: 'start', sessionId: activeSessionId }));
  stopButton.addEventListener('click', () => {
    const state = sessionStates.get(activeSessionId);
    if (state?.runId) send({ type: 'stop', sessionId: activeSessionId, runId: state.runId });
  });

  window.addEventListener('resize', () => resizeTerminal(activeSessionId));
  new ResizeObserver(() => resizeTerminal(activeSessionId)).observe(terminalHost);
  ensureTerminal(sessionStates.get(activeSessionId));
  resizeTerminal(activeSessionId);

  socket = new WebSocket(`ws://${location.host}/terminal`);
  socket.addEventListener('open', () => {
    connectionNotice = '';
    updateControls();
    refreshNotice();
  });
  socket.addEventListener('message', event => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch {
      connectionNotice = '收到无法识别的终端事件。';
      refreshNotice();
    }
  });
  socket.addEventListener('close', () => {
    for (const state of sessionStates.values()) state.runtimeStatus = 'disconnected';
    connectionNotice = '与本地终端服务的连接已断开。';
    updateControls();
    refreshNotice();
  });
  socket.addEventListener('error', () => {
    connectionNotice = '无法连接本地终端服务。';
    refreshNotice();
  });
})();
