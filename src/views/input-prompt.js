const { ipcRenderer } = require("electron");
const { initI18n, setLanguage, applyI18n, t } = window.WhispLineI18n;

const SHORT_PRESS_THRESHOLD_MS = 500;
const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const DEFAULT_TRANSLATE_SHORTCUT = "Shift+Alt";
const DEBUG_MICROPHONE_CLEANUP = false;
const themeOptions = new Set(["midnight", "elegant"]);

function resolveTheme(value) {
  return themeOptions.has(value) ? value : "elegant";
}

function applyTheme(value) {
  document.documentElement.setAttribute("data-theme", resolveTheme(value));
}

function logMicrophoneCleanup(...args) {
  if (!DEBUG_MICROPHONE_CLEANUP) {
    return;
  }
  console.log(...args);
}

class VoiceInputPrompt {
  constructor() {
    this.isRecording = false;
    this.translateMode = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.analyser = null;
    this.dataArray = null;
    this.animationId = null;
    this.starting = false;
    this.stopRequested = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;
    this.transcriptionInProgress = false;
    this.recordShortcut = DEFAULT_RECORD_SHORTCUT;
    this.translateShortcut = DEFAULT_TRANSLATE_SHORTCUT;

    this.promptElement = document.getElementById("inputPrompt");
    this.promptText = document.getElementById("promptText");
    this.waveContainer = document.getElementById("waveContainer");
    this.statusText = document.getElementById("statusText");
    this.transcriptionText = document.getElementById("transcriptionText");

    this.createWaveBars();
    this.setupEventListeners();
    this.syncShortcutFromSettings();
  }

  createWaveBars() {
    for (let i = 0; i < 16; i++) {
      const bar = document.createElement("div");
      bar.className = "wave-bar";
      bar.style.height = "3px";
      this.waveContainer.appendChild(bar);
    }
  }

  setupEventListeners() {
    ipcRenderer.on("shortcut-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      const recordShortcut = payload.recordShortcut || DEFAULT_RECORD_SHORTCUT;
      const translateShortcut =
        payload.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT;
      this.updateShortcutHint(recordShortcut, translateShortcut);
    });

    ipcRenderer.on("ui-language-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      setLanguage(payload.language);
      applyI18n(document);
      this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    });

    ipcRenderer.on("ui-theme-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      applyTheme(payload.theme);
    });

    // Listen for start recording from main process
    ipcRenderer.on("start-recording", async (event, translateMode = false) => {
      if (this.isRecording || this.starting) {
        return;
      }
      this.stopRequested = false;
      this.translateMode = translateMode;
      await this.startRecording();
    });

    // Listen for stop recording from main process
    ipcRenderer.on("stop-recording", () => {
      this.stopRequested = true;
      this.stopRecording();
    });

    ipcRenderer.on("cancel-recording", () => {
      this.cancelRecording();
    });

    // Listen for cleanup microphone signal
    ipcRenderer.on("cleanup-microphone", () => {
      console.log("Received cleanup signal from main process");
      this.cleanup();
    });

    // Legacy support for toggle recording
    ipcRenderer.on("toggle-recording", async () => {
      if (!this.isRecording) {
        await this.startRecording();
      } else {
        this.stopRecording();
      }
    });

    // ESC key to cancel recording when window is focused
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.cancelRecording();
      }
    });

    // Add window beforeunload event to ensure cleanup
    window.addEventListener("beforeunload", () => {
      this.cleanup();
    });
  }

  async syncShortcutFromSettings() {
    try {
      const settings = await ipcRenderer.invoke("get-settings");
      if (!settings) {
        return;
      }
      this.updateShortcutHint(
        settings.shortcut || DEFAULT_RECORD_SHORTCUT,
        settings.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT
      );
    } catch (error) {
      console.error("Failed to load shortcut hint settings:", error);
      this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    }
  }

  formatShortcutLabel(shortcut) {
    if (typeof shortcut !== "string") {
      return "";
    }
    const label = shortcut.replace(/\+/g, " + ");
    const isMac = window.navigator?.platform?.includes("Mac");
    return isMac ? label.replace(/Alt/g, "Option") : label;
  }

  updateShortcutHint(recordShortcut, translateShortcut) {
    if (!this.promptText) {
      return;
    }
    const safeRecordShortcut =
      recordShortcut || this.recordShortcut || DEFAULT_RECORD_SHORTCUT;
    const safeTranslateShortcut =
      translateShortcut || this.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT;
    this.recordShortcut = safeRecordShortcut;
    this.translateShortcut = safeTranslateShortcut;
    const recordLabel = this.formatShortcutLabel(safeRecordShortcut);
    const translateLabel = this.formatShortcutLabel(safeTranslateShortcut);
    this.promptText.textContent = t("inputPrompt.hint", {
      record: recordLabel,
      translate: translateLabel,
    });
  }

  async startRecording() {
    if (this.isRecording || this.starting) return;

    this.starting = true;
    try {
      // Show prompt immediately
      this.promptElement.classList.add("visible");
      this.promptText.textContent = t("inputPrompt.starting");
      this.statusText.textContent = "";

      this.audioChunks = [];

      // Create media stream directly using getUserMedia
      // In Electron, system-level permissions are handled by main process
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (this.stopRequested) {
        this.mediaStream = stream;
        this.cleanup();
        this.hidePrompt();
        return;
      }

      this.mediaStream = stream;

      // Update UI for recording state after permissions resolve
      this.promptElement.classList.add("recording");
      if (this.translateMode) {
        this.promptText.textContent = t("inputPrompt.listeningEnglish");
      } else {
        this.promptText.textContent = t("inputPrompt.listening");
      }
      this.statusText.innerHTML = `${t("inputPrompt.recording")} <div class="recording-dot"></div>`;

      // Setup audio context for visualization
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      // Setup media recorder
      // Try to use the best supported format, fallback to webm
      let mimeType = "audio/webm;codecs=opus"; // Default fallback
      if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4"; // Better compression than WebM, widely supported
      } else if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus"; // Good compression, modern browsers
      }
      
      console.log("Using audio format:", mimeType);
      this.recordingMimeType = mimeType; // Store for later use
      
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: mimeType,
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.processRecording();
      };

      this.mediaRecorder.start();
      this.recordingStartedAt = Date.now();
      this.cancelledShortPress = false;
      this.isRecording = true;
      this.startWaveAnimation();

      if (this.stopRequested) {
        this.stopRecording();
      }
    } catch (error) {
      console.error("Error starting recording:", error);
      await this.handleRecordingError(error);
    } finally {
      this.starting = false;
    }
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    const elapsedMs = this.recordingStartedAt
      ? Date.now() - this.recordingStartedAt
      : 0;
    const isShortPress = elapsedMs <= SHORT_PRESS_THRESHOLD_MS;
    const shouldCancel = this.cancelledShortPress || this.cancelInProgress || isShortPress;
    this.cancelledShortPress = shouldCancel;

    if (shouldCancel) {
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
    } else {
      this.promptText.textContent = t("inputPrompt.processing");
      this.statusText.textContent = t("inputPrompt.transcribing");
    }

    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    }

    this.cleanup({ preserveAudioChunks: true });
    this.stopWaveAnimation();
  }

  cancelRecording() {
    if (this.cancelInProgress) {
      return;
    }
    this.cancelInProgress = true;
    this.stopRequested = true;

    if (this.transcriptionInProgress) {
      ipcRenderer.invoke("cancel-transcription").catch(() => {});
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      this.cleanup();
      this.stopWaveAnimation();
      setTimeout(() => this.hidePrompt(), 300);
      return;
    }

    if (this.isRecording) {
      this.cancelledShortPress = true;
      this.stopRecording();
      return;
    }

    this.promptText.textContent = t("inputPrompt.cancelled");
    this.statusText.textContent = "";
    this.cleanup();
    this.stopWaveAnimation();
    setTimeout(() => this.hidePrompt(), 300);
  }

  cleanup(options = {}) {
    const { preserveAudioChunks = false } = options;
    logMicrophoneCleanup("Starting microphone cleanup...");
    
    // Stop all media tracks
    if (this.mediaStream) {
      logMicrophoneCleanup("Stopping media stream tracks...");
      this.mediaStream.getTracks().forEach((track) => {
        logMicrophoneCleanup(
          `Stopping track: ${track.kind}, state: ${track.readyState}`
        );
        track.stop();
        logMicrophoneCleanup(
          `Track stopped: ${track.kind}, new state: ${track.readyState}`
        );
      });
      this.mediaStream = null;
      logMicrophoneCleanup("Media stream cleared");
    }

    // Close audio context
    if (this.audioContext) {
      logMicrophoneCleanup(
        `Closing audio context, current state: ${this.audioContext.state}`
      );
      if (this.audioContext.state !== 'closed') {
        this.audioContext.close().then(() => {
          logMicrophoneCleanup("Audio context closed successfully");
        }).catch(err => {
          console.error('Error closing audio context:', err);
        });
      }
      this.audioContext = null;
    }

    // Clean up media recorder
    if (this.mediaRecorder) {
      logMicrophoneCleanup("Cleaning up media recorder...");
      if (!preserveAudioChunks) {
        this.mediaRecorder = null;
      }
    }

    // Clean up analyser
    if (this.analyser) {
      logMicrophoneCleanup("Cleaning up analyser...");
      this.analyser = null;
    }
    
    if (this.dataArray) {
      this.dataArray = null;
    }

    // Reset audio chunks
    if (!preserveAudioChunks) {
      this.audioChunks = [];
    }
    
    logMicrophoneCleanup("Microphone cleanup completed");
  }

  async processRecording() {
    try {
      this.transcriptionInProgress = true;
      if (this.cancelledShortPress) {
        this.cancelledShortPress = false;
        this.recordingStartedAt = null;
        this.audioChunks = [];
        this.statusText.textContent = t("inputPrompt.cancelled");
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 300);
        return;
      }
      if (!this.audioChunks.length) {
        console.warn('No audio chunks captured; skipping transcription request');
        this.statusText.textContent = t("inputPrompt.noAudio");
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 1500);
        return;
      }

      const audioBlob = new Blob(this.audioChunks, {
        type: this.recordingMimeType || "audio/webm", // Use actual recording format
      });
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      const transcription = await ipcRenderer.invoke(
        "transcribe-audio",
        audioBuffer,
        this.translateMode,
        this.recordingMimeType // Pass the actual MIME type
      );

      if (transcription && transcription.trim()) {
        await this.typeText(transcription);
      } else {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        setTimeout(() => this.hidePrompt(), 2000);
      }
    } catch (error) {
      console.error("Transcription error:", error);
      const isCancelled =
        error &&
        (error.name === "TranscriptionCancelledError" ||
          (typeof error.message === "string" && error.message.includes("TRANSCRIPTION_CANCELLED")));
      if (isCancelled) {
        this.statusText.textContent = t("inputPrompt.cancelled");
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 300);
      } else {
        this.statusText.textContent = t("inputPrompt.transcriptionFailed");
        setTimeout(() => this.hidePrompt(), 3000);
      }
    } finally {
      this.transcriptionInProgress = false;
    }
  }

  async handleRecordingError(error) {
    this.isRecording = false;

    // Force cleanup of resources
    this.cleanup();

    let errorMessageKey = "inputPrompt.recordingFailed";

    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      errorMessageKey = "inputPrompt.permissionDenied";
    } else if (error.name === "NotFoundError") {
      errorMessageKey = "inputPrompt.noMicrophone";
    } else if (error.name === "NotReadableError") {
      errorMessageKey = "inputPrompt.microphoneBusy";
    } else if (error.name === "OverconstrainedError") {
      errorMessageKey = "inputPrompt.microphoneUnsupported";
    }

    this.promptText.textContent = t(errorMessageKey);
    this.statusText.textContent = t("inputPrompt.checkMicrophone");

    setTimeout(() => this.hidePrompt(), 3000);
  }

  async handleTextProcessingFailure(text, messageOverride) {
    const fallbackMessage =
      typeof messageOverride === "string" && messageOverride.trim()
        ? messageOverride
        : t("inputPrompt.textProcessingFailed");
    this.statusText.textContent = fallbackMessage;
    this.statusText.style.color = "var(--status-warning-strong)";

    // Final fallback: copy to clipboard
    try {
      const pasteShortcut = this.getPasteShortcutLabel();
      await navigator.clipboard.writeText(text);
      this.statusText.textContent = t("inputPrompt.textCopiedFallback", {
        shortcut: pasteShortcut,
      });
      this.statusText.style.color = "var(--status-warning)";
      setTimeout(() => this.hidePrompt(), 3000);
    } catch (clipboardError) {
      console.error("Failed to copy to clipboard:", clipboardError);
      this.statusText.textContent = t("inputPrompt.errorCouldNotProcess");
      this.statusText.style.color = "var(--status-danger)";
      setTimeout(() => this.hidePrompt(), 3000);
    }
  }

  async typeText(text) {
    // Send the transcribed text to the active application
    try {
      const result = await ipcRenderer.invoke("type-text", text);

      if (!result || !result.success) {
        console.warn("Text processing failed in main process:", result);
        await this.handleTextProcessingFailure(text, result?.message);
        return;
      }

      const pasteShortcut = this.getPasteShortcutLabel();

      if (result.method === "direct_typing") {
        console.log("Text typed directly:", text);
        this.statusText.textContent = t("inputPrompt.textTypedDirect");
        this.statusText.style.color = "var(--status-success)";
        setTimeout(() => this.hidePrompt(), 1500);
      } else if (result.method === "koffi_sendinput") {
        // Windows SendInput method
        console.log("Text inserted via SendInput:", text);
        this.statusText.textContent = t("inputPrompt.textInserted");
        this.statusText.style.color = "var(--status-success)";
        // Hide prompt immediately after successful insertion on Windows
        this.hidePrompt();
      } else if (result.method === "cgevent_unicode") {
        // macOS CGEvent Unicode method
        console.log("Text inserted via CGEvent:", text);
        this.statusText.textContent = t("inputPrompt.textInserted");
        this.statusText.style.color = "var(--status-success)";
        // Hide prompt immediately after successful insertion
        this.hidePrompt();
      } else if (result.method === "clipboard_textinsert") {
        console.log("Text inserted successfully:", text);
        const isPartial =
          typeof result.message === "string" &&
          result.message.includes("partially restored");
        this.statusText.textContent = isPartial
          ? t("inputPrompt.textInsertedPartial")
          : t("inputPrompt.textInsertedAuto");

        // Different colors based on message complexity
        if (isPartial) {
          this.statusText.style.color = "var(--status-warning)"; // Orange for partial restoration
        } else {
          this.statusText.style.color = "var(--status-success)"; // Green for full restoration
        }

        // Close immediately after successful insertion
        this.hidePrompt();
      } else if (result.method === "clipboard") {
        console.log("Text copied to clipboard:", text);
        this.statusText.textContent = t("inputPrompt.textCopied", {
          shortcut: pasteShortcut,
        });
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 3000);
      } else {
        this.statusText.textContent = result.message || t("inputPrompt.textInserted");
        this.statusText.style.color = "var(--status-success)";
        this.hidePrompt();
      }
    } catch (error) {
      console.error("Failed to process text:", error);
      await this.handleTextProcessingFailure(text);
    }
  }

  getPasteShortcutLabel() {
    const isMac = window.navigator?.platform?.includes("Mac");
    return isMac ? "Cmd+V" : "Ctrl+V";
  }

  startWaveAnimation() {
    const bars = this.waveContainer.querySelectorAll(".wave-bar");

    const animate = () => {
      if (!this.isRecording) return;

      if (this.analyser && this.dataArray) {
        this.analyser.getByteFrequencyData(this.dataArray);

        bars.forEach((bar, index) => {
          const dataIndex = Math.floor(
            (index / bars.length) * this.dataArray.length
          );
          const amplitude = this.dataArray[dataIndex] / 255;
          const height = Math.max(3, amplitude * 25);

          bar.style.height = `${height}px`;
          bar.classList.toggle("active", amplitude > 0.1);
        });
      } else {
        // Fallback random animation
        bars.forEach((bar) => {
          const height = Math.random() * 20 + 3;
          bar.style.height = `${height}px`;
          bar.classList.toggle("active", Math.random() > 0.5);
        });
      }

      this.animationId = requestAnimationFrame(animate);
    };

    animate();
  }

  stopWaveAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Reset wave bars
    const bars = this.waveContainer.querySelectorAll(".wave-bar");
    bars.forEach((bar) => {
      bar.style.height = "3px";
      bar.classList.remove("active");
    });
  }

  hidePrompt() {
    // Force cleanup of any remaining resources
    this.cleanup();
    
    this.promptElement.classList.remove("visible", "recording");
    this.transcriptionText.classList.remove("visible");
    this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    this.statusText.textContent = "";
    this.statusText.style.color = "";
    this.transcriptionText.textContent = "";

    // Reset recording state
    this.isRecording = false;
    this.stopRequested = false;
    this.starting = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;
    this.transcriptionInProgress = false;

    setTimeout(() => {
      ipcRenderer.invoke("hide-input-prompt");
    }, 300);
  }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  const initialize = async () => {
    try {
      const settings = await ipcRenderer.invoke("get-settings");
      initI18n(settings?.uiLanguage);
      applyTheme(settings?.uiTheme);
    } catch (error) {
      console.error("Failed to load UI language settings:", error);
      initI18n("auto");
      applyTheme("elegant");
    }
    new VoiceInputPrompt();
  };
  initialize();
});
