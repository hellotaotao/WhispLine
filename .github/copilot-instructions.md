# WhispLine – AI Coding Instructions

Concise guidance for AI agents to be productive in this codebase.

## Big picture
- Electron tray app for hold-to-record voice dictation. Global hotkeys via `uiohook-napi`: hold Ctrl+Shift to record; Shift+Alt for English output (translate mode).
- Data flow: hotkey → show `input-prompt.html` → `getUserMedia` + `MediaRecorder` → Blob → `ipcRenderer.invoke("transcribe-audio", buffer, translateMode, mimeType)` → main `transcription-service.js` → provider SDK (Groq/OpenAI) → text → `type-text` with clipboard-based insertion → activity persisted.

## Key files
- `src/main.js`: windows/tray lifecycle, hotkeys, and IPC handlers:
  - transcribe: `ipcMain.handle("transcribe-audio")`
  - text insertion: `ipcMain.handle("type-text")`
  - prompt visibility/cleanup: `hide-input-prompt`, `cleanup-microphone`
- `src/views/input-prompt.html`: recording UI + audio capture. Chooses `mimeType` (prefers `audio/mp4` if supported else `audio/webm;codecs=opus`), accumulates chunks, sends to main.
- `src/services/transcription-service.js`: writes a temp file in `os.tmpdir()`; picks extension from MIME (`.m4a`/`.webm`/`.wav`), selects model, delegates to provider, cleans up.
- Providers:
  - `src/services/groq-transcription.js`: `whisper-large-v3(-turbo)`, uses `groq-sdk` (`audio.transcriptions/translations`).
  - `src/services/openai-transcription.js`: `whisper-1`, `gpt-4o(-mini)-transcribe`, via `openai` SDK.
- `src/permission-manager.js`: mic + Accessibility checks (macOS). Text insertion on macOS uses clipboard save/restore and AppleScript Cmd+V.
- `src/database-manager.js`: persists transcription activity; main notifies `activity-updated`.

## Conventions and behavior
- Settings via `electron-store`: keys like `provider` (default `groq`), `model` (e.g., `whisper-large-v3-turbo`), `language`, `dictionary`, `apiKeyGroq`, `apiKeyOpenAI`.
- Translate mode forces model: OpenAI → `whisper-1`; Groq → `whisper-large-v3`. Otherwise use stored `model`.
- Audio is not transcoded; temp-file extension must match MIME. Renderer passes actual `recordingMimeType` with the buffer.
- IPC is the contract between main and renderers—do not change channel names casually.

## Developer workflows
- Install/run: `npm install`; dev: `npm run dev`; prod: `npm start` (VS Code task: “Start WhispLine”).
- Build: `npm run build` (or platform-specific scripts if present).
- macOS permissions reset to re-test flows:
  - `tccutil reset Accessibility com.tao.WhispLine`
  - `tccutil reset Microphone com.tao.WhispLine`

## Integration notes
- Audio formats: `audio/mp4` (m4a/AAC) or `audio/webm;codecs=opus` (WebM/Opus) from renderer; both accepted by Groq/OpenAI. Prefer consistent MIME at the recorder to avoid mismatched extensions.
- Native deps: `uiohook-napi` is native; rebuilds may be needed across platforms.

## When adding features
- Respect existing IPC channels and window responsibilities. If adding settings, wire through `electron-store` and `settings.html`.
- For new transcription models, update provider `getSupportedModels()` and ensure `transcription-service` mapping (translate mode) stays coherent.
- Keep temporary-file handling and cleanup intact; avoid blocking the main thread.
