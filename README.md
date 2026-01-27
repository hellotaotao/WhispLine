# WhispLine

A voice input method software built with Electron that allows you to dictate text in any application using hotkeys and AI transcription.

## Features

- **Hold-to-Record Hotkey**: Hold down Ctrl+Shift to start recording, release to stop and transcribe
- **Real-time Audio Visualization**: Beautiful waveform animation while recording
- **AI Transcription**: Uses Groq's Whisper API for accurate speech-to-text
- **Auto-typing**: Automatically types transcribed text into active application (macOS)
- **Cross-platform**: Works on macOS, Windows, and Linux
- **Background Operation**: Runs silently in the system tray
- **Customizable Settings**: Configure API key, microphone, and languages
- **Auto-Update**: Automatically checks for and installs updates (production builds only)

## Installation

1. Clone this repository
2. Install dependencies: `npm install`
3. Configure your Groq API key in settings
4. Start the application: `npm start`

## Usage

1. Launch WhispLine
2. Configure your Groq API key in Settings
3. Hold down Ctrl+Shift to start recording
4. Speak into your microphone while holding the keys
5. Release the keys to stop recording and transcribe
6. Text will be automatically typed into the active application
7. Press Escape to cancel recording or in-progress transcription

## Configuration

Access settings through the system tray menu or main window to configure:
- API Key for transcription service
- Global hotkey combinations
- Default microphone
- Transcription language

## Auto-Update

WhispLine includes automatic update functionality that:
- Checks for updates on app startup (production builds only)
- Notifies you when a new version is available
- Downloads and installs updates with your permission
- Can be manually triggered via the "Check for Updates" menu item or button in the main window

**Note**: Auto-update only works in production builds. Development mode (using `npm run dev`) does not check for updates.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## Publishing Releases

To enable auto-update functionality for users:

1. Build the app using `npm run build`
2. Create a new release on GitHub with a version tag (e.g., `v1.0.78`)
3. Upload the built artifacts from the `dist/` folder to the GitHub release
4. The auto-updater will automatically detect and download new releases for users

The app uses GitHub Releases as the update server. Each new release should include:
- macOS: `.dmg` file
- Windows: `.exe` installer
- Linux: `.AppImage` file

**Note**: For auto-update to work properly, ensure the `version` field in `package.json` matches the release tag on GitHub.

## Console Character Encoding (Windows)

On Windows, the console may display non-English characters as garbled text due to PowerShell/CMD output encoding settings.

**Solution**:
Set UTF-8 encoding in your terminal before running the application:
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
npm run dev
```

**Note**:
- This only affects development console output, not application functionality
- Transcribed text displays correctly in the application UI and when inserted into other software
- This is a Windows terminal limitation, not an application code issue

## Reset macOS permissions for repeated testing
```
tccutil reset Accessibility com.tao.WhispLine
tccutil reset Microphone com.tao.WhispLine
```

## Requirements

- Node.js 16 or higher
- Valid Groq API key
- Microphone access permission

## License

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
