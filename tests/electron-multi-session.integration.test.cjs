const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createDesktopWorkspaceStore } = require('../app/desktop/desktop-workspace.cjs');
const { root, artifactDir, waitFor, delay, createFixture, launch, closeApp, cleanupFixture } = require('./multi-session-electron-helper.cjs');

const workspaceExpression = `window.__wire.filter(message => message.type === 'workspace' || message.type === 'snapshot').at(-1)`;
const termExpression = id => `window.__terms.find(terminal => terminal.__sessionId === ${JSON.stringify(id)})`;
const textExpression = id => `(() => { const t = ${termExpression(id)}; if (!t) return ''; const b = t.buffer.active; return Array.from({length:b.length}, (_,i) => b.getLine(i).translateToString(true)).join(String.fromCharCode(10)); })()`;

async function click(page, selector) {
  assert.equal(await page.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return false; element.click(); return true; })()`), true, `clickable ${selector}`);
}

async function createSession(page, cwd, name, agent = 'codex', launchOnOpen = false) {
  await click(page, '#new-session');
  assert.equal(await page.evaluate(`document.querySelector('#create-dialog').open && document.querySelector('#create-launch').checked`), true);
  // Directory-dialog native selection is verified separately; only this test's own form value is supplied here.
  await page.evaluate(`document.querySelector('#create-cwd').value=${JSON.stringify(cwd)}; document.querySelector('#create-name').value=${JSON.stringify(name)}; document.querySelector('#create-agent').value=${JSON.stringify(agent)}; document.querySelector('#create-launch').checked=${launchOnOpen}; true`);
  await click(page, '#create-submit');
  const workspace = await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.sessions.some(session => session.name === name), 'created session ' + name);
  const id = workspace.workspace.sessions.find(session => session.name === name).id;
  await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${id}"] .session-status')?.dataset.status`), value => value === 'running', 'running session ' + name);
  await waitFor(() => page.evaluate(textExpression(id)), value => value.includes('FIXTURE_READY'), 'native fixture ready ' + name);
  return id;
}

async function select(page, id) {
  await click(page, `[data-session-id="${id}"]`);
  await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${id}"]').getAttribute('aria-selected')`), value => value === 'true', 'selected ' + id);
}

async function input(page, id, text) {
  await page.evaluate(`${termExpression(id)}.focus(); true`);
  await page.send('Input.insertText', { text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

async function stop(page, id) {
  await select(page, id);
  await click(page, '#stop');
  assert.equal(await page.evaluate(`document.querySelector('#confirm-dialog').open`), true);
  await click(page, '#confirm-submit');
  await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${id}"] .session-status')?.dataset.status`), value => value === 'stopped', 'stopped ' + id);
}

function fixtureLogs(fixture) {
  return fs.readdirSync(fixture.logs).filter(name => name.endsWith('.log')).map(name => ({ pid: Number(name.split('.')[0]), text: fs.readFileSync(path.join(fixture.logs, name), 'utf8') }));
}

test('a packaged launch reports a missing CLI without blocking other sessions or installing the CLI', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const fixture = await createFixture();
  let app;
  t.after(async () => { await cleanupFixture(fixture, app); });

  fs.rmSync(path.join(fixture.bin, 'codex.exe'), { force: true });
  const store = createDesktopWorkspaceStore({ userDataPath: fixture.userData });
  store.save({
    schemaVersion: 2,
    projects: [{ id: 'missing-cli-project', rootPath: fixture.dirs[0], collapsed: false }],
    sessions: [
      { id: 'missing-codex', projectId: 'missing-cli-project', agent: 'codex', name: 'Missing Codex', launchOnOpen: true },
      { id: 'idle-antigravity', projectId: 'missing-cli-project', agent: 'agy', name: 'Antigravity remains idle', launchOnOpen: false }
    ],
    selectedSessionId: 'missing-codex'
  });

  app = await launch(fixture);
  const failure = await waitFor(() => app.page.evaluate(`(() => {
    const row = document.querySelector('[data-session-id="missing-codex"] .session-status');
    return row ? { status: row.dataset.status, notice: document.querySelector('#notice').textContent, noticeHidden: document.querySelector('#notice').hidden } : null;
  })()`), value => value?.status === 'failed' && value.notice.includes('Native codex.exe not found'), 'visible missing Codex error');
  assert.equal(failure.noticeHidden, false);
  assert.equal(await app.page.evaluate(`document.querySelector('[data-session-id="idle-antigravity"] .session-status').dataset.status`), 'idle');
  assert.equal(await app.page.evaluate(`document.querySelector('#connection').textContent`), '本地已连接');
  assert.equal(await app.page.evaluate(`document.querySelector('#directory').textContent`), fixture.dirs[0]);
  assert.equal(fs.existsSync(path.join(fixture.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')), false);
  assert.deepEqual(fs.readdirSync(fixture.bin), ['agy.exe']);

  const evidence = {
    fixture: 'packaged Electron + isolated userData/PATH/LOCALAPPDATA + controlled native fake CLI absent for Codex',
    missingCliStatus: failure,
    unrelatedSessionStatus: 'idle',
    agentDockConnected: true,
    codexInstalledByAgentDock: false
  };
  const artifacts = artifactDir;
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'missing-cli-packaged.json'), JSON.stringify(evidence, null, 2));
  await closeApp(app, fixture);
});

test('packaged launch migrates a legacy shared directory and preserves configured autostart flags', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fixture = await createFixture();
  let app;
  t.after(() => cleanupFixture(fixture, app));
  fs.copyFileSync(path.join(fixture.bin, 'codex.exe'), path.join(fixture.bin, 'claude.exe'));
  fs.writeFileSync(path.join(fixture.userData, 'workspace.json'), JSON.stringify({
    schemaVersion: 1,
    cwd: fixture.dirs[0],
    launchOnOpen: { codex: true, agy: false, claude: true }
  }));

  app = await launch(fixture);
  const { page } = app;
  const migrated = await waitFor(() => page.evaluate(workspaceExpression), value => value?.workspace?.schemaVersion === 2 && value.workspace.sessions.length === 3, 'legacy workspace migrated in the packaged UI');
  assert.equal(migrated.workspace.projects.length, 1);
  assert.equal(migrated.workspace.projects[0].rootPath, fixture.dirs[0]);
  assert.deepEqual(migrated.workspace.sessions.map(session => session.launchOnOpen), [true, false, true]);
  assert.equal(migrated.workspace.sessions.every(session => session.projectId === migrated.workspace.projects[0].id), true);
  await waitFor(() => page.evaluate("Array.from(document.querySelectorAll('.session-row')).find(row=>row.dataset.sessionId==='codex')?.querySelector('.session-status')?.dataset.status"), value => value === 'running', 'legacy Codex autostart');
  await waitFor(() => page.evaluate("Array.from(document.querySelectorAll('.session-row')).find(row=>row.dataset.sessionId==='claude')?.querySelector('.session-status')?.dataset.status"), value => value === 'running', 'legacy Claude Code autostart');
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('.session-row')).find(row=>row.dataset.sessionId==='agy')?.querySelector('.session-status')?.dataset.status"), 'idle');
  const logs = fixtureLogs(fixture);
  assert.equal(logs.length, 2);
  assert.equal(logs.every(log => log.text.includes('START ' + fixture.dirs[0])), true);

  await select(page, 'agy');
  await click(page, '#session-menu-toggle');
  await click(page, '#launch-on-open');
  await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.sessions.find(session => session.id === 'agy')?.launchOnOpen, 'persisted Antigravity autostart setting');
  const persisted = JSON.parse(fs.readFileSync(path.join(fixture.userData, 'workspace.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.sessions.map(session => session.launchOnOpen), [true, true, true]);
  await stop(page, 'codex');
  await stop(page, 'claude');
  await closeApp(app, fixture);
  app = null;

  fs.writeFileSync(path.join(artifactDir, 'schema1-migration-packaged-0.2.16.json'), JSON.stringify({
    target: fixture.targets.at(-1),
    legacySharedDirectoryPreserved: migrated.workspace.projects[0].rootPath === fixture.dirs[0],
    legacyAutostartPreserved: [true, false, true],
    schema2Persisted: persisted.schemaVersion === 2,
    fakeCliStarts: logs.length,
    realCliUsed: false
  }, null, 2));
});

test('topbar directory action creates and starts an independent native session while its original run remains active', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const fixture = await createFixture();
  let app;
  t.after(() => cleanupFixture(fixture, app));
  app = await launch(fixture);
  const { page } = app;
  const emptyDirectory = await page.evaluate(`(() => { const path=document.querySelector('#directory'), action=document.querySelector('#change-directory'); return {disabled:action.disabled, text:path.textContent, title:action.title}; })()`);
  assert.equal(emptyDirectory.disabled, true);
  assert.match(emptyDirectory.text, /请先选择或新建会话/);
  assert.match(emptyDirectory.title, /请先选择或新建会话/);
  const original = await createSession(page, fixture.dirs[0], 'Original activity');
  const originalRun = await page.evaluate(`window.__wire.filter(m=>m.type==='status'&&m.sessionId==='${original}'&&m.status==='running').at(-1).runId`);
  const originalPid = fixtureLogs(fixture).find(log => log.text.includes('START ' + fixture.dirs[0])).pid;
  await page.evaluate(`window.__blockReconnect=true; window.__sockets.at(-1).close(); true`);
  await waitFor(() => page.evaluate(`document.querySelector('.project-add').disabled`), Boolean, 'project add disabled while disconnected');
  const projectReason = await page.evaluate(`(() => { const button=document.querySelector('.project-add'), reason=document.getElementById(button.getAttribute('aria-describedby')); button.click(); return {title:button.title, text:reason?.textContent, visible:Boolean(reason&&!reason.hidden&&reason.getBoundingClientRect().height), opened:document.querySelector('#create-dialog').open}; })()`);
  assert.match(projectReason.title, /等待本地终端服务连接/);
  assert.match(projectReason.text, /等待本地终端服务连接/);
  assert.equal(projectReason.visible, true);
  assert.equal(projectReason.opened, false);
  await page.evaluate(`window.__blockReconnect=false; true`);
  await waitFor(() => page.evaluate(`document.querySelector('.project-add').disabled`), value => value === false, 'project add enabled after reconnect');
  await click(page, '.project-add');
  assert.equal(await page.evaluate(`document.querySelector('#create-cwd').value`), fixture.dirs[0]);
  await click(page, '#create-cancel');
  await click(page, '#new-session');
  assert.equal(await page.evaluate(`document.querySelector('#create-cwd').value`), '');
  assert.equal(await page.evaluate(`document.querySelector('#create-agent').value`), 'codex');
  assert.equal(await page.evaluate(`document.querySelector('#create-context').hidden`), true);
  assert.equal(await page.evaluate(`document.querySelector('#create-launch').checked`), true);
  assert.match(await page.evaluate(`document.querySelector('#create-launch').parentElement.textContent`), /打开 AgentDock 时启动此会话/);
  await page.evaluate(`window.__blockReconnect=true; window.__sockets.at(-1).close(); true`);
  await waitFor(() => page.evaluate(`document.querySelector('#create-submit').disabled`), Boolean, 'disconnected create disabled');
  const reason = await page.evaluate(`(() => { const button=document.querySelector('#create-submit'), description=document.getElementById(button.getAttribute('aria-describedby')); return {title:button.title, text:description?.textContent, visible:Boolean(description&&!description.hidden&&description.getBoundingClientRect().height)}; })()`);
  assert.match(reason.title, /等待本地终端服务连接/);
  assert.match(reason.text, /等待本地终端服务连接/);
  assert.equal(reason.visible, true, 'connection reason is visible inside the modal');
  await page.evaluate(`window.__blockReconnect=false; true`);
  await waitFor(() => page.evaluate(`document.querySelector('#create-submit').disabled`), value => value === false, 'create enabled after reconnect');
  // The native picker bridge is covered separately; only the isolated test directory is assigned.
  await page.evaluate(`document.querySelector('#create-cwd').value=${JSON.stringify(fixture.dirs[1])}; document.querySelector('#create-name').value='Other directory activity'; document.querySelector('#create-launch').checked=false; true`);
  await click(page, '#create-submit');
  const created = await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.sessions.some(session => session.name === 'Other directory activity'), 'different-directory session');
  const other = created.workspace.sessions.find(session => session.name === 'Other directory activity').id;
  await waitFor(() => page.evaluate(textExpression(other)), value => value.includes('FIXTURE_READY'), 'other-directory native CLI ready');
  await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${other}"]').getAttribute('aria-selected')`), value => value === 'true', 'new session selected');
  assert.equal(await page.evaluate(`document.querySelectorAll('.project-group').length`), 2);
  assert.equal(fixtureLogs(fixture).length, 2);
  assert.equal(await page.evaluate(`window.__sent.filter(m=>m.type==='create-session'&&m.name==='Other directory activity').length`), 1);
  assert.equal(await page.evaluate(`window.__sent.some(m=>['stop','remove-session'].includes(m.type)&&m.sessionId==='${original}')`), false);
  await select(page, original);
  assert.equal(await page.evaluate(`document.querySelector('#directory').title`), fixture.dirs[0]);
  assert.equal(await page.evaluate(`document.querySelector('[data-session-id="${original}"] .session-status').dataset.status`), 'running');
  assert.equal(await page.evaluate(`window.__wire.filter(m=>m.type==='status'&&m.sessionId==='${original}'&&m.status==='running').at(-1).runId`), originalRun);
  await input(page, original, 'PING ORIGINAL_STILL_ACTIVE');
  await waitFor(() => page.evaluate(textExpression(original)), value => value.includes('PONG ORIGINAL_STILL_ACTIVE'), 'original run remains responsive');
  assert.ok(fixtureLogs(fixture).find(log => log.pid === originalPid).text.includes('INPUT PING ORIGINAL_STILL_ACTIVE'));
  await select(page, other);
  assert.equal(await page.evaluate(`document.querySelector('#directory').title`), fixture.dirs[1]);
  await input(page, other, 'PING OTHER_DIRECTORY_ACTIVE');
  await waitFor(() => page.evaluate(textExpression(other)), value => value.includes('PONG OTHER_DIRECTORY_ACTIVE'), 'new run responds in other directory');
  assert.ok(fixtureLogs(fixture).some(log => log.pid !== originalPid && log.text.includes('START ' + fixture.dirs[1]) && log.text.includes('INPUT PING OTHER_DIRECTORY_ACTIVE')));
  await stop(page, original); await stop(page, other);
  await closeApp(app, fixture);
});

test('packaged session directory change moves only the stopped session and preserves its sibling run', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const fixture = await createFixture();
  let app;
  t.after(() => cleanupFixture(fixture, app));
  app = await launch(fixture);
  const { page } = app;
  const moved = await createSession(page, fixture.dirs[0], 'Move this session');
  const sibling = await createSession(page, fixture.dirs[0], 'Keep this session');

  await select(page, moved);
  await click(page, '#session-menu-toggle');
  const runningAction = await page.evaluate(`(() => { const action=document.querySelector('#change-session-directory'); return {disabled:action.disabled,title:action.title}; })()`);
  assert.equal(runningAction.disabled, true);
  assert.match(runningAction.title, /先停止此会话/);
  await click(page, '#session-menu-toggle');
  await stop(page, moved);

  await click(page, '#session-menu-toggle');
  assert.equal(await page.evaluate(`document.querySelector('#change-session-directory').disabled`), false);
  await page.evaluate(`window.__sockets.at(-1).send(JSON.stringify({type:'change-session-directory',requestId:'packaged-move',sessionId:${JSON.stringify(moved)},cwd:${JSON.stringify(fixture.dirs[1])}})); true`);
  const movedWorkspace = await waitFor(() => page.evaluate(workspaceExpression), value => value.sessions.find(session => session.sessionId === moved)?.cwd === fixture.dirs[1], 'moved session directory');
  assert.equal(movedWorkspace.workspace.projects.length, 2);
  assert.equal(await page.evaluate(`document.querySelector('[data-session-id="${moved}"] .session-status').dataset.status`), 'stopped');
  assert.equal(await page.evaluate(`document.querySelector('[data-session-id="${sibling}"] .session-status').dataset.status`), 'running');

  await select(page, sibling);
  await input(page, sibling, 'PING SIBLING_STILL_ACTIVE');
  await waitFor(() => page.evaluate(textExpression(sibling)), value => value.includes('PONG SIBLING_STILL_ACTIVE'), 'sibling remains responsive');
  await select(page, moved);
  await click(page, '#start');
  await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${moved}"] .session-status').dataset.status`), value => value === 'running', 'moved session restarted');
  await waitFor(() => fixtureLogs(fixture), logs => logs.some(log => log.text.includes('START ' + fixture.dirs[1])), 'moved session native cwd');
  assert.equal(await page.evaluate(`document.querySelector('#directory').title`), fixture.dirs[1]);
  await stop(page, moved); await stop(page, sibling);
  await closeApp(app, fixture);
});

test('real Electron multi-session shell isolates native CLI runs, preserves workspace, copies selection, and resumes a disconnected burst', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  const fixture = await createFixture();
  let app;
  const evidence = { fixture: 'C# console EXE, native ConPTY, production Electron/service/xterm', checks: [] };
  const artifacts = artifactDir;
  fs.mkdirSync(artifacts, { recursive: true });
  t.after(async () => {
    evidence.targets = fixture.targets;
    evidence.electronOutput = app?.output.join('') || '';
    evidence.closeDiagnostic = app?.closeDiagnostic;
    evidence.fixtureLogs = fixtureLogs(fixture);
    if (app?.child.exitCode === null) {
      evidence.lastState = await app.page.evaluate(`({connection:document.querySelector('#connection').textContent,notice:document.querySelector('#notice').textContent,snapshots:window.__wire.filter(m=>m.type==='snapshot').map(m=>({sessions:m.sessions.map(s=>({sessionId:s.sessionId,runtime:s.runtime}))})),recentSent:window.__sent.slice(-8).map(m=>({type:m.type,sessionId:m.sessionId,runId:m.runId,seq:m.seq})),socketCount:window.__sockets.length})`).catch(error => ({ inspectionError: error.message }));
      evidence.clipboardProbe = await app.page.evaluate(`({events:window.__clipboardProbe||[],secureContext:isSecureContext,focus:document.hasFocus(),selectionLength:window.__terms?.find(t=>t.hasSelection())?.getSelection().length||0,writePermission:navigator.permissions?.query?undefined:'unsupported'})`).catch(error => ({ inspectionError: error.message }));
      evidence.clipboardProbePermission = await app.page.evaluate(`navigator.permissions?.query?navigator.permissions.query({name:'clipboard-write'}).then(p=>p.state).catch(e=>'error:'+e.name):'unsupported'`).catch(error => 'error:' + error.message);
      await app.main.evaluate(`(async () => { if (!globalThis.__clipboardBackup) return false; const c=__electronTest.clipboard; if (!['AGENTDOCK_COPY_SELECTION_732984','AGENTDOCK_CLIPBOARD_API_PROBE'].includes(await c.readText())) return false; if(globalThis.__clipboardBackup.length) await c.write(globalThis.__clipboardBackup); else c.clear(); delete globalThis.__clipboardBackup; return true; })()`).catch(() => {});
    }
    try { await cleanupFixture(fixture, app); }
    finally { fs.writeFileSync(path.join(artifacts, 'integration-evidence.json'), JSON.stringify(evidence, null, 2)); }
  });
  app = await launch(fixture);
  fs.writeFileSync(path.join(fixture.dirs[0], 'keep-project-file.txt'), 'owned integration project data');
  const { page, main } = app;
  assert.equal(await page.evaluate(`document.querySelector('#empty-state').hidden`), false);
  await click(page, '#empty-create');
  assert.equal(await page.evaluate(`document.querySelector('#choose-directory').disabled`), false);
  await click(page, '#create-cancel');
  assert.equal(await page.evaluate(`(${workspaceExpression}).workspace.sessions.length`), 0);
  assert.equal(fs.existsSync(path.join(fixture.userData, 'workspace.json')), false, 'cancel does not create a configuration');
  evidence.checks.push('empty workspace and create cancellation; native directory bridge is available');

  const first = await createSession(page, fixture.dirs[0], 'Codex development');
  evidence.viewport = await page.evaluate(`(() => {
    const pane=document.querySelector('[data-terminal-session="${first}"]');
    const read=element=>element?({background:getComputedStyle(element).backgroundColor,overflowY:getComputedStyle(element).overflowY,clientWidth:element.clientWidth,rect:element.getBoundingClientRect().toJSON()}):null;
    return {windowWidth:innerWidth,area:read(document.querySelector('.terminal-area')),legacy:read(pane.querySelector('.xterm-viewport')),scrollable:read(pane.querySelector('.xterm-scrollable-element')),verticalScrollbar:read(pane.querySelector('.scrollbar.vertical'))};
  })()`);
  const viewportScreenshot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(artifacts, 'integration-first-terminal-viewport.png'), Buffer.from(viewportScreenshot.data, 'base64'));
  evidence.viewport.bottomPixel = await main.evaluate(`(() => { const image=__electronTest.nativeImage.createFromBuffer(Buffer.from(${JSON.stringify(viewportScreenshot.data)},'base64')); const size=image.getSize(), pixels=image.toBitmap(), ratio=size.width/${evidence.viewport.windowWidth}, x=Math.floor(${evidence.viewport.legacy.rect.x + evidence.viewport.legacy.rect.width / 2}*ratio), y=Math.floor(${evidence.viewport.legacy.rect.bottom - 2}*ratio), offset=(y*size.width+x)*4; return {x,y,rgb:[pixels[offset+2],pixels[offset+1],pixels[offset]],size}; })()`);
  assert.equal(evidence.viewport.legacy.background, evidence.viewport.area.background, 'legacy xterm viewport background must match terminal theme');
  if (evidence.viewport.scrollable && evidence.viewport.verticalScrollbar) {
    assert.ok(Math.abs(evidence.viewport.legacy.clientWidth - evidence.viewport.legacy.rect.width) < 1, 'legacy viewport must not reserve a second native scrollbar beside the xterm 6 scrollbar');
  }
  assert.equal(`rgb(${evidence.viewport.bottomPixel.rgb.join(', ')})`, evidence.viewport.area.background, 'terminal screenshot bottom background must match the theme');
  evidence.checks.push('real xterm legacy viewport shares theme background, reserves no duplicate scrollbar, and screenshot bottom pixel matches terminal theme');
  const second = await createSession(page, fixture.dirs[1], 'Codex review');
  const third = await createSession(page, fixture.dirs[0], 'Antigravity check', 'agy');
  assert.equal(await page.evaluate(`document.querySelectorAll('.project-group').length`), 2);
  assert.equal(await page.evaluate(`document.querySelector('#shared-warning').hidden`), false);
  const firstText = await page.evaluate(textExpression(first));
  const secondText = await page.evaluate(textExpression(second));
  assert.ok(firstText.replace(/\s/g, '').includes(fixture.dirs[0].replace(/\s/g, '')));
  assert.ok(secondText.replace(/\s/g, '').includes(fixture.dirs[1].replace(/\s/g, '')));
  assert.ok(!firstText.replace(/\s/g, '').includes(fixture.dirs[1].replace(/\s/g, '')));
  assert.ok(fixtureLogs(fixture).some(log => log.text.includes('START ' + fixture.dirs[0])));
  assert.ok(fixtureLogs(fixture).some(log => log.text.includes('START ' + fixture.dirs[1])));
  assert.equal(fixtureLogs(fixture).length, 3);
  evidence.checks.push('two Codex sessions and Antigravity execute in two independent Unicode/space directories, correctly grouped and warned');

  await select(page, second);
  assert.equal(await page.evaluate(`document.querySelector('#shared-warning').hidden`), true);
  await click(page, '#session-menu-toggle'); await click(page, '#rename-session');
  await page.evaluate(`document.querySelector('#rename-name').value='Review renamed'; true`);
  await click(page, '#rename-submit');
  await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.sessions.find(session => session.id === second)?.name === 'Review renamed', 'persisted rename');
  await click(page, '#session-menu-toggle'); await click(page, '#launch-on-open');
  await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.sessions.find(session => session.id === second)?.launchOnOpen, 'launch-on-open true');
  await click(page, '#new-other-directory');
  assert.equal(await page.evaluate(`document.querySelector('#create-cwd').value`), '');
  assert.equal(await page.evaluate(`document.querySelector('#create-agent').value`), 'codex');
  await click(page, '#create-cancel');

  const workspace = await page.evaluate(workspaceExpression);
  const firstProject = workspace.workspace.sessions.find(session => session.id === first).projectId;
  await click(page, `[data-collapse-project="${firstProject}"]`);
  await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.projects.find(project => project.id === firstProject).collapsed, 'collapsed project');
  await click(page, `[data-collapse-project="${firstProject}"]`);
  await waitFor(() => page.evaluate(workspaceExpression), value => !value.workspace.projects.find(project => project.id === firstProject).collapsed, 'expanded project');
  evidence.checks.push('rename, autostart flag, other-directory entry, and project collapse/expand persist through acknowledged workspace commands');

  await select(page, first);
  await page.evaluate(`${termExpression(first)}.focus(); true`);
  await page.send('Input.insertText', { text: 'PING DRAFT_' });
  await select(page, second);
  await input(page, second, 'PING SECOND_ONLY');
  await waitFor(() => page.evaluate(textExpression(second)), value => value.includes('PONG SECOND_ONLY'), 'second session response');
  await select(page, first);
  await input(page, first, 'PRESERVED');
  await waitFor(() => page.evaluate(textExpression(first)), value => value.includes('PONG DRAFT_PRESERVED'), 'CLI input draft survives session switch');
  await input(page, first, 'PING ISOLATED_FIRST');
  await waitFor(() => page.evaluate(textExpression(first)), value => value.includes('PONG ISOLATED_FIRST'), 'first response');
  await input(page, first, 'LINES 100');
  await waitFor(() => page.evaluate(textExpression(first)), value => value.includes('SCROLL_0099'), 'scrollback fixture');
  await input(page, first, 'DELAY first');
  await page.evaluate(`${termExpression(first)}.scrollToTop(); true`);
  const scrollPosition = await page.evaluate(`${termExpression(first)}.buffer.active.viewportY`);
  await select(page, second);
  await page.evaluate(`document.querySelector('#search').focus(); true`);
  await waitFor(() => page.evaluate(`document.querySelector('[data-unread-for="${first}"]').hidden`), value => value === false, 'background unread');
  assert.equal(await page.evaluate(`document.activeElement.id`), 'search', 'background output must not steal focus');
  assert.ok(!(await page.evaluate(textExpression(second))).includes('ISOLATED_FIRST'));
  await select(page, first);
  assert.equal(await page.evaluate(`${termExpression(first)}.buffer.active.viewportY`), scrollPosition, 'switching preserves scroll position');
  assert.equal(await page.evaluate(`document.querySelector('[data-unread-for="${first}"]').hidden`), true);
  await click(page, '#latest');
  evidence.checks.push('real terminal output isolation; background unread without focus theft; scrollback and terminal object retained on switching');

  const originalRun = await page.evaluate(`window.__wire.filter(m=>m.type==='status'&&m.sessionId==='${first}'&&m.status==='running').at(-1).runId`);
  const beforeRestartScreen = await page.evaluate(textExpression(first));
  await stop(page, first);
  await click(page, '#start');
  await waitFor(() => page.evaluate(`window.__wire.filter(m=>m.type==='status'&&m.sessionId==='${first}'&&m.status==='running').at(-1)?.runId`), value => value && value !== originalRun, 'new run after stop');
  await waitFor(() => page.evaluate(textExpression(first)), value => (value.match(/FIXTURE_READY/g) || []).length === 2, 'new native run banner retaining earlier buffer');
  evidence.restart = await page.evaluate(`({separatorVisible: (${textExpression(first)}).includes('新一轮会话'), retainedOldResponse: (${textExpression(first)}).includes('PONG ISOLATED_FIRST'), terminalInstances: window.__terms.filter(t=>t.__sessionId==='${first}').length, nativeOutput:window.__wire.filter(m=>m.type==='output'&&m.sessionId==='${first}'&&m.runId!==${JSON.stringify(originalRun)}).map(m=>m.prefix).slice(0,5)})`);
  evidence.restart.beforeScreen = beforeRestartScreen;
  evidence.restart.afterScreen = await page.evaluate(textExpression(first));
  assert.equal(evidence.restart.retainedOldResponse, true);
  assert.equal(evidence.restart.terminalInstances, 1);
  const runCount = fixtureLogs(fixture).length;
  await input(page, first, 'PING NEW_RUN');
  await waitFor(() => page.evaluate(textExpression(first)), value => value.includes('PONG NEW_RUN'), 'new-run response');
  await stop(page, first);
  await stop(page, third);
  await click(page, '#start-all');
  await waitFor(() => page.evaluate(`[...document.querySelectorAll('.session-status')].map(e=>e.dataset.status)`), value => value.length === 3 && value.every(status => status === 'running'), 'start all');
  await waitFor(() => fixtureLogs(fixture).length, value => value === runCount + 2, 'start-all starts only idle/stopped sessions');
  evidence.checks.push('quick stop/restart gets fresh runId; same real terminal, old tail, and run separator remain in scrollback despite native repaint; start-all leaves already-running session untouched');

  await select(page, first);
  await main.evaluate(`(async () => { const c=__electronTest.clipboard; const originals=await c.read(); const backup=[]; for(const item of originals){const entries={}; for(const type of item.types) entries[type]=await item.getType(type); if(item.types.length) backup.push(new __electronTest.ClipboardItem(entries));} globalThis.__clipboardBackup=backup; return true; })()`);
  await input(page, first, 'PING AGENTDOCK_COPY_SELECTION_732984');
  await waitFor(() => page.evaluate(textExpression(first)), value => value.includes('PONG AGENTDOCK_COPY_SELECTION_732984'), 'copy fixture');
  await page.evaluate(`(() => { const t=${termExpression(first)}, b=t.buffer.active; for(let y=0;y<b.length;y++){const line=b.getLine(y).translateToString(true), x=line.indexOf('AGENTDOCK_COPY_SELECTION_732984'); if(x>=0){t.select(x,y,'AGENTDOCK_COPY_SELECTION_732984'.length);t.focus();return true;}} throw new Error('copy marker missing');})()`);
  assert.equal(await page.evaluate(`${termExpression(first)}.getSelection()`), 'AGENTDOCK_COPY_SELECTION_732984');
  const clipboardApiProbe = await page.evaluate(`Promise.race([navigator.clipboard.writeText('AGENTDOCK_CLIPBOARD_API_PROBE').then(()=> 'resolved',error=>'rejected:'+error.name),new Promise(resolve=>setTimeout(()=>resolve('timeout'),1200))])`);
  await delay(100);
  const clipboardApiProbeOwned = await main.evaluate(`(async()=>await __electronTest.clipboard.readText()==='AGENTDOCK_CLIPBOARD_API_PROBE')()`);
  const clipboardApiProbeRestored = clipboardApiProbeOwned && await main.evaluate(`(async()=>{const c=__electronTest.clipboard;if(globalThis.__clipboardBackup.length)await c.write(globalThis.__clipboardBackup);else c.clear();return true})()`);
  evidence.clipboardApiProbe = { result: clipboardApiProbe, wroteMarker: clipboardApiProbeOwned, restored: clipboardApiProbeRestored };
  await page.evaluate(`(() => { window.__clipboardProbe=[]; document.addEventListener('copy',e=>window.__clipboardProbe.push({type:'copy',prevented:e.defaultPrevented,hasMarker:e.clipboardData?.getData('text/plain')==='AGENTDOCK_COPY_SELECTION_732984'}),true); document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='c')window.__clipboardProbe.push({type:'keydown',prevented:e.defaultPrevented,target:e.target?.tagName});},true); })()`);
  const etxBefore = fixtureLogs(fixture).reduce((total, log) => total + (log.text.match(/ETX received/g) || []).length, 0);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await waitFor(() => main.evaluate(`(async()=>await __electronTest.clipboard.readText() === 'AGENTDOCK_COPY_SELECTION_732984')()`), Boolean, 'OS clipboard contains real xterm selection');
  await delay(200);
  assert.equal(fixtureLogs(fixture).reduce((total, log) => total + (log.text.match(/ETX received/g) || []).length, 0), etxBefore);
  await page.evaluate(`${termExpression(first)}.clearSelection(); ${termExpression(first)}.focus(); true`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await waitFor(() => fixtureLogs(fixture).reduce((total, log) => total + (log.text.match(/ETX received/g) || []).length, 0), value => value === etxBefore + 1, 'unselected Ctrl+C sends ETX');
  evidence.clipboardRestored = await main.evaluate(`(async () => {const c=__electronTest.clipboard; if(await c.readText()!=='AGENTDOCK_COPY_SELECTION_732984')return false;if(globalThis.__clipboardBackup.length) await c.write(globalThis.__clipboardBackup); else c.clear();delete globalThis.__clipboardBackup;return true;})()`);
  evidence.checks.push('real xterm selection + Ctrl+C writes OS clipboard and sends no ETX; unselected Ctrl+C reaches native CLI as ETX; original clipboard restored only while still test-owned');

  const beforeBurstRuns = fixtureLogs(fixture).length;
  const burstRun = await page.evaluate(`window.__wire.filter(m=>m.type==='status'&&m.sessionId==='${first}'&&m.status==='running').at(-1).runId`);
  await input(page, first, 'BURST');
  await page.evaluate(`window.__blockReconnect=true; window.__sockets.at(-1).close(); true`);
  await waitFor(() => fixtureLogs(fixture).some(log => log.text.includes('BURST_BEGIN')), Boolean, 'native burst started while disconnected');
  await delay(1200);
  assert.equal(fixtureLogs(fixture).some(log => log.text.includes('BURST_DONE')), false, 'large disconnected burst blocks behind bounded PTY output');
  const sentBeforeReconnect = await page.evaluate(`window.__sent.length`);
  await page.evaluate(`window.__blockReconnect=false; true`);
  await waitFor(() => page.evaluate(`window.__sent.slice(${sentBeforeReconnect}).filter(m=>m.type==='resume-output'&&m.sessionId==='${first}')`), value => value.length > 0, 'explicit output skip checkpoint', 16000);
  await waitFor(() => page.evaluate(textExpression(first)), value => value.includes('FIXTURE_BURST_DONE'), 'same run resumes and draws remaining real output', 20000);
  const burstEvidence = await page.evaluate(`({ resume: window.__sent.slice(${sentBeforeReconnect}).filter(m=>m.type==='resume-output'&&m.sessionId==='${first}'), rerunOrInput: window.__sent.slice(${sentBeforeReconnect}).filter(m=>m.type==='start'||m.type==='input'), bytes: window.__wire.filter(m=>m.type==='output'&&m.sessionId==='${first}'&&m.runId===${JSON.stringify(burstRun)}).reduce((n,m)=>n+m.bytes,0), snapshot: window.__wire.filter(m=>m.type==='snapshot').at(-1).sessions.find(s=>s.sessionId==='${first}').runtime, notice: document.querySelector('#notice').textContent })`);
  assert.equal(burstEvidence.snapshot.runId, burstRun);
  assert.equal(burstEvidence.rerunOrInput.length, 0);
  assert.equal(fixtureLogs(fixture).length, beforeBurstRuns);
  assert.ok(burstEvidence.bytes > 262144);
  assert.ok(burstEvidence.resume.some(message => message.testGapVisible), 'missing-output marker is in the real xterm buffer before skip acknowledgement (later burst may evict 5000-line scrollback)');
  evidence.burst = burstEvidence;
  evidence.checks.push('>2 MiB native output blocks while WS disconnected, explicit checkpoint unblocks same run, visible gap, no CLI input replay or process restart');

  for (const [width, height, scale] of [[960, 640, 1], [1280, 820, 1.25], [1280, 820, 1.5], [1440, 904, 1]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await delay(150);
    const layout = await page.evaluate(`({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,pixelRatio:devicePixelRatio,term:document.querySelector('[data-terminal-session="${first}"]').getBoundingClientRect().toJSON(),header:document.querySelector('.toolbar').getBoundingClientRect().toJSON()})`);
    assert.ok(layout.scrollWidth <= layout.width, `horizontal overflow at ${width}x${height} DPR ${scale}`);
    assert.equal(layout.pixelRatio, scale);
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifacts, `integration-${width}x${height}-dpr${scale}.png`), Buffer.from(screenshot.data, 'base64'));
    (evidence.layouts ||= []).push(layout);
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  evidence.checks.push('960x640 and 1440x904 CSS viewports plus 125% / 150% device-scale layouts have no document horizontal overflow; screenshot artifacts saved');

  await select(page, third);
  await click(page, '#session-menu-toggle'); await click(page, '#remove-session');
  await click(page, '#confirm-cancel');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-session-id]').length`), 3);
  await click(page, '#session-menu-toggle'); await click(page, '#remove-session');
  await click(page, '#confirm-submit');
  await waitFor(() => page.evaluate(`document.querySelectorAll('[data-session-id]').length`), value => value === 2, 'removed running third session');
  assert.equal(fs.existsSync(fixture.dirs[0]), true);
  assert.equal(fs.readFileSync(path.join(fixture.dirs[0], 'keep-project-file.txt'), 'utf8'), 'owned integration project data');
  await stop(page, first); await stop(page, second);
  await select(page, second);
  await click(page, `[data-collapse-project="${firstProject}"]`);
  await waitFor(() => page.evaluate(workspaceExpression), value => value.workspace.projects.find(project => project.id === firstProject).collapsed, 'persist final collapsed state');
  const persisted = JSON.parse(fs.readFileSync(path.join(fixture.userData, 'workspace.json'), 'utf8'));
  assert.equal(persisted.selectedSessionId, second);
  assert.equal(persisted.sessions.find(session => session.id === second).name, 'Review renamed');
  assert.equal(persisted.sessions.find(session => session.id === second).launchOnOpen, true);
  await closeApp(app, fixture);
  app = await launch(fixture);
  await waitFor(() => app.page.evaluate(`document.querySelector('[data-session-id="${second}"] .session-status')?.dataset.status`), value => value === 'running', 'saved autostart session after relaunch');
  assert.equal(await app.page.evaluate(`document.querySelector('[data-session-id="${first}"] .session-status').dataset.status`), 'idle');
  assert.equal(await app.page.evaluate(`document.querySelector('[data-session-id="${second}"]').getAttribute('aria-selected')`), 'true');
  assert.equal(await app.page.evaluate(`document.querySelector('[data-collapse-project="${firstProject}"]').getAttribute('aria-expanded')`), 'false');
  await stop(app.page, second);
  evidence.checks.push('running remove cancellation and confirmed removal keep project files; clean relaunch restores selected session, renamed title, fold state, and autostarts only enabled session');
  await closeApp(app, fixture);
  assert.equal(evidence.restart.separatorVisible, true, 'native restart must preserve a visible run separator');
  assert.ok(evidence.restart.afterScreen.includes('SCROLL_0099'), 'native restart must preserve the previous visible tail in scrollback');
});
