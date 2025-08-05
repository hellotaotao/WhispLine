# WhispLine AI Coding Instructions

This document provides guidance for AI agents working on the WhispLine codebase.

## Architecture Overview

WhispLine is an Electron-based voice input application that transcribes speech to text using the Groq API. It runs as a system tray application and uses global hotkeys for voice recording.

### Core Components:

- **`src/main.js`**: The Electron main process. It manages the application's lifecycle, windows, system tray, global hotkeys, and IPC channels. This is the central coordination point of the application.
- **`src/views/*.html`**: The renderer processes for the UI.
  - `main.html`: The primary (but hidden) application window.
  - `settings.html`: The user-facing settings panel for API keys and other configurations.
  - `input-prompt.html`: A borderless overlay window for visualizing audio input during recording.
- **`src/permission-manager.js`**: A client-side module responsible for handling microphone and accessibility permissions, which are critical for the app's functionality.
- **`electron-store`**: Used for persistent storage of user settings.

### Key Architectural Patterns:

- **Multi-Window Architecture**: The application uses several specialized windows. The main process is responsible for creating, showing, and hiding these windows in response to user actions (like clicking the tray icon or using a hotkey).
- **Global Hotkey System**: `uiohook-napi` is used to capture global keyboard events (`Ctrl+Shift` for hold-to-record). This is a native dependency and a key feature.
- **IPC Communication**: The application relies on `ipcMain.handle()` and `ipcRenderer.invoke()` for communication between the main process and the various renderer windows. For example, the input prompt window is shown and hidden via IPC calls from the main process.
- **Text Insertion Fallback**: The application attempts to type transcribed text directly. If it lacks the necessary permissions (especially on macOS), it falls back to copying the text to the clipboard.

## Developer Workflows

### Setup and Running

- **Install dependencies**: `npm install`
- **Run in development mode**: `npm run dev`
- **Run in production mode**: `npm start`

### Building the Application

- **Build for all platforms**: `npm run build`
- **Build for a specific platform**:
  - `npm run build:mac`
  - `npm run build:win`
  - `npm run build:linux`

### Debugging Permissions on macOS

To test the permission granting flow repeatedly, you can reset the permissions using these terminal commands:

```bash
tccutil reset Accessibility com.tao.WhispLine
tccutil reset Microphone com.tao.WhispLine
```

## Critical Dependencies

- **`electron`**: The core framework for the application.
- **`groq-sdk`**: The SDK for interacting with the Groq API for speech-to-text transcription.
- **`uiohook-napi`**: For global keyboard event listening. This is a native module and may have platform-specific considerations.
- **`electron-store`**: For persisting user settings.

When working on this codebase, pay close attention to the interactions between the main process and the renderer windows, the global hotkey implementation, and the platform-specific permission handling.
