const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, createFixture, launch, closeApp, cleanupFixture, waitFor } = require('./multi-session-electron-helper.cjs');

async function scenario(reconnect) {
  const fixture = await createFixture();
  let app;
  const result = { reconnect };
  try {
    app = await launch(fixture);
    result.pid = app.child.pid;
    result.target = fixture.targets[0];
    if (reconnect) {
      await app.page.evaluate('window.__blockReconnect=true;window.__sockets.at(-1).close();true');
      await waitFor(() => app.page.evaluate(`window.__sockets.filter(socket=>socket.url.endsWith('/unavailable-for-test')).length`), count => count >= 2, 'two refused Chromium upgrade attempts');
      await app.page.evaluate('window.__blockReconnect=false;true');
      await waitFor(() => app.page.evaluate(`window.__wire.filter(message=>message.type==='snapshot').length`), count => count >= 2, 'new snapshot after refused upgrades');
      await waitFor(() => app.page.evaluate(`document.querySelector('#connection').textContent`), text => text === '本地已连接', 'Chromium reconnected');
    }
    result.snapshots = await app.page.evaluate(`window.__wire.filter(message=>message.type==='snapshot').length`);
    result.refusedUpgradeAttempts = await app.page.evaluate(`window.__sockets.filter(socket=>socket.url.endsWith('/unavailable-for-test')).length`);
    assert.deepEqual(fs.readdirSync(fixture.logs), [], 'The empty-workspace transport probe must not start any CLI');
    const started = Date.now();
    await closeApp(app, fixture);
    result.closed = true;
    result.elapsed = Date.now() - started;
  } catch (error) {
    result.error = error.message;
    result.diagnostic = app?.closeDiagnostic;
    result.output = app?.output.join('');
  } finally {
    await cleanupFixture(fixture, app);
    result.cleanup = fixture.cleanup;
  }
  return result;
}

(async () => {
  const results = [];
  for (const reconnect of [false, true]) results.push(await scenario(reconnect));
  fs.writeFileSync(path.join(root, 'test-results', 'multi-session-ui', 'chromium-close-probe.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(result => result.closed), 'Both the baseline and two-refused-upgrade Chromium case must exit within the unchanged 15s deadline');
})().catch(error => { console.error(error); process.exitCode = 1; });
