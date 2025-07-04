const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let settingsWindow;
let inputPromptWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false,
    icon: path.join(__dirname, '../assets/icon.svg')
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
    width: 600,
    height: 500,
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


function registerGlobalShortcuts() {
  const shortcut = store.get('shortcut', 'CommandOrControl+Shift+V');
  
  globalShortcut.register(shortcut, () => {
    if (inputPromptWindow) {
      inputPromptWindow.show();
      inputPromptWindow.webContents.send('start-recording');
    }
  });
}

app.whenReady().then(() => {
  createMainWindow();
  createInputPromptWindow();
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
    shortcut: store.get('shortcut', 'CommandOrControl+Shift+V'),
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
