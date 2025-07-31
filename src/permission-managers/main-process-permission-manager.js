/**
 * Main Process Permission Manager
 * Handles system-level permissions in Electron main process
 */

const { systemPreferences, dialog, app } = require('electron');
const { exec } = require('child_process');

class MainProcessPermissionManager {
  constructor() {
    this.currentAccessibilityPermission = false;
  }

  /**
   * Initialize permission manager
   */
  async init() {
    try {
      await this.checkAccessibilityPermissions();
      return true;
    } catch (error) {
      console.error('Failed to initialize main process permission manager:', error);
      return false;
    }
  }

  // ============================================================================
  // ACCESSIBILITY PERMISSION METHODS
  // ============================================================================

  /**
   * Check accessibility permissions on macOS
   */
  async checkAccessibilityPermissions() {
    if (process.platform !== "darwin") {
      this.currentAccessibilityPermission = true; // Not needed on other platforms
      return true;
    }

    try {
      // Check if we already have permission
      const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
      this.currentAccessibilityPermission = hasPermission; // Initialize the state
      
      if (hasPermission) {
        console.log("Accessibility permission already granted");
        return true;
      }

      // Show permission dialog
      await this.showAccessibilityPermissionDialog();
      return false;
    } catch (error) {
      console.error("Failed to check accessibility permissions:", error);
      this.currentAccessibilityPermission = false;
      return false;
    }
  }

  /**
   * Show accessibility permission dialog only when needed
   */
  async showAccessibilityPermissionDialog() {
    const result = await dialog.showMessageBox(null, {
      type: "warning",
      title: "Accessibility Permission Required",
      message: "WhispLine needs accessibility permission to capture global keyboard shortcuts (Ctrl+Shift) and insert transcribed text automatically.",
      detail: "Please grant accessibility permission in System Preferences to use global keyboard shortcuts and automatic text insertion.\n\nThe app will work with microphone-only mode and manual pasting if you prefer not to grant this permission.",
      buttons: ["Open System Preferences", "Continue without shortcuts", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 0) {
      // Open accessibility preferences
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
      
      // Set up a timer to periodically check for permission changes
      // This will help detect when user grants permission in System Preferences
      const checkInterval = setInterval(async () => {
        const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
        if (hasPermission) {
          console.log("Permission detected! Updating hotkey status...");
          clearInterval(checkInterval);
          await this.recheckAccessibilityPermission();
        }
      }, 2000); // Check every 2 seconds
      
      // Stop checking after 2 minutes to avoid infinite polling
      setTimeout(() => {
        clearInterval(checkInterval);
        console.log("Stopped automatic permission checking after timeout");
      }, 120000);
      
    } else if (result.response === 2) {
      app.quit();
    }
    // If result.response === 1, continue without global shortcuts
  }

  /**
   * Recheck accessibility permission and update hotkey status if needed
   */
  async recheckAccessibilityPermission() {
    if (process.platform !== "darwin") {
      return { changed: false, granted: true };
    }

    try {
      const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
      console.log("Rechecking accessibility permission:", hasPermission, "Previous state:", this.currentAccessibilityPermission);
      
      // Check if permission status has changed
      if (hasPermission !== this.currentAccessibilityPermission) {
        console.log(`Accessibility permission changed from ${this.currentAccessibilityPermission} to ${hasPermission}`);
        this.currentAccessibilityPermission = hasPermission;
        
        return { 
          changed: true, 
          granted: hasPermission,
          previous: !hasPermission 
        };
      }
      
      return { 
        changed: false, 
        granted: hasPermission 
      };
    } catch (error) {
      console.error("Failed to recheck accessibility permissions:", error);
      return { changed: false, granted: false, error: error.message };
    }
  }

  /**
   * Get current accessibility permission status
   */
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

  /**
   * Request accessibility permission
   */
  async requestAccessibilityPermission() {
    if (process.platform !== "darwin") {
      return { granted: true, status: "not_required" };
    }

    try {
      // This will prompt the user to grant accessibility permission
      const granted = systemPreferences.isTrustedAccessibilityClient(true);
      
      // Update our cached state
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

  // ============================================================================
  // MICROPHONE PERMISSION METHODS
  // ============================================================================

  /**
   * Check and request microphone permission when actually needed
   */
  async checkAndRequestMicrophonePermission() {
    if (process.platform !== "darwin") {
      return true; // Not needed on other platforms
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
        
        // Show user-friendly dialog before requesting permission
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

        // Request microphone access
        try {
          await systemPreferences.askForMediaAccess('microphone');
          const newStatus = systemPreferences.getMediaAccessStatus('microphone');
          console.log("Permission request completed, new status:", newStatus);
          
          if (newStatus === 'granted') {
            console.log("Microphone permission successfully granted");
            return true;
          } else {
            console.log("Microphone permission was not granted");
            await this.showPermissionDeniedGuidance();
            return false;
          }
        } catch (err) {
          console.error("Failed to request microphone access:", err);
          await this.showPermissionDeniedGuidance();
          return false;
        }
      }
      
      if (status === 'denied') {
        console.log("Microphone permission previously denied");
        await this.showPermissionDeniedGuidance();
        return false;
      }
      
    } catch (error) {
      console.error("Failed to check microphone permissions:", error);
      return false;
    }
    
    return false;
  }

  /**
   * Show guidance for manually enabling microphone permission
   */
  async showPermissionDeniedGuidance() {
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
      // Open system preferences
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"');
    }
  }

  /**
   * Request initial microphone permission on startup to ensure app appears in system settings
   */
  async requestInitialMicrophonePermission() {
    if (process.platform !== "darwin") {
      return;
    }

    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log("Initial microphone permission check, status:", status);
      
      // Always request permission if not granted to ensure app is registered
      if (status !== 'granted') {
        console.log("Requesting microphone permission to register app in system settings...");
        
        try {
          // Force the system permission dialog to appear and register the app
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
          // Even if request fails, the app should still be registered
          console.log("App should still be registered in system settings despite error");
        }
      } else {
        console.log("Microphone permission already granted");
      }
    } catch (error) {
      console.error("Failed to check initial microphone permissions:", error);
    }
  }

  /**
   * Get microphone permission status
   */
  getMicrophonePermissionStatus() {
    if (process.platform !== "darwin") {
      return { granted: true, status: "not_required" };
    }

    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return {
        granted: status === 'granted',
        status: status,
      };
    } catch (error) {
      console.error("Failed to check microphone permission:", error);
      return {
        granted: false,
        status: "error",
        error: error.message,
      };
    }
  }
}

module.exports = MainProcessPermissionManager;