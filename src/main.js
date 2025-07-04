const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen, clipboard } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let settingsWindow;
let inputPromptWindow;
let tray;

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

function registerGlobalShortcuts() {
  try {
    // Use a specific key combination for global shortcut
    const shortcut = store.get('shortcut', 'CommandOrControl+Shift+Space');
    
    globalShortcut.register(shortcut, () => {
      if (inputPromptWindow) {
        inputPromptWindow.show();
        inputPromptWindow.webContents.send('toggle-recording');
      }
    });
  } catch (error) {
    console.error('Failed to register global shortcut:', error);
  }
}

app.whenReady().then(() => {
  createMainWindow();
  createInputPromptWindow();
  createTray();
  registerGlobalShortcuts();
  
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
  globalShortcut.unregisterAll();
});

// IPC handlers
ipcMain.handle('get-settings', () => {
  return {
    apiKey: store.get('apiKey', ''),
    shortcut: store.get('shortcut', 'CommandOrControl+Shift+Space'),
    language: store.get('language', 'en'),
    microphone: store.get('microphone', 'default')
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  store.set('apiKey', settings.apiKey);
  store.set('shortcut', settings.shortcut);
  store.set('language', settings.language);
  store.set('microphone', settings.microphone);
  
  // Re-register global shortcuts
  globalShortcut.unregisterAll();
  registerGlobalShortcuts();
  
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
  // On macOS, we can use AppleScript to type text
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      // Escape the text for AppleScript
      const escapedText = text.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
      const script = `osascript -e 'tell application "System Events" to keystroke "${escapedText}"'`;
      
      exec(script, (error, stdout, stderr) => {
        if (error) {
          console.error('Failed to type text:', error);
          reject(error);
        } else {
          resolve(true);
        }
      });
    });
  } else {
    // For other platforms, just copy to clipboard
    clipboard.writeText(text);
    return true;
  }
});
