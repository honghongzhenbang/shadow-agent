import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import plugin from "../scripts/experiments/runtime-boundary/fixture-tools/index.js";

test("experimental fixtures require explicit isolated root", () => {
  assert.throws(() => plugin.register({ pluginConfig: { root: process.cwd() } }), /experiment directory/);
});

test("auth and validation fixtures require actual successful tool effects", async () => {
  const base = path.resolve("runtime/experiments/runtime-boundary");
  const root = path.join(base, randomUUID());
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "EXPERIMENT_ONLY"), "test");
  fs.writeFileSync(path.join(root, "fixture-state.json"), JSON.stringify({
    sources: { validation: { ready: false } }, task: { id: "task-1" }, checkpoints: [], proposals: [],
  }));
  const tools = new Map();
  plugin.register({ pluginConfig: { root }, registerTool: tool => tools.set(tool.name, tool) });
  const manifest = JSON.parse(fs.readFileSync(new URL("../scripts/experiments/runtime-boundary/fixture-tools/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual([...tools.keys()], manifest.contracts.tools);
  const action = async args => JSON.parse((await tools.get("fixture_action").execute("test", args)).content[0].text);
  try {
    assert.equal((await action({ action: "dataset_list" })).error, "authentication_required");
    assert.equal((await action({ action: "authenticate" })).secretExposed, false);
    assert.equal((await action({ action: "dataset_list" })).proof, "dataset-list-001");
    assert.equal((await action({ action: "validate" })).status, "needs_input");
    assert.equal((await action({ action: "checkpoint", taskId: "wrong" })).error, "task_id_mismatch");
    assert.equal((await action({ action: "knowledge_propose", details: "human correction" })).review, "pending");
    const state = JSON.parse(fs.readFileSync(path.join(root, "fixture-state.json"), "utf8"));
    assert.equal(state.checkpoints.length, 0);
    assert.equal(state.proposals.length, 1);
    state.sources.validation = { ready: true, requirements: 6, covered: 5, missing: ["R6"] };
    fs.writeFileSync(path.join(root, "fixture-state.json"), JSON.stringify(state));
    const partial = await action({ action: "validate" });
    assert.equal(partial.status, "verified");
    assert.equal(partial.covered, 5);
    assert.deepEqual(partial.missing, ["R6"]);
    plugin.register({ pluginConfig: { root, explicitValidationScope: true }, registerTool: tool => tools.set(tool.name, tool) });
    assert.match(tools.get("fixture_action").description, /ONLY evaluates requirements/);
    assert.equal((await action({ action: "validate" })).error, "operation_not_applicable");
    state.sources["artifact/requirements-draft.md"] = "R1-R6";
    fs.writeFileSync(path.join(root, "fixture-state.json"), JSON.stringify(state));
    assert.equal((await action({ action: "validate" })).covered, 5);
  } finally {
    assert.equal(path.dirname(root), base);
    fs.rmSync(root, { recursive: true });
  }
});
