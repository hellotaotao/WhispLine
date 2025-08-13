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
const AutoLaunch = require('auto-launch');
const { exec } = require("child_process");
const path = require("path");
const { default: Store } = require("electron-store");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const DatabaseManager = require("./database-manager");
const PermissionManager = require("./permission-manager");
const TranscriptionService = require("./services/transcription-service");

// Import Windows text inserter for Windows platform
let windowsTextInserter = null;
if (process.platform === 'win32') {
  try {
    windowsTextInserter = require("./windows-text-inserter-koffi");
    console.log("Windows koffi text inserter loaded");
  } catch (error) {
    console.error("Failed to load Windows text inserter:", error);
  }
}

const store = new Store();
const db = new DatabaseManager();
const permissionManager = new PermissionManager();
const isDevelopment = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Transcription service cache to avoid recreating clients
let transcriptionServiceCache = new Map();

// Helper function to get or create transcription service
function getTranscriptionService(provider, apiKey) {
  const cacheKey = `${provider}:${apiKey}`;
  
  if (!transcriptionServiceCache.has(cacheKey)) {
    try {
      const service = new TranscriptionService(provider, apiKey);
      transcriptionServiceCache.set(cacheKey, service);
      console.log(`Created new transcription service for provider: ${provider}`);
    } catch (error) {
      console.error(`Failed to create transcription service for ${provider}:`, error);
      throw error;
    }
  }
  
  return transcriptionServiceCache.get(cacheKey);
}

// Helper function to clear service cache (useful when API keys change)
function clearTranscriptionServiceCache() {
  transcriptionServiceCache.clear();
  console.log('Transcription service cache cleared');
}

// Auto-launch setup
const autoLauncher = new AutoLaunch({
  name: 'WhispLine',
  path: app.getPath('exe'),
});

let mainWindow;
let settingsWindow;
let inputPromptWindow;
let tray;
let hookStarted = false; // Track if hook is started
let accessibilityWatchdog = null; // Low-frequency permission watchdog (macOS only)

// Key state tracking for hotkey combination
let ctrlPressed = false;
let shiftPressed = false;
let altPressed = false;
let isRecording = false;

// Set up permission manager event listeners
permissionManager.on('accessibility-permission-changed', (data) => {
  if (data.granted && !hookStarted) {
    console.log("Permission granted! Starting hotkeys...");
    setupGlobalHotkeys();
  } else if (!data.granted && hookStarted) {
    console.log("Permission revoked! Stopping hotkeys...");
    stopGlobalHotkeys();
  }
  
  // Notify main window
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('accessibility-permission-changed', data);
  }
  
  // Update settings window if open
  if (settingsWindow && settingsWindow.webContents) {
    settingsWindow.webContents.send('permission-status-updated', {
      accessibility: data.granted
    });
  }
});

permissionManager.on('quit-requested', () => {
  app.quit();
});

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

  // Add window focus event listener for dynamic permission detection
  // Note: This provides additional coverage beyond app.on("activate") for edge cases
  // where user might return to main window without app activation event
  mainWindow.on("focus", async () => {
    // Only recheck if we don't currently have permission (optimize for common case)
    if (!permissionManager.hasAccessibilityPermission()) {
      await permissionManager.recheckAccessibilityPermission();
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 750,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: false,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
  });

  settingsWindow.loadFile(path.join(__dirname, "views/settings.html"));

  settingsWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      settingsWindow.close();
    }
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  // Check permissions when settings window gains focus
  settingsWindow.on("focus", async () => {
    // Always check in settings window since user might want to see current status
    await permissionManager.recheckAccessibilityPermission();
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
    focusable: false,
  });

  inputPromptWindow.loadFile(path.join(__dirname, "views/input-prompt.html"));
}

// Position Input Prompt on the display where the user is currently active (by cursor)
function positionInputPromptOnActiveDisplay(offsetBottom = 100) {
  if (!inputPromptWindow) return;
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
    const area = display.workArea || display.bounds;
    const { width: winW, height: winH } = inputPromptWindow.getBounds();
    const x = Math.round(area.x + area.width / 2 - winW / 2);
    const y = Math.round(area.y + area.height - winH - Math.max(0, offsetBottom));
    inputPromptWindow.setPosition(x, y, false);
  } catch (e) {
    // Fallback: no-op if positioning fails
  }
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, "../assets/icon.png"));

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
        click: async () => {
          app.isQuitting = true;
          await stopGlobalHotkeys(); // Stop hotkeys before quitting
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip("WhispLine");

    tray.on("double-click", () => {
      mainWindow.show();
    });
  } catch (error) {
    console.error("Failed to create tray:", error);
  }
}

async function setupGlobalHotkeys() {
  try {
    // Check accessibility permission on macOS
    if (process.platform === "darwin") {
      const hasPermission = await permissionManager.checkAccessibilityPermission();
      if (!hasPermission) {
        return;
      }
    }

    // Ensure any previous hook is stopped before starting new one
    if (hookStarted) {
      console.log("Stopping existing hotkey listener before restart...");
      await stopGlobalHotkeys();
      // Small delay to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Register keyboard event listeners (with defensive try/catch)
    uIOhook.on("keydown", (e) => {
      try {
      // Ctrl key (left or right)
      if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlR) {
        ctrlPressed = true;
      }
      // Shift key (left or right)
      if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftR) {
        shiftPressed = true;
      }
      // Alt key (left or right)
      if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltR) {
        altPressed = true;
      }

      // Start recording when Ctrl+Shift OR Shift+Alt are pressed
      if (!isRecording) {
        let shouldStartRecording = false;
        let translateMode = false;
        
        // Ctrl+Shift for normal transcription
        if (ctrlPressed && shiftPressed) {
          shouldStartRecording = true;
          translateMode = false;
        }
        // Shift+Alt for English translation
        else if (shiftPressed && altPressed) {
          shouldStartRecording = true;
          translateMode = true;
        }
        
        if (shouldStartRecording) {
          // Check microphone permission before starting recording
          permissionManager.checkAndRequestMicrophonePermission().then(hasPermission => {
            if (hasPermission) {
              isRecording = true;
              if (inputPromptWindow) {
                // Reposition to the active display before showing
                positionInputPromptOnActiveDisplay(100);
                inputPromptWindow.showInactive();
                inputPromptWindow.webContents.send("start-recording", translateMode);
              }
            } else {
              console.log("Recording cancelled due to lack of microphone permission");
            }
          }).catch(error => {
            console.error("Error checking microphone permission:", error);
          });
        }
      }
      } catch (handlerErr) {
        console.error("uIOhook keydown handler error:", handlerErr);
      }
    });

    uIOhook.on("keyup", (e) => {
      try {
      // Ctrl key released
      if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlR) {
        ctrlPressed = false;
      }
      // Shift key released
      if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftR) {
        shiftPressed = false;
      }
      // Alt key released
      if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltR) {
        altPressed = false;
      }

      // Stop recording when neither Ctrl+Shift nor Shift+Alt is pressed
      if (isRecording && !( (ctrlPressed && shiftPressed) || (shiftPressed && altPressed) )) {
        isRecording = false;
        inputPromptWindow?.webContents.send("stop-recording");
      }
      } catch (handlerErr) {
        console.error("uIOhook keyup handler error:", handlerErr);
      }
    });

    // Add error handler for uiohook
    uIOhook.on("error", async (error) => {
      try {
        console.error("uIOhook error:", error);
        // On any error, immediately stop the hook to avoid potential freeze
        await stopGlobalHotkeys();
      } catch (stopErr) {
        console.error("Failed to stop hotkeys after uIOhook error:", stopErr);
      } finally {
        // Recheck permission and notify UI
        try {
          await permissionManager.recheckAccessibilityPermission();
        } catch (reErr) {
          console.error("Permission recheck failed after uIOhook error:", reErr);
        }
        if (process.platform === "darwin" && error && error.message && error.message.toLowerCase().includes("access")) {
          permissionManager.showAccessibilityPermissionDialog();
        }
      }
    });

    // Start the global hook (wrap in try/catch to catch synchronous start errors)
    try {
      uIOhook.start();
    } catch (startErr) {
      console.error("uIOhook.start() threw:", startErr);
      await stopGlobalHotkeys();
      if (process.platform === "darwin") {
        permissionManager.showAccessibilityPermissionDialog();
      }
      return;
    }
    hookStarted = true;
    console.log("Global hotkey listener started successfully");

    // Start low-frequency watchdog (every 2s) to ensure eventual recovery if permission is revoked without error event
    if (process.platform === 'darwin') {
      if (accessibilityWatchdog) {
        clearInterval(accessibilityWatchdog);
      }
      accessibilityWatchdog = setInterval(async () => {
        try {
          if (!hookStarted) return; // if already stopped, do nothing
          const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
          if (!hasPermission) {
            console.warn("Accessibility permission revoked detected by watchdog. Stopping hotkeys to recover...");
            clearInterval(accessibilityWatchdog);
            accessibilityWatchdog = null;
            await stopGlobalHotkeys();
            await permissionManager.recheckAccessibilityPermission();
          }
        } catch (wdErr) {
          console.error("Accessibility watchdog error:", wdErr);
        }
      }, 2000);
    }
  } catch (error) {
    console.error("Failed to setup global hotkeys:", error);
    hookStarted = false;
    
    if (process.platform === "darwin" && error.message && error.message.includes("accessibility")) {
      // Only show permission dialog when we actually encounter a permission error
      permissionManager.showAccessibilityPermissionDialog();
    }
  }
}


function stopGlobalHotkeys() {
  if (!hookStarted) {
    return Promise.resolve(); // Already stopped or never started
  }

  return new Promise((resolve) => {
    try {
      console.log("Stopping global hotkey listener...");

      // Remove all listeners first
      uIOhook.removeAllListeners();

      // Then stop the hook
      uIOhook.stop();
      hookStarted = false;
      console.log("Global hotkey listener stopped successfully");

      // Clear watchdog if running
      if (accessibilityWatchdog) {
        clearInterval(accessibilityWatchdog);
        accessibilityWatchdog = null;
      }
      
      // Small delay to ensure cleanup completes
      setTimeout(resolve, 100);
    } catch (error) {
      console.error("Failed to stop global hotkeys:", error);
      hookStarted = false;

      // Clear watchdog even on failure path
      if (accessibilityWatchdog) {
        clearInterval(accessibilityWatchdog);
        accessibilityWatchdog = null;
      }

      // Force cleanup if normal stop fails
      try {
        // Kill any remaining uiohook processes on macOS
        if (process.platform === "darwin") {
          exec('pkill -f "WhispLine Helper"', (err) => {
            if (err) console.log("No WhispLine Helper processes found to kill");
            else console.log("Force killed WhispLine Helper processes");
            setTimeout(resolve, 100);
          });
        } else {
          setTimeout(resolve, 100);
        }
      } catch (killError) {
        console.error("Failed to force cleanup:", killError);
        setTimeout(resolve, 100);
      }
    }
  });
}

// Clean up any orphaned helper processes from previous runs
function cleanupOrphanedProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec('pgrep -f "WhispLine Helper"', (error, stdout) => {
        if (!error && stdout.trim()) {
          console.log("Found orphaned WhispLine Helper processes, cleaning up...");
          exec('pkill -f "WhispLine Helper"', (killError) => {
            if (killError) {
              console.error("Failed to cleanup orphaned processes:", killError);
            } else {
              console.log("Successfully cleaned up orphaned processes");
            }
            resolve();
          });
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}


app.whenReady().then(async () => {
  // Set platform-specific icons
  if (process.platform === 'darwin') {
    // Set macOS Dock icon (useful in development)
    try {
      app.dock.setIcon(path.join(__dirname, '../assets/icon.png'));
    } catch (e) {
      console.warn('Failed to set Dock icon:', e);
    }
  }

  // Set up application menu to enable standard editing shortcuts
  const template = [
    {
      label: "WhispLine",
      submenu: [
        {
          label: "About WhispLine",
          role: "about"
        },
        {
          type: "separator"
        },
        {
          label: "Preferences...",
          accelerator: process.platform === "darwin" ? "Command+," : "Ctrl+,",
          click: () => {
            createSettingsWindow();
          }
        },
        {
          type: "separator"
        },
        {
          label: "Quit WhispLine",
          accelerator: process.platform === "darwin" ? "Command+Q" : "Ctrl+Q",
          click: async () => {
            app.isQuitting = true;
            await stopGlobalHotkeys();
            app.quit();
          }
        }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectall" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "toggleDevTools" }
      ]
    },
    {
      label: "Window",
      role: "window",
      submenu: [
        { role: "minimize" },
        { role: "close" }
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Clean up any orphaned processes first
  await cleanupOrphanedProcesses();

  // Initialize application components immediately to improve startup performance
  createMainWindow();
  createInputPromptWindow();
  createTray();
  await setupGlobalHotkeys();

  // Show main window on startup unless startMinimized is true
  const startMinimized = store.get("startMinimized", false);
  if (!startMinimized) {
    mainWindow.show();
  }

  // Request microphone permission on startup (non-blocking for UX)
  if (process.platform === "darwin") {
    permissionManager.requestInitialMicrophonePermission();
  }

  app.on("activate", () => {
    // On macOS, show or recreate main window when dock icon is clicked
    if (mainWindow) {
      mainWindow.show();
    } else {
      createMainWindow();
    }
    // Recheck accessibility permission if needed
    if (!permissionManager.hasAccessibilityPermission()) {
      permissionManager.recheckAccessibilityPermission();
    }
  });
});

app.on("window-all-closed", async () => {
  // On macOS, don't quit when all windows are closed unless explicitly quitting
  if (process.platform !== "darwin" || app.isQuitting) {
    await stopGlobalHotkeys();
    app.quit();
  }
});

app.on("will-quit", async (event) => {
  event.preventDefault();
  await stopGlobalHotkeys();
  globalShortcut.unregisterAll();
  app.exit(0);
});

app.on("before-quit", async (event) => {
  if (!app.isQuitting) {
    event.preventDefault();
    // Mark that we're intentionally quitting
    app.isQuitting = true;
    // Additional cleanup before quit
    await stopGlobalHotkeys();
    app.quit();
  }
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
    apiKeyGroq: store.get("apiKeyGroq", store.get("apiKey", "")),
    apiKeyOpenAI: store.get("apiKeyOpenAI", ""),
    shortcut: "Ctrl+Shift (hold down)", // Fixed hotkey, not customizable
    language: store.get("language", "auto"),
    model: store.get("model", "whisper-large-v3-turbo"),
    microphone: store.get("microphone", "default"),
    autoLaunch: store.get("autoLaunch", false),
    startMinimized: store.get("startMinimized", false),
    provider: store.get("provider", "groq"),
  };
});

ipcMain.handle("save-settings", async (event, settings) => {
  // Persist API keys (provider-specific + legacy fallback)
  if (typeof settings.apiKeyGroq === 'string') {
    store.set("apiKeyGroq", settings.apiKeyGroq);
  }
  if (typeof settings.apiKeyOpenAI === 'string') {
    store.set("apiKeyOpenAI", settings.apiKeyOpenAI);
  }
  // Keep legacy apiKey synchronized with currently selected provider's key
  store.set("apiKey", settings.provider === 'openai' ? (settings.apiKeyOpenAI || '') : (settings.apiKeyGroq || ''));
  store.set("shortcut", settings.shortcut);
  store.set("language", settings.language);
  store.set("model", settings.model);
  store.set("microphone", settings.microphone);
  store.set("autoLaunch", settings.autoLaunch);
  store.set("startMinimized", settings.startMinimized);
  store.set("provider", settings.provider || "groq");

  // Clear transcription service cache when settings change (especially API keys)
  clearTranscriptionServiceCache();

  // Handle auto-launch setting
  try {
    if (settings.autoLaunch) {
      await autoLauncher.enable();
      console.log("Auto-launch enabled");
    } else {
      await autoLauncher.disable();
      console.log("Auto-launch disabled");
    }
  } catch (error) {
    console.error("Failed to update auto-launch setting:", error);
  }

  // Note: uiohook doesn't need re-registration like globalShortcut
  // The hotkey combination is hardcoded to Ctrl+Shift

  return true;
});

ipcMain.handle("open-settings", () => {
  createSettingsWindow();
});

ipcMain.handle("hide-input-prompt", () => {
  if (inputPromptWindow) {
    // Send cleanup signal to renderer process before hiding
    inputPromptWindow.webContents.send("cleanup-microphone");
    inputPromptWindow.hide();
  }
});

ipcMain.handle("cleanup-microphone", () => {
  // This handler is called when the renderer process needs to clean up microphone resources
  console.log("Microphone cleanup requested from renderer process");
  return true;
});

ipcMain.handle("transcribe-audio", async (event, audioBuffer, translateMode = false, mimeType = 'audio/webm') => {
  try {
    const provider = store.get("provider", "groq");
    const apiKey = provider === 'openai'
      ? (store.get("apiKeyOpenAI", store.get("apiKey", "")))
      : (store.get("apiKeyGroq", store.get("apiKey", "")));
    if (!apiKey) {
      throw new Error("API key not configured");
    }

    const language = store.get("language", "auto");
    const model = store.get("model", "whisper-large-v3-turbo");
    const dictionary = store.get('dictionary', '');

    // Get cached transcription service
    const transcriptionService = getTranscriptionService(provider, apiKey);

    // Transcribe audio
    const resultText = await transcriptionService.transcribeAudio(audioBuffer, {
      model,
      language,
      prompt: dictionary,
      translateMode,
      mimeType
    });

    // Save successful transcription to database
    db.addActivity(resultText, true);

    // Notify main window to update Recent Activity
    if (mainWindow) {
      mainWindow.webContents.send('activity-updated');
    }

    return resultText;
  } catch (error) {
    console.error(`${translateMode ? 'Translation' : 'Transcription'} error:`, error);
    
    // Save failed transcription to database
    db.addActivity(`${translateMode ? 'Translation' : 'Transcription'} failed: ${error.message}`, false, error.message);
    
    // Notify main window to update Recent Activity
    if (mainWindow) {
      mainWindow.webContents.send('activity-updated');
    }
    
    throw error;
  }
});

ipcMain.handle("type-text", async (event, text) => {
  try {
    if (process.platform === "darwin") {
      // macOS: Use clipboard method with comprehensive preservation
      const originalClipboardData = await saveCompleteClipboard();
      
      try {
        // Set our text to clipboard
        clipboard.writeText(text);
        console.log("Text copied to clipboard:", JSON.stringify(text));
        
        // Try text insertion only when Accessibility permission is granted
        const canInsert = permissionManager.hasAccessibilityPermission();
        if (canInsert) {
          await performTextInsertion();
        }
        
        // Restore original clipboard content after a short delay
        setTimeout(async () => {
          await restoreCompleteClipboard(originalClipboardData);
        }, 500);
        
        // Provide user feedback based on clipboard complexity
        let message = canInsert
          ? "Text inserted automatically (clipboard preserved)."
          : "Text copied to clipboard. Press Cmd+V to paste.";
        if (originalClipboardData.isComplexContent) {
          message = "Text inserted automatically. Note: complex clipboard content may be partially restored.";
        }
        
        return {
          success: true,
          method: canInsert ? "clipboard_textinsert" : "clipboard",
          message: message,
        };
      } catch (insertError) {
        console.log("Text insertion failed, user needs to paste manually:", insertError.message);
        
        // If text insertion failed, we should still restore clipboard
        setTimeout(async () => {
          await restoreCompleteClipboard(originalClipboardData);
        }, 100);
        
        return {
          success: true,
          method: "clipboard",
          message: "Text copied to clipboard. Press Cmd+V to paste.",
        };
      }
    } else if (process.platform === "win32") {
      // Windows: Try koffi text insertion first, fallback to clipboard
      if (windowsTextInserter) {
        try {
          console.log("Attempting Windows text insertion via koffi:", JSON.stringify(text));
          await windowsTextInserter.insertText(text);
          
          return {
            success: true,
            method: "koffi_sendinput",
            message: "Text inserted directly via Windows API.",
          };
        } catch (koffiError) {
          console.error("Windows koffi text insertion failed:", koffiError);
          
          // Fallback to clipboard if koffi fails
          clipboard.writeText(text);
          return {
            success: true,
            method: "clipboard",
            message: "Direct text insertion failed, text copied to clipboard. Press Ctrl+V to paste.",
          };
        }
      } else {
        // No koffi available, use clipboard
        clipboard.writeText(text);
        return {
          success: true,
          method: "clipboard",
          message: "Text copied to clipboard. Press Ctrl+V to paste.",
        };
      }
    } else {
      // Other platforms: fallback to clipboard
      clipboard.writeText(text);
      return {
        success: true,
        method: "clipboard",
        message: "Text copied to clipboard. Press Ctrl+V to paste.",
      };
    }
  } catch (error) {
    console.error("Failed to process text:", error);
    throw error;
  }
});

// Function to perform text insertion using keyboard shortcut
async function performTextInsertion() {
  return new Promise((resolve, reject) => {
    // AppleScript to simulate Cmd+V
    const script = `
      tell application "System Events"
        delay 0.05
        keystroke "v" using command down
      end tell
    `;
    
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error("Text insertion error:", error.message);
        reject(new Error(`Text insertion failed: ${error.message}`));
        return;
      }
      if (stderr) {
        console.warn("Text insertion stderr:", stderr);
      }
      // AppleScript executed successfully, but we can't verify if text was actually inserted
      resolve();
    });
  });
}

ipcMain.handle("show-permission-dialog", async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Text Insertion Permission",
    message: "WhispLine needs permission to insert text into applications.",
    detail:
      "The app will copy text to your clipboard as a fallback method. You can manually paste the transcribed text where needed.",
    buttons: ["Continue with Clipboard", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });

  return result.response;
});

// Check accessibility permission status
ipcMain.handle("check-accessibility-permission", async () => {
  return permissionManager.getAccessibilityPermissionStatus();
});

// Request accessibility permission
ipcMain.handle("request-accessibility-permission", async () => {
  return await permissionManager.requestAccessibilityPermission();
});

// Manual recheck accessibility permission (for settings page button)
ipcMain.handle("recheck-accessibility-permission", async () => {
  console.log("Manual accessibility permission recheck requested");
  const hasPermission = await permissionManager.recheckAccessibilityPermission();
  return {
    granted: hasPermission,
    status: hasPermission ? "granted" : "denied",
  };
});

// Get recent activities
ipcMain.handle("get-recent-activities", async (event) => {
  try {
    return db.getActivities();
  } catch (error) {
    console.error("Error getting recent activities:", error);
    return [];
  }
});

// Get app version using Electron's official API
ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

// Dictionary-related IPC handlers
ipcMain.handle("get-dictionary", async (event) => {
  try {
    return store.get("dictionary", "");
  } catch (error) {
    console.error("Error getting dictionary:", error);
    return "";
  }
});

ipcMain.handle("save-dictionary", async (event, text) => {
  try {
    store.set("dictionary", text);
    return true;
  } catch (error) {
    console.error("Error saving dictionary:", error);
    throw error;
  }
});

// Function to save complete clipboard content using Electron APIs
async function saveCompleteClipboard() {
  const formats = clipboard.availableFormats();
  const data = { formats };

  // Standard formats - just read them directly like old code
  data.text = clipboard.readText();
  data.html = clipboard.readHTML();
  data.rtf = clipboard.readRTF();
  data.image = clipboard.readImage();

  // macOS-specific formats
  if (process.platform === 'darwin') {
    try {
      data.bookmark = clipboard.readBookmark();
    } catch (e) {}
    
    try {
      data.findText = clipboard.readFindText();
    } catch (e) {}
  }

  // Custom formats - read all available formats as buffers
  data.customFormats = {};
  for (const format of formats) {
    try {
      data.customFormats[format] = clipboard.readBuffer(format);
    } catch (e) {}
  }

  // Simple check for complex content
  data.isComplexContent = formats.length > 5;

  console.log("Original clipboard saved with formats:", formats);
  return data;
}

// Function to restore complete clipboard content
async function restoreCompleteClipboard(clipboardData) {
  if (!clipboardData || !clipboardData.formats || clipboardData.formats.length === 0) {
    return;
  }

  try {
    clipboard.clear();

    // Restore standard formats - just like old code
    const dataToWrite = {};
    if (clipboardData.text) dataToWrite.text = clipboardData.text;
    if (clipboardData.html) dataToWrite.html = clipboardData.html;
    if (clipboardData.rtf) dataToWrite.rtf = clipboardData.rtf;
    if (clipboardData.image && !clipboardData.image.isEmpty()) {
      dataToWrite.image = clipboardData.image;
    }
    if (clipboardData.bookmark) dataToWrite.bookmark = clipboardData.bookmark;

    if (Object.keys(dataToWrite).length > 0) {
      clipboard.write(dataToWrite);
    }

    // macOS find text
    if (process.platform === 'darwin' && clipboardData.findText) {
      try {
        clipboard.writeFindText(clipboardData.findText);
      } catch (e) {}
    }

    // Restore all custom formats
    if (clipboardData.customFormats) {
      for (const [format, buffer] of Object.entries(clipboardData.customFormats)) {
        try {
          clipboard.writeBuffer(format, buffer);
        } catch (e) {}
      }
    }

    console.log("Original clipboard restored");

  } catch (error) {
    // Fallback to text only
    if (clipboardData.text) {
      try {
        clipboard.writeText(clipboardData.text);
      } catch (e) {}
    }
  }
}
