const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');
const log = require('electron-log');

class AutoUpdaterService {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.updateCheckInProgress = false;
    
    // Configure logging
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    
    // Configure auto-updater
    autoUpdater.autoDownload = false; // Don't auto-download, ask user first
    autoUpdater.autoInstallOnAppQuit = true;
    
    this.setupEventListeners();
  }
  
  setupEventListeners() {
    // Checking for updates
    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for updates...');
      this.sendStatusToWindow('Checking for updates...');
    });
    
    // Update available
    autoUpdater.on('update-available', (info) => {
      log.info('Update available:', info.version);
      this.updateCheckInProgress = false;
      
      dialog.showMessageBox(this.mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version ${info.version} is available!`,
        detail: 'Would you like to download it now?',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
    });
    
    // Update not available
    autoUpdater.on('update-not-available', (info) => {
      log.info('Update not available:', info.version);
      this.updateCheckInProgress = false;
      
      // Only show dialog if user manually checked for updates
      if (this.manualCheck) {
        dialog.showMessageBox(this.mainWindow, {
          type: 'info',
          title: 'No Updates',
          message: 'You are already running the latest version.',
          detail: `Current version: ${info.version}`,
          buttons: ['OK']
        });
        this.manualCheck = false;
      }
    });
    
    // Error during update check
    autoUpdater.on('error', (err) => {
      log.error('Error in auto-updater:', err);
      this.updateCheckInProgress = false;
      
      // Only show error if user manually checked for updates
      if (this.manualCheck) {
        dialog.showMessageBox(this.mainWindow, {
          type: 'error',
          title: 'Update Error',
          message: 'Error checking for updates',
          detail: err.message,
          buttons: ['OK']
        });
        this.manualCheck = false;
      }
    });
    
    // Download progress
    autoUpdater.on('download-progress', (progressObj) => {
      const message = `Downloading update: ${Math.round(progressObj.percent)}%`;
      log.info(message);
      this.sendStatusToWindow(message);
    });
    
    // Update downloaded
    autoUpdater.on('update-downloaded', (info) => {
      log.info('Update downloaded:', info.version);
      
      dialog.showMessageBox(this.mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded.`,
        detail: 'The update will be installed when you quit the application. Would you like to restart now?',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then((result) => {
        if (result.response === 0) {
          // Quit and install update
          autoUpdater.quitAndInstall();
        }
      });
    });
  }
  
  sendStatusToWindow(message) {
    if (this.mainWindow && this.mainWindow.webContents) {
      this.mainWindow.webContents.send('update-status', message);
    }
  }
  
  // Check for updates (manual check by user)
  checkForUpdates() {
    if (this.updateCheckInProgress) {
      log.info('Update check already in progress');
      return;
    }
    
    this.manualCheck = true;
    this.updateCheckInProgress = true;
    
    log.info('Manually checking for updates...');
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('Failed to check for updates:', err);
      this.updateCheckInProgress = false;
      this.manualCheck = false;
    });
  }
  
  // Check for updates silently (on app startup)
  checkForUpdatesQuietly() {
    if (this.updateCheckInProgress) {
      log.info('Update check already in progress');
      return;
    }
    
    this.manualCheck = false;
    this.updateCheckInProgress = true;
    
    log.info('Checking for updates quietly...');
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('Failed to check for updates:', err);
      this.updateCheckInProgress = false;
    });
  }
}

module.exports = AutoUpdaterService;
