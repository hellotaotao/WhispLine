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
        click: async () => {
          app.isQuitting = true;
          await stopGlobalHotkeys(); // Stop hotkeys before quitting
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
          inputPromptWindow.showInactive();
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
    message: "FluidInput needs accessibility permission to capture global keyboard shortcuts (Ctrl+Shift) and insert transcribed text automatically.",
    detail: "Please grant accessibility permission in System Preferences to use global keyboard shortcuts and automatic text insertion.\n\nThe app will work with microphone-only mode and manual pasting if you prefer not to grant this permission.",
    buttons: ["Open System Preferences", "Continue without shortcuts", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });

  if (result.response === 0) {
    // Open accessibility preferences
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
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
          exec('pkill -f "FluidInput Helper"', (err) => {
            if (err) console.log("No FluidInput Helper processes found to kill");
            else console.log("Force killed FluidInput Helper processes");
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

  try {
    // First check if we already have permission
    const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
    if (hasPermission) {
      console.log("Accessibility permission already granted");
      return true;
    }

    // Skip permission request in development mode
    if (isDevelopment) {
      console.log("Development mode: skipping accessibility permission check");
      return true;
    }

    // Only show dialog if we don't have permission and not in dev mode
    const result = await dialog.showMessageBox(null, {
      type: "warning",
      title: "Accessibility Permission Required",
      message: "FluidInput needs accessibility permission to capture global keyboard shortcuts and insert transcribed text automatically.",
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
      console.log("Microphone permission status:", status);
      
      if (status === 'granted') {
        console.log("Microphone permission already granted");
        return true;
      }
      
      if (status === 'denied') {
        const result = await dialog.showMessageBox(null, {
          type: "warning",
          title: "Microphone Permission Required",
          message: "FluidInput needs microphone access to transcribe your voice.",
          detail: "Please grant microphone permission in System Preferences > Privacy & Security > Microphone.",
          buttons: ["Open System Preferences", "Quit"],
          defaultId: 0,
          cancelId: 1,
        });

        if (result.response === 0) {
          // Open system preferences
          exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"');
        }
        
        app.quit();
        return false;
      }
      
      if (status === 'not-determined' && !isDevelopment) {
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
  // Only check microphone permission at startup
  const hasMicrophonePermission = await checkMicrophonePermissions();
  if (!hasMicrophonePermission) {
    return; // App will quit if permission denied
  }

  // Set up application menu to enable standard editing shortcuts
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
          label: "Quit FluidInput",
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
  setTimeout(() => {
    createMainWindow();
    createInputPromptWindow();
    createTray();
    setupGlobalHotkeys();

    // Register global shortcut for settings
    globalShortcut.register(process.platform === "darwin" ? "Command+," : "Ctrl+,", () => {
      createSettingsWindow();
    });

    // Show main window on startup
    mainWindow.show();
  }, 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
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
    console.log("type-text called with:", JSON.stringify(text));
    
    if (process.platform === "darwin") {
      // Use clipboard method with comprehensive preservation
      // Save all clipboard formats (text, image, files, etc.)
      const originalClipboardData = await saveCompleteClipboard();
      console.log("Original clipboard saved with formats:", originalClipboardData.formats);
      
      try {
        // Set our text to clipboard
        clipboard.writeText(text);
        console.log("Text copied to clipboard:", JSON.stringify(text));
        
        // Verify clipboard content
        const clipboardCheck = clipboard.readText();
        console.log("Clipboard verification:", JSON.stringify(clipboardCheck));
        
        // Try auto-paste
        await performAutoPaste();
        
        // Restore original clipboard content after a short delay
        setTimeout(async () => {
          await restoreCompleteClipboard(originalClipboardData);
          console.log("Original clipboard fully restored");
        }, 500);
        
        // Provide user feedback based on clipboard complexity
        let message = "Text pasted automatically (clipboard preserved).";
        if (originalClipboardData.hasComplex || originalClipboardData.isComplexContent) {
          message = "Text pasted automatically. Note: complex clipboard content may be partially restored.";
        }
        
        return {
          success: true,
          method: "clipboard_autopaste",
          message: message,
        };
      } catch (pasteError) {
        console.log("Auto-paste failed, user needs to paste manually:", pasteError.message);
        
        // If auto-paste failed, we should still restore clipboard
        setTimeout(async () => {
          await restoreCompleteClipboard(originalClipboardData);
          console.log("Original clipboard fully restored after paste failure");
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

// Function to perform automatic paste using keyboard shortcut
async function performAutoPaste() {
  return new Promise((resolve, reject) => {
    console.log("Performing auto-paste...");
    // AppleScript to simulate Cmd+V
    const script = `
      tell application "System Events"
        delay 0.1
        keystroke "v" using command down
      end tell
    `;
    
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error("Auto-paste error:", error.message);
        reject(new Error(`Auto-paste failed: ${error.message}`));
        return;
      }
      if (stderr) {
        console.warn("Auto-paste stderr:", stderr);
      }
      console.log("Auto-paste completed successfully");
      resolve();
    });
  });
}

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

// Get recent activities
ipcMain.handle("get-recent-activities", async (event) => {
  try {
    return db.getActivities();
  } catch (error) {
    console.error("Error getting recent activities:", error);
    return [];
  }
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

// Function to save complete clipboard content (all formats)
async function saveCompleteClipboard() {
  return new Promise((resolve, reject) => {
    // Use a more comprehensive AppleScript to handle complex clipboard data
    const script = `
      on run
        set clipboardInfo to {}
        set formatList to {}
        
        try
          -- Try to get all available types/formats
          tell application "System Events"
            set clipboardTypes to clipboard info
            repeat with aType in clipboardTypes
              set end of formatList to (aType as string)
            end repeat
          end tell
        on error
          -- Fallback format detection
        end try
        
        -- Check for standard formats
        set hasText to false
        set hasImage to false
        set hasRTF to false
        set hasHTML to false
        set hasFiles to false
        set hasOther to false
        
        try
          set textData to the clipboard as text
          set hasText to true
        end try
        
        try
          set imageData to the clipboard as «class TIFF»
          set hasImage to true
        end try
        
        try
          set rtfData to the clipboard as «class RTF »
          set hasRTF to true
        end try
        
        try
          set htmlData to the clipboard as «class HTML»
          set hasHTML to true
        end try
        
        try
          set fileData to the clipboard as «class furl»
          set hasFiles to true
        end try
        
        -- Check for other complex formats (Notes, audio, etc.)
        if (count of formatList) > 0 then
          repeat with aFormat in formatList
            if aFormat contains "NSStringPboardType" or aFormat contains "public.utf8-plain-text" then
              -- Text format
            else if aFormat contains "public.tiff" or aFormat contains "public.jpeg" then
              -- Image format
            else if aFormat contains "public.rtf" then
              -- RTF format
            else if aFormat contains "public.html" then
              -- HTML format
            else if aFormat contains "public.file-url" then
              -- File format
            else
              -- Other complex format detected
              set hasOther to true
            end if
          end repeat
        end if
        
        set result to ""
        if hasText then set result to result & "text,"
        if hasImage then set result to result & "image,"
        if hasRTF then set result to result & "rtf,"
        if hasHTML then set result to result & "html,"
        if hasFiles then set result to result & "files,"
        if hasOther then set result to result & "complex,"
        
        return result
      end run
    `;
    
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.warn("Failed to detect clipboard formats, using fallback method");
        // Enhanced fallback - use Node.js clipboard with multiple attempts
        const clipboardData = performEnhancedClipboardBackup();
        resolve(clipboardData);
        return;
      }
      
      const formats = stdout.trim().split(',').map(f => f.trim()).filter(f => f);
      console.log("Detected clipboard formats:", formats);
      
      const clipboardData = {
        formats: formats,
        hasText: formats.includes('text'),
        hasImage: formats.includes('image'),
        hasRTF: formats.includes('rtf'),
        hasHTML: formats.includes('html'),
        hasFiles: formats.includes('files'),
        hasComplex: formats.includes('complex'),
        timestamp: Date.now()
      };
      
      // Save different types of data
      try {
        if (clipboardData.hasText) {
          clipboardData.text = clipboard.readText();
        }
        if (clipboardData.hasImage) {
          clipboardData.image = clipboard.readImage();
        }
        if (clipboardData.hasHTML) {
          clipboardData.html = clipboard.readHTML();
        }
        if (clipboardData.hasRTF) {
          clipboardData.rtf = clipboard.readRTF();
        }
      } catch (saveError) {
        console.warn("Error saving some clipboard formats:", saveError);
      }
      
      resolve(clipboardData);
    });
  });
}

// Enhanced fallback clipboard backup for complex scenarios
function performEnhancedClipboardBackup() {
  const clipboardData = {
    formats: [],
    hasText: false,
    hasImage: false,
    hasRTF: false,
    hasHTML: false,
    hasComplex: false,
    isComplexContent: false,
    timestamp: Date.now()
  };
  
  try {
    // Try multiple formats
    const text = clipboard.readText();
    if (text && text.length > 0) {
      clipboardData.text = text;
      clipboardData.hasText = true;
      clipboardData.formats.push('text');
    }
  } catch (e) {}
  
  try {
    const image = clipboard.readImage();
    if (image && !image.isEmpty()) {
      clipboardData.image = image;
      clipboardData.hasImage = true;
      clipboardData.formats.push('image');
    }
  } catch (e) {}
  
  try {
    const html = clipboard.readHTML();
    if (html && html.length > 0) {
      clipboardData.html = html;
      clipboardData.hasHTML = true;
      clipboardData.formats.push('html');
    }
  } catch (e) {}
  
  try {
    const rtf = clipboard.readRTF();
    if (rtf && rtf.length > 0) {
      clipboardData.rtf = rtf;
      clipboardData.hasRTF = true;
      clipboardData.formats.push('rtf');
    }
  } catch (e) {}
  
  // If we can't read any standard formats but there's something in clipboard,
  // it's probably complex content
  if (clipboardData.formats.length === 0) {
    clipboardData.isComplexContent = true;
    clipboardData.hasComplex = true;
    clipboardData.formats.push('complex');
  }
  
  return clipboardData;
}

// Function to restore complete clipboard content
async function restoreCompleteClipboard(clipboardData) {
  return new Promise((resolve, reject) => {
    if (!clipboardData || clipboardData.formats.length === 0) {
      console.log("No clipboard data to restore");
      resolve();
      return;
    }
    
    console.log("Attempting to restore clipboard with formats:", clipboardData.formats);
    
    try {
      // For complex content that we can't handle properly, use AppleScript workaround
      if (clipboardData.hasComplex || clipboardData.isComplexContent) {
        console.log("Detected complex content, using alternative restoration method");
        
        // Use a different approach: temporarily write to pasteboard using AppleScript
        const restoreScript = `
          tell application "System Events"
            -- For complex content, we can't perfectly restore it
            -- So we'll restore the best available format
            delay 0.1
          end tell
        `;
        
        exec(`osascript -e '${restoreScript}'`, (error) => {
          if (error) {
            console.warn("Complex content restore script failed:", error.message);
          }
          
          // Try to restore the best available simple format
          restoreSimpleFormat(clipboardData);
          resolve();
        });
        
        return;
      }
      
      // Standard restoration for simple formats
      restoreSimpleFormat(clipboardData);
      resolve();
      
    } catch (error) {
      console.error("Failed to restore clipboard:", error);
      // Fallback to text only
      restoreSimpleFormat(clipboardData);
      resolve(); // Don't reject, just log the error
    }
  });
}

// Helper function to restore simple formats
function restoreSimpleFormat(clipboardData) {
  try {
    // Restore in priority order: image > rtf > html > text
    if (clipboardData.hasImage && clipboardData.image) {
      console.log("Restoring image to clipboard");
      clipboard.writeImage(clipboardData.image);
    } else if (clipboardData.hasRTF && clipboardData.rtf) {
      console.log("Restoring RTF to clipboard");
      clipboard.writeRTF(clipboardData.rtf);
    } else if (clipboardData.hasHTML && clipboardData.html) {
      console.log("Restoring HTML to clipboard");
      clipboard.writeHTML(clipboardData.html);
    } else if (clipboardData.hasText && clipboardData.text) {
      console.log("Restoring text to clipboard");
      clipboard.writeText(clipboardData.text);
    } else {
      console.log("No restorable format found, clipboard may remain empty");
    }
  } catch (error) {
    console.error("Failed to restore simple format:", error);
    // Last resort: try text only
    if (clipboardData.hasText && clipboardData.text) {
      try {
        clipboard.writeText(clipboardData.text);
        console.log("Fallback: restored text to clipboard");
      } catch (textError) {
        console.error("Failed to restore even text:", textError);
      }
    }
  }
}
