import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openV4TestDatabase } from "./test-fixture.mjs";

// Exercise the installed SDK and provider schema handling without a gateway or model.
const runtimeRequire = createRequire(new URL("../../../tools/openclaw-runtime/node_modules/openclaw/package.json", import.meta.url));
const { validateToolArguments } = await import(pathToFileURL(runtimeRequire.resolve("@openclaw/ai/validation")));
const { normalizeToolParameterSchema, normalizeOpenAIStrictCompatSchema } =
  await import(pathToFileURL(runtimeRequire.resolve("@openclaw/ai/internal/openai")));
const moduleUrl = new URL("./index.js?tool-parameters-sdk", import.meta.url).href;
const sdkUrl = new URL("../../../tools/openclaw-runtime/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js", import.meta.url).href;
const coreStubUrl = "data:text/javascript,export function delegateCompactionToRuntime(){throw new Error('Compaction is outside parameter tests')}";
const sdkHook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === moduleUrl && specifier === "openclaw/plugin-sdk/core") {
    return { url: coreStubUrl, shortCircuit: true };
  }
  if (context.parentURL === moduleUrl && specifier === "openclaw/plugin-sdk/tool-plugin") {
    return { url: sdkUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
let runtimeModule;
try { runtimeModule = await import(moduleUrl); }
finally { sdkHook.deregister(); }

function registeredTools(config = {}) {
  const tools = new Map();
  runtimeModule.registerShadowTools({ pluginConfig: config, registerTool: tool => tools.set(tool.name, tool) });
  return tools;
}

const tools = registeredTools();
const schemaVariants = [
  ["declared", schema => schema],
  ["openai-compatible", schema => normalizeOpenAIStrictCompatSchema(normalizeToolParameterSchema(schema, { modelProvider: "openai" }))],
];

function validate(tool, args, parameters = tool.parameters) {
  const before = structuredClone(args);
  try { return validateToolArguments({ ...tool, parameters }, { name: tool.name, arguments: args }); }
  finally { assert.deepEqual(args, before, "validation must not mutate caller arguments"); }
}

function fixture(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "shadow-tool-parameters-")));
  const config = { databasePath: path.join(root, "isolated.sqlite"), reuseConnections: false };
  const store = openV4TestDatabase(config.databasePath);
  t.after(() => {
    store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("shadow-tool-parameters-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const registered = registeredTools(config);
  return { store, call: async (name, args) => {
    const tool = registered.get(name);
    const result = await tool.execute("isolated-parameter-test", validate(tool, args));
    assert.notEqual(result.isError, true);
    return result.details;
  } };
}

test("evidence search declares bounded integers and rejects empty lookup conditions", () => {
  const tool = tools.get("shadow_evidence_search");
  for (const args of [{}, { projectKey: "fixture-project" }, { providers: ["feishu"] },
    { threadId: "fixture-thread", after: "2026-01-01T00:00:00Z" }]) {
    assert.throws(() => validate(tool, args), /Validation failed/);
  }
  for (const [variant, transform] of schemaVariants) {
    const schema = transform(tool.parameters);
    for (const args of [
      { query: "fixture" }, { query: "fixture", limit: 1, maxBytes: 4096 },
      { query: "fixture", limit: 20, maxBytes: 32768 },
      { evidenceIds: ["a".repeat(32)] }, { externalId: "fixture-message" },
    ]) assert.deepEqual(validate(tool, args, schema), args, variant);
    for (const args of [
      { query: "" }, { query: " \t\n" }, { externalId: "" }, { externalId: " \t" },
      { evidenceIds: [] }, { query: "", evidenceIds: ["a".repeat(32)] },
      { query: "fixture", evidenceIds: [] }, { query: "fixture", externalId: "" },
      ...[0, 21, 100, 1.5].map(limit => ({ query: "fixture", limit })),
      ...[4095, 32769, 65536, 4096.5].map(maxBytes => ({ query: "fixture", maxBytes })),
    ]) assert.throws(() => validate(tool, args, schema), /Validation failed/, `${variant}: ${JSON.stringify(args)}`);
  }
  assert.equal(tool.parameters.properties.limit.default, 8);
  assert.equal(tool.parameters.properties.maxBytes.default, 16384);
  assert.match(tool.description, /cannot search alone/);
  assert.match(tool.description, /1-20.*4096-32768/);
});

test("entity context keeps its distinct 8192-byte minimum and configured default", () => {
  const tool = tools.get("shadow_context_entity");
  assert.throws(() => validate(tool, { maxBytes: 8192 }), /Validation failed/);
  for (const [variant, transform] of schemaVariants) {
    const schema = transform(tool.parameters);
    for (const maxBytes of [undefined, 8192, 131072]) {
      const args = { canonicalKey: "fixture:entity", ...(maxBytes === undefined ? {} : { maxBytes }) };
      assert.deepEqual(validate(tool, args, schema), args, variant);
    }
    for (const maxBytes of [4096, 8191, 131073, 8192.5]) {
      assert.throws(() => validate(tool, { canonicalKey: "fixture:entity", maxBytes }, schema), /Validation failed/, variant);
    }
  }
  assert.equal(Object.hasOwn(tool.parameters.properties.maxBytes, "default"), false);
  assert.match(tool.description, /8192-131072/);
  assert.match(tool.parameters.properties.maxBytes.description, /config.maxContextBytes/);
});

test("evidence tool describes normalized scope and explicit operational log lookup", () => {
  const tool = tools.get("shadow_evidence_search");
  assert.match(tool.description, /empty scoped result is not proof of absence/);
  assert.doesNotMatch(tool.description, /Prefer Collaboration/);
  for (const [, transform] of schemaVariants) {
    const properties = transform(tool.parameters).properties;
    assert.match(properties.sourceKinds.description, /Text discovery defaults exclude tool logs/);
    assert.match(properties.sourceKinds.description, /Exact identity reads.*all stored kinds/);
    assert.match(properties.sourceKinds.description, /filters.sourceKinds=null/);
    assert.match(properties.sourceKinds.description, /retaining relevant project\/time constraints/);
    assert.match(properties.sourceFamilies.description, /not directly collected Git commits/);
    assert.match(properties.providers.description, /not the software discussed/);
    assert.match(properties.eventKinds.description, /excludes records without a canonical source record/);
    assert.match(properties.externalId.description, /scope filters still apply/);
  }
});

test("primary exact identity rejects empty or malformed arrays instead of widening lookup", () => {
  const tool = tools.get("shadow_evidence_search");
  for (const lookup of [{ query: "fixture" }, { evidenceIds: ["a".repeat(32)] }, { externalId: "fixture-record" }]) {
    for (const field of ["sourceKinds", "sourceFamilies", "providers", "eventKinds", "evidenceIds"]) {
      for (const value of [[], null, "codex_tool_output", [""]]) {
        const args = { ...lookup, [field]: value };
        for (const [variant, transform] of schemaVariants) {
          assert.throws(() => validate(tool, args, transform(tool.parameters)), /Validation failed/,
            `${variant}: ${JSON.stringify(args)}`);
        }
        assert.throws(() => runtimeModule.primaryEvidenceSearch(null, args), /non-empty array/,
          `execution: ${JSON.stringify(args)}`);
      }
    }
  }
});

test("provider normalization retains scalar bounds; empty search is also guarded at execution", () => {
  const search = tools.get("shadow_evidence_search");
  const schema = normalizeToolParameterSchema(normalizeOpenAIStrictCompatSchema(search.parameters), { modelProvider: "openai" });
  for (const args of [{ query: "fixture", limit: 21 }, { query: "fixture", maxBytes: 65536 }, { query: " \t" }]) {
    assert.throws(() => validate(search, args, schema), /Validation failed/);
  }
  // The installed SDK flattens top-level anyOf. Do not mistake it for a runtime guard.
  assert.deepEqual(validate(search, {}, schema), {});
  assert.throws(() => runtimeModule.primaryEvidenceSearch(null, {}), /query, evidenceIds, or externalId is required/);
  const entity = tools.get("shadow_context_entity");
  const entitySchema = normalizeToolParameterSchema(entity.parameters, { modelProvider: "openai" });
  assert.throws(() => validate(entity, { canonicalKey: "fixture:entity", maxBytes: 4096 }, entitySchema), /Validation failed/);
});

function proposal(metadata = {}) {
  return {
    rationale: "Isolated deterministic parameter fixture.",
    entities: [{ canonicalKey: "fixture:entity", type: "Component", name: "Fixture entity", metadata }],
    facts: [{ subjectCanonicalKey: "fixture:entity", predicate: "fixture_state", objectValue: "observed",
      sourceEvidenceIds: ["a".repeat(32)] }],
  };
}

test("proposal metadata stays open through OpenAI compatibility while surrounding objects stay strict", () => {
  const tool = tools.get("shadow_context_propose");
  const args = proposal({ source: "test://fixture", path: "fixture/readme", custom: { labels: ["isolated"], reviewed: false } });
  for (const [variant, transform] of schemaVariants) {
    assert.deepEqual(validate(tool, args, transform(tool.parameters)), args, variant);
    for (const location of ["request", "entity", "fact"]) {
      for (const field of ["source", "evidenceIds"]) {
        const invalid = structuredClone(args);
        const target = location === "request" ? invalid : location === "entity" ? invalid.entities[0] : invalid.facts[0];
        target[field] = field === "source" ? "test://fixture" : ["a".repeat(32)];
        assert.throws(() => validate(tool, invalid, transform(tool.parameters)), /additional properties/i, `${variant}: ${location}.${field}`);
      }
    }
    for (const metadata of [null, [], "source"]) {
      assert.throws(() => validate(tool, proposal(metadata), transform(tool.parameters)), /Validation failed/);
    }
  }
  assert.deepEqual(validate(tool, args, normalizeToolParameterSchema(normalizeOpenAIStrictCompatSchema(tool.parameters),
    { modelProvider: "openai" })), args);
  // Reproduce the old declaration's mismatch using the installed compatibility pass.
  const legacy = structuredClone(tool.parameters);
  legacy.properties.entities.items.properties.metadata = { type: "object" };
  assert.deepEqual(validate(tool, args, legacy), args);
  assert.throws(() => validate(tool, args, normalizeOpenAIStrictCompatSchema(legacy)), /additional properties/i);
  assert.match(tool.parameters.properties.entities.items.properties.metadata.description, /not metadata.source/);
});

test("registered evidence search honors valid limits, budgets and identities in an isolated store", async (t) => {
  const { store, call } = fixture(t);
  const source = store.upsertSource({ sourceKey: "parameter-fixture", kind: "test", uri: "test://parameters" });
  const evidence = [];
  for (let i = 0; i < 24; i += 1) evidence.push(store.addEvidence({
    sourceId: source.id, kind: "project_document", title: `Fixture ${i}`, content: "parameterneedle",
    externalId: `fixture-${i}`, sourceLocator: `test://parameters/${i}`, occurredAt: "2026-01-01T00:00:00.000Z",
  }));
  const before = store.db.prepare("SELECT total_changes() AS n").get().n;
  const defaults = await call("shadow_evidence_search", { query: "parameterneedle" });
  assert.equal(defaults.matches.length, 8);
  assert.equal(defaults.maxBytes, 16384);
  for (const [limit, maxBytes] of [[1, 4096], [20, 32768]]) {
    const result = await call("shadow_evidence_search", { query: "parameterneedle", limit, maxBytes });
    assert.equal(result.matches.length, limit);
    assert.equal(result.maxBytes, maxBytes);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= maxBytes);
  }
  for (const args of [{ evidenceIds: [evidence[0].id] }, { externalId: "fixture-0" }]) {
    const result = await call("shadow_evidence_search", args);
    assert.deepEqual(result.matches.map(item => item.evidenceId), [evidence[0].id]);
  }
  for (const args of [{}, { projectKey: "fixture-project" }, { query: " \t" }, { externalId: " " }]) {
    assert.throws(() => runtimeModule.primaryEvidenceSearch(store.db, args), /query, evidenceIds, or externalId is required/);
  }
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("registered primary exact identity reads logs and unknown kinds without changing discovery", async (t) => {
  const { store, call } = fixture(t);
  const source = store.upsertSource({ sourceKey: "registered-identity", kind: "test", uri: "test://registered-identity" });
  const rows = ["codex_tool_output", "codex_thread_digest", "codex_memory_document", "future_custom_kind", "codex_user_message"]
    .map((kind, i) => store.addEvidence({ sourceId: source.id, kind, title: "registeredidentity", content: "registeredidentity",
      externalId: `registered-${i}`, sourceLocator: `test://registered-identity/${i}` }));
  const before = store.db.prepare("SELECT total_changes() AS n").get().n;
  for (const [i, row] of rows.entries()) {
    for (const args of [{ evidenceIds: [row.id] }, { externalId: `registered-${i}` }]) {
      const result = await call("shadow_evidence_search", args);
      assert.deepEqual(result.matches.map(item => item.evidenceId), [row.id]);
      assert.equal(result.filters.sourceKinds, null);
    }
  }
  const discovered = await call("shadow_evidence_search", { query: "registeredidentity" });
  assert.deepEqual(discovered.matches.map(item => item.evidenceId), [rows.at(-1).id]);
  assert.ok(Array.isArray(discovered.filters.sourceKinds));
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("registered proposal preserves metadata but still requires real evidence, then entity reads at minimum budget", async (t) => {
  const { store, call } = fixture(t);
  const source = store.upsertSource({ sourceKey: "proposal-fixture", kind: "test", uri: "test://proposal" });
  const evidence = store.addEvidence({ sourceId: source.id, kind: "project_document", title: "Fixture proof",
    content: "The isolated fixture was observed.", sourceLocator: "test://proposal/proof" });
  const metadata = { source: "test://proposal/proof", custom: { evidenceId: evidence.id, labels: ["fixture"] } };
  const args = proposal(metadata);
  const missingProof = structuredClone(args);
  delete missingProof.facts[0].sourceEvidenceIds;
  await assert.rejects(call("shadow_context_propose", missingProof), /no source evidence or derivation inputs/);
  await assert.rejects(call("shadow_context_propose", args), /Unknown evidence/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM graph_entities WHERE canonical_key='fixture:entity'").get().n, 0);

  args.facts[0].sourceEvidenceIds = [evidence.id];
  const result = await call("shadow_context_propose", args);
  assert.equal(result.facts.length, 1);
  const entity = store.db.prepare("SELECT * FROM graph_entities WHERE canonical_key='fixture:entity'").get();
  const storedMetadata = JSON.parse(entity.metadata_json);
  assert.equal(storedMetadata.source, metadata.source);
  assert.deepEqual(storedMetadata.custom, metadata.custom);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM graph_evidence_assessments WHERE fact_id=? AND evidence_id=?")
    .get(result.facts[0].id, evidence.id).n, 1);
  for (const args of [{ canonicalKey: "fixture:entity", maxBytes: 8192 }, { entityId: entity.id }]) {
    const context = await call("shadow_context_entity", args);
    assert.equal(context.seedEntityId, entity.id);
    assert.ok(context.items.some(item => item.type === "entity" && item.value.id === entity.id));
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= (args.maxBytes ?? 65536));
  }
});
