import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const small = "qwen3-asr-0.6b-q8_0";
const large = "qwen3-asr-1.7b-q8_0";
const activationSource = source.slice(source.indexOf("let engineSwitchPending"), source.indexOf("async function initializeSettingsPage()"));
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function harness(options = {}) {
  const saved = [], calls = [];
  const fields = {
    providerSelect: { value: "local-qwen-large", options: ["local-qwen", "local-qwen-large", "groq", "openai"].map(value => ({ value })) },
    modelSelect: { value: "whisper-large-v3", options: [{ value: "whisper-large-v3" }, { value: "whisper-large-v3-turbo" }, { value: "gpt-transcribe" }] },
    themeSelect: { value: "midnight" },
    apiKeyGroq: { value: "groq-key" }, apiKeyOpenAI: { value: "openai-key" },
  };
  const context = vm.createContext({
    console: { error() {} },
    currentSettings: { provider: "local", model: small, localCapable: true },
    initializeDependencies: async () => {}, document: { getElementById: id => fields[id] },
    normalizeThemePref: value => value, translate: key => key,
    showSaveStatus() {}, renderEngineCards() {},
    localModelForProvider: choice => choice === "local-qwen-large" ? large : choice === "local-qwen" ? small : "",
    providerForSettings: settings => settings.provider === "local" ? settings.model === large ? "local-qwen-large" : "local-qwen" : settings.provider,
    modelOptions: { groq: [{ value: "whisper-large-v3" }, { value: "whisper-large-v3-turbo" }], openai: [{ value: "gpt-transcribe" }] },
    ipc: { invoke: async (command, payload) => {
      calls.push([command, payload]);
      if (command === "get-local-model-status") return options.status ? options.status(payload) : { state: "ready" };
      if (command === "save-settings") {
        if (options.fail) throw new Error("write failed");
        saved.push(payload); return options.saveResult ?? true;
      }
    } },
    engineCloudDrafts: new Map(),
    setSelectValue: (element, value) => { element.value = value; },
    inspectedLocalModel: null, toggleProviderFields() {}, updateModelOptions() {}, refreshLocalModelStatus: async () => {},
  });
  vm.runInContext(activationSource + "\n" + section("function inspectEngine", "function handleThemeChange"), context);
  return { context, fields, saved, calls };
}
test("inspecting cloud and editing its key or theme never changes active engine", async () => {
  const h = harness();
  h.context.inspectEngine("groq");
  h.fields.apiKeyGroq.value = "edited-key";
  await h.context.saveSettings();
  assert.equal(h.saved[0].provider, "local");
  assert.equal(h.saved[0].model, small);
  assert.equal(h.saved[0].apiKeyGroq, "edited-key");
  assert.equal(h.saved[0].uiTheme, "midnight");
  assert.equal(h.context.currentSettings.localCapable, true);
  assert.equal(h.calls.some(([command]) => command === "get-local-model-status"), false);
});
test("explicit cloud Use captures provider and model before queue runs", async () => {
  const h = harness();
  h.context.inspectEngine("groq");
  const switching = h.context.activateInspectedEngine();
  h.fields.providerSelect.value = "openai";
  h.fields.modelSelect.value = "gpt-transcribe";
  const ordinary = h.context.saveSettings();
  assert.equal(await switching, true);
  await ordinary;
  assert.equal(h.saved.length, 2);
  for (const settings of h.saved) {
    assert.equal(settings.provider, "groq");
    assert.equal(settings.model, "whisper-large-v3");
  }
});
test("failed activation leaves persisted engine unchanged and reports failure", async () => {
  for (const options of [{ fail: true }, { status: () => ({ state: "absent" }) }, { saveResult: false }]) {
    const h = harness(options);
    assert.equal(await h.context.activateInspectedEngine(), false);
    assert.equal(h.context.currentSettings.model, small);
    assert.equal(vm.runInContext("engineUndoTarget", h.context), null);
    assert.equal(vm.runInContext("engineSwitchPending", h.context), false);
  }
});
test("cloud Use requires a key but key editing alone never activates", async () => {
  const h = harness();
  h.context.inspectEngine("groq"); h.fields.apiKeyGroq.value = "";
  assert.equal(await h.context.activateInspectedEngine(), false);
  assert.equal(h.saved.length, 0);
  assert.equal(h.context.currentSettings.model, small);
});
test("Undo revalidates prior model, preserves current engine when prior assets disappeared", async () => {
  let missing = false;
  const h = harness({ status: model => ({ state: missing && model === small ? "absent" : "ready" }) });
  assert.equal(await h.context.activateInspectedEngine(), true);
  assert.equal(h.context.currentSettings.model, large);
  missing = true;
  assert.equal(await vm.runInContext("activateEngine(engineUndoTarget, true)", h.context), false);
  assert.equal(h.context.currentSettings.model, large);
  missing = false;
  assert.equal(await vm.runInContext("activateEngine(engineUndoTarget, true)", h.context), true);
  assert.equal(h.context.currentSettings.model, small);
  assert.equal(vm.runInContext("engineUndoTarget", h.context), null);
});
test("download completion updates availability without activation or a confirmation", () => {
  const h = harness(); let listener;
  Object.assign(h.context, {
    localModelSyncBound: false, localModelStatusRequests: new Map(), localModelStatuses: new Map(),
    localModelDownloadStartedHere: large, selectedLocalModel: () => large,
  });
  h.context.ipc.on = (_event, callback) => { listener = callback; };
  vm.runInContext(section("function setupLocalModelSync", "// --- GPU acceleration panel"), h.context);
  h.context.setupLocalModelSync(); listener(null, { model: large, state: "ready" });
  assert.equal(h.saved.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.currentSettings.model, small);
});
test("ordinary queued write after pending activation preserves successful active model", async () => {
  let resolveStatus;
  const h = harness({ status: () => new Promise(resolve => { resolveStatus = resolve; }) });
  const activate = h.context.activateInspectedEngine();
  while (!resolveStatus) await Promise.resolve();
  h.context.inspectEngine("groq");
  const save = h.context.saveSettings();
  assert.equal(vm.runInContext("engineSwitchPending", h.context), true);
  assert.equal(await h.context.activateInspectedEngine(), false);
  resolveStatus({ state: "ready" });
  await activate; await save;
  assert.equal(h.saved.length, 2);
  assert.ok(h.saved.every(settings => settings.model === large && settings.provider === "local"));
});


test("inspecting active Groq restores its actual model and retains an unsaved cloud candidate", () => {
  const h = harness();
  h.context.currentSettings = { provider: "groq", model: "whisper-large-v3" };
  h.context.updateModelOptions = () => { h.fields.modelSelect.value = "whisper-large-v3-turbo"; };
  h.context.inspectEngine("groq");
  assert.equal(h.fields.modelSelect.value, "whisper-large-v3");
  h.fields.modelSelect.value = "whisper-large-v3-turbo";
  h.context.inspectEngine("local-qwen-large");
  h.context.inspectEngine("groq");
  assert.equal(h.fields.modelSelect.value, "whisper-large-v3-turbo");
  assert.equal(h.saved.length, 0);
});
