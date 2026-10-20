const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputPath = path.join(root, 'dist', 'win-unpacked');
const resourcesPath = path.join(outputPath, 'resources');
const servicePath = path.join(resourcesPath, 'agentdock-service');
const runtimePath = path.join(resourcesPath, 'agentdock-runtime', 'node.exe');
const appArchivePath = path.join(resourcesPath, 'app.asar');
const setupPath = path.join(root, 'dist', `AgentDock-Setup-${packageJson.version}.exe`);

for (const filePath of [
  path.join(outputPath, 'AgentDock.exe'),
  appArchivePath,
  runtimePath,
  path.join(servicePath, 'app', 'desktop', 'service-entry.cjs'),
  path.join(resourcesPath, 'agentdock-runtime', 'LICENSE'),
  path.join(resourcesPath, 'THIRD-PARTY-NOTICES.md'),
  path.join(outputPath, 'LICENSE.electron.txt'),
  path.join(outputPath, 'LICENSES.chromium.html')
]) {
  assert.equal(fs.existsSync(filePath), true, `Missing packaged file: ${filePath}`);
}

const packedPackage = JSON.parse(asar.extractFile(appArchivePath, 'package.json').toString('utf8'));
assert.equal(packedPackage.version, packageJson.version, 'Packaged package version mismatch');
assert.equal(packedPackage.main, packageJson.main, 'Packaged Electron main entry mismatch');

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relativePath) : [relativePath];
  }).sort();
}

const sourceAppPath = path.join(root, 'app');
const sourceFiles = listFiles(sourceAppPath);
const packedFiles = asar.listPackage(appArchivePath).map(filePath => filePath.replace(/\\/g, '/'));
const packedSourceFiles = packedFiles.filter(filePath => filePath.startsWith('/app/') &&
  !Object.hasOwn(asar.statFile(appArchivePath, filePath.slice(1).split('/').join(path.sep)), 'files')).map(filePath => filePath.slice('/app/'.length)).sort();
assert.deepEqual(packedSourceFiles, sourceFiles, 'Packaged app.asar source file list mismatch');
const serviceAppPath = path.join(servicePath, 'app');
assert.deepEqual(listFiles(serviceAppPath), sourceFiles, 'Packaged service source file list mismatch');
for (const relativePath of sourceFiles) {
  const sourceHash = createHash('sha256').update(fs.readFileSync(path.join(sourceAppPath, relativePath))).digest('hex');
  const archiveHash = createHash('sha256').update(asar.extractFile(appArchivePath, path.join('app', relativePath))).digest('hex');
  assert.equal(archiveHash, sourceHash, `Packaged app.asar source mismatch: app/${relativePath}`);
  const serviceHash = createHash('sha256').update(fs.readFileSync(path.join(serviceAppPath, relativePath))).digest('hex');
  assert.equal(serviceHash, sourceHash, `Packaged service source mismatch: app/${relativePath}`);
}
assert.equal(fs.existsSync(setupPath), true, `Missing packaged file: ${setupPath}`);

const serviceModulesPath = path.join(servicePath, 'node_modules');
for (const [moduleName, expectedVersion] of [
  ['node-pty', packageJson.devDependencies['node-pty']],
  ['ws', packageJson.devDependencies.ws],
  ['@xterm/xterm', packageJson.devDependencies['@xterm/xterm']],
  ['@xterm/addon-fit', packageJson.devDependencies['@xterm/addon-fit']]
]) {
  const modulePath = path.join(serviceModulesPath, moduleName, 'package.json');
  const modulePackage = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  assert.equal(modulePackage.version, expectedVersion, `Unexpected packaged ${moduleName} version`);
  assert.equal(fs.existsSync(path.join(path.dirname(modulePath), 'LICENSE')), true, `Missing ${moduleName} license`);
}

assert.equal(packedFiles.includes(`/${packageJson.main}`), true, 'Electron main entry is missing from app.asar');
assert.equal(packedFiles.some(filePath => filePath.includes('/node_modules/')), false, 'Service dependencies were duplicated inside app.asar');

const runtimeResult = spawnSync(runtimePath, ['-e', [
  "const pty=require('node-pty');",
  "process.stdout.write(JSON.stringify({node:process.versions.node,abi:process.versions.modules,pty:require('node-pty/package.json').version,cleanup:pty.supportsSafeWindowsProcessTreeCleanup()}));"
].join(' ')], { cwd: servicePath, encoding: 'utf8' });
if (runtimeResult.error) throw runtimeResult.error;
assert.equal(runtimeResult.status, 0, runtimeResult.stderr || 'Packaged Node could not load node-pty');
const runtimeInfo = JSON.parse(runtimeResult.stdout);
assert.equal(runtimeInfo.node, packageJson.devDependencies.node, 'Packaged Node version mismatch');
assert.equal(runtimeInfo.abi, '137', 'Packaged Node module ABI mismatch');
assert.equal(runtimeInfo.pty, packageJson.devDependencies['node-pty'], 'Packaged node-pty version mismatch');
assert.equal(runtimeInfo.cleanup, true, 'Packaged node-pty is missing safe Job Object cleanup support');

console.log(`Verified ${path.basename(setupPath)}: ${sourceFiles.length} app sources match in asar and service, Node ${runtimeInfo.node}, ABI ${runtimeInfo.abi}, node-pty ${runtimeInfo.pty}`);
