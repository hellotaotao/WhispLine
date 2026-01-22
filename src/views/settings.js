const { ipcRenderer } = require("electron");
const { initI18n, setLanguage, applyI18n, t } = window.WhispLineI18n;

// Define available models per API provider
const modelOptions = {
  groq: [
    { value: "whisper-large-v3", label: "Whisper Large V3 (Standard)" },
    { value: "whisper-large-v3-turbo", label: "Whisper Large V3 Turbo (Faster)" }
  ],
  openai: [
    { value: "whisper-1", label: "Whisper-1 (Classic)" },
    { value: "gpt-4o-transcribe", label: "GPT-4o Transcribe (High Quality)" },
    { value: "gpt-4o-mini-transcribe", label: "GPT-4o Mini Transcribe (Fast)" }
  ]
};

// Update model dropdown based on selected provider
function updateModelOptions(provider) {
  const select = document.getElementById("modelSelect");
  select.innerHTML = "";
  (modelOptions[provider] || []).forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    select.appendChild(option);
  });
}

function toggleApiKeyVisibility(provider) {
  const keyGroq = document.getElementById("apiKeyGroq");
  const keyOpenAI = document.getElementById("apiKeyOpenAI");
  if (!keyGroq || !keyOpenAI) return;
  if (provider === "openai") {
    keyGroq.classList.add("hidden");
    keyOpenAI.classList.remove("hidden");
  } else {
    keyOpenAI.classList.add("hidden");
    keyGroq.classList.remove("hidden");
  }
}

let currentSettings = {};

async function loadSettings() {
  try {
    currentSettings = await ipcRenderer.invoke("get-settings");
    initI18n(currentSettings.uiLanguage);
    // Initialize provider and models
    const providerSelect = document.getElementById("providerSelect");
    providerSelect.value = currentSettings.provider || "groq";
    updateModelOptions(providerSelect.value);
    // Toggle which API key input is visible for current provider
    if (typeof toggleApiKeyVisibility === "function") {
      toggleApiKeyVisibility(providerSelect.value);
    }

    const apiKeyGroq = document.getElementById("apiKeyGroq");
    const apiKeyOpenAI = document.getElementById("apiKeyOpenAI");
    apiKeyGroq.value =
      currentSettings.apiKeyGroq || currentSettings.apiKey || "";
    apiKeyOpenAI.value = currentSettings.apiKeyOpenAI || "";

    const shortcutSelect = document.getElementById("shortcutSelect");
    if (shortcutSelect) {
      const shortcutValue = currentSettings.shortcut || "Ctrl+Shift";
      const hasOption = Array.from(shortcutSelect.options).some(
        (opt) => opt.value === shortcutValue
      );
      shortcutSelect.value = hasOption ? shortcutValue : "Ctrl+Shift";
    }

    const uiLanguageSelect = document.getElementById("uiLanguageSelect");
    if (uiLanguageSelect) {
      const uiLanguageValue = currentSettings.uiLanguage || "auto";
      const hasOption = Array.from(uiLanguageSelect.options).some(
        (opt) => opt.value === uiLanguageValue
      );
      uiLanguageSelect.value = hasOption ? uiLanguageValue : "auto";
      uiLanguageSelect.addEventListener("change", () => {
        setLanguage(uiLanguageSelect.value);
        applyI18n(document);
        checkMicrophonePermissionStatus();
        checkAccessibilityStatus();
      });
    }

    // Set the selected language
    const languageSelect = document.getElementById("languageSelect");
    if (currentSettings.language) {
      languageSelect.value = currentSettings.language;
    }

    // Set the selected model
    const modelSelect = document.getElementById("modelSelect");
    if (currentSettings.model) modelSelect.value = currentSettings.model;

    // Configure auto-launch and start-minimized controls
    const autoLaunchCheck = document.getElementById("autoLaunchCheck");
    const startMinimizedCheck = document.getElementById("startMinimizedCheck");
    autoLaunchCheck.checked = currentSettings.autoLaunch;
    startMinimizedCheck.checked = currentSettings.startMinimized;

    // Check initial permission status
    await checkMicrophonePermissionStatus();
    await checkAccessibilityStatus();
    setupShortcutSync();
  } catch (error) {
    console.error("Failed to load settings:", error);
    initI18n("auto");
  }
}

function setupShortcutSync() {
  ipcRenderer.on("shortcut-updated", (event, payload) => {
    if (!payload || !payload.recordShortcut) {
      return;
    }
    const shortcutSelect = document.getElementById("shortcutSelect");
    if (!shortcutSelect) {
      return;
    }
    const hasOption = Array.from(shortcutSelect.options).some(
      (opt) => opt.value === payload.recordShortcut
    );
    shortcutSelect.value = hasOption ? payload.recordShortcut : "Ctrl+Shift";
  });
}

async function checkMicrophonePermissionStatus() {
  try {
    const statusElement = document.getElementById("permissionStatus");
    statusElement.textContent = t("settings.permission.checking");
    statusElement.className = "permission-status";

    // Check system-level microphone permission through main process
    if (
      window.navigator &&
      window.navigator.platform &&
      window.navigator.platform.includes("Mac")
    ) {
      // For macOS, we rely on main process to check system permission
      // Since Electron apps don't need browser-level permission
      statusElement.textContent = t("settings.permission.availableElectron");
      statusElement.className = "permission-status granted";
    } else {
      // For other platforms
      statusElement.textContent = t("settings.permission.available");
      statusElement.className = "permission-status granted";
    }
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    const statusElement = document.getElementById("permissionStatus");
    statusElement.textContent = t("settings.permission.error");
    statusElement.className = "permission-status denied";
  }
}

async function checkAccessibilityStatus() {
  try {
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipcRenderer.invoke(
      "check-accessibility-permission"
    );

    let statusText, statusClass;
    if (result.granted) {
      statusText = t("settings.accessibility.granted");
      statusClass = "granted";
    } else if (result.status === "not_required") {
      statusText = t("settings.accessibility.notRequired");
      statusClass = "granted";
    } else {
      statusText = t("settings.accessibility.denied");
      statusClass = "denied";
    }

    statusElement.textContent = statusText;
    statusElement.className = `permission-status ${statusClass}`;
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.permission.error");
    statusElement.className = "permission-status denied";
  }
}

async function recheckAccessibilityPermission() {
  try {
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipcRenderer.invoke(
      "recheck-accessibility-permission"
    );

    let statusText, statusClass;
    if (result.granted) {
      statusText = t("settings.accessibility.granted");
      statusClass = "granted";
    } else {
      statusText = t("settings.accessibility.denied");
      statusClass = "denied";
    }

    statusElement.textContent = statusText;
    statusElement.className = `permission-status ${statusClass}`;
  } catch (error) {
    console.error("Failed to recheck accessibility permission:", error);
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.permission.error");
    statusElement.className = "permission-status denied";
  }
}

async function saveSettings() {
  try {
    const provider = document.getElementById("providerSelect").value;
    const settings = {
      apiKeyGroq: document.getElementById("apiKeyGroq").value,
      apiKeyOpenAI: document.getElementById("apiKeyOpenAI").value,
      shortcut: document.getElementById("shortcutSelect").value,
      language: document.getElementById("languageSelect").value,
      uiLanguage: document.getElementById("uiLanguageSelect").value,
      model: document.getElementById("modelSelect").value,
      microphone: currentSettings.microphone,
      autoLaunch: document.getElementById("autoLaunchCheck").checked,
      startMinimized: document.getElementById("startMinimizedCheck").checked,
      provider
    };

    await ipcRenderer.invoke("save-settings", settings);
    window.close();
  } catch (error) {
    console.error("Failed to save settings:", error);
    alert(t("settings.saveError"));
  }
}

function closeSettings() {
  window.close();
}

// Load settings when page loads
document.addEventListener("DOMContentLoaded", loadSettings);

// Listen to provider changes
document.getElementById("providerSelect").addEventListener("change", (e) => {
  updateModelOptions(e.target.value);
  if (typeof toggleApiKeyVisibility === "function") {
    toggleApiKeyVisibility(e.target.value);
  }
});

// Permission check buttons
document
  .getElementById("checkPermission")
  .addEventListener("click", checkMicrophonePermissionStatus);

document
  .getElementById("checkAccessibility")
  .addEventListener("click", recheckAccessibilityPermission);

// Sidebar navigation
document.querySelectorAll(".sidebar-item").forEach((item) => {
  item.addEventListener("click", () => {
    document
      .querySelectorAll(".sidebar-item")
      .forEach((i) => i.classList.remove("active"));
    item.classList.add("active");

    const target = item.getAttribute("data-section");
    document
      .querySelectorAll(".content-section")
      .forEach((sec) => sec.classList.remove("active"));
    const content = document.getElementById(`section-${target}`);
    if (content) content.classList.add("active");
  });
});
