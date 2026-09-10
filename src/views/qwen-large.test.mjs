import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const large = "qwen3-asr-1.7b-q8_0";
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}
test("large Qwen settings mapping round-trips independently of default Qwen", () => {
  const source = read("settings.js");
  const constants = source.match(/^const (?:QWEN\w*|NEMOTRON\w*|LOCAL_\w*) = .*;$/gm).join("\n");
  const context = vm.createContext({});
  vm.runInContext(constants + "\n" + functionSource(source, "localModelForProvider") + "\n" + functionSource(source, "providerForSettings"), context);
  assert.equal(context.localModelForProvider("local-qwen-large"), large);
  assert.equal(context.providerForSettings({ provider: "local", model: large }), "local-qwen-large");
  assert.equal(context.localModelForProvider("local-qwen"), "qwen3-asr-0.6b-q8_0");
});
test("main selection preserves large Qwen rather than normalizing to default", () => {
  const source = read("main.js");
  const constants = source.match(/^const (?:QWEN\w*|NEMOTRON\w*) = .*;$/gm).join("\n");
  const context = vm.createContext({ cachedSettings: { provider: "local", model: large } });
  vm.runInContext(constants + "\n" + functionSource(source, "normalizeLocalModel") + "\n" + functionSource(source, "selectedEngineValue"), context);
  assert.equal(context.normalizeLocalModel(large), large);
  assert.equal(context.selectedEngineValue(), "local-qwen-large");
});
test("large Qwen is opt-in and labeled experimental", () => {
  assert.match(read("main.html"), /value="local-qwen-large"/);
  assert.match(read("settings.js"), /value: LOCAL_QWEN_LARGE_PROVIDER, local: true, icon: "memory", experimental: true/);
  assert.match(read("input-prompt.js"), /\[QWEN_LARGE_LOCAL_MODEL_ID\]: "Qwen3 1.7B · Local"/);
});


test("large Qwen download requests status and assets for the inspected model", async () => {
  const source = read("settings.js");
  const calls = [];
  const context = vm.createContext({
    localModelState: "absent", localModelDownloadStartedHere: "",
    inspectedLocalModel: large,
    document: { getElementById: () => ({ value: "openai", options: [] }) },
    localModelForProvider: () => "",
    localModelStatuses: new Map(), localModelStatusRequests: new Map(),
    ipc: { invoke: async (command, model) => { calls.push([command, model]); return { state: "absent" }; } },
    renderLocalModelPanel() {}, renderEngineCards() {}, console,
  });
  const selected = functionSource(source, "selectedLocalModel");
  const refresh = "async " + functionSource(source, "refreshLocalModelStatus");
  const action = "async " + functionSource(source, "handleLocalModelAction");
  await vm.runInContext(selected + "\n" + refresh + "\n" + action + "\nhandleLocalModelAction()", context);
  assert.ok(calls.some(([command, model]) => command === "get-local-model-status" && model === large));
  assert.ok(calls.some(([command, model]) => command === "download-local-model" && model === large));
});
