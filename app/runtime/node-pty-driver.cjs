const path = require('node:path');

function createNodePtyDriver({
  nodePty = require('node-pty'),
  name = 'xterm-256color',
  cols = 80,
  rows = 24,
  platform = process.platform,
  killProcess
} = {}) {
  if (!nodePty || typeof nodePty.spawn !== 'function') throw new Error('node-pty is unavailable');

  return (launch, handlers) => {
    if (!launch || typeof launch.command !== 'string' || !launch.command) throw new Error('A CLI command is required');
    if (platform === 'win32' && ['.cmd', '.bat'].includes(path.win32.extname(launch.command).toLowerCase())) {
      throw new Error('Windows CLI launchers must resolve to a native .exe');
    }
    if (!Array.isArray(launch.args) || launch.args.some(argument => typeof argument !== 'string')) {
      throw new Error('CLI arguments must be an array of strings');
    }
    if (typeof launch.cwd !== 'string' || !launch.cwd) throw new Error('A working directory is required');

    const ptyOptions = {
      name,
      cols,
      rows,
      cwd: launch.cwd,
      handleFlowControl: true
    };
    if (platform === 'win32') {
      ptyOptions.useConpty = true;
      ptyOptions.env = { ...process.env, TERM: name };
    }
    const terminal = nodePty.spawn(launch.command, launch.args, ptyOptions);
    let exited = false;
    let stopPromise = null;
    let resolveStop;
    let rejectStop;
    let dataSubscription;
    let exitSubscription;

    dataSubscription = terminal.onData(data => {
      if (!exited) handlers.onData(data);
    });
    exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      if (exited) return;
      exited = true;
      try {
        handlers.onExit(exitCode, signal);
      } finally {
        try {
          if (platform === 'win32' && !stopPromise &&
              typeof nodePty.supportsSafeWindowsProcessTreeCleanup === 'function' &&
              nodePty.supportsSafeWindowsProcessTreeCleanup()) {
            terminal.kill();
          }
        } finally {
          if (dataSubscription) dataSubscription.dispose();
          if (exitSubscription) exitSubscription.dispose();
          if (resolveStop) resolveStop();
          resolveStop = null;
          rejectStop = null;
        }
      }
    });

    return {
      write(data) {
        if (exited) throw new Error('PTY process has exited');
        terminal.write(data);
      },
      resize(columns, lineCount) {
        if (exited) throw new Error('PTY process has exited');
        terminal.resize(columns, lineCount);
      },
      kill() {
        if (exited) return Promise.resolve();
        const stopProcess = killProcess || (process => {
          if (platform === 'win32' && (typeof nodePty.supportsSafeWindowsProcessTreeCleanup !== 'function' || !nodePty.supportsSafeWindowsProcessTreeCleanup())) {
            throw new Error('Windows PTY process-tree cleanup is not verified');
          }
          return process.kill();
        });
        if (!stopPromise) {
          let resolveCurrent;
          let rejectCurrent;
          const currentStopPromise = new Promise((resolve, reject) => {
            resolveCurrent = resolve;
            rejectCurrent = reject;
          });
          stopPromise = currentStopPromise;
          resolveStop = resolveCurrent;
          rejectStop = rejectCurrent;
          try {
            Promise.resolve(stopProcess(terminal)).catch(error => {
              if (!exited && stopPromise === currentStopPromise) {
                stopPromise = null;
                resolveStop = null;
                rejectStop = null;
                rejectCurrent(error);
              }
            });
          } catch (error) {
            stopPromise = null;
            resolveStop = null;
            rejectStop = null;
            rejectCurrent(error);
          }
          return currentStopPromise;
        }
        return stopPromise;
      }
    };
  };
}

module.exports = { createNodePtyDriver };
