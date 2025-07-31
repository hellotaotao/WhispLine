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
const { default: Store } = require("electron-store");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const DatabaseManager = require("./database-manager");

const store = new Store();
const db = new DatabaseManager();
const isDevelopment = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
let mainWindow;
let settingsWindow;
let inputPromptWindow;
let tray;
let hookStarted = false; // Track if hook is started
let currentAccessibilityPermission = false; // Track current accessibility permission state

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

  // Add window focus event listener for dynamic permission detection
  // Note: This provides additional coverage beyond app.on("activate") for edge cases
  // where user might return to main window without app activation event
  mainWindow.on("focus", async () => {
    // Only recheck if we don't currently have permission (optimize for common case)
    if (!currentAccessibilityPermission) {
      await recheckAccessibilityPermission();
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
    await recheckAccessibilityPermission();
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
      const hasPermission = await checkAccessibilityPermissions();
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
        // Check microphone permission before starting recording
        checkAndRequestMicrophonePermission().then(hasPermission => {
          if (hasPermission) {
            isRecording = true;
            if (inputPromptWindow) {
              inputPromptWindow.showInactive();
              inputPromptWindow.webContents.send("start-recording");
            }
          } else {
            console.log("Recording cancelled due to lack of microphone permission");
          }
        }).catch(error => {
          console.error("Error checking microphone permission:", error);
        });
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
        // Only show permission dialog when we actually encounter a permission error
        showAccessibilityPermissionDialog();
      }
    });

    // Start the global hook
    uIOhook.start();
    hookStarted = true;
    console.log("Global hotkey listener started successfully");
  } catch (error) {
    console.error("Failed to setup global hotkeys:", error);
    hookStarted = false;
    
    if (process.platform === "darwin" && error.message && error.message.includes("accessibility")) {
      // Only show permission dialog when we actually encounter a permission error
      showAccessibilityPermissionDialog();
    }
  }
}

// Show accessibility permission dialog only when needed
async function showAccessibilityPermissionDialog() {
  const result = await dialog.showMessageBox(null, {
    type: "warning",
    title: "Accessibility Permission Required",
    message: "WhispLine needs accessibility permission to capture global keyboard shortcuts (Ctrl+Shift) and insert transcribed text automatically.",
    detail: "Please grant accessibility permission in System Preferences to use global keyboard shortcuts and automatic text insertion.\n\nThe app will work with microphone-only mode and manual pasting if you prefer not to grant this permission.",
    buttons: ["Open System Preferences", "Continue without shortcuts", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });

  if (result.response === 0) {
    // Open accessibility preferences
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
    
    // Set up a timer to periodically check for permission changes
    // This will help detect when user grants permission in System Preferences
    const checkInterval = setInterval(async () => {
      const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
      if (hasPermission) {
        console.log("Permission detected! Updating hotkey status...");
        clearInterval(checkInterval);
        await recheckAccessibilityPermission();
      }
    }, 2000); // Check every 2 seconds
    
    // Stop checking after 2 minutes to avoid infinite polling
    setTimeout(() => {
      clearInterval(checkInterval);
      console.log("Stopped automatic permission checking after timeout");
    }, 120000);
    
  } else if (result.response === 2) {
    app.quit();
  }
  // If result.response === 1, continue without global shortcuts
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
      
      // Small delay to ensure cleanup completes
      setTimeout(resolve, 100);
    } catch (error) {
      console.error("Failed to stop global hotkeys:", error);
      hookStarted = false;

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
  if (process.platform === "darwin") {
    exec('pgrep -f "WhispLine Helper"', (error, stdout) => {
      if (!error && stdout.trim()) {
        console.log(
          "Found orphaned WhispLine Helper processes, cleaning up...",
        );
        exec('pkill -f "WhispLine Helper"', (killError) => {
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
    currentAccessibilityPermission = true; // Not needed on other platforms
    return true;
  }

  try {
    // Check if we already have permission
    const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
    currentAccessibilityPermission = hasPermission; // Initialize the state
    
    if (hasPermission) {
      console.log("Accessibility permission already granted");
      return true;
    }

    // Show permission dialog
    await showAccessibilityPermissionDialog();
    return false;
  } catch (error) {
    console.error("Failed to check accessibility permissions:", error);
    currentAccessibilityPermission = false;
    return false;
  }
}

// Recheck accessibility permission and update hotkey status if needed
async function recheckAccessibilityPermission() {
  if (process.platform !== "darwin") {
    return true; // Not needed on other platforms
  }

  try {
    const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
    console.log("Rechecking accessibility permission:", hasPermission, "Previous state:", currentAccessibilityPermission);
    
    // Check if permission status has changed
    if (hasPermission !== currentAccessibilityPermission) {
      console.log(`Accessibility permission changed from ${currentAccessibilityPermission} to ${hasPermission}`);
      currentAccessibilityPermission = hasPermission;
      
      if (hasPermission && !hookStarted) {
        // Permission was granted, start hotkeys
        console.log("Permission granted! Starting hotkeys...");
        await setupGlobalHotkeys();
        
        // Notify user about hotkey activation
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('accessibility-permission-changed', {
            granted: true,
            message: 'Accessibility permission granted! Global hotkeys are now active.'
          });
        }
      } else if (!hasPermission && hookStarted) {
        // Permission was revoked, stop hotkeys
        console.log("Permission revoked! Stopping hotkeys...");
        await stopGlobalHotkeys();
        
        // Notify user about hotkey deactivation
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('accessibility-permission-changed', {
            granted: false,
            message: 'Accessibility permission revoked. Global hotkeys are disabled.'
          });
        }
      }
      
      // Update settings window if open
      if (settingsWindow && settingsWindow.webContents) {
        settingsWindow.webContents.send('permission-status-updated', {
          accessibility: hasPermission
        });
      }
    }
    
    return hasPermission;
  } catch (error) {
    console.error("Failed to recheck accessibility permissions:", error);
    return false;
  }
}

// Check and request microphone permission when actually needed
async function checkAndRequestMicrophonePermission() {
  if (process.platform !== "darwin") {
    return true; // Not needed on other platforms
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log("Checking microphone permission for recording, status:", status);
    
    if (status === 'granted') {
      console.log("Microphone permission already granted");
      return true;
    }
    
    if (status === 'not-determined') {
      console.log("Microphone permission not determined, requesting...");
      
      // Show user-friendly dialog before requesting permission
      const result = await dialog.showMessageBox(null, {
        type: "info",
        title: "Microphone Permission Required",
        message: "WhispLine needs microphone access to transcribe your voice.",
        detail: "Please grant microphone permission in the next dialog to use voice input features.",
        buttons: ["Grant Permission", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 1) {
        console.log("User cancelled permission request");
        return false;
      }

      // Request microphone access
      try {
        await systemPreferences.askForMediaAccess('microphone');
        const newStatus = systemPreferences.getMediaAccessStatus('microphone');
        console.log("Permission request completed, new status:", newStatus);
        
        if (newStatus === 'granted') {
          console.log("Microphone permission successfully granted");
          return true;
        } else {
          console.log("Microphone permission was not granted");
          await showPermissionDeniedGuidance();
          return false;
        }
      } catch (err) {
        console.error("Failed to request microphone access:", err);
        await showPermissionDeniedGuidance();
        return false;
      }
    }
    
    if (status === 'denied') {
      console.log("Microphone permission previously denied");
      await showPermissionDeniedGuidance();
      return false;
    }
    
  } catch (error) {
    console.error("Failed to check microphone permissions:", error);
    return false;
  }
  
  return false;
}

// Show guidance for manually enabling microphone permission
async function showPermissionDeniedGuidance() {
  const result = await dialog.showMessageBox(null, {
    type: "warning",
    title: "Microphone Permission Needed",
    message: "WhispLine cannot access your microphone.",
    detail: "To use voice input features, please:\n\n1. Go to System Preferences > Security & Privacy > Privacy > Microphone\n2. Enable microphone access for WhispLine\n3. Try using the voice input again\n\nAlternatively, you can continue using the app without voice input.",
    buttons: ["Open System Preferences", "Continue Without Voice"],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    // Open system preferences
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"');
  }
}

// Request initial microphone permission on startup to ensure app appears in system settings
async function requestInitialMicrophonePermission() {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log("Initial microphone permission check, status:", status);
    
    // Always request permission if not granted to ensure app is registered
    if (status !== 'granted') {
      console.log("Requesting microphone permission to register app in system settings...");
      
      try {
        // Force the system permission dialog to appear and register the app
        const granted = await systemPreferences.askForMediaAccess('microphone');
        const newStatus = systemPreferences.getMediaAccessStatus('microphone');
        console.log("Permission request completed, granted:", granted, "new status:", newStatus);
        
        if (newStatus === 'granted') {
          console.log("Microphone permission granted - app registered in system settings");
        } else if (newStatus === 'denied') {
          console.log("Microphone permission denied - app should now be visible in system settings for manual control");
        }
        
      } catch (err) {
        console.error("Failed to request initial microphone access:", err);
        // Even if request fails, the app should still be registered
        console.log("App should still be registered in system settings despite error");
      }
    } else {
      console.log("Microphone permission already granted");
    }
  } catch (error) {
    console.error("Failed to check initial microphone permissions:", error);
  }
}

app.whenReady().then(async () => {
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
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Clean up any orphaned processes first
  cleanupOrphanedProcesses();

  // Small delay to ensure cleanup completes
  setTimeout(async () => {
    createMainWindow();
    createInputPromptWindow();
    createTray();
    await setupGlobalHotkeys();

    // Request microphone permission on startup to ensure app appears in system settings
    if (process.platform === "darwin") {
      setTimeout(async () => {
        await requestInitialMicrophonePermission();
      }, 2000); // Wait for UI to be ready
    }

    // Show main window on startup
    mainWindow.show();
  }, 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      // Only recheck if we don't currently have permission (avoid unnecessary checks)
      if (!currentAccessibilityPermission) {
        recheckAccessibilityPermission();
      }
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
    shortcut: "Ctrl+Shift (hold down)", // Fixed hotkey, not customizable
    language: store.get("language", "auto"),
    model: store.get("model", "whisper-large-v3-turbo"),
    microphone: store.get("microphone", "default"),
  };
});

ipcMain.handle("save-settings", (event, settings) => {
  store.set("apiKey", settings.apiKey);
  store.set("shortcut", settings.shortcut);
  store.set("language", settings.language);
  store.set("model", settings.model);
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
    const language = store.get("language", "auto");
    const model = store.get("model", "whisper-large-v3-turbo");

    console.log(`🎙️  Using model: ${model} | Language: ${language}`);

    // Save audio buffer to temporary file
    const tempFile = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
    fs.writeFileSync(tempFile, audioBuffer);

    // Prepare transcription options
    const transcriptionOptions = {
      file: fs.createReadStream(tempFile),
      model: model,
      response_format: "verbose_json",
    };

    // Only add language parameter if it's not "auto"
    if (language !== "auto") {
      transcriptionOptions.language = language;
    }

    // Add dictionary prompt if available
    const dictionary = store.get("dictionary", "");
    if (dictionary.trim()) {
      transcriptionOptions.prompt = dictionary;
    }

    const transcription = await groq.audio.transcriptions.create(transcriptionOptions);

    // Clean up temp file
    fs.unlinkSync(tempFile);

    // Save successful transcription to database
    db.addActivity(transcription.text, true);

    // Notify main window to update Recent Activity
    if (mainWindow) {
      mainWindow.webContents.send('activity-updated');
    }

    console.log(`✅ Transcription completed: "${transcription.text}"`);

    return transcription.text;
  } catch (error) {
    console.error("Transcription error:", error);
    
    // Save failed transcription to database
    db.addActivity(`Transcription failed: ${error.message}`, false, error.message);
    
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
      // Use clipboard method with comprehensive preservation
      const originalClipboardData = await saveCompleteClipboard();
      
      try {
        // Set our text to clipboard
        clipboard.writeText(text);
        console.log("Text copied to clipboard:", JSON.stringify(text));
        
        // Try text insertion
        await performTextInsertion();
        
        // Restore original clipboard content after a short delay
        setTimeout(async () => {
          await restoreCompleteClipboard(originalClipboardData);
        }, 500);
        
        // Provide user feedback based on clipboard complexity
        let message = "Text inserted automatically (clipboard preserved).";
        if (originalClipboardData.isComplexContent) {
          message = "Text inserted automatically. Note: complex clipboard content may be partially restored.";
        }
        
        return {
          success: true,
          method: "clipboard_textinsert",
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
    } else {
      // For non-macOS platforms, fall back to clipboard
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
      console.log("Text insertion completed successfully");
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
    
    // Update our cached state
    currentAccessibilityPermission = granted;
    
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

// Manual recheck accessibility permission (for settings page button)
ipcMain.handle("recheck-accessibility-permission", async () => {
  console.log("Manual accessibility permission recheck requested");
  const hasPermission = await recheckAccessibilityPermission();
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
