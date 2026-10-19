const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDesktopPaths } = require('../app/desktop/runtime-path.cjs');

test('development uses the pinned Node package and the source service entry', () => {
  const paths = resolveDesktopPaths({ isPackaged: false, appPath: 'D:\\AgentDock', resourcesPath: 'D:\\AgentDock\\resources' });
  assert.equal(paths.runtimePath, path.join('D:\\AgentDock', 'node_modules', 'node', 'bin', 'node.exe'));
  assert.equal(paths.serviceEntryPath, path.join('D:\\AgentDock', 'app', 'desktop', 'service-entry.cjs'));
  assert.equal(paths.preloadPath, path.join('D:\\AgentDock', 'app', 'desktop', 'preload.cjs'));
});

test('packaged mode only uses the fixed runtime and unpacked service assets', () => {
  const paths = resolveDesktopPaths({ isPackaged: true, appPath: 'C:\\Program Files\\AgentDock\\resources\\app.asar', resourcesPath: 'C:\\Program Files\\AgentDock\\resources' });
  assert.equal(paths.runtimePath, path.join('C:\\Program Files\\AgentDock\\resources', 'agentdock-runtime', 'node.exe'));
  assert.equal(paths.serviceEntryPath, path.join('C:\\Program Files\\AgentDock\\resources', 'agentdock-service', 'app', 'desktop', 'service-entry.cjs'));
  assert.equal(paths.preloadPath, path.join('C:\\Program Files\\AgentDock\\resources\\app.asar', 'app', 'desktop', 'preload.cjs'));
  assert.notEqual(paths.runtimePath, process.execPath);
});
