/**
 * Permission Manager Factory
 * Automatically creates the appropriate permission manager based on environment
 */

// Check if we're in the main process (Node.js/Electron)
const isMainProcess = typeof window === 'undefined' && 
                     typeof process !== 'undefined' && 
                     process.type === 'browser';

/**
 * Create the appropriate permission manager for the current environment
 * @returns {MainProcessPermissionManager|RendererPermissionManager}
 */
function createPermissionManager() {
  if (isMainProcess) {
    const MainProcessPermissionManager = require('./main-process-permission-manager');
    return new MainProcessPermissionManager();
  } else {
    const RendererPermissionManager = require('./renderer-permission-manager');
    return new RendererPermissionManager();
  }
}

// Export factory function and individual classes for direct use if needed
module.exports = {
  createPermissionManager,
  MainProcessPermissionManager: isMainProcess ? require('./main-process-permission-manager') : null,
  RendererPermissionManager: !isMainProcess ? require('./renderer-permission-manager') : null
};

// For browser environments, also expose on window
if (typeof window !== 'undefined') {
  window.createPermissionManager = createPermissionManager;
}