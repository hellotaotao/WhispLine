const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen, clipboard, dialog } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const Store = require('electron-store');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const store = new Store();
let mainWindow;
let settingsWindow;
let inputPromptWindow;
let tray;

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
      contextIsolation: false
    },
    show: false,
    icon: path.join(__dirname, '../assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'views/main.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
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
    height: 700,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    resizable: false,
    show: false
  });

  settingsWindow.loadFile(path.join(__dirname, 'views/settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });
}

function createInputPromptWindow() {
  const displays = screen.getAllDisplays();
  const primaryDisplay = displays.find(display => display.bounds.x === 0 && display.bounds.y === 0) || displays[0];
  
  const windowWidth = 400;
  const windowHeight = 100;
  const x = Math.round(primaryDisplay.bounds.x + (primaryDisplay.bounds.width / 2) - (windowWidth / 2));
  const y = Math.round(primaryDisplay.bounds.y + primaryDisplay.bounds.height - windowHeight - 100);

  inputPromptWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: false
  });

  inputPromptWindow.loadFile(path.join(__dirname, 'views/input-prompt.html'));
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, '../assets/tray-icon.png'));
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Main Window',
        click: () => {
          mainWindow.show();
        }
      },
      {
        label: 'Settings',
        click: () => {
          createSettingsWindow();
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip('FluidInput');
    
    tray.on('double-click', () => {
      mainWindow.show();
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function setupGlobalHotkeys() {
  try {
    // Register keyboard event listeners
    uIOhook.on('keydown', (e) => {
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
          inputPromptWindow.webContents.send('start-recording');
        }
      }
    });
    
    uIOhook.on('keyup', (e) => {
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
          inputPromptWindow.webContents.send('stop-recording');
        }
      }
    });
    
    // Start the global hook
    uIOhook.start();
    console.log('Global hotkey listener started');
    
  } catch (error) {
    console.error('Failed to setup global hotkeys:', error);
  }
}

function stopGlobalHotkeys() {
  try {
    uIOhook.stop();
    console.log('Global hotkey listener stopped');
  } catch (error) {
    console.error('Failed to stop global hotkeys:', error);
  }
}

app.whenReady().then(() => {
  createMainWindow();
  createInputPromptWindow();
  createTray();
  setupGlobalHotkeys();
  
  // Show main window on startup
  mainWindow.show();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopGlobalHotkeys();
  globalShortcut.unregisterAll();
});

// IPC handlers
ipcMain.handle('get-settings', () => {
  return {
    apiKey: store.get('apiKey', ''),
    shortcut: 'Ctrl+Shift (hold down)', // Fixed hotkey, not customizable
    language: store.get('language', 'en'),
    microphone: store.get('microphone', 'default')
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  store.set('apiKey', settings.apiKey);
  store.set('shortcut', settings.shortcut);
  store.set('language', settings.language);
  store.set('microphone', settings.microphone);
  
  // Note: uiohook doesn't need re-registration like globalShortcut
  // The hotkey combination is hardcoded to Ctrl+Shift
  
  return true;
});

ipcMain.handle('open-settings', () => {
  createSettingsWindow();
});

ipcMain.handle('hide-input-prompt', () => {
  if (inputPromptWindow) {
    inputPromptWindow.hide();
  }
});

ipcMain.handle('transcribe-audio', async (event, audioBuffer) => {
  const Groq = require('groq-sdk');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  
  try {
    const apiKey = store.get('apiKey');
    if (!apiKey) {
      throw new Error('API key not configured');
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
    console.error('Transcription error:', error);
    throw error;
  }
});

ipcMain.handle('type-text', async (event, text) => {
  try {
    // Always copy to clipboard first as a reliable fallback
    clipboard.writeText(text);
    
    // On macOS, try to use AppleScript if accessibility is enabled
    if (process.platform === 'darwin') {
      try {
        // Test if we have accessibility permissions first
        const testScript = `osascript -e 'tell application "System Events" to return true'`;
        
        await new Promise((resolve, reject) => {
          exec(testScript, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve(true);
            }
          });
        });
        
        // If test passes, try to type the text
        const escapedText = text.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
        const script = `osascript -e 'tell application "System Events" to keystroke "${escapedText}"'`;
        
        await new Promise((resolve, reject) => {
          exec(script, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve(true);
            }
          });
        });
        
        return { success: true, method: 'typed' };
        
      } catch (appleScriptError) {
        console.log('AppleScript not available, text copied to clipboard');
        return { 
          success: true, 
          method: 'clipboard',
          message: 'Text copied to clipboard. To enable auto-typing, grant accessibility permissions in System Preferences > Security & Privacy > Accessibility.'
        };
      }
    } else {
      // For other platforms, clipboard is the primary method
      return { success: true, method: 'clipboard' };
    }
  } catch (error) {
    console.error('Failed to handle text:', error);
    throw error;
  }
});

ipcMain.handle('show-permission-dialog', async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Accessibility Permission Required',
    message: 'To enable automatic text typing, FluidInput needs accessibility permissions.',
    detail: 'Please go to System Preferences > Security & Privacy > Privacy > Accessibility and add FluidInput to the list of allowed applications.',
    buttons: ['Open System Preferences', 'Continue with Clipboard Only', 'Cancel'],
    defaultId: 0,
    cancelId: 2
  });
  
  if (result.response === 0) {
    // Open System Preferences
    exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
  }
  
  return result.response;
});
