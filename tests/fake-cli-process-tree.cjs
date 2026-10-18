const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [mode, stateFile, stopFile, exitFile] = process.argv.slice(2);

if (mode === 'worker') {
  fs.writeFileSync(stateFile, String(process.pid));
  const interval = setInterval(() => {
    if (!fs.existsSync(stopFile)) return;
    clearInterval(interval);
    fs.rmSync(stateFile, { force: true });
  }, 25);
} else if (mode === 'root' || mode === 'root-exit') {
  const worker = spawn(process.execPath, [__filename, 'worker', stateFile, stopFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  worker.unref();
  if (mode === 'root-exit') {
    const interval = setInterval(() => {
      if (!fs.existsSync(exitFile)) return;
      clearInterval(interval);
      process.exit(23);
    }, 25);
  } else {
    setInterval(() => {}, 1000);
  }
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
