const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJsonPath = require.resolve('node-pty/package.json', { paths: [root] });
const nodePtyRoot = path.dirname(packageJsonPath);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

if (packageJson.version !== '1.1.0') throw new Error(`Unsupported node-pty version: ${packageJson.version}`);

const conptyPath = path.join(nodePtyRoot, 'src', 'win', 'conpty.cc');
const conptySource = fs.readFileSync(conptyPath, 'utf8');
if (conptySource.includes('supportsJobObjectCleanup')) process.exit(0);

const patchPath = path.join(root, 'patches', 'node-pty+1.1.0.patch');
const check = spawnSync('git', ['apply', '--check', '--', patchPath], {
  cwd: root,
  stdio: 'inherit'
});
if (check.error) throw check.error;
if (check.status !== 0) throw new Error('Cannot apply the pinned node-pty patch');

const apply = spawnSync('git', ['apply', '--', patchPath], {
  cwd: root,
  stdio: 'inherit'
});
if (apply.error) throw apply.error;
if (apply.status !== 0) process.exit(apply.status || 1);
