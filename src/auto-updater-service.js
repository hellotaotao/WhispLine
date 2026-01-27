const { autoUpdater } = require("electron-updater");
const { dialog } = require("electron");
const log = require("electron-log");

class AutoUpdaterService {
  constructor() {
    // Configure logging
    log.transports.file.level = "info";
    autoUpdater.logger = log;

    // Configure auto-updater
    autoUpdater.autoDownload = false; // Don't auto-download, ask user first
    autoUpdater.autoInstallOnAppQuit = true; // Auto-install on quit after download

    this.updateAvailable = false;
    this.updateDownloaded = false;
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    autoUpdater.on("checking-for-update", () => {
      log.info("Checking for updates...");
    });

    autoUpdater.on("update-available", (info) => {
      log.info("Update available:", info.version);
      this.updateAvailable = true;
      this.showUpdateAvailableDialog(info);
    });

    autoUpdater.on("update-not-available", (info) => {
      log.info("Update not available:", info.version);
      this.updateAvailable = false;
    });

    autoUpdater.on("error", (err) => {
      log.error("Error in auto-updater:", err);
      this.updateAvailable = false;
      this.updateDownloaded = false;
    });

    autoUpdater.on("download-progress", (progressObj) => {
      const logMessage = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
      log.info(logMessage);
    });

    autoUpdater.on("update-downloaded", (info) => {
      log.info("Update downloaded:", info.version);
      this.updateDownloaded = true;
      this.showUpdateDownloadedDialog(info);
    });
  }

  showUpdateAvailableDialog(info) {
    const detailLines = [
      "A new version of WhispLine is available. Would you like to download it now?",
      "",
      `Current version: ${autoUpdater.currentVersion}`,
      `New version: ${info.version}`
    ];
    
    const dialogOpts = {
      type: "info",
      buttons: ["Download", "Later"],
      title: "Update Available",
      message: `Version ${info.version} is available`,
      detail: detailLines.join("\n"),
    };

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        // User clicked "Download"
        autoUpdater.downloadUpdate();
        this.showDownloadingDialog();
      }
    });
  }

  showDownloadingDialog() {
    dialog.showMessageBox({
      type: "info",
      buttons: ["OK"],
      title: "Downloading Update",
      message: "Update is being downloaded",
      detail: "The update is being downloaded in the background. You'll be notified when it's ready to install.",
    });
  }

  showUpdateDownloadedDialog(info) {
    const dialogOpts = {
      type: "info",
      buttons: ["Restart Now", "Later"],
      title: "Update Ready",
      message: `Version ${info.version} has been downloaded`,
      detail: "The update has been downloaded and is ready to install. Would you like to restart now?",
    };

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        // User clicked "Restart Now"
        autoUpdater.quitAndInstall();
      }
    });
  }

  checkForUpdates() {
    if (!this.updateDownloaded) {
      autoUpdater.checkForUpdates().catch((err) => {
        log.error("Failed to check for updates:", err);
        dialog.showMessageBox({
          type: "error",
          buttons: ["OK"],
          title: "Update Check Failed",
          message: "Failed to check for updates",
          detail: err.message || "An error occurred while checking for updates. Please try again later.",
        });
      });
    } else {
      // Update already downloaded, show install dialog
      dialog.showMessageBox({
        type: "info",
        buttons: ["Restart Now", "Later"],
        title: "Update Ready",
        message: "An update has been downloaded",
        detail: "Would you like to restart now to install the update?",
      }).then((returnValue) => {
        if (returnValue.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  }

  checkForUpdatesQuietly() {
    // Check for updates without showing dialogs for "no updates available"
    autoUpdater.checkForUpdates().catch((err) => {
      log.error("Failed to check for updates (silent):", err);
    });
  }
}

module.exports = AutoUpdaterService;
