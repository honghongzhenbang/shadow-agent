import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { assessFactEvidence, assertGraphFact, upsertGraphEntity } from "../src/graph-model.mjs";
import { importCognitiveProfile } from "../src/cognitive-profile.mjs";
import { previewUserBasics, confirmUserBasics, readUserProfile, workFocusProjection, migrateUserProfile,
  syncUserProfileFile, selectUserProfileFacts, profileTurnContext } from "../src/user-profile.mjs";
import { checkTaskAccess } from "../openclaw/shadow-policy/task-access.mjs";
import { currentUserContext } from "../openclaw/shadow-policy/index.mjs";
import { processDirectInputRequest } from "../src/direct-input.mjs";
import { materializeContextGraph } from "../src/context-graph.mjs";
import { collectImports } from "../src/collectors/imports.mjs";
import { collectProjects } from "../src/collectors/projects.mjs";

const basics = { name: "新用户", role: "工程师", team: "测试团队", responsibilities: ["负责测试软件"],
  exclusions: ["不负责硬件生产"], firstObjective: "整理示例项目的测试方案", preferences: ["结果简洁"],
  sources: [{ software: "办公软件", scope: "本人最近一周会话", connected: false },
    { software: "本机项目", scope: "D:/demo", connected: true }] };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-user-profile-"));
  const file = path.join(directory, "context.sqlite");
  const store = openDatabase(file);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, file };
}
function confirm(store, input = basics) { return confirmUserBasics(store, input, previewUserBasics(input).confirmation); }
function evidence(store, content = "test record") {
  const source = store.upsertSource({ sourceKey: content, kind: "manual_knowledge", uri: "test://profile" });
  return store.addEvidence({ sourceId: source.id, kind: "manual_knowledge", title: content, content, sourceLocator: `test://${content}` }).id;
}

test("empty-user preview never writes; explicit confirmation uses graph and existing task queue idempotently", t => {
  const { store, file } = fixture(t);
  assert.equal(readUserProfile(store.db).state, "needs_input");
  const preview = previewUserBasics(basics);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM evidence").get().n, 0);
  assert.throws(() => confirmUserBasics(store, basics, "wrong"), /mismatch/);
  assert.throws(() => previewUserBasics({ ...basics, exclusions: [] }), /Required list/);
  assert.throws(() => previewUserBasics({ ...basics, accessToken: "secret" }), /Unknown/);
  const first = confirm(store), second = confirm(store);
  assert.equal(first.profile.state, "ready");
  assert.equal(first.profile.autonomousOwnershipReady, true);
  assert.equal(first.evidenceId, second.evidenceId);
  assert.equal(first.profile.revision, second.profile.revision);
  assert.equal(first.taskRequest.id, second.taskRequest.id);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM direct_input_receipts").get().n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM controller_outbox").get().n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM graph_entities").get().n, 1);
  assert.ok(preview.tasks.some(task => task.owner === "user" && task.title.includes("登录")));
  assert.ok(preview.tasks.some(task => task.owner === "agent" && task.source?.scope === "D:/demo"));
  assert.match(currentUserContext(file), /新用户/);
  assert.ok(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_focus_profiles'").get());
});

test("confirmed initialization plan uses existing task handoff and persistent receipt", async t => {
  const { store, directory } = fixture(t);
  const queued = confirm(store).taskRequest;
  const cards = [{ id: "profile-user-info", title: "补充同事关系", notes: `Evidence: ${queued.evidence_id}` },
    { id: "profile-agent-discovery", title: "调查已选择的资料", notes: `Evidence: ${queued.evidence_id}` }];
  let calls = 0;
  const dependencies = {
    runConversation: async (_root, input) => {
      calls++;
      assert.match(input.message, /owner=user/);
      assert.match(input.message, /D:\/demo/);
      assert.match(input.message, /不得索要明文凭据/);
      return { text: "已建立初始化卡片", payload: { accepted: { runId: "onboarding-test" } } };
    },
    listCards: async () => cards,
  };
  const result = await processDirectInputRequest(store, { projectRoot: directory }, queued.id, dependencies);
  assert.equal(result.createdTasks.length, 2);
  for (const card of cards) {
    const owner = store.db.prepare("SELECT owner_session_key FROM work_task_attention WHERE card_id=?").get(card.id);
    assert.match(owner.owner_session_key, /^agent:main:shadow:task:/);
  }
  assert.equal((await processDirectInputRequest(store, { projectRoot: directory }, queued.id, dependencies)).idempotent, true);
  assert.equal(calls, 1);
});

test("voice cold start reuses one agent task and idempotent initialization without login or profile paths", t => {
  const { store } = fixture(t);
  const input = { ...basics, sources: [{ software: "手机录音", scope: "手动提交的录音", kind: "voice", connected: false },
    { software: "电脑录音", scope: "本人选择的文件", kind: "voice", connected: true }] };
  const preview = previewUserBasics(input);
  assert.equal(preview.tasks.filter(t => t.capability === "voice-input").length, 1);
  assert.equal(preview.tasks.some(t => t.title.includes("登录")), false);
  assert.match(preview.tasks.find(t => t.capability === "voice-input").acceptance, /35 秒/);
  const a = confirm(store, input), b = confirm(store, input);
  assert.equal(a.taskRequest.id, b.taskRequest.id);
  assert.equal(JSON.stringify(a.profile).includes("funPython"), false);
  assert.equal(previewUserBasics(basics).tasks.some(t => t.capability === "voice-input"), false);
});

test("routing knowledge is not responsibility and structural refresh reuses bound person", t => {
  const { store } = fixture(t);
  const profile = confirm(store).profile;
  const fact = assertGraphFact(store.db, { subject: profile.ownerEntityId, predicate: "RESPONSIBLE_FOR",
    objectValue: "了解另一部门的软件入口", metadata: { routingUse: "knowledge_route" } });
  assessFactEvidence(store.db, { factId: fact.id, evidenceId: evidence(store, "资料位置"),
    basis: "record", directness: "direct", method: "document_record", outcome: "observed", assessedBy: "test" });
  selectUserProfileFacts(store.db, [{ factId: fact.id, section: "responsibilities" }]);
  assert.ok(!workFocusProjection(store.db).responsibilities.includes("了解另一部门的软件入口"));
  assert.ok(workFocusProjection(store.db).workstreams.some(item => item.title === "了解另一部门的软件入口"));
  materializeContextGraph(store, {}, { refreshStructural: false, runMaintenance: false });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM graph_entities WHERE type='Person'").get().n, 1);
});

test("confirmation and task outbox fail atomically", t => {
  const { store } = fixture(t);
  const enqueue = store.enqueueControllerAction;
  store.enqueueControllerAction = () => { throw new Error("outbox failure"); };
  assert.throws(() => confirm(store), /outbox failure/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM evidence").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM graph_entities").get().n, 0);
  assert.equal(readUserProfile(store.db).ownerEntityId, null);
  store.enqueueControllerAction = enqueue;
});

test("new facts and corrections refresh both views; unrelated people do not enter owner profile", t => {
  const { store, directory } = fixture(t);
  const original = confirm(store).profile;
  const owner = original.ownerEntityId;
  const id = evidence(store, "新的个人偏好");
  const fact = assertGraphFact(store.db, { subject: owner, predicate: "PREFERS", objectValue: "附上测试证据" });
  assessFactEvidence(store.db, { factId: fact.id, evidenceId: id, basis: "record", directness: "direct", method: "document_record", outcome: "observed", assessedBy: "test" });
  const updated = readUserProfile(store.db);
  assert.notEqual(updated.revision, original.revision);
  assert.ok(updated.items.some(item => item.factId === fact.id));
  const output = syncUserProfileFile(store.db, path.join(directory, "private"));
  assert.match(fs.readFileSync(output.file, "utf8"), /附上测试证据/);
  const colleague = upsertGraphEntity(store.db, { canonicalKey: "person:other", type: "Person", name: "同事" });
  const other = assertGraphFact(store.db, { subject: colleague.id, predicate: "RESPONSIBLE_FOR", objectValue: "负责生产" });
  assert.throws(() => selectUserProfileFacts(store.db, [{ factId: other.id, section: "responsibilities" }]), /bound owner/);
  assert.equal(readUserProfile(store.db).revision, updated.revision);
  store.db.prepare("UPDATE graph_facts SET status='superseded' WHERE id=?").run(fact.id);
  assert.ok(!readUserProfile(store.db).items.some(item => item.factId === fact.id));
  syncUserProfileFile(store.db, path.join(directory, "private"));
  assert.doesNotMatch(fs.readFileSync(output.file, "utf8"), /附上测试证据/);
});

test("opposition and expiry are computed from evidence, not cached trust or linked review", t => {
  const { store } = fixture(t);
  const profile = confirm(store).profile;
  const duty = profile.items.find(item => item.section === "responsibilities");
  const id = evidence(store, "职责有误");
  assessFactEvidence(store.db, { factId: duty.factId, evidenceId: id, stance: "contradicts", basis: "record", directness: "direct", method: "document_record", outcome: "contradicted", assessedBy: "test" });
  store.db.prepare("UPDATE graph_facts SET epistemic_status='supported' WHERE id=?").run(duty.factId);
  assert.equal(readUserProfile(store.db).conflicts[0].factId, duty.factId);
  assert.equal(readUserProfile(store.db).autonomousOwnershipReady, false);
  store.db.prepare("UPDATE graph_evidence_assessments SET valid_until='2020-01-01' WHERE evidence_id=?").run(id);
  assert.ok(readUserProfile(store.db).items.some(item => item.factId === duty.factId));
  store.db.prepare("UPDATE graph_facts SET valid_to='2020-01-01' WHERE id=?").run(duty.factId);
  assert.ok(!readUserProfile(store.db).items.some(item => item.factId === duty.factId));
});

test("scheduled profile change preserves the current preference until the handover date", t => {
  const { store } = fixture(t);
  const profile = confirm(store).profile;
  const old = profile.items.find(item => item.section === "preferences");
  const sourceId = evidence(store, "Scheduled preference change");
  const next = assertGraphFact(store.db, { subject: profile.ownerEntityId, predicate: old.predicate, scopeKey: old.scope,
    objectValue: "Explain details", validFrom: "2100-01-01T00:00:00Z", supersedesFactId: old.factId,
    supersessionReason: "Scheduled preference", sourceEvidenceIds: [sourceId], metadata: { userProfile: { section: "preferences" } } });
  assert.equal(next.supersession.allowed, true);
  assessFactEvidence(store.db, { factId: next.id, evidenceId: sourceId, basis: "record", directness: "direct",
    method: "document_record", assessedBy: "test" });
  assert.ok(readUserProfile(store.db).items.some(item => item.factId === old.factId));
  assert.ok(!readUserProfile(store.db).items.some(item => item.factId === next.id));
  const later = readUserProfile(store.db, { now: "2100-01-01T00:00:00Z" });
  assert.ok(later.items.some(item => item.factId === next.id));
  assert.ok(!later.items.some(item => item.factId === old.factId));
});

test("USER file edits enter the existing knowledge queue once, never overwrite current facts", t => {
  const { store, directory } = fixture(t);
  const before = confirm(store).profile;
  const dir = path.join(directory, "private");
  const { file } = syncUserProfileFile(store.db, dir);
  assert.equal(syncUserProfileFile(store.db, dir).feedbackEvidenceId, null);
  const generated = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, generated.replace("负责测试软件", "负责设备采购"));
  const edited = syncUserProfileFile(store.db, dir);
  assert.ok(edited.feedbackEvidenceId);
  assert.equal(store.db.prepare("SELECT status FROM graph_enrichment_queue WHERE evidence_id=?").get(edited.feedbackEvidenceId).status, "pending");
  assert.equal(readUserProfile(store.db).revision, before.revision);
  assert.equal(syncUserProfileFile(store.db, dir).feedbackEvidenceId, null);
  fs.unlinkSync(file);
  assert.equal(syncUserProfileFile(store.db, dir).feedbackEvidenceId, null);
  assert.match(fs.readFileSync(file, "utf8"), /负责测试软件/);
  fs.unlinkSync(path.join(dir, ".USER.generated.md"));
  assert.equal(syncUserProfileFile(store.db, dir).feedbackEvidenceId, null);
});

test("existing graph migrates without duplicating facts; legacy brief becomes untrusted review input", t => {
  const { store } = fixture(t);
  importCognitiveProfile(store, { version: 1, entities: [{ canonicalKey: "person:existing", name: "原用户", type: "Person", metadata: { isProfileOwner: true } }],
    relations: [{ subject: "person:existing", predicate: "RESPONSIBLE_FOR", objectValue: "原软件" }] });
  store.db.exec("CREATE TABLE work_focus_profiles(id TEXT, summary TEXT, evidence_ids_json TEXT)");
  store.db.prepare("INSERT INTO work_focus_profiles VALUES('primary', ?, '[]')").run("旧模型简况：已完成昨日部署，长期负责不存在的项目");
  assert.throws(() => confirm(store), /Migrate/);
  const facts = store.db.prepare("SELECT id FROM graph_facts ORDER BY id").all();
  const dry = migrateUserProfile(store.db);
  assert.equal(dry.legacyRows, 1);
  assert.ok(store.db.prepare("SELECT * FROM work_focus_profiles").get());
  const migrated = migrateUserProfile(store.db, { apply: true });
  assert.ok(migrated.archiveEvidenceId);
  assert.deepEqual(store.db.prepare("SELECT id FROM graph_facts ORDER BY id").all(), facts);
  assert.deepEqual(workFocusProjection(store.db).responsibilities, ["原软件"]);
  assert.equal(migrated.profile.state, "needs_input");
  const archive = store.db.prepare("SELECT role,metadata_json FROM evidence WHERE id=?").get(migrated.archiveEvidenceId);
  assert.equal(archive.role, "assistant");
  assert.equal(JSON.parse(archive.metadata_json).explicitUserKnowledge, false);
  assert.equal(migrateUserProfile(store.db, { apply: true }).archiveEvidenceId, null);
});

test("ambiguous owners require explicit binding rather than name guessing", t => {
  const { store } = fixture(t);
  for (const name of ["a", "b"]) upsertGraphEntity(store.db, { canonicalKey: name, type: "Person", name: "同名", metadata: { isProfileOwner: true } });
  assert.equal(migrateUserProfile(store.db).requiresOwner, true);
  assert.throws(() => migrateUserProfile(store.db, { apply: true }), /unambiguous/);
});

test("cold-start gate leaves explicit requests working and blocks inferred outside ownership", () => {
  const lookup = { profileReady: () => false };
  assert.equal(checkTaskAccess({ toolName: "workboard_create" }, { sessionKey: "agent:main:shadow:user" }, lookup), undefined);
  assert.equal(checkTaskAccess({ toolName: "workboard_create" }, { sessionKey: "agent:main:shadow:conversation:outside" }, lookup).block, true);
  assert.equal(checkTaskAccess({ toolName: "workboard_read" }, { sessionKey: "agent:main:shadow:conversation:outside" }, lookup), undefined);
});

test("runtime reload uses same graph, not file; context stays bounded", t => {
  const { store, file } = fixture(t);
  const before = confirm(store).profile;
  const child = spawnSync(process.execPath, ["scripts/user-profile.mjs", "status", "--database", file], { encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).revision, before.revision);
  assert.ok(Buffer.byteLength(profileTurnContext(store.db)) < 10000);
});

test("installed projection modules load without importing the application write or execution stack", async t => {
  const { store, directory } = fixture(t);
  const profile = confirm(store).profile;
  const installed = path.join(directory, "installed", "src");
  fs.mkdirSync(installed, { recursive: true });
  const installer = fs.readFileSync("scripts/install-shadow-context-plugin.ps1", "utf8");
  for (const module of ["user-profile-view.mjs", "utils.mjs", "knowledge-policy.mjs", "graph-model.mjs"]) {
    assert.ok(installer.includes(module));
    fs.copyFileSync(path.join("src", module), path.join(installed, module));
  }
  const view = await import(pathToFileURL(path.join(installed, "user-profile-view.mjs")).href);
  assert.equal(view.readUserProfile(store.db).revision, profile.revision);
});

test("generated private views never re-enter the document collectors even as a project root", async t => {
  const { store, directory } = fixture(t);
  confirm(store);
  const root = path.join(directory, "Private-Profile");
  syncUserProfileFile(store.db, root);
  store.upsertProject({ projectKey: "profile", name: "private view", rootPath: root });
  const config = { paths: { inboxRoots: [root] }, policy: { blockedPaths: [] }, collection: {
    documentExtensions: [".md"], maxDocumentBytes: 65536, maxEvidenceChars: 8192,
    maxProjectFiles: 100, ignoredDirectories: [], projectScanDepth: 2 } };
  const before = store.db.prepare("SELECT count(*) n FROM evidence").get().n;
  assert.equal((await collectImports(store, config)).evidence, 0);
  assert.equal((await collectProjects(store, config)).evidence, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM evidence").get().n, before);
});
