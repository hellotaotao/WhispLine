const { ipcRenderer } = require("electron");

const SHORT_PRESS_THRESHOLD_MS = 500;

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

    this.promptElement = document.getElementById("inputPrompt");
    this.promptText = document.getElementById("promptText");
    this.waveContainer = document.getElementById("waveContainer");
    this.statusText = document.getElementById("statusText");
    this.transcriptionText = document.getElementById("transcriptionText");

    this.createWaveBars();
    this.setupEventListeners();
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
      if (e.key === "Escape" && this.isRecording) {
        this.stopRecording();
      }
    });

    // Add window beforeunload event to ensure cleanup
    window.addEventListener("beforeunload", () => {
      this.cleanup();
    });
  }

  async startRecording() {
    if (this.isRecording || this.starting) return;

    this.starting = true;
    try {
      // Show prompt immediately
      this.promptElement.classList.add("visible");
      this.promptText.textContent = "Starting recording...";
      this.statusText.textContent = "";

      this.audioChunks = [];

      // Update UI for recording state
      this.promptElement.classList.add("recording");
      if (this.translateMode) {
        this.promptText.textContent = "Listening (English output)...";
      } else {
        this.promptText.textContent = "Listening...";
      }
      this.statusText.innerHTML =
        'Recording <div class="recording-dot"></div>';

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
    this.cancelledShortPress = isShortPress;

    if (isShortPress) {
      this.promptText.textContent = "Cancelled";
      this.statusText.textContent = "";
    } else {
      this.promptText.textContent = "Processing...";
      this.statusText.textContent = "Transcribing audio...";
    }

    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    }

    this.cleanup({ preserveAudioChunks: true });
    this.stopWaveAnimation();
  }

  cleanup(options = {}) {
    const { preserveAudioChunks = false } = options;
    console.log('Starting microphone cleanup...');
    
    // Stop all media tracks
    if (this.mediaStream) {
      console.log('Stopping media stream tracks...');
      this.mediaStream.getTracks().forEach((track) => {
        console.log(`Stopping track: ${track.kind}, state: ${track.readyState}`);
        track.stop();
        console.log(`Track stopped: ${track.kind}, new state: ${track.readyState}`);
      });
      this.mediaStream = null;
      console.log('Media stream cleared');
    }

    // Close audio context
    if (this.audioContext) {
      console.log(`Closing audio context, current state: ${this.audioContext.state}`);
      if (this.audioContext.state !== 'closed') {
        this.audioContext.close().then(() => {
          console.log('Audio context closed successfully');
        }).catch(err => {
          console.error('Error closing audio context:', err);
        });
      }
      this.audioContext = null;
    }

    // Clean up media recorder
    if (this.mediaRecorder) {
      console.log('Cleaning up media recorder...');
      if (!preserveAudioChunks) {
        this.mediaRecorder = null;
      }
    }

    // Clean up analyser
    if (this.analyser) {
      console.log('Cleaning up analyser...');
      this.analyser = null;
    }
    
    if (this.dataArray) {
      this.dataArray = null;
    }

    // Reset audio chunks
    if (!preserveAudioChunks) {
      this.audioChunks = [];
    }
    
    console.log('Microphone cleanup completed');
  }

  async processRecording() {
    try {
      if (this.cancelledShortPress) {
        this.cancelledShortPress = false;
        this.recordingStartedAt = null;
        this.audioChunks = [];
        this.statusText.textContent = "Cancelled";
        this.statusText.style.color = "#ffaa00";
        setTimeout(() => this.hidePrompt(), 300);
        return;
      }
      if (!this.audioChunks.length) {
        console.warn('No audio chunks captured; skipping transcription request');
        this.statusText.textContent = "No audio captured";
        this.statusText.style.color = "#ffaa00";
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
        this.statusText.textContent = "No speech detected";
        setTimeout(() => this.hidePrompt(), 2000);
      }
    } catch (error) {
      console.error("Transcription error:", error);
      this.statusText.textContent =
        "Transcription failed - please try again";
      setTimeout(() => this.hidePrompt(), 3000);
    }
  }

  async handleRecordingError(error) {
    this.isRecording = false;

    // Force cleanup of resources
    this.cleanup();

    let errorMessage = "Recording failed";

    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      errorMessage = "Microphone permission denied";
    } else if (error.name === "NotFoundError") {
      errorMessage = "No microphone found";
    } else if (error.name === "NotReadableError") {
      errorMessage = "Microphone is busy";
    } else if (error.name === "OverconstrainedError") {
      errorMessage = "Microphone settings not supported";
    }

    this.promptText.textContent = errorMessage;
    this.statusText.textContent = "Please check your microphone settings";

    setTimeout(() => this.hidePrompt(), 3000);
  }

  async typeText(text) {
    // Send the transcribed text to the active application
    try {
      const result = await ipcRenderer.invoke("type-text", text);

      if (result.success) {
        if (result.method === "direct_typing") {
          console.log("Text typed directly:", text);
          this.statusText.textContent = "Text typed directly";
          this.statusText.style.color = "#00ff00";
          setTimeout(() => this.hidePrompt(), 1500);
        } else if (result.method === "koffi_sendinput") {
          // Windows SendInput method
          console.log("Text inserted via SendInput:", text);
          this.statusText.textContent = result.message || "Text inserted";
          this.statusText.style.color = "#00ff00";
          // Hide prompt immediately after successful insertion on Windows
          this.hidePrompt();
        } else if (result.method === "clipboard_textinsert") {
          console.log("Text inserted successfully:", text);
          this.statusText.textContent = result.message || "Text inserted automatically";
          
          // Different colors based on message complexity
          if (result.message && result.message.includes("partially restored")) {
            this.statusText.style.color = "#ffaa00"; // Orange for partial restoration
          } else {
            this.statusText.style.color = "#00ff00"; // Green for full restoration
          }
          
          // Close immediately after successful insertion
          this.hidePrompt();
        } else if (result.method === "clipboard") {
          console.log("Text copied to clipboard:", text);
          this.statusText.textContent = result.message || "Text copied - Press Cmd+V to paste";
          this.statusText.style.color = "#ffaa00";
          setTimeout(() => this.hidePrompt(), 3000);
        }
      }
    } catch (error) {
      console.error("Failed to process text:", error);
      this.statusText.textContent = "Text processing failed - trying clipboard fallback";
      this.statusText.style.color = "#ff6600";

      // Final fallback: copy to clipboard
      try {
        await navigator.clipboard.writeText(text);
        this.statusText.textContent = "Text copied to clipboard - Press Cmd+V to paste";
        this.statusText.style.color = "#ffaa00";
        setTimeout(() => this.hidePrompt(), 3000);
      } catch (clipboardError) {
        console.error("Failed to copy to clipboard:", clipboardError);
        this.statusText.textContent = "Error: Could not process text";
        this.statusText.style.color = "#ff0000";
        setTimeout(() => this.hidePrompt(), 3000);
      }
    }
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
    this.promptText.textContent = "Hold Ctrl + Shift to dictate, Shift + Alt for English";
    this.statusText.textContent = "";
    this.statusText.style.color = "";
    this.transcriptionText.textContent = "";

    // Reset recording state
    this.isRecording = false;
    this.stopRequested = false;
    this.starting = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;

    setTimeout(() => {
      ipcRenderer.invoke("hide-input-prompt");
    }, 300);
  }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new VoiceInputPrompt();
});
