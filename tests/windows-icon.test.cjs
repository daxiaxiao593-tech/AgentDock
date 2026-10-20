const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('Windows executable icon is the AgentDock brand image', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.build.win.icon, 'build/agentdock.ico');

  const png = fs.readFileSync(path.join(root, 'build', 'agentdock-256.png'));
  const ico = fs.readFileSync(path.join(root, 'build', 'agentdock.ico'));
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico[6], png.readUInt32BE(16) === 256 ? 0 : png.readUInt32BE(16));
  assert.equal(ico[7], png.readUInt32BE(20) === 256 ? 0 : png.readUInt32BE(20));
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.deepEqual(ico.subarray(22), png);
});
