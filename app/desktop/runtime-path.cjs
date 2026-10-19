const path = require('node:path');

function resolveDesktopPaths({ isPackaged, appPath, resourcesPath } = {}) {
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath)) throw new Error('An absolute Electron app path is required');
  if (isPackaged) {
    if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw new Error('An absolute Electron resources path is required');
    return {
      runtimePath: path.join(resourcesPath, 'agentdock-runtime', 'node.exe'),
      serviceEntryPath: path.join(resourcesPath, 'agentdock-service', 'app', 'desktop', 'service-entry.cjs'),
      preloadPath: path.join(appPath, 'app', 'desktop', 'preload.cjs')
    };
  }
  return {
    runtimePath: path.join(appPath, 'node_modules', 'node', 'bin', 'node.exe'),
    serviceEntryPath: path.join(appPath, 'app', 'desktop', 'service-entry.cjs'),
    preloadPath: path.join(appPath, 'app', 'desktop', 'preload.cjs')
  };
}

module.exports = { resolveDesktopPaths };
