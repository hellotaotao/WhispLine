# FluidInput

A voice input method software built with Electron that allows you to dictate text in any application using hotkeys and AI transcription.

## Features

- **Global Hotkey Support**: Press Ctrl+Shift+V to start voice input from anywhere
- **Real-time Audio Visualization**: Beautiful waveform animation while recording
- **AI Transcription**: Uses Groq's Whisper API for accurate speech-to-text
- **Cross-platform**: Works on macOS, Windows, and Linux
- **Background Operation**: Runs silently in the system tray
- **Customizable Settings**: Configure hotkeys, microphone, and languages

## Installation

1. Clone this repository
2. Install dependencies: `npm install`
3. Configure your Groq API key in settings
4. Start the application: `npm start`

## Usage

1. Launch FluidInput
2. Configure your Groq API key in Settings
3. Press the hotkey (default: Ctrl+Shift+V) to start recording
4. Speak into your microphone
5. Release the hotkey to stop recording and transcribe

## Configuration

Access settings through the system tray menu or main window to configure:
- API Key for transcription service
- Global hotkey combinations
- Default microphone
- Transcription language

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## Requirements

- Node.js 16 or higher
- Valid Groq API key
- Microphone access permission

## License

MIT License
