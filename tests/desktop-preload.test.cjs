const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('preload exposes only the native working-directory picker', async () => {
  let exposedName;
  let exposedApi;
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, '../app/desktop/preload.cjs'), 'utf8');
  vm.runInNewContext(source, {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { exposedName = name; exposedApi = api; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve('C:\\Project'); } }
      };
    }
  });

  assert.equal(exposedName, 'agentDock');
  assert.deepEqual(Object.keys(exposedApi), ['selectWorkingDirectory']);
  assert.equal(await exposedApi.selectWorkingDirectory(), 'C:\\Project');
  assert.deepEqual(calls, [['agentdock:select-working-directory']]);
});
