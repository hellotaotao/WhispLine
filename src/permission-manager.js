const { systemPreferences, dialog } = require("electron");
const { exec } = require("child_process");
const { EventEmitter } = require("events");

class PermissionManager extends EventEmitter {
  constructor() {
    super();
    this.currentAccessibilityPermission = false;
  }

  // Accessibility Permission Methods
  async checkAccessibilityPermission() {
    if (process.platform !== "darwin") {
      this.currentAccessibilityPermission = true;
      return true;
    }

    try {
      const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
      this.currentAccessibilityPermission = hasPermission;
      
      if (hasPermission) {
        console.log("Accessibility permission already granted");
        return true;
      }

      await this.showAccessibilityPermissionDialog();
      return false;
    } catch (error) {
      console.error("Failed to check accessibility permissions:", error);
      this.currentAccessibilityPermission = false;
      return false;
    }
  }

  async showAccessibilityPermissionDialog() {
    const result = await dialog.showMessageBox(null, {
      type: "warning",
      title: "Accessibility Permission Required",
      message: "WhispLine needs accessibility permission to capture global keyboard shortcuts and insert transcribed text automatically.",
      detail: "Please grant accessibility permission in System Preferences to use global keyboard shortcuts and automatic text insertion.\n\nThe app will work with microphone-only mode and manual pasting if you prefer not to grant this permission.",
      buttons: ["Open System Preferences", "Continue without shortcuts", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 0) {
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
      
      const checkInterval = setInterval(async () => {
        const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
        if (hasPermission) {
          console.log("Permission detected! Updating hotkey status...");
          clearInterval(checkInterval);
          await this.recheckAccessibilityPermission();
        }
      }, 2000);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        console.log("Stopped automatic permission checking after timeout");
      }, 120000);
      
    } else if (result.response === 2) {
      this.emit('quit-requested');
    }
  }

  async recheckAccessibilityPermission() {
    if (process.platform !== "darwin") {
      return true;
    }

    try {
      const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
      console.log("Rechecking accessibility permission:", hasPermission, "Previous state:", this.currentAccessibilityPermission);
      
      if (hasPermission !== this.currentAccessibilityPermission) {
        console.log(`Accessibility permission changed from ${this.currentAccessibilityPermission} to ${hasPermission}`);
        this.currentAccessibilityPermission = hasPermission;
        
        this.emit('accessibility-permission-changed', {
          granted: hasPermission,
          message: hasPermission 
            ? 'Accessibility permission granted! Global hotkeys are now active.'
            : 'Accessibility permission revoked. Global hotkeys are disabled.'
        });
      }
      
      return hasPermission;
    } catch (error) {
      console.error("Failed to recheck accessibility permissions:", error);
      return false;
    }
  }

  async requestAccessibilityPermission() {
    if (process.platform !== "darwin") {
      return { granted: true, status: "not_required" };
    }

    try {
      const granted = systemPreferences.isTrustedAccessibilityClient(true);
      this.currentAccessibilityPermission = granted;
      
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
  }

  getAccessibilityPermissionStatus() {
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
  }

  // Microphone Permission Methods
  async checkAndRequestMicrophonePermission() {
    if (process.platform !== "darwin") {
      return true;
    }

    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log("Checking microphone permission for recording, status:", status);
      
      if (status === 'granted') {
        console.log("Microphone permission already granted");
        return true;
      }
      
      if (status === 'not-determined') {
        console.log("Microphone permission not determined, requesting...");
        
        const result = await dialog.showMessageBox(null, {
          type: "info",
          title: "Microphone Permission Required",
          message: "WhispLine needs microphone access to transcribe your voice.",
          detail: "Please grant microphone permission in the next dialog to use voice input features.",
          buttons: ["Grant Permission", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });

        if (result.response === 1) {
          console.log("User cancelled permission request");
          return false;
        }

        try {
          await systemPreferences.askForMediaAccess('microphone');
          const newStatus = systemPreferences.getMediaAccessStatus('microphone');
          console.log("Permission request completed, new status:", newStatus);
          
          if (newStatus === 'granted') {
            console.log("Microphone permission successfully granted");
            return true;
          } else {
            console.log("Microphone permission was not granted");
            await this.showMicrophonePermissionDeniedGuidance();
            return false;
          }
        } catch (err) {
          console.error("Failed to request microphone access:", err);
          await this.showMicrophonePermissionDeniedGuidance();
          return false;
        }
      }
      
      if (status === 'denied') {
        console.log("Microphone permission previously denied");
        await this.showMicrophonePermissionDeniedGuidance();
        return false;
      }
      
    } catch (error) {
      console.error("Failed to check microphone permissions:", error);
      return false;
    }
    
    return false;
  }

  async showMicrophonePermissionDeniedGuidance() {
    const result = await dialog.showMessageBox(null, {
      type: "warning",
      title: "Microphone Permission Needed",
      message: "WhispLine cannot access your microphone.",
      detail: "To use voice input features, please:\n\n1. Go to System Preferences > Security & Privacy > Privacy > Microphone\n2. Enable microphone access for WhispLine\n3. Try using the voice input again\n\nAlternatively, you can continue using the app without voice input.",
      buttons: ["Open System Preferences", "Continue Without Voice"],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"');
    }
  }

  async requestInitialMicrophonePermission() {
    if (process.platform !== "darwin") {
      return;
    }

    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log("Initial microphone permission check, status:", status);
      
      if (status !== 'granted') {
        console.log("Requesting microphone permission to register app in system settings...");
        
        try {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          const newStatus = systemPreferences.getMediaAccessStatus('microphone');
          console.log("Permission request completed, granted:", granted, "new status:", newStatus);
          
          if (newStatus === 'granted') {
            console.log("Microphone permission granted - app registered in system settings");
          } else if (newStatus === 'denied') {
            console.log("Microphone permission denied - app should now be visible in system settings for manual control");
          }
          
        } catch (err) {
          console.error("Failed to request initial microphone access:", err);
          console.log("App should still be registered in system settings despite error");
        }
      } else {
        console.log("Microphone permission already granted");
      }
    } catch (error) {
      console.error("Failed to check initial microphone permissions:", error);
    }
  }

  // Utility Methods
  getCurrentAccessibilityPermission() {
    return this.currentAccessibilityPermission;
  }

  hasAccessibilityPermission() {
    if (process.platform !== "darwin") {
      return true;
    }
    return this.currentAccessibilityPermission;
  }
}

module.exports = PermissionManager;
