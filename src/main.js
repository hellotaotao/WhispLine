const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Tray,
  screen,
  clipboard,
  dialog,
  systemPreferences,
} = require("electron");
const { exec } = require("child_process");
const path = require("path");
const Store = require("electron-store");
const { uIOhook, UiohookKey } = require("uiohook-napi");

const store = new Store();
let mainWindow;
let settingsWindow;
let inputPromptWindow;
let tray;
let hookStarted = false; // Track if hook is started
let isDevelopment = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

// Key state tracking for hotkey combination
let ctrlPressed = false;
let shiftPressed = false;
let isRecording = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
    icon: path.join(__dirname, "../assets/icon.png"),
  });

  mainWindow.loadFile(path.join(__dirname, "views/main.html"));

  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Handle main window closed event
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 700,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: false,
    show: false,
  });

  settingsWindow.loadFile(path.join(__dirname, "views/settings.html"));

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
  });
}

function createInputPromptWindow() {
  const displays = screen.getAllDisplays();
  const primaryDisplay =
    displays.find(
      (display) => display.bounds.x === 0 && display.bounds.y === 0,
    ) || displays[0];

  const windowWidth = 400;
  const windowHeight = 100;
  const x = Math.round(
    primaryDisplay.bounds.x + primaryDisplay.bounds.width / 2 - windowWidth / 2,
  );
  const y = Math.round(
    primaryDisplay.bounds.y + primaryDisplay.bounds.height - windowHeight - 100,
  );

  inputPromptWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: false,
  });

  inputPromptWindow.loadFile(path.join(__dirname, "views/input-prompt.html"));
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, "../assets/tray-icon.png"));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show Main Window",
        click: () => {
          mainWindow.show();
        },
      },
      {
        label: "Settings",
        click: () => {
          createSettingsWindow();
        },
      },
      {
        type: "separator",
      },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          stopGlobalHotkeys(); // Stop hotkeys before quitting
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip("FluidInput");

    tray.on("double-click", () => {
      mainWindow.show();
    });
  } catch (error) {
    console.error("Failed to create tray:", error);
  }
}

function setupGlobalHotkeys() {
  try {
    // Ensure any previous hook is stopped
    if (hookStarted) {
      stopGlobalHotkeys();
    }

    // Check accessibility permission before starting (skip in dev mode)
    if (process.platform === "darwin" && !isDevelopment && !systemPreferences.isTrustedAccessibilityClient(false)) {
      console.error("Accessibility permission not granted, cannot start global hotkeys");
      dialog.showErrorBox(
        "Permission Required", 
        "Accessibility permission is required for global keyboard shortcuts. Please restart the app after granting permission."
      );
      return;
    }

    // Register keyboard event listeners
    uIOhook.on("keydown", (e) => {
      // Ctrl key (left or right)
      if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlR) {
        ctrlPressed = true;
      }
      // Shift key (left or right)
      if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftR) {
        shiftPressed = true;
      }

      // Start recording when both Ctrl+Shift are pressed
      if (ctrlPressed && shiftPressed && !isRecording) {
        isRecording = true;
        if (inputPromptWindow) {
          inputPromptWindow.show();
          inputPromptWindow.webContents.send("start-recording");
        }
      }
    });

    uIOhook.on("keyup", (e) => {
      // Ctrl key released
      if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlR) {
        ctrlPressed = false;
      }
      // Shift key released
      if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftR) {
        shiftPressed = false;
      }

      // Stop recording when either key is released
      if ((!ctrlPressed || !shiftPressed) && isRecording) {
        isRecording = false;
        if (inputPromptWindow) {
          inputPromptWindow.webContents.send("stop-recording");
        }
      }
    });

    // Add error handler for uiohook
    uIOhook.on("error", (error) => {
      console.error("uIOhook error:", error);
      if (error.message && error.message.includes("accessibility")) {
        dialog.showErrorBox(
          "Accessibility Permission Error",
          "Global keyboard shortcuts require accessibility permission. Please grant permission in System Preferences and restart the app."
        );
      }
    });

    // Start the global hook
    uIOhook.start();
    hookStarted = true;
    console.log("Global hotkey listener started");
  } catch (error) {
    console.error("Failed to setup global hotkeys:", error);
    hookStarted = false;
    
    if (process.platform === "darwin" && error.message && error.message.includes("accessibility")) {
      dialog.showErrorBox(
        "Permission Error",
        "Global keyboard shortcuts require accessibility permission. Please grant permission in System Preferences and restart the app."
      );
    }
  }
}

function stopGlobalHotkeys() {
  if (!hookStarted) {
    return; // Already stopped or never started
  }

  try {
    console.log("Stopping global hotkey listener...");

    // Remove all listeners first
    uIOhook.removeAllListeners();

    // Then stop the hook
    uIOhook.stop();
    hookStarted = false;
    console.log("Global hotkey listener stopped successfully");
  } catch (error) {
    console.error("Failed to stop global hotkeys:", error);
    hookStarted = false;

    // Force cleanup if normal stop fails
    try {
      // Kill any remaining uiohook processes on macOS
      if (process.platform === "darwin") {
        exec('pkill -f "FluidInput Helper"', (err) => {
          if (err) console.log("No FluidInput Helper processes found to kill");
          else console.log("Force killed FluidInput Helper processes");
        });
      }
    } catch (killError) {
      console.error("Failed to force cleanup:", killError);
    }
  }
}

// Clean up any orphaned helper processes from previous runs
function cleanupOrphanedProcesses() {
  if (process.platform === "darwin") {
    exec('pgrep -f "FluidInput Helper"', (error, stdout) => {
      if (!error && stdout.trim()) {
        console.log(
          "Found orphaned FluidInput Helper processes, cleaning up...",
        );
        exec('pkill -f "FluidInput Helper"', (killError) => {
          if (killError) {
            console.error("Failed to cleanup orphaned processes:", killError);
          } else {
            console.log("Successfully cleaned up orphaned processes");
          }
        });
      }
    });
  }
}

// Check accessibility permissions on macOS
async function checkAccessibilityPermissions() {
  if (process.platform !== "darwin") {
    return true; // Not needed on other platforms
  }

  // Skip strict permission check in development mode
  if (isDevelopment) {
    console.log("Development mode: skipping strict accessibility permission check");
    return true;
  }

  try {
    const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
    if (!hasPermission) {
      const result = await dialog.showMessageBox(null, {
        type: "warning",
        title: "Accessibility Permission Required",
        message: "FluidInput needs accessibility permission to capture global keyboard shortcuts.",
        detail: "Please grant accessibility permission in System Preferences to use FluidInput.\n\nAfter granting permission, please restart the application.",
        buttons: ["Open System Preferences", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        // Try to prompt for accessibility permission
        systemPreferences.isTrustedAccessibilityClient(true);
      }
      
      app.quit();
      return false;
    }
    return true;
  } catch (error) {
    console.error("Failed to check accessibility permissions:", error);
    return false;
  }
}

// Check microphone permissions
async function checkMicrophonePermissions() {
  if (process.platform === "darwin") {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status !== 'granted' && !isDevelopment) {
        const result = await dialog.showMessageBox(null, {
          type: "info",
          title: "Microphone Permission Required",
          message: "FluidInput needs microphone access to transcribe your voice.",
          detail: "Please grant microphone permission when prompted.",
          buttons: ["Continue", "Quit"],
          defaultId: 0,
          cancelId: 1,
        });

        if (result.response === 1) {
          app.quit();
          return false;
        }

        // Request microphone access
        try {
          await systemPreferences.askForMediaAccess('microphone');
        } catch (err) {
          console.error("Failed to request microphone access:", err);
        }
      }
    } catch (error) {
      console.error("Failed to check microphone permissions:", error);
    }
  }
  return true;
}

app.whenReady().then(async () => {
  // Check permissions first
  const hasAccessibilityPermission = await checkAccessibilityPermissions();
  if (!hasAccessibilityPermission) {
    return; // App will quit if permission denied
  }

  const hasMicrophonePermission = await checkMicrophonePermissions();
  if (!hasMicrophonePermission) {
    return; // App will quit if permission denied
  }

  // Set up macOS menu to handle Cmd+Q properly
  if (process.platform === "darwin") {
    const template = [
      {
        label: "FluidInput",
        submenu: [
          {
            label: "About FluidInput",
            role: "about"
          },
          {
            type: "separator"
          },
          {
            label: "Quit FluidInput",
            accelerator: "Command+Q",
            click: () => {
              app.isQuitting = true;
              stopGlobalHotkeys();
              app.quit();
            }
          }
        ]
      }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  // Clean up any orphaned processes first
  cleanupOrphanedProcesses();

  // Small delay to ensure cleanup completes
  setTimeout(() => {
    createMainWindow();
    createInputPromptWindow();
    createTray();
    setupGlobalHotkeys();

    // Show main window on startup
    mainWindow.show();
  }, 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS, don't quit when all windows are closed unless explicitly quitting
  if (process.platform !== "darwin" || app.isQuitting) {
    stopGlobalHotkeys();
    app.quit();
  }
});

app.on("will-quit", () => {
  stopGlobalHotkeys();
  globalShortcut.unregisterAll();
});

app.on("before-quit", (event) => {
  // Mark that we're intentionally quitting
  app.isQuitting = true;
  // Additional cleanup before quit
  stopGlobalHotkeys();
});

// Handle process termination signals
process.on("SIGINT", () => {
  console.log("Received SIGINT, cleaning up...");
  stopGlobalHotkeys();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, cleaning up...");
  stopGlobalHotkeys();
  process.exit(0);
});

// IPC handlers
ipcMain.handle("get-settings", () => {
  return {
    apiKey: store.get("apiKey", ""),
    shortcut: "Ctrl+Shift (hold down)", // Fixed hotkey, not customizable
    language: store.get("language", "en"),
    microphone: store.get("microphone", "default"),
  };
});

ipcMain.handle("save-settings", (event, settings) => {
  store.set("apiKey", settings.apiKey);
  store.set("shortcut", settings.shortcut);
  store.set("language", settings.language);
  store.set("microphone", settings.microphone);

  // Note: uiohook doesn't need re-registration like globalShortcut
  // The hotkey combination is hardcoded to Ctrl+Shift

  return true;
});

ipcMain.handle("open-settings", () => {
  createSettingsWindow();
});

ipcMain.handle("hide-input-prompt", () => {
  if (inputPromptWindow) {
    inputPromptWindow.hide();
  }
});

ipcMain.handle("transcribe-audio", async (event, audioBuffer) => {
  const Groq = require("groq-sdk");
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  try {
    const apiKey = store.get("apiKey");
    if (!apiKey) {
      throw new Error("API key not configured");
    }

    const groq = new Groq({ apiKey });

    // Save audio buffer to temporary file
    const tempFile = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
    fs.writeFileSync(tempFile, audioBuffer);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: "whisper-large-v3-turbo",
      response_format: "verbose_json",
    });

    // Clean up temp file
    fs.unlinkSync(tempFile);

    return transcription.text;
  } catch (error) {
    console.error("Transcription error:", error);
    throw error;
  }
});

ipcMain.handle("type-text", async (event, text) => {
  try {
    // Simple clipboard-based approach to avoid requesting broad permissions
    clipboard.writeText(text);

    return {
      success: true,
      method: "clipboard",
      message: "Text copied to clipboard. Press Cmd+V to paste.",
    };
  } catch (error) {
    console.error("Failed to copy text to clipboard:", error);
    throw error;
  }
});

ipcMain.handle("show-permission-dialog", async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Text Insertion Permission",
    message: "FluidInput needs permission to insert text into applications.",
    detail:
      "The app will copy text to your clipboard as a fallback method. You can manually paste the transcribed text where needed.",
    buttons: ["Continue with Clipboard", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });

  return result.response;
});

ipcMain.handle("check-microphone-permission", async () => {
  try {
    // Check if microphone permission has been granted
    const session = mainWindow.webContents.session;
    const permissionStatus = await session.checkPermissionForOrigin(
      "media",
      "file://",
    );

    return {
      granted: permissionStatus === "granted",
      status: permissionStatus,
    };
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    return {
      granted: false,
      status: "unknown",
      error: error.message,
    };
  }
});

ipcMain.handle("request-microphone-permission", async () => {
  try {
    const session = mainWindow.webContents.session;

    // Request microphone permission
    const granted = await session.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        if (permission === "media") {
          callback(true);
          return;
        }
        callback(false);
      },
    );

    return { granted: true };
  } catch (error) {
    console.error("Failed to request microphone permission:", error);
    return {
      granted: false,
      error: error.message,
    };
  }
});

ipcMain.handle("show-microphone-permission-dialog", async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Microphone Permission Required",
    message: "FluidInput needs access to your microphone to transcribe speech.",
    detail:
      "Please grant microphone permission in the next dialog to use voice input features.",
    buttons: ["Grant Permission", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });

  return result.response === 0;
});

ipcMain.handle("show-permission-denied-dialog", async () => {
  const isMac = process.platform === "darwin";
  const settingsPath = isMac
    ? "System Preferences > Security & Privacy > Privacy > Microphone"
    : "System Settings > Privacy > Microphone";

  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Microphone Permission Denied",
    message: "FluidInput cannot access your microphone.",
    detail: `To use voice input features, please:\n\n1. Go to ${settingsPath}\n2. Enable microphone access for FluidInput\n3. Restart the application\n\nAlternatively, you can continue without voice input.`,
    buttons: ["Open System Settings", "Continue Without Voice", "Retry"],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    // Open system settings
    if (isMac) {
      exec(
        'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"',
      );
    } else if (process.platform === "win32") {
      exec("start ms-settings:privacy-microphone");
    } else {
      // Linux - generic settings
      exec("gnome-control-center privacy");
    }
  }

  return result.response;
});

// Check accessibility permission status
ipcMain.handle("check-accessibility-permission", async () => {
  if (process.platform !== "darwin") {
    return { granted: true, status: "not_required" };
  }

  try {
    const granted = systemPreferences.isTrustedAccessibilityClient(false);
    return {
      granted,
      status: granted ? "granted" : "denied",
    };
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    return {
      granted: false,
      status: "error",
      error: error.message,
    };
  }
});

// Request accessibility permission
ipcMain.handle("request-accessibility-permission", async () => {
  if (process.platform !== "darwin") {
    return { granted: true, status: "not_required" };
  }

  try {
    // This will prompt the user to grant accessibility permission
    const granted = systemPreferences.isTrustedAccessibilityClient(true);
    return {
      granted,
      status: granted ? "granted" : "prompt_shown",
    };
  } catch (error) {
    console.error("Failed to request accessibility permission:", error);
    return {
      granted: false,
      status: "error",
      error: error.message,
    };
  }
});
