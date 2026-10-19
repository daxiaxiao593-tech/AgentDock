const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') process.exit(0);

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expectedNodeVersion = packageJson.dependencies.node;
const expectedNodeModuleAbi = '137';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to rebuild patched node-pty');

const runtimePath = path.join(root, 'node_modules', 'node', 'bin', 'node.exe');
if (!fs.existsSync(runtimePath)) throw new Error(`Pinned Node runtime is missing: ${runtimePath}`);
const runtimeInfo = spawnSync(runtimePath, ['-p', 'JSON.stringify({version:process.versions.node,modules:process.versions.modules})'], { encoding: 'utf8' });
if (runtimeInfo.error) throw runtimeInfo.error;
if (runtimeInfo.status !== 0) throw new Error('Cannot inspect the pinned Node runtime');
const runtime = JSON.parse(runtimeInfo.stdout.trim());
if (runtime.version !== expectedNodeVersion || runtime.modules !== expectedNodeModuleAbi) {
  throw new Error(`Expected Node ${expectedNodeVersion} ABI ${expectedNodeModuleAbi}; found ${runtime.version} ABI ${runtime.modules}`);
}
const nodePtyRoot = path.dirname(require.resolve('node-pty/package.json', { paths: [root] }));
const nodeGypCli = path.resolve(path.dirname(npmCli), '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
if (!fs.existsSync(nodeGypCli)) throw new Error(`Cannot find npm's node-gyp: ${nodeGypCli}`);

function findPython() {
  const candidates = [process.env.npm_config_python, process.env.PYTHON].filter(Boolean);
  const discovered = spawnSync('where.exe', ['python'], { encoding: 'utf8' });
  if (discovered.status === 0) candidates.push(...discovered.stdout.split(/\r?\n/).filter(Boolean));

  return candidates.find(candidate => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
}

const python = findPython();
if (!python) throw new Error('A working Python executable is required to rebuild patched node-pty');

const result = spawnSync(runtimePath, [nodeGypCli, 'rebuild', '--python', python, '--devdir', path.join(root, '.cache', 'node-gyp')], {
  cwd: nodePtyRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHON: python,
    PYTHONUTF8: '1'
  }
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
