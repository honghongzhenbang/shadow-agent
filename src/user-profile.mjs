import fs from "node:fs";
import path from "node:path";
import { importCognitiveProfile } from "./cognitive-profile.mjs";
import { sha256, stableJson } from "./utils.mjs";
import { captureKnowledge, captureKnowledgeEpisode } from "../openclaw/shadow-work/src/epistemic.js";
import { enqueueDirectInputRequest } from "./direct-input.mjs";

import { binding, boundProfileOwner, readUserProfile, renderUserProfile } from "./user-profile-view.mjs";
export { boundProfileOwner, readUserProfile, renderUserProfile, profileTurnContext,
  selectUserProfileFacts, workFocusProjection } from "./user-profile-view.mjs";

const parse = (s, fallback = {}) => { try { return JSON.parse(s); } catch { return fallback; } };

function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1000) throw new Error(`Required bounded field: ${field}`);
  if (/\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+\S+|[?&](?:access_token|refresh_token|token)=/i.test(value)) throw new Error("Credentials must use the application's secure authorization flow, not profile input.");
  return value.trim();
}

export function previewUserBasics(input) {
  if (!input || typeof input !== "object" || input.exampleOnly === true) throw new Error("Provide your own basic information.");
  const fields = ["name", "role", "team", "responsibilities", "exclusions", "firstObjective", "preferences", "sources"];
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error("Unknown basic field; permissions and credentials are not profile data.");
  const basics = {};
  for (const field of ["name", "role", "team", "firstObjective"]) basics[field] = text(input[field], field);
  for (const field of ["responsibilities", "exclusions", "preferences"]) {
    if (field === "preferences" && input[field] === undefined) { basics[field] = []; continue; }
    if (!Array.isArray(input[field]) || input[field].length > 24 || (field !== "preferences" && !input[field].length)) {
      throw new Error(`Required list: ${field}; explicitly state no exclusions when applicable.`);
    }
    basics[field] = [...new Set(input[field].map(value => text(value, field)))];
  }
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > 12)) throw new Error("sources must be a bounded list.");
  basics.sources = (input.sources ?? []).map(source => {
    if (!source || Object.keys(source).some(key => !["software", "scope", "connected", "kind"].includes(key))) throw new Error("Source selection accepts software, scope, connected and kind only; never credentials.");
    if (source.kind != null && source.kind !== "voice") throw new Error("Unsupported source kind.");
    return { software: text(source.software, "source software"), scope: text(source.scope, "source scope"), connected: source.connected === true,
      ...(source.kind ? { kind: source.kind } : {}) };
  });
  return { basics, confirmation: sha256(stableJson(basics)), tasks: initializationTasks(basics),
    note: "Confirm these facts and the initialization task plan. Source selection permits read-only investigation within its scope, not new external writes or permissions." };
}

export function initializationTasks(basics) {
  const tasks = [
    { owner: "user", title: "补充职责边界和同事协作关系", acceptance: "已知职责保留，仅补充缺少的负责/委派/协作边界与人员关系；不要求重复录入。" },
    { owner: "agent", title: basics.firstObjective, acceptance: "在独立任务卡澄清验收并推进用户首个目标，任务状态只保存在 Workboard。" },
  ];
  if (!basics.sources.length) tasks.push({ owner: "user", title: "确认可读取的软件和资料范围", acceptance: "由用户选择文件目录、编程工具记忆、办公软件等来源，不默认全盘扫描。" });
  for (const source of basics.sources) {
    if (source.kind === "voice") {
      if (!tasks.some(task => task.capability === "voice-input")) tasks.push({ owner: "agent", capability: "voice-input",
        title: "配置并验收语音输入", source,
        acceptance: "阅读 docs/operations/local-voice-setup.md。先询问录音来源、速度/质量偏好和云端意愿；检查电脑资源并配置隔离运行环境。Fun-ASR-Nano 为本地首选，实际不可用则用 SenseVoice；验证 35 秒上限、说话人边界、本地降级和隔离库幂等导入，记录配置与回执。不得自动上传音频、索要明文凭据或启动麦克风。需要用户输入时在同卡续接；运行配置不写入 USER.md。" });
      continue;
    }
    if (!source.connected) tasks.push({ owner: "user", title: `完成 ${source.software} 接入或登录`,
      acceptance: "通过软件本机/官方安全授权入口完成连接，并验证目标只读操作；密码、Token 不进入聊天、卡片或图谱。", source });
    tasks.push({ owner: "agent", title: `调查 ${source.software} 并整理知识`, source,
      acceptance: `连接可用后，只读调查 ${source.scope}；先列目录/索引，再按用户目标选择重要资料，保留位置、来源和待核实项；不复制全部原文。发现的事实、冲突走既有知识维护队列，不直接改 USER.md。` });
  }
  return tasks;
}

export function confirmUserBasics(store, input, confirmation) {
  const preview = previewUserBasics(input);
  if (confirmation !== preview.confirmation) throw new Error("Preview confirmation mismatch; review the current input first.");
  const previous = store.db.prepare(`SELECT evidence.metadata_json, receipt.id FROM evidence
    JOIN direct_input_receipts receipt ON receipt.evidence_id=evidence.id
    WHERE evidence.source_locator=? LIMIT 1`).get(`shadow://onboarding/plan/${confirmation}`);
  if (previous) return { evidenceId: parse(previous.metadata_json).profileEvidenceId,
    evidenceInserted: false, idempotent: true, profile: readUserProfile(store.db),
    tasks: preview.tasks, taskRequest: store.directInputReceipt(previous.id) };
  const current = binding(store.db);
  if (!current && store.db.prepare("SELECT 1 FROM graph_entities WHERE json_valid(metadata_json) AND json_extract(metadata_json,'$.isProfileOwner')=1 LIMIT 1").get()) {
    throw new Error("Existing owner knowledge found. Migrate the explicit owner before confirming basics; do not create another person.");
  }
  const entity = current ? store.db.prepare("SELECT canonical_key FROM graph_entities WHERE id=?").get(current.owner_entity_id) : null;
  const canonicalKey = entity?.canonical_key ?? "user:primary";
  const { basics } = preview;
  const values = { identity: [basics.name], role: [basics.role], team: [basics.team],
    responsibilities: basics.responsibilities, exclusions: basics.exclusions,
    objectives: [basics.firstObjective], preferences: basics.preferences };
  const relations = Object.entries(values).flatMap(([section, entries]) => entries.map(value => ({
    subject: canonicalKey, predicate: `USER_${section.toUpperCase()}`, objectValue: value,
    metadata: { userProfile: { section } }, notes: "用户预览确认的个人资料；不构成动作授权。",
  })));
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = importCognitiveProfile(store, {
      version: 1, title: "用户确认的基本资料", entities: [{ canonicalKey, type: "Person", name: basics.name }], relations,
    }, { sourceLocator: "manual://user-basics/primary", createdBy: "user-basics-confirmed", transaction: false });
    const ownerId = store.db.prepare("SELECT id FROM graph_entities WHERE canonical_key=?").get(canonicalKey).id;
    boundProfileOwner(store.db, ownerId, result.evidenceId);
    const captured = captureKnowledgeEpisode(store.db, {
      title: "用户确认的初始化任务计划", sourceLocator: `shadow://onboarding/plan/${confirmation}`,
      content: `用户已确认以下初始化任务计划。复用 Workboard：先查重；建立一张初始化总卡与关联任务。owner=user 的卡保留所需用户输入，owner=agent 的卡交给独立控制会话推进。软件未接入时先等待对应登录任务，但其他已就绪来源继续。不得索要明文凭据。任务结果通过既有知识差量维护流程入图谱，更新同一用户投影。\n${JSON.stringify(preview.tasks, null, 2)}`,
      summary: "用户确认冷启动任务计划：人工补充、软件安全授权与 Agent 有界调查使用已有任务链路，不另建初始化调度器。",
      metadata: { onboardingPlan: true, confirmation, profileEvidenceId: result.evidenceId },
    }, { transaction: false });
    const request = enqueueDirectInputRequest(store, { evidenceId: captured.evidenceId, source: "onboarding-confirmed" });
    store.db.exec("COMMIT");
    return { ...result, profile: readUserProfile(store.db), tasks: preview.tasks, taskRequest: request.receipt };
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

export function migrateUserProfile(database, { ownerEntityId, apply = false } = {}) {
  const current = binding(database);
  const owners = database.prepare(`SELECT id, name FROM graph_entities WHERE status='active'
    AND json_valid(metadata_json) AND json_extract(metadata_json, '$.isProfileOwner')=1`).all();
  const id = current?.owner_entity_id ?? ownerEntityId ?? (owners.length === 1 ? owners[0].id : null);
  const hasLegacy = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_focus_profiles'").get();
  const legacy = hasLegacy ? database.prepare("SELECT * FROM work_focus_profiles").all() : [];
  if (!apply) return { dryRun: true, ownerEntityId: id, ownerCandidates: owners, legacyRows: legacy.length, requiresOwner: !id };
  if (!id) throw new Error("No unambiguous owner. Provide an exact existing entity ID; never infer by name.");
  database.exec("BEGIN IMMEDIATE");
  try {
    boundProfileOwner(database, id);
    let archiveEvidenceId = null;
    if (legacy.length) {
      const captured = captureKnowledge(database, {
        title: "历史工作简况迁移待复核", content: JSON.stringify(legacy, null, 2),
        sourceLocator: "shadow://user-profile/legacy-focus", generatedBy: "profile-migration",
        summary: "保存旧工作简况的原文与引用。仅作为历史线索，需要逐项核对现有图谱；不要把模型摘要或动态待办升级为当前职责。",
        metadata: { migrationArchive: true },
        keywords: ["历史简况", "迁移", "待复核"], retrievalCues: ["旧简况记录了哪些职责和待办？", "旧简况与当前事实有哪些冲突？"],
      }, { transaction: false, explicitUserKnowledge: false, evidenceRole: "assistant" });
      archiveEvidenceId = captured.evidenceId;
    }
    database.exec("DROP TABLE IF EXISTS work_focus_profiles");
    database.exec("COMMIT");
    return { ownerEntityId: id, archiveEvidenceId, legacyRows: legacy.length, profile: readUserProfile(database) };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export function userProfileDirectory(databasePath) { return path.join(path.dirname(databasePath), "private-profile"); }

export function syncUserProfileFile(database, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "USER.md"), baselineFile = path.join(directory, ".USER.generated.md");
  const profile = readUserProfile(database);
  const body = renderUserProfile(profile);
  const rendered = `${body}\n<!-- shadow-user-projection sha256:${sha256(body)} -->\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const baseline = fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, "utf8") : null;
  let feedback = null;
  const generated = current?.match(/^([\s\S]*)\n<!-- shadow-user-projection sha256:([a-f0-9]{64}) -->\n$/);
  const intactGenerated = generated && sha256(generated[1]) === generated[2];
  if (current !== null && current !== baseline && current !== rendered && !intactGenerated) {
    // Store the edit and its baseline before replacing the view. Never ingest our own generated file.
    if (Buffer.byteLength(current) > 65536) throw new Error("USER.md edit exceeds 64 KiB; preserved unchanged for manual review.");
    feedback = captureKnowledgeEpisode(database, {
      title: "USER.md 人工修订", content: `原生成基线：\n${baseline ?? "unknown"}\n\n用户修改后的文件：\n${current}`,
      sourceLocator: "shadow://user-profile/file-edit", generatedBy: "user-profile-file-edit",
      metadata: { userProfileEdit: true, baselineHash: baseline ? sha256(baseline) : null, editHash: sha256(current) },
      summary: "用户修改了私有资料视图。请对比基线，仅将真实差量与当前图谱核对；保留冲突，不把整个文件重新当作新事实或授权。",
    });
  }
  if (current !== rendered || baseline !== rendered) {
    const latest = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (latest !== current) throw new Error("USER.md changed during refresh; preserved for the next pass.");
    // Integrity marker distinguishes an older generated view from an edit after interrupted writes.
    fs.writeFileSync(`${baselineFile}.tmp`, rendered, "utf8"); fs.renameSync(`${baselineFile}.tmp`, baselineFile);
    fs.writeFileSync(`${file}.tmp`, rendered, "utf8"); fs.renameSync(`${file}.tmp`, file);
  }
  return { file, revision: profile.revision, feedbackEvidenceId: feedback?.evidenceId ?? null };
}
