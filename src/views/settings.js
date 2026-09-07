(function () {
let ipc = null;
let initI18n = () => "en";
let setLanguage = () => "en";
let applyI18n = () => {};
let t = (key) => key;

if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-settings-js-ran", "1");
}

const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 25;
const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
const QWEN_LOCAL_MODEL = "qwen3-asr-0.6b-q8_0";
const NEMOTRON_LOCAL_MODEL = "nemotron-3.5-asr-streaming-0.6b-q8_0";
const LOCAL_QWEN_PROVIDER = "local-qwen";
const LOCAL_NEMOTRON_PROVIDER = "local-nemotron";
let currentThemePref = "elegant";

// First entry per provider is the effective default when switching provider
// (the rebuilt <select> lands on it) — keep it in sync with the backend
// default (settings.rs default_model / save_onboarding_api_key /
// perform_transcription_request's empty-model fallback). `recommended` adds a
// localized "★ 推荐" tag to the label. Turbo over lv3 is evidence-backed: the
// 2026-07-03 punctuation sweep (CLAUDE.md) showed lv3 collapse to zero
// punctuation on run-on Chinese speech while turbo+seed punctuates.
//
// OpenAI is deliberately ONE row. `gpt-transcribe` ($0.0045/min, 2026-07-28)
// dominates the three models dropped on 2026-09-06:
//   - gpt-4o-transcribe ($0.006/min) — dearer, and measured WORST of the family
//     on Chinese punctuation (0/1/0 marks vs mini's 6/8/7, 2026-07-07).
//   - whisper-1 ($0.006/min) — dearer, oldest, collapses the same way, worst
//     prompt-leak offender.
//   - gpt-4o-mini-transcribe ($0.003/min) — the only real trade-off, and it
//     lost on quality: measured head-to-head 2026-09-07 (same 20 s run-on zh
//     clip, 3 reps each, both deterministic, both 92/92 words correct), it
//     emits HALF-WIDTH ASCII commas into Chinese text and runs the whole
//     utterance together as one sentence, where gpt-transcribe emits proper
//     full-width ，。 and segments it into two. scrub.rs does no width
//     normalization, so that lands in the user's document verbatim. The 33%
//     saving is ~$0.68/month at 15 min/day of real audio — not worth it.
// whisper-1 is NOT gone from the code: OpenAI's /audio/translations endpoint
// accepts only whisper-1, so it stays hardcoded for translate mode
// (commands.rs) and keeps its MODEL_LABEL entry for history rendering.
const modelOptions = {
  groq: [
    { value: "whisper-large-v3-turbo", labelKey: "settings.model.options.whisperLargeV3Turbo", recommended: true },
    { value: "whisper-large-v3", labelKey: "settings.model.options.whisperLargeV3" },
  ],
  openai: [
    { value: "gpt-transcribe", labelKey: "settings.model.options.gptTranscribe", recommended: true },
  ],
};

let currentSettings = {};
let pageEventsBound = false;
let shortcutSyncBound = false;
let themeSyncBound = false;
let pendingAccessibilityRecheck = false;
let accessibilityRecheckTimer = null;
let settingsInitialized = false;
let activeSettingsTab = "dictation";

// Keep primary dictation controls together; low-frequency setup is collapsible.
const SETTINGS_TABS = ["dictation", "app"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function translate(key, vars) {
  try {
    return typeof t === "function" ? t(key, vars) : key;
  } catch {
    return key;
  }
}

function normalizeThemePref(value) {
  return THEME_PREFS.has(value) ? value : "elegant";
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function concreteTheme(pref) {
  const normalized = normalizeThemePref(pref);
  return normalized === "auto" ? (systemPrefersDark() ? "midnight" : "elegant") : normalized;
}

function applyTheme(value) {
  currentThemePref = normalizeThemePref(value);
  document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
}

function watchSystemTheme() {
  if (!window.matchMedia) {
    return;
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentThemePref === "auto") {
      document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
    }
  });
}

function getDependencies() {
  const bridge = window.__SAYTYPE_IPC__;
  const i18nApi = window.SayTypeI18n;

  if (
    bridge &&
    typeof bridge.invoke === "function" &&
    typeof bridge.on === "function" &&
    i18nApi &&
    typeof i18nApi.initI18n === "function" &&
    typeof i18nApi.setLanguage === "function" &&
    typeof i18nApi.applyI18n === "function" &&
    typeof i18nApi.t === "function"
  ) {
    return { bridge, i18nApi };
  }

  return null;
}

async function waitForDependencies() {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const dependencies = getDependencies();
    if (dependencies) {
      return dependencies;
    }
    await delay(READY_POLL_MS);
  }

  return getDependencies();
}

async function initializeDependencies() {
  if (ipc) {
    return;
  }

  const dependencies = getDependencies() || (await waitForDependencies());
  if (!dependencies) {
    throw new Error("settings runtime dependencies unavailable");
  }

  ipc = dependencies.bridge;
  ({ initI18n, setLanguage, applyI18n, t } = dependencies.i18nApi);
}

function updateModelOptions(provider) {
  const select = document.getElementById("modelSelect");
  if (!select) {
    return;
  }

  select.innerHTML = "";
  (modelOptions[provider] || []).forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    const label = opt.labelKey ? translate(opt.labelKey) : opt.label || opt.value;
    option.textContent = opt.recommended
      ? `${label} · ${translate("settings.model.recommendedTag")}`
      : label;
    select.appendChild(option);
  });
}

// The engine list, in the order it is offered. Cloud rows carry the key state,
// local rows the download state — the two things that decide whether a choice
// is usable at all, which a bare dropdown could not show.
const ENGINE_CARDS = [
  { value: LOCAL_QWEN_PROVIDER, local: true, icon: "memory", recommended: true },
  { value: "openai", local: false, icon: "cloud" },
  { value: "groq", local: false, icon: "cloud" },
  { value: LOCAL_NEMOTRON_PROVIDER, local: true, icon: "memory", experimental: true },
];

function engineStatus(entry) {
  if (entry.value === LOCAL_QWEN_PROVIDER) {
    if (localModelState === "ready") {
      return { key: "settings.engine.status.ready", tone: "ok" };
    }
    if (localModelState === "downloading") {
      return { key: "settings.engine.status.downloading", tone: "busy" };
    }
    return { key: "settings.engine.status.needsDownload", tone: "warn" };
  }
  if (entry.local) {
    return { key: "settings.engine.status.local", tone: "" };
  }
  const field = entry.value === "groq" ? "apiKeyGroq" : "apiKeyOpenAI";
  const hasKey = !!document.getElementById(field)?.value.trim();
  return hasKey
    ? { key: "settings.engine.status.keySet", tone: "ok" }
    : { key: "settings.engine.status.needsKey", tone: "warn" };
}

function renderEngineCards() {
  const host = document.getElementById("engineCards");
  const select = document.getElementById("providerSelect");
  if (!host || !select) {
    return;
  }
  const offered = new Set(Array.from(select.options).map((option) => option.value));
  const selected = select.value;

  host.replaceChildren(
    ...ENGINE_CARDS.filter((entry) => offered.has(entry.value)).map((entry) => {
      const active = entry.value === selected;
      const card = document.createElement("button");
      card.type = "button";
      card.className = `engine-card-row${active ? " active" : ""}${
        entry.experimental ? " experimental" : ""
      }`;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(active));

      const radio = document.createElement("span");
      radio.className = "engine-radio";

      const icon = document.createElement("span");
      icon.className = "engine-card-icon material-icons";
      icon.textContent = entry.icon;

      const body = document.createElement("div");
      body.className = "engine-card-body";
      const nameRow = document.createElement("div");
      nameRow.className = "engine-card-name";
      const name = document.createElement("span");
      name.textContent = translate(`settings.engine.${camelKey(entry.value)}.name`);
      nameRow.appendChild(name);
      if (entry.recommended) {
        const tag = document.createElement("span");
        tag.className = "engine-tag-ok";
        tag.textContent = translate("settings.engine.recommended");
        nameRow.appendChild(tag);
      }
      if (entry.experimental) {
        const tag = document.createElement("span");
        tag.className = "engine-tag-muted";
        tag.textContent = translate("settings.engine.experimental");
        nameRow.appendChild(tag);
      }
      const desc = document.createElement("div");
      desc.className = "engine-card-desc";
      desc.textContent = translate(`settings.engine.${camelKey(entry.value)}.description`);
      body.appendChild(nameRow);
      body.appendChild(desc);

      const status = engineStatus(entry);
      const statusEl = document.createElement("span");
      statusEl.className = `engine-card-status${status.tone ? ` engine-status-${status.tone}` : ""}`;
      statusEl.textContent = translate(status.key);

      card.append(radio, icon, body, statusEl);
      card.addEventListener("click", () => {
        if (select.value === entry.value) {
          return;
        }
        // Drive the select rather than duplicating its logic: `change` reaches
        // handleProviderChange and the page-level commit exactly as a native
        // selection would.
        select.value = entry.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        renderEngineCards();
      });
      return card;
    })
  );
}

function camelKey(providerValue) {
  return providerValue.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function localModelForProvider(provider) {
  if (provider === LOCAL_NEMOTRON_PROVIDER) {
    return NEMOTRON_LOCAL_MODEL;
  }
  if (provider === LOCAL_QWEN_PROVIDER) {
    return QWEN_LOCAL_MODEL;
  }
  return "";
}

function providerForSettings(settings) {
  if (settings?.provider !== "local") {
    return settings?.provider || "groq";
  }
  return settings.model === NEMOTRON_LOCAL_MODEL
    ? LOCAL_NEMOTRON_PROVIDER
    : LOCAL_QWEN_PROVIDER;
}

// Nemotron is wired for Apple Silicon and Windows x64. On other build targets it
// is not merely "not downloaded yet" — it cannot run. Drop the option instead
// of letting it be picked. This is a compile-time constant per build
// (`nemotronSupported`), so removing the node once is enough.
function applyNemotronAvailability() {
  if (currentSettings.nemotronSupported) {
    return;
  }
  document
    .querySelector(`#providerSelect option[value="${LOCAL_NEMOTRON_PROVIDER}"]`)
    ?.remove();
  document.getElementById("nemotronLatencyItem")?.classList.add("hidden");
}

// Reuse the same key inputs so switching modes never loses an unsaved key.
// Local translation lives in a separate, collapsed panel, not in dictation.
function toggleProviderFields(providerChoice) {
  const provider = localModelForProvider(providerChoice) ? "local" : providerChoice;
  const isLocal = provider === "local";
  document.getElementById("cloudDictationOptions")?.classList.toggle("hidden", isLocal);
  const advanced = document.getElementById("engineAdvanced");
  advanced?.classList.toggle("hidden", !isLocal && !inspectedLocalModel);

  const apiKeyItem = document.getElementById("apiKeyItem");
  const modelItem = document.getElementById("modelItem");
  const nemotronLatencyItem = document.getElementById("nemotronLatencyItem");
  const fieldGroq = document.getElementById("apiKeyFieldGroq");
  const fieldOpenAI = document.getElementById("apiKeyFieldOpenAI");
  if (!fieldGroq || !fieldOpenAI) {
    return;
  }

  const title = document.getElementById("apiKeyTitle");
  const description = document.getElementById("apiKeyDescription");
  const uploadNote = document.getElementById("translateUploadNote");
  const translateSelect = document.getElementById("translateProviderSelect");
  const translationPanel = document.getElementById("translationPanel");
  const translationSlot = document.getElementById("translationKeySlot");
  const dictationSlot = document.getElementById("dictationKeySlot");
  if (apiKeyItem && translationPanel && translationSlot && dictationSlot) {
    const wasLocal = apiKeyItem.parentElement === translationSlot;
    if (wasLocal !== isLocal) translationPanel.open = false;
    if (isLocal) translationSlot.appendChild(apiKeyItem);
    else dictationSlot.after(apiKeyItem);
    translationPanel.classList.toggle("hidden", !isLocal);
  }
  if (title) title.textContent = translate("settings.apiKey.title");
  if (description) description.textContent = translate("settings.apiKey.description");
  uploadNote?.classList.toggle("hidden", !isLocal);
  translateSelect?.classList.toggle("hidden", !isLocal);

  // Language never reaches the local engine: the CLI invocation carries no
  // language argument. Show that rather than letting the choice look applied.
  const languageSelect = document.getElementById("languageSelect");
  if (languageSelect) {
    languageSelect.disabled = isLocal;
  }
  document.getElementById("languageLocalNote")?.classList.toggle("hidden", !isLocal);

  apiKeyItem?.classList.remove("hidden");
  modelItem?.classList.toggle("hidden", isLocal);
  nemotronLatencyItem?.classList.toggle("hidden", providerChoice !== LOCAL_NEMOTRON_PROVIDER);
  // GPU acceleration applies to the Qwen engine only: Nemotron runs on its
  // own runtime, and platforms without a GPU pack have nothing to switch.
  document
    .getElementById("localComputeItem")
    ?.classList.toggle(
      "hidden",
      !gpuRuntimeSupported || providerChoice !== LOCAL_QWEN_PROVIDER
    );
  const keyProvider = isLocal ? translateSelect?.value || "groq" : provider;
  fieldGroq.classList.toggle("hidden", keyProvider !== "groq");
  fieldOpenAI.classList.toggle("hidden", keyProvider !== "openai");
}

// --- Local model panel (provider "local") ---
let localModelState = "absent"; // absent | partial | downloading | ready
// Whether the running download was started from this Settings page. Gates the
// "switch to local?" prompt on ready: a download driven by the onboarding
// onboarding wizard auto-switches there, so Settings must not show a second,
// competing dialog.
let localModelDownloadStartedHere = "";
let inspectedLocalModel = null;
let localModelSyncBound = false;
let updatesPanelBound = false;
let currentAppVersion = "";
let diagnosticLogPanelBound = false;
let diagnosticLogLoaded = false;
let diagnosticLogLoading = false;
let currentDiagnosticLog = null;

function formatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function selectedLocalModel() {
  const provider = document.getElementById("providerSelect")?.value;
  return inspectedLocalModel || localModelForProvider(provider) || QWEN_LOCAL_MODEL;
}

function renderLocalModelPanel(status) {
  // The Qwen card reports the same state, so re-render it whenever this does.
  window.setTimeout(renderEngineCards, 0);
  const item = document.getElementById("localModelItem");
  const statusEl = document.getElementById("localModelStatus");
  const actionBtn = document.getElementById("localModelActionBtn");
  const deleteBtn = document.getElementById("localModelDeleteBtn");
  const progressEl = document.getElementById("localModelProgress");
  if (!item || !statusEl || !actionBtn || !deleteBtn || !progressEl) {
    return;
  }
  localModelState = status.state;
  const provider = document.getElementById("providerSelect")?.value;
  item.classList.toggle("hidden", !inspectedLocalModel && !localModelForProvider(provider));
  const advanced = document.getElementById("engineAdvanced");
  if (advanced) {
    const visible = !!inspectedLocalModel || !!localModelForProvider(provider);
    advanced.classList.toggle("hidden", !visible);
    if (visible && status.state !== "ready") advanced.open = true;
  }


  const pct = status.totalBytes ? status.downloadedBytes / status.totalBytes : 0;
  progressEl.value = Math.round(pct * 1000);
  progressEl.classList.toggle("hidden", status.state !== "downloading");
  // Also offered in the "partial" state: an interrupted download leaves up to
  // ~1 GB of .part files behind, and resuming is not the only way out of it.
  const isPartial = status.state === "partial";
  deleteBtn.classList.toggle("hidden", status.state !== "ready" && !isPartial);
  deleteBtn.textContent = translate(
    isPartial ? "settings.localModel.deletePartial" : "settings.localModel.delete"
  );

  if (status.state === "unsupported") {
    statusEl.textContent = translate("settings.localModel.statusUnsupported");
    actionBtn.classList.add("hidden");
    deleteBtn.classList.add("hidden");
  } else if (status.state === "ready") {
    statusEl.textContent = translate("settings.localModel.statusReady", {
      size: formatGB(status.totalBytes),
    });
    actionBtn.classList.add("hidden");
  } else if (status.state === "downloading") {
    statusEl.textContent = translate("settings.localModel.statusDownloading", {
      done: formatGB(status.downloadedBytes),
      total: formatGB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate("settings.localModel.cancel");
  } else {
    statusEl.textContent =
      status.state === "partial"
        ? translate("settings.localModel.statusPartial")
        : translate("settings.localModel.statusAbsent", { total: formatGB(status.totalBytes) });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate(
      status.state === "partial" ? "settings.localModel.resume" : "settings.localModel.download"
    );
  }
}

async function refreshLocalModelStatus() {
  if (!ipc) {
    return;
  }
  try {
    renderLocalModelPanel(await ipc.invoke("get-local-model-status", selectedLocalModel()));
  } catch (error) {
    console.error("Failed to fetch local model status:", error);
  }
}

async function handleLocalModelAction() {
  try {
    if (localModelState === "downloading") {
      localModelDownloadStartedHere = "";
      await ipc.invoke("cancel-local-model-download");
      return; // terminal event repaints the panel
    }
    // Optimistic repaint, then kick the (long-running) download; progress
    // events keep the panel live. Errors surface via the "error" event too.
    const model = selectedLocalModel();
    localModelDownloadStartedHere = model;
    renderLocalModelPanel({ state: "downloading", downloadedBytes: 0, totalBytes: 1 });
    void refreshLocalModelStatus();
    await ipc.invoke("download-local-model", model);
  } catch (error) {
    console.error("Local model download failed:", error);
  }
}

// Download finished from this page → offer (don't force) the switch to the
// local engine; the backend save + broadcast keeps every window in sync.
async function offerSwitchToLocal(model) {
  if (currentSettings?.provider === "local" && currentSettings?.model === model) {
    return;
  }
  if (!confirm(translate("settings.localModel.switchPrompt"))) {
    return;
  }
  try {
    await ipc.invoke("set-local-model", model);
    currentSettings.provider = "local";
    currentSettings.model = model;
    const providerSelect = document.getElementById("providerSelect");
    setSelectValue(providerSelect, providerForSettings(currentSettings), "groq");
    toggleProviderFields(providerSelect?.value || "groq");
    void refreshLocalModelStatus();
  } catch (error) {
    // Same reason as saveSettings: no modal on this page. The user is looking
    // at the row that failed to change.
    console.error("Failed to switch to the local engine:", error);
    showSaveStatus("error", translate("settings.saveError"));
  }
}

async function handleLocalModelDelete() {
  const confirmKey =
    localModelState === "partial"
      ? "settings.localModel.deletePartialConfirm"
      : "settings.localModel.deleteConfirm";
  if (!confirm(translate(confirmKey))) {
    return;
  }
  try {
    await ipc.invoke("delete-local-model", selectedLocalModel());
    await refreshLocalModelStatus();
  } catch (error) {
    console.error("Failed to delete local model:", error);
  }
}

function setupLocalModelSync() {
  if (localModelSyncBound || !ipc) {
    return;
  }
  localModelSyncBound = true;
  ipc.on("local-model-download-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    if (payload.model && payload.model !== selectedLocalModel()) {
      return;
    }
    if (payload.state === "error") {
      alert(translate("settings.localModel.downloadFailed", { reason: payload.message || "" }));
    }
    if (payload.state === "downloading") {
      renderLocalModelPanel({
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
      });
    } else {
      // ready/cancelled/error: re-derive the real on-disk state.
      void refreshLocalModelStatus();
    }
    if (payload.state === "ready" && localModelDownloadStartedHere === selectedLocalModel()) {
      const model = localModelDownloadStartedHere;
      localModelDownloadStartedHere = "";
      void offerSwitchToLocal(model);
    }
  });

}

// --- GPU acceleration panel (local Qwen engine) ---
// The GPU runtime is an optional ~33 MB pack fetched on demand: the required
// runtime is CPU-only, and which backend runs is decided by which pack the
// process is started from, not by a flag. Qwen only — Nemotron ships its own
// runtime and is unaffected by this setting.
let gpuRuntimeSupported = false;
let gpuRuntimeState = "absent"; // absent | downloading | ready
let gpuRuntimeStatus = null;
let gpuRuntimeSyncBound = false;

function formatMB(bytes) {
  return `${Math.round((bytes || 0) / 1024 / 1024)} MB`;
}

function renderLocalComputePanel(status) {
  const statusEl = document.getElementById("localComputeStatus");
  const select = document.getElementById("localComputeSelect");
  const actionBtn = document.getElementById("localComputeActionBtn");
  const deleteBtn = document.getElementById("localComputeDeleteBtn");
  const progressEl = document.getElementById("localComputeProgress");
  if (!statusEl || !select || !actionBtn || !deleteBtn || !progressEl) {
    return;
  }
  gpuRuntimeState = status.state;

  const pct = status.totalBytes ? status.downloadedBytes / status.totalBytes : 0;
  progressEl.value = Math.round(pct * 1000);
  progressEl.classList.toggle("hidden", status.state !== "downloading");
  deleteBtn.classList.toggle("hidden", status.state !== "ready");
  deleteBtn.textContent = translate("settings.localCompute.delete");
  actionBtn.classList.add("hidden");

  if (status.state === "downloading") {
    statusEl.textContent = translate("settings.localCompute.statusDownloading", {
      done: formatMB(status.downloadedBytes),
      total: formatMB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate("settings.localCompute.cancel");
    return;
  }
  // The copy follows the control the user is looking at, not the saved value:
  // the select can be ahead of the config until Save.
  if (select.value !== "gpu") {
    statusEl.textContent = translate("settings.localCompute.statusCpu");
    return;
  }
  if (status.state !== "ready") {
    statusEl.textContent = translate("settings.localCompute.statusAbsent", {
      total: formatMB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate(
      status.downloadedBytes > 0
        ? "settings.localCompute.retry"
        : "settings.localCompute.download"
    );
    return;
  }
  if (status.fellBack) {
    statusEl.textContent = translate("settings.localCompute.statusFellBack");
    return;
  }
  // An installed pack that lists no device is the "no driver / unusable GPU"
  // case — say so, because the transcription silently runs on the CPU.
  statusEl.textContent = status.devices?.length
    ? translate("settings.localCompute.statusReady", { device: status.devices[0] })
    : translate("settings.localCompute.statusNoDevice");
}

async function refreshGpuRuntimeStatus() {
  if (!ipc || !gpuRuntimeSupported) {
    return;
  }
  try {
    const status = await ipc.invoke("get-gpu-runtime-status");
    // The status reports the pack size as sizeBytes; progress events use
    // totalBytes. Normalize here so the panel has one shape to render.
    gpuRuntimeStatus = { ...status, totalBytes: status.sizeBytes };
    renderLocalComputePanel(gpuRuntimeStatus);
  } catch (error) {
    console.error("Failed to fetch GPU runtime status:", error);
  }
}

async function handleGpuRuntimeAction() {
  try {
    if (gpuRuntimeState === "downloading") {
      await ipc.invoke("cancel-gpu-runtime-download");
      return; // the terminal event repaints the panel
    }
    renderLocalComputePanel({
      ...(gpuRuntimeStatus || {}),
      state: "downloading",
      downloadedBytes: 0,
      totalBytes: gpuRuntimeStatus?.totalBytes || 1,
    });
    await ipc.invoke("download-gpu-runtime");
  } catch (error) {
    console.error("GPU runtime download failed:", error);
  }
}

async function handleGpuRuntimeDelete() {
  if (!confirm(translate("settings.localCompute.deleteConfirm"))) {
    return;
  }
  try {
    await ipc.invoke("delete-gpu-runtime");
    // The backend also rewrites a saved "gpu" back to "auto"; mirror it here so
    // the form cannot save the removed backend straight back in.
    const select = document.getElementById("localComputeSelect");
    if (select?.value === "gpu") {
      select.value = "auto";
    }
    currentSettings.localCompute = "auto";
    await refreshGpuRuntimeStatus();
    void renderBuildLine();
    renderEngineCards();
  } catch (error) {
    console.error("Failed to remove the GPU runtime:", error);
  }
}

// Picking the GPU with nothing installed is a request to install it — the
// setting on its own would save and then quietly keep running on the CPU.
function handleLocalComputeChange() {
  const select = document.getElementById("localComputeSelect");
  if (select?.value === "gpu" && gpuRuntimeState === "absent") {
    void handleGpuRuntimeAction();
    return;
  }
  renderLocalComputePanel(
    gpuRuntimeStatus || { state: gpuRuntimeState, downloadedBytes: 0, totalBytes: 0, devices: [] }
  );
}

function setupGpuRuntimeSync() {
  if (gpuRuntimeSyncBound || !ipc) {
    return;
  }
  gpuRuntimeSyncBound = true;
  ipc.on("local-gpu-runtime-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    if (payload.state === "error") {
      alert(translate("settings.localCompute.downloadFailed", { reason: payload.message || "" }));
    }
    if (payload.state === "downloading") {
      renderLocalComputePanel({
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
        devices: [],
      });
    } else {
      // ready/cancelled/error/absent: re-derive the real on-disk state.
      void refreshGpuRuntimeStatus();
    }
  });
}

function revealLocalModelPanel(model = QWEN_LOCAL_MODEL) {
  // Inspect/download without selecting an engine that is not yet usable.
  inspectedLocalModel = model;
  const advanced = document.getElementById("engineAdvanced");
  if (advanced) advanced.open = true;
  void refreshLocalModelStatus();
  window.setTimeout(() => {
    document.getElementById("localModelItem")?.scrollIntoView({ block: "center" });
  }, 0);
}

function renderUpdateStatus(status) {
  const statusEl = document.getElementById("updateStatus");
  const checkBtn = document.getElementById("checkUpdatesBtn");
  const installBtn = document.getElementById("installUpdateBtn");
  if (!statusEl || !checkBtn || !installBtn) {
    return;
  }

  const state = status?.state || "idle";
  const version = status?.version || "";
  checkBtn.disabled = state === "checking" || state === "downloading";
  checkBtn.classList.toggle("hidden", state === "ready");
  installBtn.classList.toggle("hidden", state !== "ready");

  if (state === "checking") {
    statusEl.textContent = translate("settings.updates.checking");
  } else if (state === "downloading") {
    statusEl.textContent = translate("settings.updates.downloading", { version });
  } else if (state === "ready") {
    statusEl.textContent = translate("settings.updates.ready", { version });
  } else if (state === "error") {
    statusEl.textContent = translate("settings.updates.error", { message: status?.message || "" });
  } else if (state === "upToDate") {
    statusEl.textContent = translate("settings.updates.upToDate", { version: currentAppVersion });
  } else {
    statusEl.textContent = currentAppVersion ? `v${currentAppVersion}` : "";
  }
}

async function refreshUpdateStatus() {
  try {
    renderUpdateStatus(await ipc.invoke("get-update-status"));
  } catch {
    renderUpdateStatus({ state: "idle" });
  }
}

async function setupUpdatesPanel() {
  if (updatesPanelBound || !ipc) {
    return;
  }
  updatesPanelBound = true;

  ipc.on("update-status", (_event, payload) => {
    if (payload) {
      renderUpdateStatus(payload);
    }
  });

  document.getElementById("checkUpdatesBtn")?.addEventListener("click", async () => {
    try {
      renderUpdateStatus(await ipc.invoke("check-for-updates"));
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  document.getElementById("installUpdateBtn")?.addEventListener("click", async () => {
    try {
      await ipc.invoke("install-update-and-restart");
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  try {
    // Dev-channel builds show the local build counter alongside the version;
    // official CI builds stay a clean "1.6.1". Remote versions in the
    // downloading/ready strings are untouched.
    const info = await ipc.invoke("get-build-info");
    currentAppVersion =
      info.channel === "official" ? info.version : `${info.version} · dev.${info.buildNumber}`;
  } catch {
    currentAppVersion = "";
  }
  await refreshUpdateStatus();
}

function formatDiagnosticLogSize(bytes) {
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function renderDiagnosticLog(result) {
  const contentElement = document.getElementById("diagnosticLogContent");
  const statusElement = document.getElementById("diagnosticLogStatus");
  const copyButton = document.getElementById("copyDiagnosticLogBtn");
  if (!contentElement || !statusElement || !copyButton) {
    return;
  }

  currentDiagnosticLog = result;
  const content = typeof result?.content === "string" ? result.content : "";
  contentElement.value = content;
  copyButton.disabled = !content;
  if (!content) {
    statusElement.textContent = translate("settings.diagnostics.empty");
    return;
  }

  const language = currentSettings?.uiLanguage;
  const locale = language === "zh" ? "zh-CN" : language === "en" ? "en-US" : undefined;
  const modifiedAt = Number(result.modifiedAtUnixMs);
  const time = modifiedAt > 0 ? new Date(modifiedAt).toLocaleString(locale) : "—";
  statusElement.textContent = translate(
    result.truncated ? "settings.diagnostics.truncated" : "settings.diagnostics.loaded",
    {
      size: formatDiagnosticLogSize(Number(result.sizeBytes)),
      time,
    }
  );
}

async function refreshDiagnosticLog() {
  if (!ipc || diagnosticLogLoading) {
    return;
  }

  const statusElement = document.getElementById("diagnosticLogStatus");
  const refreshButton = document.getElementById("refreshDiagnosticLogBtn");
  const copyButton = document.getElementById("copyDiagnosticLogBtn");
  diagnosticLogLoading = true;
  if (statusElement) {
    statusElement.textContent = translate("settings.diagnostics.loading");
  }
  if (refreshButton) {
    refreshButton.disabled = true;
  }
  if (copyButton) {
    copyButton.disabled = true;
  }

  try {
    const result = await ipc.invoke("get-diagnostic-log");
    diagnosticLogLoaded = true;
    renderDiagnosticLog(result);
  } catch (error) {
    if (statusElement) {
      statusElement.textContent = translate("settings.diagnostics.loadError", {
        message: String(error),
      });
    }
  } finally {
    diagnosticLogLoading = false;
    if (refreshButton) {
      refreshButton.disabled = false;
    }
    if (copyButton) {
      copyButton.disabled = !document.getElementById("diagnosticLogContent")?.value;
    }
  }
}

async function copyDiagnosticLog() {
  const content = document.getElementById("diagnosticLogContent")?.value || "";
  const statusElement = document.getElementById("diagnosticLogStatus");
  if (!content || !statusElement) {
    return;
  }

  try {
    await ipc.invoke("copy-to-clipboard", content, null);
    statusElement.textContent = translate("settings.diagnostics.copied");
  } catch (error) {
    statusElement.textContent = translate("settings.diagnostics.copyError", {
      message: String(error),
    });
  }
}

function setupDiagnosticLogPanel() {
  if (diagnosticLogPanelBound) {
    return;
  }
  const panel = document.getElementById("diagnosticLogPanel");
  if (!panel) {
    return;
  }

  panel.addEventListener("toggle", () => {
    if (panel.open && !diagnosticLogLoaded) {
      void refreshDiagnosticLog();
    }
  });
  document.getElementById("refreshDiagnosticLogBtn")?.addEventListener("click", () => {
    void refreshDiagnosticLog();
  });
  document.getElementById("copyDiagnosticLogBtn")?.addEventListener("click", () => {
    void copyDiagnosticLog();
  });
  diagnosticLogPanelBound = true;

  if (panel.open) {
    void refreshDiagnosticLog();
  }
}

function toggleKeyReveal(button) {
  const input = document.getElementById(button.getAttribute("data-target"));
  if (!input) {
    return;
  }
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.textContent = reveal ? "visibility_off" : "visibility";
  const label = translate(reveal ? "settings.apiKey.hide" : "settings.apiKey.reveal");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

// Settings commit as they are changed — there is no draft to keep. The Home
// engine switcher always wrote through immediately (set_provider), so the page
// and the switcher used to disagree about what "changed" meant; now they don't.
let saveStatusTimer = null;

function showSaveStatus(state, message) {
  const element = document.getElementById("saveStatus");
  if (!element) {
    return;
  }
  window.clearTimeout(saveStatusTimer);
  element.textContent = message;
  element.classList.toggle("save-status-error", state === "error");
  element.classList.toggle("save-status-ok", state === "ok");
  if (state === "ok") {
    // A confirmation only has to be caught out of the corner of the eye; a
    // failure stays until the next attempt says otherwise.
    saveStatusTimer = window.setTimeout(() => {
      element.textContent = "";
      element.classList.remove("save-status-ok");
    }, 1600);
  }
}

// Text inputs commit on blur, but a key pasted and left alone should not sit
// unsaved either — hence a debounce on top.
let commitTimer = null;

function commitSoon(delayMs = 700) {
  window.clearTimeout(commitTimer);
  commitTimer = window.setTimeout(() => {
    void saveSettings();
  }, delayMs);
}

function commitNow() {
  window.clearTimeout(commitTimer);
  void saveSettings();
}

function setSelectValue(element, value, fallback) {
  if (!element) {
    return;
  }

  const hasOption = Array.from(element.options).some((option) => option.value === value);
  element.value = hasOption ? value : fallback;
}

function handleTranslateProviderChange() {
  toggleProviderFields(document.getElementById("providerSelect")?.value || "groq");
  commitNow();
}

function handleProviderChange(event) {
  const providerChoice = event.target.value || "groq";
  inspectedLocalModel = null;
  renderEngineCards();
  const provider = localModelForProvider(providerChoice) ? "local" : providerChoice;
  if (provider !== "local") {
    updateModelOptions(provider);
  }
  toggleProviderFields(providerChoice);
  void refreshLocalModelStatus();
}

function handleThemeChange(event) {
  applyTheme(event.target.value);
}

function handleUiLanguageChange(event) {
  setLanguage(event.target.value);
  applyI18n(document);
  if (currentDiagnosticLog) {
    renderDiagnosticLog(currentDiagnosticLog);
  }
  void checkMicrophonePermissionStatus();
  void checkAccessibilityStatus();
  void refreshUpdateStatus();
}

function activateSettingsTab(tabName, focus = false) {
  const target = SETTINGS_TABS.includes(tabName) ? tabName : "dictation";
  activeSettingsTab = target;

  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    const active = tab.getAttribute("data-settings-tab") === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) {
      tab.focus();
    }
  });

  document.querySelectorAll(".settings-panel").forEach((panel) => {
    const active = panel.id === `settings-panel-${target}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function handleSettingsTabClick(event) {
  activateSettingsTab(event.currentTarget.getAttribute("data-settings-tab"));
}

function handleSettingsTabKeydown(event) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
    return;
  }
  event.preventDefault();
  const current = SETTINGS_TABS.indexOf(activeSettingsTab);
  let next = current;
  if (event.key === "ArrowRight") {
    next = (current + 1) % SETTINGS_TABS.length;
  } else if (event.key === "ArrowLeft") {
    next = (current - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = SETTINGS_TABS.length - 1;
  }
  activateSettingsTab(SETTINGS_TABS[next], true);
}

function bindEventHandlers() {
  if (pageEventsBound) {
    return;
  }

  watchSystemTheme();

  const providerSelect = document.getElementById("providerSelect");
  const checkPermissionButton = document.getElementById("checkPermission");
  const checkAccessibilityButton = document.getElementById("checkAccessibility");
  const uiLanguageSelect = document.getElementById("uiLanguageSelect");
  const themeSelect = document.getElementById("themeSelect");

  providerSelect?.addEventListener("change", handleProviderChange);
  document
    .getElementById("translateProviderSelect")
    ?.addEventListener("change", handleTranslateProviderChange);
  checkPermissionButton?.addEventListener("click", () => {
    void requestMicrophonePermission();
  });
  document.getElementById("recheckPermissions")?.addEventListener("click", () => {
    void recheckPermissions();
  });
  document.getElementById("openDictionaryBtn")?.addEventListener("click", () => {
    // Dictation is where you configure a dictation; the dictionary is part of
    // that, even though its editor is its own page.
    window.showPage?.("dictionary");
  });
  document.getElementById("revealAppBtn")?.addEventListener("click", () => {
    void ipc.invoke("reveal-app-in-finder").catch((error) => {
      console.error("Failed to reveal the app:", error);
    });
  });
  checkAccessibilityButton?.addEventListener("click", () => {
    void handleAccessibilityPermission();
  });
  uiLanguageSelect?.addEventListener("change", handleUiLanguageChange);
  themeSelect?.addEventListener("change", handleThemeChange);

  document.querySelectorAll(".reveal-btn").forEach((button) => {
    button.addEventListener("click", () => toggleKeyReveal(button));
  });

  document.getElementById("localModelActionBtn")?.addEventListener("click", () => {
    void handleLocalModelAction();
  });
  document.getElementById("localComputeActionBtn")?.addEventListener("click", () => {
    void handleGpuRuntimeAction();
  });
  document.getElementById("localComputeDeleteBtn")?.addEventListener("click", () => {
    void handleGpuRuntimeDelete();
  });
  document
    .getElementById("localComputeSelect")
    ?.addEventListener("change", handleLocalComputeChange);
  document.getElementById("localModelDeleteBtn")?.addEventListener("click", () => {
    void handleLocalModelDelete();
  });

  // Only edits inside Settings commit. History search and the dictionary live
  // in the same main window and must not trigger a settings write.
  const settingsPage = document.querySelector("#settings-page");
  settingsPage?.addEventListener("change", commitNow);
  for (const id of ["apiKeyGroq", "apiKeyOpenAI"]) {
    document.getElementById(id)?.addEventListener("input", () => renderEngineCards());
  }
  settingsPage?.addEventListener("input", (event) => {
    // Selects and checkboxes already fired `change`; only free text needs the
    // debounce, and re-committing on every keystroke would rewrite the config
    // file per character.
    if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
      commitSoon();
    }
  });
  settingsPage?.addEventListener(
    "blur",
    (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
        commitNow();
      }
    },
    true
  );

  // Permission state can change while another main-window page is active or
  // while System Settings is in front. Refresh quietly whenever the app comes
  // back; the debounced gated recheck stays for the guided flow, where the TCC
  // grant can land a beat after refocus.
  window.addEventListener("focus", () => {
    void refreshAccessibilityQuietly();
    scheduleAccessibilityRecheck();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshAccessibilityQuietly();
      scheduleAccessibilityRecheck();
    }
  });

  // The backend broadcasts every real Accessibility state change (wizard
  // grant, main-window rechecks), so re-render without waiting for the next
  // visit to Settings.
  ipc.on("accessibility-permission-changed", () => {
    void refreshAccessibilityQuietly();
  });

  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    tab.addEventListener("click", handleSettingsTabClick);
    tab.addEventListener("keydown", handleSettingsTabKeydown);
  });

  pageEventsBound = true;
}

// Permissions are install-time state, not a setting anyone returns to. When
// both are granted the two rows collapse into one line; the moment one is
// missing they expand again, with the button that fixes it.
const permissionState = { microphone: null, accessibility: null };

function renderPermissionSummary() {
  const allGranted =
    permissionState.microphone === true && permissionState.accessibility === true;
  document.getElementById("permissionSummary")?.classList.toggle("hidden", !allGranted);
  for (const id of ["permissionStatus", "accessibilityStatus"]) {
    document
      .getElementById(id)
      ?.closest(".setting-item")
      ?.classList.toggle("hidden", allGranted);
  }
}

function renderAccessibilityStatus(result) {
  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return;
  }

  let ok = false;
  if (!result) {
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
  } else if (result.granted) {
    statusElement.textContent = translate("settings.accessibility.granted");
    statusElement.className = "permission-status granted";
    ok = true;
  } else if (result.status === "not_required") {
    statusElement.textContent = translate("settings.accessibility.notRequired");
    statusElement.className = "permission-status granted";
    ok = true;
  } else {
    statusElement.textContent = translate("settings.accessibility.denied");
    statusElement.className = "permission-status denied";
  }

  // Once granted there's nothing to act on, so hide the check button.
  document.getElementById("checkAccessibility")?.classList.toggle("hidden", ok);
  permissionState.accessibility = ok;
  renderPermissionSummary();
}

function scheduleAccessibilityRecheck() {
  if (!pendingAccessibilityRecheck) {
    return;
  }

  if (accessibilityRecheckTimer) {
    window.clearTimeout(accessibilityRecheckTimer);
  }

  accessibilityRecheckTimer = window.setTimeout(() => {
    accessibilityRecheckTimer = null;
    pendingAccessibilityRecheck = false;
    void recheckAccessibilityPermission();
  }, 400);
}

async function requestAccessibilityPermission() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("request-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to request accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

async function handleAccessibilityPermission() {
  const result = await requestAccessibilityPermission();
  if (!result || result.granted || result.status === "not_required") {
    return;
  }

  try {
    pendingAccessibilityRecheck = true;
    await ipc.invoke("show-permission-dialog");
  } catch (error) {
    pendingAccessibilityRecheck = false;
    console.error("Failed to open accessibility settings:", error);
  }
}

function setupShortcutSync() {
  if (shortcutSyncBound || !ipc) {
    return;
  }

  shortcutSyncBound = true;
  ipc.on("shortcut-updated", (_event, payload) => {
    if (!payload || !payload.recordShortcut) {
      return;
    }

    const shortcutSelect = document.getElementById("shortcutSelect");
    setSelectValue(shortcutSelect, payload.recordShortcut, "Ctrl+Shift");
  });
}

function setupThemeSync() {
  if (themeSyncBound || !ipc) {
    return;
  }

  themeSyncBound = true;
  ipc.on("ui-theme-updated", (_event, payload) => {
    if (!payload) {
      return;
    }

    applyTheme(payload.theme);
    setSelectValue(document.getElementById("themeSelect"), normalizeThemePref(payload.theme), "elegant");
  });
}

async function recheckPermissions() {
  const button = document.getElementById("recheckPermissions");
  const feedback = document.getElementById("permissionRecheckFeedback");
  if (!button || !feedback || button.disabled) return;
  button.disabled = true;
  button.textContent = translate("settings.permission.checking");
  feedback.textContent = translate("settings.permission.checking");
  feedback.setAttribute("aria-busy", "true");
  try {
    const [microphone, accessibility] = await Promise.all([
      checkMicrophonePermissionStatus(), checkAccessibilityStatus(),
    ]);
    const failed = microphone == null || accessibility == null;
    const granted = microphone && (accessibility?.granted || accessibility?.status === "not_required");
    feedback.textContent = translate(`settings.permissions.${
      failed ? "checkFailed" : granted ? "checked" : "needsAttention"
    }`);
  } catch {
    feedback.textContent = translate("settings.permissions.checkFailed");
  } finally {
    button.disabled = false;
    button.textContent = translate("settings.permissions.recheck");
    feedback.setAttribute("aria-busy", "false");
  }
}

async function checkMicrophonePermissionStatus() {
  if (!ipc) {
    return;
  }

  const statusElement = document.getElementById("permissionStatus");
  if (!statusElement) {
    return;
  }

  const micButton = document.getElementById("checkPermission");
  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-microphone-permission");
    const status = result.status;
    let ok = false;

    if (status === "granted") {
      statusElement.textContent = translate("settings.permission.granted");
      statusElement.className = "permission-status granted";
      ok = true;
    } else if (status === "not-determined") {
      statusElement.textContent = translate("settings.permission.notDetermined");
      statusElement.className = "permission-status";
    } else if (status === "restricted") {
      statusElement.textContent = translate("settings.permission.restricted");
      statusElement.className = "permission-status denied";
    } else {
      statusElement.textContent = translate("settings.permission.denied");
      statusElement.className = "permission-status denied";
    }
    micButton?.classList.toggle("hidden", ok);
    permissionState.microphone = ok;
    renderPermissionSummary();
    return ok;
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
    micButton?.classList.remove("hidden");
    permissionState.microphone = false;
    renderPermissionSummary();
    return null;
  }
}

async function requestMicrophonePermission() {
  try {
    const current = await ipc.invoke("check-microphone-permission");
    if (current?.status === "denied" || current?.status === "restricted") {
      await ipc.invoke("open-microphone-settings");
    } else if (
      current?.status !== "granted" &&
      navigator.mediaDevices?.getUserMedia
    ) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
  } catch (error) {
    console.warn("Microphone permission action failed:", error);
  }
  await checkMicrophonePermissionStatus();
}

async function checkAccessibilityStatus() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

// Same full recheck (backend state sync + hotkey restart on grant), but
// without the "rechecking…" placeholder write — safe to run on every focus /
// broadcast without making the status line flicker. Errors keep whatever is
// currently shown rather than degrading it to the error state.
async function refreshAccessibilityQuietly() {
  if (!ipc) {
    return;
  }
  try {
    renderAccessibilityStatus(await ipc.invoke("recheck-accessibility-permission"));
  } catch (error) {
    console.error("Failed to refresh accessibility permission:", error);
  }
}

async function recheckAccessibilityPermission() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("recheck-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to recheck accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

// The About row mirrors the sidebar's build string; dev builds carry the
// counter and provenance, official builds are a bare version.
async function renderBuildLine() {
  const element = document.getElementById("settingsBuildLine");
  if (!element) {
    return;
  }
  try {
    const info = await ipc.invoke("get-build-info");
    if (!info) {
      return;
    }
    const parts = [`SayType ${info.version}`];
    if (info.channel !== "official") {
      parts.push(`dev.${info.buildNumber}`);
      parts.push(`${info.gitHash}${info.gitDirty ? " (dirty)" : ""}`);
    }
    element.textContent = parts.join(" · ");
  } catch (error) {
    console.error("Failed to read build info:", error);
  }
}

async function loadSettings() {
  await initializeDependencies();

  try {
    inspectedLocalModel = null;
    currentSettings = await ipc.invoke("get-settings");
    // Raw API keys come from a dedicated command — get_settings never ships
    // them to general readers. The main window fetches them only because it now
    // owns the Settings editor; input-prompt and other windows stay blocked.
    // Shares fate with the get-settings call above: if the config is readable
    // for one it is for the other, so this won't leave the key fields blank
    // (which a subsequent Save would persist as cleared keys).
    const apiKeys = await ipc.invoke("get-api-keys");
    initI18n(currentSettings.uiLanguage);
    applyTheme(currentSettings.uiTheme);

    const provider = currentSettings.provider || "groq";
    const providerChoice = providerForSettings(currentSettings);
    const providerSelect = document.getElementById("providerSelect");
    const shortcutSelect = document.getElementById("shortcutSelect");
    const uiLanguageSelect = document.getElementById("uiLanguageSelect");
    const themeSelect = document.getElementById("themeSelect");
    const languageSelect = document.getElementById("languageSelect");
    const modelSelect = document.getElementById("modelSelect");
    const nemotronLatencySelect = document.getElementById("nemotronLatencySelect");
    const autoLaunchCheck = document.getElementById("autoLaunchCheck");
    const startMinimizedCheck = document.getElementById("startMinimizedCheck");
    const apiKeyGroq = document.getElementById("apiKeyGroq");
    const apiKeyOpenAI = document.getElementById("apiKeyOpenAI");

    // Captured out of the payload: saveSettings replaces currentSettings with
    // the form values, which carry no backend-reported capability flags.
    gpuRuntimeSupported = !!currentSettings.gpuRuntimeSupported;
    setSelectValue(
      document.getElementById("localComputeSelect"),
      currentSettings.localCompute || "auto",
      "auto"
    );
    applyNemotronAvailability();
    // Seed before toggleProviderFields: on a local engine it decides which key
    // field is on screen.
    setSelectValue(
      document.getElementById("translateProviderSelect"),
      currentSettings.translateProvider || "groq",
      "groq"
    );
    setSelectValue(providerSelect, providerChoice, "groq");
    if (provider !== "local") {
      updateModelOptions(provider);
    }
    // Read back from the select: a stored choice this build can't offer (e.g. a
    // Nemotron config carried to an unsupported build) landed on the
    // fallback, and the dependent fields must follow what is on screen.
    toggleProviderFields(providerSelect?.value || providerChoice);

    if (apiKeyGroq) {
      apiKeyGroq.value = apiKeys.apiKeyGroq || apiKeys.apiKey || "";
    }
    if (apiKeyOpenAI) {
      apiKeyOpenAI.value = apiKeys.apiKeyOpenAI || "";
    }

    setSelectValue(shortcutSelect, currentSettings.shortcut || "Ctrl+Shift", "Ctrl+Shift");
    setSelectValue(uiLanguageSelect, currentSettings.uiLanguage || "auto", "auto");
    setSelectValue(themeSelect, normalizeThemePref(currentSettings.uiTheme), "elegant");
    setSelectValue(languageSelect, currentSettings.language || "auto", "auto");
    setSelectValue(
      nemotronLatencySelect,
      String(currentSettings.nemotronLatencyMs || 560),
      "560"
    );
    if (provider !== "local") {
      setSelectValue(modelSelect, currentSettings.model, modelSelect?.options[0]?.value || "");
    }

    if (autoLaunchCheck) {
      autoLaunchCheck.checked = !!currentSettings.autoLaunch;
    }
    if (startMinimizedCheck) {
      startMinimizedCheck.checked = !!currentSettings.startMinimized;
    }

    await refreshLocalModelStatus();
    await refreshGpuRuntimeStatus();
    await Promise.all([
      checkMicrophonePermissionStatus(),
      checkAccessibilityStatus(),
    ]);

  } catch (error) {
    console.error("Failed to load settings:", error);
    initI18n("auto");
    applyTheme("elegant");
  }
}

async function saveSettings() {
  // Keep whole-form writes ordered while model readiness IPC is in flight.
  saveSettings.pending = (saveSettings.pending || Promise.resolve()).then(persistSettings);
  return saveSettings.pending;
}

async function persistSettings() {
  try {
    await initializeDependencies();

    const providerSelect = document.getElementById("providerSelect");
    const providerChoice = providerSelect?.value || "groq";
    let localModel = localModelForProvider(providerChoice);
    let provider = localModel ? "local" : providerChoice;
    let rejectedEngine = false;
    let cloudModel = document.getElementById("modelSelect")?.value || "";
    if (localModel && (currentSettings.provider !== "local" || currentSettings.model !== localModel)) {
      // Query the requested model, not the last panel's cached status.
      const status = await ipc.invoke("get-local-model-status", localModel);
      if (status.state !== "ready") {
        inspectedLocalModel = localModel;
        rejectedEngine = true;
        provider = currentSettings.provider;
        localModel = provider === "local" ? currentSettings.model : null;
        cloudModel = currentSettings.model;
        // A later edit may already be queued; do not repaint over it.
        if (providerSelect.value === providerChoice) {
          setSelectValue(providerSelect, providerForSettings(currentSettings), "groq");
          if (!localModel) {
            updateModelOptions(provider);
            setSelectValue(document.getElementById("modelSelect"), cloudModel, cloudModel);
          }
          toggleProviderFields(providerSelect.value);
          renderLocalModelPanel(status);
          renderEngineCards();
        }
      }
    }
    const themeSelect = document.getElementById("themeSelect");
    const settings = {
      apiKeyGroq: document.getElementById("apiKeyGroq")?.value || "",
      apiKeyOpenAI: document.getElementById("apiKeyOpenAI")?.value || "",
      shortcut: document.getElementById("shortcutSelect")?.value || "Ctrl+Shift",
      language: document.getElementById("languageSelect")?.value || "auto",
      uiLanguage: document.getElementById("uiLanguageSelect")?.value || "auto",
      uiTheme: normalizeThemePref(themeSelect ? themeSelect.value : "elegant"),
      model: localModel || cloudModel,
      microphone: currentSettings.microphone,
      autoLaunch: !!document.getElementById("autoLaunchCheck")?.checked,
      startMinimized: !!document.getElementById("startMinimizedCheck")?.checked,
      provider,
      localCompute: document.getElementById("localComputeSelect")?.value || "auto",
      translateProvider: document.getElementById("translateProviderSelect")?.value || "",
      nemotronLatencyMs: Number(
        document.getElementById("nemotronLatencySelect")?.value || 560
      ),
    };

    await ipc.invoke("save-settings", settings);
    currentSettings = settings;
    showSaveStatus(rejectedEngine ? "error" : "ok", translate(
      rejectedEngine ? "settings.localModel.notReady" : "settings.saved"
    ));
  } catch (error) {
    // Never an alert: a write can fail while the user is mid-edit, and a modal
    // there would eat the next keystroke. The marker persists instead.
    console.error("Failed to save settings:", error);
    showSaveStatus("error", translate("settings.saveError"));
  }
}

async function initializeSettingsPage() {
  if (settingsInitialized) {
    return;
  }

  await initializeDependencies();
  bindEventHandlers();
  setupShortcutSync();
  setupThemeSync();
  setupLocalModelSync();
  setupGpuRuntimeSync();
  setupDiagnosticLogPanel();
  void setupUpdatesPanel();
  await loadSettings();
  activateSettingsTab(activeSettingsTab);
  settingsInitialized = true;
  document.documentElement.setAttribute("data-settings-bootstrap-complete", "1");
}

async function showSettings(target = null) {
  const wasInitialized = settingsInitialized;
  try {
    await initializeSettingsPage();
    if (wasInitialized) {
      await loadSettings();
    }

    if (typeof target === "string" && target.startsWith("local-model")) {
      activateSettingsTab("dictation");
      const model = target.split(":", 2)[1] || QWEN_LOCAL_MODEL;
      revealLocalModelPanel(model);
      return;
    }

    const resolvedTarget = target === "system" ? "app" : target === "engines" ? "dictation" : target;
    activateSettingsTab(SETTINGS_TABS.includes(resolvedTarget) ? resolvedTarget : activeSettingsTab);
  } catch (error) {
    console.error("Failed to initialize settings page:", error);
    document.documentElement.setAttribute(
      "data-settings-bootstrap-error",
      String(error?.message || error)
    );
  }
}

window.SayTypeSettings = {
  show: showSettings,
  save: saveSettings,
};

document.documentElement.setAttribute("data-settings-handlers-exposed", "1");
})();
