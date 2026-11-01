import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { openV4TestDatabase } from "../openclaw/shadow-work/src/test-fixture.mjs";
import { assessFactEvidence, assertGraphFact, upsertGraphEntity } from "../src/graph-model.mjs";
import { captureKnowledge } from "../openclaw/shadow-work/src/epistemic.js";
import { resolveCognitiveRoute } from "../openclaw/shadow-work/src/routing.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "openclaw/plugin-sdk/tool-plugin") return {
      url: "data:text/javascript,export function defineToolPlugin(value){return Object.assign(value,{register(){}})}", shortCircuit: true,
    };
    if (specifier === "openclaw/plugin-sdk/core") return {
      url: "data:text/javascript,export function delegateCompactionToRuntime(){throw new Error('Runtime calls forbidden in routing tests')}", shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { default: plugin, queryContext } = await import("../openclaw/shadow-work/src/index.js");

const NOW = "2026-10-22T00:00:00.000Z";
const HANDOVER = "2026-11-01T00:00:00.000Z";

function fixture(t) {
  const store = openV4TestDatabase(":memory:");
  t.after(() => store.close());
  const source = store.upsertSource({ sourceKey: "routing-focused", kind: "test", uri: "test://routing-focused" });
  let serial = 0;
  const entity = (canonicalKey, type = "KnowledgeTopic", name = "TemporalSample", extra = {}) =>
    upsertGraphEntity(store.db, { canonicalKey, type, name, ...extra });
  const topic = entity("topic:temporal-sample");
  const evidence = () => store.addEvidence({
    sourceId: source.id, kind: "project_document", title: "Isolated routing evidence",
    content: `Isolated routing observation ${++serial}`, sourceLocator: `test://routing-focused/${serial}`,
    occurredAt: "2026-10-21T00:00:00.000Z",
  });
  const assess = (factId, extra = {}) => {
    const record = evidence();
    return assessFactEvidence(store.db, {
      factId, evidenceId: record.id, stance: "supports", method: "document_record", environment: "local",
      assessedAt: "2026-10-21T00:00:00.000Z", ...extra,
    });
  };
  const fact = (value, extra = {}) => {
    const row = assertGraphFact(store.db, {
      subject: topic.id, predicate: "HAS_VALUE", objectValue: value,
      validFrom: "2020-01-01T00:00:00.000Z", ...extra,
    });
    assess(row.id);
    return row;
  };
  const route = (extra = {}) => resolveCognitiveRoute(store.db, { query: "TemporalSample", asOf: NOW, ...extra });
  const query = (extra = {}) => queryContext(store.db, {
    entityId: topic.id, depth: 1, maxBytes: 65_536, asOf: NOW, ...extra,
  });
  return { store, entity, topic, evidence, assess, fact, route, query };
}

test("routing fixes one asOf and applies inclusive start and exclusive end across timezone formats", (t) => {
  const f = fixture(t);
  const current = f.fact("current", { validFrom: "2026-10-22T08:00:00+08:00", validTo: HANDOVER });
  const ended = f.fact("ended", { validTo: "2026-10-22T00:00:00Z" });
  const future = f.fact("future", { validFrom: HANDOVER });
  const result = f.route();
  assert.deepEqual(result.verifiedFacts.map((row) => row.id), [current.id]);
  assert.equal(result.asOf, NOW);
  assert.equal(result.temporalSemantics, "valid_time_with_available_evidence_not_knowledge_time_replay");
  assert.ok(!JSON.stringify(result).includes(ended.id));
  assert.ok(!JSON.stringify(result).includes(future.id));
  assert.deepEqual(f.route({ asOf: HANDOVER }).verifiedFacts.map((row) => row.id), [future.id]);
  assert.throws(() => f.route({ asOf: "not-a-time" }), /asOf/i);
});

test("routing preserves unbounded legacy intervals and excludes malformed intervals", (t) => {
  const f = fixture(t);
  const unbounded = f.fact("unbounded");
  const invalid = f.fact("invalid");
  f.store.db.prepare("UPDATE graph_facts SET valid_from=NULL WHERE id=?").run(unbounded.id);
  f.store.db.prepare("UPDATE graph_facts SET valid_from='invalid-date' WHERE id=?").run(invalid.id);
  assert.deepEqual(f.route().verifiedFacts.map((row) => row.id), [unbounded.id]);
});

test("future supersession retains today's predecessor and historical valid intervals", (t) => {
  const f = fixture(t);
  const old = f.fact("previous");
  const next = f.fact("next", {
    validFrom: HANDOVER, supersedesFactId: old.id, supersessionReason: "Scheduled handover",
    sourceEvidenceIds: [f.evidence().id],
  });
  assert.equal(f.store.db.prepare("SELECT status FROM graph_facts WHERE id=?").get(old.id).status, "superseded");
  for (const asOf of ["2024-01-01T00:00:00Z", NOW]) {
    assert.deepEqual(f.route({ asOf }).verifiedFacts.map((row) => row.id), [old.id]);
  }
  assert.deepEqual(f.route({ asOf: HANDOVER }).verifiedFacts.map((row) => row.id), [next.id]);
});

test("routing returns separate scopes and allows explicit scope selection", (t) => {
  const f = fixture(t);
  const one = f.fact("one", { scopeKey: "version:one" });
  const two = f.fact("two", { scopeKey: "version:two" });
  const result = f.route();
  assert.deepEqual(new Set(result.verifiedFacts.map((row) => row.scopeKey)), new Set(["version:one", "version:two"]));
  assert.deepEqual(new Set(result.verifiedFacts.map((row) => row.id)), new Set([one.id, two.id]));
  assert.ok(result.verifiedFacts.every((row) => row.validFrom && row.observedAt && row.source.evidenceId));
  assert.deepEqual(f.route({ scopeKey: "version:two" }).verifiedFacts.map((row) => row.id), [two.id]);
  assert.deepEqual(f.route({ scopeKey: "version:unknown" }).verifiedFacts, []);
});

test("expired strong support plus live weak support cannot reuse supported cache", (t) => {
  const f = fixture(t);
  const row = f.fact("expiry-sensitive");
  const weak = f.assess(row.id, { method: "statement" });
  f.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE fact_id=? AND id<>?")
    .run(NOW, row.id, weak.id);
  assert.equal(f.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(row.id).epistemic_status, "supported");
  const result = f.route();
  assert.equal(result.verifiedFacts.length, 0);
  const pending = result.reviewPending.find((item) => item.id === row.id);
  assert.equal(pending.epistemicStatus, "proposed");
  assert.equal(pending.evidenceLevel, 1);
  assert.equal(f.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(row.id).epistemic_status, "supported");
});

test("expired sole support remains discoverable as a candidate without mutating the database", (t) => {
  const f = fixture(t);
  const row = f.fact("expired-only");
  f.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE fact_id=?").run(NOW, row.id);
  const before = f.store.db.prepare("SELECT total_changes() AS changes").get().changes;
  const result = f.route();
  assert.equal(result.verifiedFacts.length, 0);
  assert.equal(result.reviewPending.find((item) => item.id === row.id).epistemicStatus, "proposed");
  assert.equal(f.store.db.prepare("SELECT total_changes() AS changes").get().changes, before);
});

test("expired contradictions are reclassified before filtering refuted or disputed caches", (t) => {
  const f = fixture(t);
  const disputed = f.fact("once-disputed");
  const contradiction = f.assess(disputed.id, { stance: "contradicts" });
  const refuted = assertGraphFact(f.store.db, {
    subject: f.topic.id, predicate: "HAS_VALUE", objectValue: "once-refuted", validFrom: "2020-01-01",
  });
  const onlyContradiction = f.assess(refuted.id, { stance: "contradicts" });
  assert.equal(f.store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(refuted.id).epistemic_status, "refuted");
  for (const row of [contradiction, onlyContradiction]) {
    f.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE id=?").run(NOW, row.id);
  }
  const result = f.route();
  assert.deepEqual(result.verifiedFacts.map((row) => row.id), [disputed.id]);
  assert.equal(result.reviewPending.find((row) => row.id === refuted.id).epistemicStatus, "proposed");
  assert.deepEqual(result.conflicts, []);
});

test("historical support selection shares the trust policy's evidence replacement cutoff", (t) => {
  const f = fixture(t);
  const row = f.fact("replaced-source");
  const oldEvidence = f.store.db.prepare("SELECT evidence_id FROM graph_evidence_assessments WHERE fact_id=?").get(row.id).evidence_id;
  const replacement = f.evidence();
  f.store.db.prepare("INSERT INTO evidence_links(parent_evidence_id, child_evidence_id, relation, created_at) VALUES(?, ?, 'supersedes', ?)")
    .run(replacement.id, oldEvidence, HANDOVER);
  assert.equal(f.route().verifiedFacts[0].evidence.id, oldEvidence);
  const after = f.route({ asOf: HANDOVER });
  assert.deepEqual(after.verifiedFacts, []);
  assert.equal(after.reviewPending.find((item) => item.id === row.id).epistemicStatus, "proposed");
});

test("contacts use the request asOf and scoped route metadata survives aggregation", (t) => {
  const f = fixture(t);
  const owner = f.entity("person:owner", "Person", "Owner");
  const oldChannel = f.entity("channel:old", "CommunicationChannel", "Old contact", { metadata: { locator: "open_id:old" } });
  const newChannel = f.entity("channel:new", "CommunicationChannel", "New contact", { metadata: { locator: "open_id:new" } });
  f.fact(undefined, { subject: owner.id, predicate: "RESPONSIBLE_FOR", objectEntity: f.topic.id, scopeKey: "version:one" });
  f.fact(undefined, { subject: owner.id, predicate: "RESPONSIBLE_FOR", objectEntity: f.topic.id, scopeKey: "version:two" });
  const old = f.fact(undefined, { subject: owner.id, predicate: "CONTACT_VIA", objectEntity: oldChannel.id });
  f.fact(undefined, {
    subject: owner.id, predicate: "CONTACT_VIA", objectEntity: newChannel.id, validFrom: HANDOVER,
    supersedesFactId: old.id, supersessionReason: "Scheduled contact migration", sourceEvidenceIds: [f.evidence().id],
  });
  const result = f.route();
  assert.equal(result.askablePeople[0].contact.locator, "open_id:old");
  assert.deepEqual(new Set(result.askablePeople[0].matchedRoutes.map((row) => row.scopeKey)), new Set(["version:one", "version:two"]));
  assert.equal(f.route({ asOf: HANDOVER }).askablePeople[0].contact.locator, "open_id:new");
});

test("repoPath and CodeRepository produce consistent locators with explicit version metadata", (t) => {
  const f = fixture(t);
  const metadata = { repoPath: "E:/fixture/camera", relativePath: "src/camera.cpp", commit: "a".repeat(40), ref: "release", executionHost: "windows-fixture" };
  const code = f.entity("repo:camera", "CodeRepository", "CameraRepository", { metadata });
  f.fact(undefined, { predicate: "IMPLEMENTED_IN", objectEntity: code.id, scopeKey: "version:one" });
  const item = f.route().retrievalRoutes.find((row) => row.entityId === code.id);
  assert.ok(item);
  assert.equal(item.locator, metadata.repoPath);
  for (const [key, value] of Object.entries(metadata)) assert.equal(item[key], value);
  assert.equal(item.scopeKey, "version:one");
  const direct = f.route({ query: metadata.repoPath }).retrievalRoutes.find((row) => row.entityId === code.id);
  assert.equal(direct.locator, item.locator);
  assert.equal(direct.reviewStatus, "evidence_assessed");
});

test("exact canonical identity does not merge same-name people and short aliases remain usable", (t) => {
  const f = fixture(t);
  const first = f.entity("person:stable:first", "Person", "\u5f20\u4e09", { aliases: ["\u5c0f\u5f20"] });
  const second = f.entity("person:stable:second", "Person", "\u5f20\u4e09");
  const byName = f.route({ query: "\u5f20\u4e09" });
  assert.deepEqual(new Set(byName.askablePeople.map((row) => row.entityId)), new Set([first.id, second.id]));
  assert.deepEqual(f.route({ query: "person:stable:first" }).askablePeople.map((row) => row.entityId), [first.id]);
  assert.deepEqual(f.route({ query: first.id }).askablePeople.map((row) => row.entityId), [first.id]);
  assert.deepEqual(f.route({ query: "\u5c0f\u5f20" }).askablePeople.map((row) => row.entityId), [first.id]);
  assert.equal(byName.verifiedFacts.length, 0);
});

test("exact repository paths and commits rank before loose code-location matches", (t) => {
  const f = fixture(t);
  const metadata = { repoPath: "E:/fixture/camera", commit: "b".repeat(40) };
  const expected = f.entity("repo:exact-camera", "Repository", "CameraRepository", { metadata });
  for (let i = 0; i < 30; i += 1) {
    f.entity(`code:loose:${i}`, "CodeLocation", "fixture camera", { metadata: { path: `E:/unrelated/${i}` } });
  }
  for (const query of [metadata.repoPath, metadata.commit]) {
    const result = f.route({ query });
    assert.equal(result.retrievalRoutes[0].entityId, expected.id);
    assert.equal(result.retrievalRoutes[0].locator, metadata.repoPath);
    assert.equal(result.retrievalRoutes[0].executionHost, null);
    assert.equal(result.retrievalRoutes[0].relativePath, null);
  }
});

test("short Chinese responsibility routes survive crowded exact-name history", (t) => {
  const f = fixture(t);
  const topic = f.entity("topic:short-name", "KnowledgeTopic", "\u6807\u5b9a");
  const owner = f.entity("person:calibration-owner", "Person", "CalibrationOwner");
  f.fact(undefined, { subject: owner.id, predicate: "RESPONSIBLE_FOR", objectEntity: topic.id });
  for (let i = 0; i < 160; i += 1) {
    f.entity(`session:noise:${i}`, "Session", "\u6807\u5b9a", { metadata: { presentationPriority: 1 } });
  }
  const result = f.route({ query: "\u6807\u5b9a\u8d1f\u8d23\u4eba\u662f\u8c01" });
  assert.equal(result.askablePeople[0]?.entityId, owner.id);
});

test("query and resolve share named-entity recall despite earlier noisy session matches", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 180; i += 1) {
    f.entity(`session:recall:${i}`, "Session", "Atlas developer17 platform development",
      { summary: "Atlas developer17 platform development responsibility coordination" });
  }
  const topic = f.entity("project:atlas", "Project", "Atlas");
  const owner = f.entity("person:developer17", "Person", "Developer Seventeen", { aliases: ["developer17"] });
  const ownership = f.fact(undefined, { subject: owner.id, predicate: "RESPONSIBLE_FOR", objectEntity: topic.id });
  const query = "Atlas platform development developer17 responsibility coordination";
  const routed = f.route({ query });
  const queried = queryContext(f.store.db, { query, depth: 1, maxBytes: 65_536, asOf: NOW });
  assert.ok(routed.askablePeople.some(row => row.entityId === owner.id
    && row.matchedRoutes.some(route => route.factId === ownership.id)));
  assert.ok(queried.seedEntityIds.includes(owner.id));
  assert.ok(queried.verifiedFacts.some(row => row.id === ownership.id));
});

test("Chinese knowledge candidates are not hidden by an unrelated ASCII FTS hit", (t) => {
  const f = fixture(t);
  const capture = (title) => captureKnowledge(f.store.db, {
    sourceType: "note", title, content: title, summary: title,
    keywords: [title, "source", "review"], retrievalCues: [`find ${title}`, `${title} record`],
  });
  const expected = capture("\u76f8\u673a\u6807\u5b9a\u8d1f\u8d23\u5206\u5de5");
  capture("V431 unrelated release");
  const result = f.route({ query: "V431 \u76f8\u673a\u6807\u5b9a\u627e\u8c01" });
  assert.ok(result.reviewPending.some((row) => row.evidenceId === expected.evidenceId));
  assert.equal(result.verifiedFacts.length, 0);
});

test("unknown routing and unsupported facts stay discoverable without asserting familiarity", (t) => {
  const f = fixture(t);
  const row = assertGraphFact(f.store.db, { subject: f.topic.id, predicate: "HAS_VALUE", objectValue: "unreviewed", validFrom: "2020-01-01" });
  assert.ok(f.route().reviewPending.some((item) => item.id === row.id));
  const unknown = f.route({ query: "deliberately unrelated unlisted subject" });
  assert.equal(unknown.outcome, "unresolved_with_next_step");
  assert.deepEqual(unknown.verifiedFacts, []);
  assert.equal(unknown.steps[0].action, "discover_route");
});

test("both context tools expose asOf and scopeKey without changing their query contracts", () => {
  const tools = Object.fromEntries(plugin.tools((definition) => definition).map((definition) => [definition.name, definition]));
  for (const name of ["shadow_context_resolve", "shadow_context_query"]) {
    const { properties, additionalProperties } = tools[name].parameters;
    assert.equal(properties.asOf.type, "string");
    assert.equal(properties.scopeKey.type, "string");
    assert.equal(properties.scopeKey.maxLength, 500);
    assert.equal(additionalProperties, false);
  }
});

test("queryContext and resolve agree on historical handover, interval boundaries, and scope", (t) => {
  const f = fixture(t);
  const old = f.fact("old", { scopeKey: "version:one" });
  f.fact("next", {
    scopeKey: "version:one", validFrom: HANDOVER, supersedesFactId: old.id,
    supersessionReason: "Scheduled release handover", sourceEvidenceIds: [f.evidence().id],
  });
  f.fact("other-version", { scopeKey: "version:two", validFrom: "2026-10-22T08:00:00+08:00" });
  for (const asOf of ["2024-01-01T00:00:00Z", NOW, HANDOVER]) {
    for (const scopeKey of [undefined, "version:one", "version:two", "version:unknown"]) {
      const queried = f.query({ asOf, scopeKey });
      assert.deepEqual(new Set(queried.verifiedFacts.map((row) => row.id)), new Set(f.route({ asOf, scopeKey }).verifiedFacts.map((row) => row.id)));
      assert.equal(queried.asOf, new Date(asOf).toISOString());
      assert.equal(queried.scopeKey, scopeKey ?? null);
      assert.equal(queried.temporalSemantics, "valid_time_with_available_evidence_not_knowledge_time_replay");
      assert.ok(queried.verifiedFacts.every((row) => row.scopeKey === row.scope_key && row.validFrom && row.observedAt));
    }
  }
  assert.throws(() => f.query({ asOf: "not-a-time" }), /asOf/i);
});

test("queryContext reclassifies expired supporting and contradicting evidence without cache writes", (t) => {
  const f = fixture(t);
  const expires = f.fact("expires", { scopeKey: "version:one" });
  const weak = f.assess(expires.id, { method: "statement" });
  f.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE fact_id=? AND id<>?")
    .run(NOW, expires.id, weak.id);
  const disputed = f.fact("restored", { scopeKey: "version:one" });
  const contradiction = f.assess(disputed.id, { stance: "contradicts" });
  const refuted = assertGraphFact(f.store.db, {
    subject: f.topic.id, predicate: "HAS_VALUE", objectValue: "refuted-cache", validFrom: "2020-01-01", scopeKey: "version:one",
  });
  const onlyContradiction = f.assess(refuted.id, { stance: "contradicts" });
  for (const row of [contradiction, onlyContradiction]) {
    f.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE id=?").run(NOW, row.id);
  }
  const before = f.store.db.prepare("SELECT total_changes() AS changes").get().changes;
  const result = f.query({ scopeKey: "version:one" });
  assert.deepEqual(result.verifiedFacts.map((row) => row.id), [disputed.id]);
  assert.deepEqual(new Set(result.reviewPending.map((row) => row.id)), new Set([expires.id, refuted.id]));
  assert.ok(result.reviewPending.every((row) => row.epistemic_status === "proposed" && row.scopeKey === "version:one"));
  assert.deepEqual(result.conflicts, []);
  assert.equal(f.store.db.prepare("SELECT total_changes() AS changes").get().changes, before);
});

test("queryContext does not traverse future or out-of-scope edges at either hop", (t) => {
  const f = fixture(t);
  const bridge = f.entity("topic:bridge", "KnowledgeTopic", "Bridge");
  const future = f.entity("person:future", "Person", "FutureOwner");
  const wrongScope = f.entity("person:other-version", "Person", "OtherVersionOwner");
  f.fact(undefined, { predicate: "RELATED_TO", objectEntity: bridge.id, scopeKey: "version:one" });
  const futureFact = f.fact(undefined, {
    subject: bridge.id, predicate: "RESPONSIBLE_FOR", objectEntity: future.id, scopeKey: "version:one", validFrom: HANDOVER,
  });
  const otherFact = f.fact(undefined, {
    subject: bridge.id, predicate: "RESPONSIBLE_FOR", objectEntity: wrongScope.id, scopeKey: "version:two",
  });
  const result = f.query({ depth: 2, scopeKey: "version:one" });
  assert.ok(!JSON.stringify(result).includes(futureFact.id));
  assert.ok(!JSON.stringify(result).includes(otherFact.id));
  assert.deepEqual(result.askablePeople, []);
  assert.ok(f.query({ depth: 2, scopeKey: "version:one", asOf: HANDOVER }).askablePeople.some((row) => row.entityId === future.id));
});

test("queryContext provenance and support selection use the same historical asOf", (t) => {
  const f = fixture(t);
  const row = f.fact("historical-proof");
  const assessment = f.store.db.prepare("SELECT id, evidence_id FROM graph_evidence_assessments WHERE fact_id=?").get(row.id);
  f.store.db.prepare("UPDATE graph_evidence_assessments SET valid_until=? WHERE id=?").run("2025-01-01T00:00:00Z", assessment.id);
  f.store.db.prepare("INSERT INTO evidence_links(parent_evidence_id, child_evidence_id, relation, created_at) VALUES(?, ?, 'supersedes', ?)")
    .run(f.evidence().id, assessment.evidence_id, HANDOVER);
  const result = f.query({ asOf: "2024-01-01T00:00:00Z" });
  assert.equal(result.verifiedFacts[0]?.id, row.id);
  assert.equal(result.verifiedFacts[0].evidence.id, assessment.evidence_id);
  assert.ok(result.items.some((item) => item.type === "evidence_assessment" && item.value.id === assessment.id));
});

test("queryContext keeps pending source review out of verified facts", (t) => {
  const f = fixture(t);
  const source = captureKnowledge(f.store.db, {
    sourceType: "note", title: "TemporalSample pending source", content: "An unreviewed observation",
    summary: "TemporalSample pending source", keywords: ["TemporalSample", "source", "review"],
    retrievalCues: ["TemporalSample evidence", "TemporalSample review"],
  });
  const row = assertGraphFact(f.store.db, {
    subject: f.topic.id, predicate: "HAS_VALUE", objectValue: "awaits-review", validFrom: "2020-01-01", scopeKey: "version:one",
  });
  f.assess(row.id, { evidenceId: source.evidenceId });
  const result = f.query();
  assert.deepEqual(result.verifiedFacts, []);
  assert.ok(result.reviewPending.some((item) => item.id === row.id && item.scopeKey === "version:one"));
});

test("queryContext excludes superseded legacy records with unknown end dates", (t) => {
  const f = fixture(t);
  const dirtySupported = f.fact("legacy-supported");
  const dirtyCandidate = assertGraphFact(f.store.db, {
    subject: f.topic.id, predicate: "HAS_VALUE", objectValue: "legacy-candidate", validFrom: "2020-01-01",
  });
  f.store.db.prepare("UPDATE graph_facts SET status='superseded', valid_to=NULL WHERE id IN (?, ?)")
    .run(dirtySupported.id, dirtyCandidate.id);
  const predecessor = f.fact("scheduled-predecessor");
  const successor = f.fact("scheduled-successor", {
    validFrom: HANDOVER, supersedesFactId: predecessor.id, supersessionReason: "Scheduled handover with a known end",
    sourceEvidenceIds: [f.evidence().id],
  });
  for (const [asOf, expected] of [[NOW, predecessor.id], [HANDOVER, successor.id]]) {
    const result = f.query({ asOf });
    assert.deepEqual(result.verifiedFacts.map((row) => row.id), [expected]);
    assert.ok(!JSON.stringify(result).includes(dirtySupported.id));
    assert.ok(!JSON.stringify(result).includes(dirtyCandidate.id));
  }
});
