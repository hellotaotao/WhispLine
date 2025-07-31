/**
 * Renderer Process Permission Manager
 * Handles browser-level permissions in Electron renderer process
 */

class RendererPermissionManager {
  constructor() {
    this.microphonePermission = 'unknown';
    this.permissionCallbacks = new Map();
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  /**
   * Initialize permission manager
   */
  async init() {
    try {
      await this.checkMicrophonePermission();
      this.setupPermissionChangeListener();
      return true;
    } catch (error) {
      console.error('Failed to initialize renderer permission manager:', error);
      return false;
    }
  }

  // ============================================================================
  // MICROPHONE PERMISSION METHODS
  // ============================================================================

  /**
   * Check current microphone permission status
   */
  async checkMicrophonePermission() {
    try {
      // First check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.microphonePermission = 'unsupported';
        return { granted: false, status: 'unsupported' };
      }

      // Try to get permission status using permissions API if available
      if (navigator.permissions && navigator.permissions.query) {
        try {
          const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
          this.microphonePermission = permissionStatus.state;

          // Listen for permission changes
          permissionStatus.onchange = () => {
            this.microphonePermission = permissionStatus.state;
            this.notifyPermissionChange('microphone', permissionStatus.state);
          };

          return {
            granted: permissionStatus.state === 'granted',
            status: permissionStatus.state
          };
        } catch (permError) {
          console.warn('Permissions API not fully supported, falling back to getUserMedia test');
        }
      }

      // Fallback: try to access microphone to determine permission
      return await this.testMicrophoneAccess();

    } catch (error) {
      console.error('Error checking microphone permission:', error);
      this.microphonePermission = 'denied';
      return { granted: false, status: 'denied', error: error.message };
    }
  }

  /**
   * Test microphone access by attempting to get media stream
   */
  async testMicrophoneAccess() {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      // Permission granted, clean up the stream immediately
      if (stream) {
        stream.getTracks().forEach(track => {
          track.stop();
          console.log('Permission test track stopped:', track.kind, track.readyState);
        });
        stream = null;
      }
      
      this.microphonePermission = 'granted';
      return { granted: true, status: 'granted' };

    } catch (error) {
      // Make sure to clean up in case of errors
      if (stream) {
        stream.getTracks().forEach(track => {
          track.stop();
          console.log('Permission test track stopped (error):', track.kind, track.readyState);
        });
        stream = null;
      }

      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        this.microphonePermission = 'denied';
        return { granted: false, status: 'denied' };
      } else if (error.name === 'NotFoundError') {
        this.microphonePermission = 'no-device';
        return { granted: false, status: 'no-device' };
      } else {
        this.microphonePermission = 'unknown';
        return { granted: false, status: 'unknown', error: error.message };
      }
    }
  }

  /**
   * Request microphone permission with user-friendly flow
   */
  async requestMicrophonePermission(showDialog = true) {
    try {
      // Show permission request dialog first if requested
      if (showDialog && window.ipcRenderer) {
        const userConsent = await window.ipcRenderer.invoke('show-microphone-permission-dialog');
        if (!userConsent) {
          return { granted: false, status: 'user-cancelled' };
        }
      }

      // Check current status first
      const currentStatus = await this.checkMicrophonePermission();
      if (currentStatus.granted) {
        return currentStatus;
      }

      // If permission was previously denied, show system settings guidance
      if (this.microphonePermission === 'denied' && this.retryCount > 0) {
        if (window.ipcRenderer) {
          const action = await window.ipcRenderer.invoke('show-permission-denied-dialog');
          if (action === 2) { // Retry option
            this.retryCount++;
            return await this.testMicrophoneAccess();
          } else if (action === 1) { // Continue without voice
            return { granted: false, status: 'user-declined' };
          }
          // action === 0 means open system settings (handled in main process)
          return { granted: false, status: 'system-settings-opened' };
        }
      }

      // Attempt to get permission
      this.retryCount++;
      const result = await this.testMicrophoneAccess();

      // If still denied after request, show guidance
      if (!result.granted && window.ipcRenderer) {
        const action = await window.ipcRenderer.invoke('show-permission-denied-dialog');
        result.userAction = action;
      }

      return result;

    } catch (error) {
      console.error('Error requesting microphone permission:', error);
      return { granted: false, status: 'error', error: error.message };
    }
  }

  /**
   * Get available audio input devices
   */
  async getAudioInputDevices() {
    try {
      // First ensure we have permission
      const permissionResult = await this.checkMicrophonePermission();
      if (!permissionResult.granted) {
        throw new Error('Microphone permission not granted');
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');

      return audioInputs.map(device => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
        groupId: device.groupId
      }));

    } catch (error) {
      console.error('Error getting audio input devices:', error);
      return [];
    }
  }

  /**
   * Create optimized media stream with specified device
   */
  async createMediaStream(deviceId = 'default') {
    try {
      const permissionResult = await this.checkMicrophonePermission();
      if (!permissionResult.granted) {
        throw new Error('Microphone permission not granted');
      }

      const constraints = {
        audio: {
          deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return stream;

    } catch (error) {
      console.error('Error creating media stream:', error);
      throw error;
    }
  }

  // ============================================================================
  // PERMISSION CHANGE LISTENERS
  // ============================================================================

  /**
   * Register callback for permission changes
   */
  onPermissionChange(permission, callback) {
    if (!this.permissionCallbacks.has(permission)) {
      this.permissionCallbacks.set(permission, new Set());
    }
    this.permissionCallbacks.get(permission).add(callback);
  }

  /**
   * Unregister permission change callback
   */
  offPermissionChange(permission, callback) {
    if (this.permissionCallbacks.has(permission)) {
      this.permissionCallbacks.get(permission).delete(callback);
    }
  }

  /**
   * Notify listeners of permission changes
   */
  notifyPermissionChange(permission, status) {
    if (this.permissionCallbacks.has(permission)) {
      this.permissionCallbacks.get(permission).forEach(callback => {
        try {
          callback(status);
        } catch (error) {
          console.error('Error in permission change callback:', error);
        }
      });
    }
  }

  /**
   * Setup listener for device changes
   */
  setupPermissionChangeListener() {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        await this.checkMicrophonePermission();
        this.notifyPermissionChange('devicechange', this.microphonePermission);
      });
    }
  }

  // ============================================================================
  // STATUS AND UTILITY METHODS
  // ============================================================================

  /**
   * Get permission status summary
   */
  getPermissionStatus() {
    return {
      microphone: this.microphonePermission,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      canRetry: this.retryCount < this.maxRetries
    };
  }

  /**
   * Reset retry counter
   */
  resetRetryCount() {
    this.retryCount = 0;
  }

  /**
   * Show permission status in a user-friendly way
   */
  getPermissionStatusText() {
    switch (this.microphonePermission) {
      case 'granted':
        return { status: '✅ Microphone access granted', color: 'green' };
      case 'denied':
        return { status: '❌ Microphone access denied', color: 'red' };
      case 'prompt':
        return { status: '⏳ Microphone permission required', color: 'orange' };
      case 'no-device':
        return { status: '🎤 No microphone device found', color: 'orange' };
      case 'unsupported':
        return { status: '⚠️ Microphone not supported by browser', color: 'red' };
      default:
        return { status: '❓ Unknown microphone permission status', color: 'gray' };
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RendererPermissionManager;
} else if (typeof window !== 'undefined') {
  window.RendererPermissionManager = RendererPermissionManager;
}