import fs from "node:fs";
import path from "node:path";

import { logger } from "../logger.mjs";
import { classifyFeishuMessageOwnership } from "../feishu-ownership.mjs";
import { feishuMessageIdentity } from "../feishu-message-identity.mjs";
import { powershellScriptCommand, runCommand } from "../process.mjs";
import {
  adapterSourceMetadata,
  feishuMessageProjectionMetadata,
  getSourceAdapter,
  publicSourceAdapter,
} from "../source-adapters/index.mjs";
import { parseJsonLoose, safeEvidenceText, sha256, splitTextChunks, stableJson } from "../utils.mjs";

function larkEnv() {
  return {
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

export async function runLarkCommand(config, args, options = {}) {
  const commandOptions = {
    timeoutMs: options.timeoutMs ?? 180000,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    env: larkEnv(),
    check: options.check,
  };
  const cliScript = path.join(path.dirname(config.feishu.cliPath), "node_modules", "@larksuite", "cli", "scripts", "run.js");
  const result = fs.existsSync(cliScript)
    ? await runCommand(process.execPath, [cliScript, ...args], commandOptions)
    : await powershellScriptCommand(config.feishu.cliPath, args, commandOptions);
  let payload = null;
  try {
    payload = parseJsonLoose(result.stdout || result.stderr);
  } catch {
    // Some successful commands emit non-JSON notices on stderr.
  }
  if (payload?.ok === false) {
    const error = new Error(payload.error?.message ?? "lark-cli returned an error");
    error.result = result;
    throw error;
  }
  return result;
}

function flag(name, value) {
  return value === undefined ? name : `${name}=${value}`;
}

function commandError(error) {
  const detail = error?.result?.stderr || error?.result?.stdout || error?.message || String(error);
  return safeEvidenceText(detail, 5000);
}

function missingScopesFromError(error) {
  try {
    const payload = parseJsonLoose(error?.result?.stderr || error?.result?.stdout || "");
    return payload?.error?.missing_scopes ?? [];
  } catch {
    return [];
  }
}

function findArrays(value, key) {
  const result = [];
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value[key])) result.push(...value[key]);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") result.push(...findArrays(child, key));
  }
  return result;
}

function findFirst(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (value[key] !== undefined) return value[key];
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findFirst(child, keys);
    if (found !== null) return found;
  }
  return null;
}

function isoWithOffset(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export function timestampIso(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
  const text = String(value).trim();
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const normalized = localMatch
    ? `${localMatch[1]}-${localMatch[2]}-${localMatch[3]}T${localMatch[4]}:${localMatch[5]}:${localMatch[6] ?? "00"}+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function cleanHighlight(value) {
  return String(value ?? "").replace(/<\/?h[b]?>/gi, "").trim();
}

function normalizeDriveSearchItem(item) {
  const metadata = item?.result_meta ?? item ?? {};
  return {
    token: metadata.token ?? item?.token ?? item?.doc_token ?? item?.obj_token ?? item?.id,
    title: cleanHighlight(item?.title_highlighted ?? item?.title ?? item?.name),
    summary: cleanHighlight(item?.summary_highlighted ?? item?.summary),
    docType: String(metadata.doc_types ?? item?.doc_type ?? item?.type ?? "").toLowerCase(),
    editTime: metadata.update_time ?? item?.edit_time ?? item?.update_time,
    url: metadata.url ?? item?.url,
    raw: item,
  };
}

export async function getFeishuHealth(config, options = {}) {
  if (!config.feishu.enabled) return { enabled: false, userReady: false, status: null };
  if (!fs.existsSync(config.feishu.cliPath)) return { enabled: true, userReady: false, error: "lark-cli not found" };
  try {
    const result = await (options.runLark ?? runLarkCommand)(config,
      ["auth", "status", "--json", ...(options.verify === false ? [] : ["--verify"])], { timeoutMs: 30000 });
    const status = parseJsonLoose(result.stdout || result.stderr);
    return {
      enabled: true,
      userReady: status?.identities?.user?.status === "ready" && status?.identities?.user?.verified !== false,
      botReady: status?.identities?.bot?.status === "ready",
      status,
    };
  } catch (error) {
    return { enabled: true, userReady: false, error: error.message };
  }
}

export function feishuCollectionState(result) {
  const succeeded = result.successfulSections?.length > 0;
  return result.errors.length ? (succeeded ? "partial" : "error") : succeeded ? "ready" : "skipped";
}

export function recordFeishuCollectionHealth(store, kind, result, now = new Date().toISOString()) {
  const prefix = `runtime:feishu:quick:${kind}`;
  const state = feishuCollectionState(result);
  store.setSetting(`${prefix}:lastAttemptAt`, now);
  store.setSetting(`${prefix}:state`, state);
  store.setSetting(`${prefix}:lastError`, JSON.stringify(result.errors));
  if (state === "ready") store.setSetting(`${prefix}:lastSuccessAt`, now);
  return state;
}

function parseLegacyMetadata(value) {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return JSON.parse(String(value || "{}").replace(/:\s*undefined(?=\s*[,}])/g, ":null"));
  }
}

export function backfillFeishuMessageOwnership(store, self) {
  const version = "2";
  if (store.getSetting("feishu:ownership-backfill-version", "") === version) {
    return { scanned: 0, updated: 0, skipped: true };
  }
  const rows = store.db.prepare(`
    SELECT id, content, metadata_json FROM evidence
    WHERE kind='feishu_message'
  `).all();
  const update = store.db.prepare("UPDATE evidence SET metadata_json=? WHERE id=?");
  let updated = 0;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const metadata = parseLegacyMetadata(row.metadata_json);
      let message;
      try { message = JSON.parse(row.content || "{}"); } catch { message = {}; }
      const ownership = classifyFeishuMessageOwnership({
        chat_type: metadata.chatType,
        sender: message.sender,
        mentions: message.mentions,
        content: message.content,
      }, self);
      update.run(stableJson({
        ...metadata,
        ownershipSignal: ownership.signal,
        senderOpenId: ownership.senderOpenId,
        senderName: ownership.senderName,
        sentBySelf: ownership.sentBySelf,
        mentionsSelf: ownership.mentionsSelf,
        mentionOpenIds: ownership.mentionOpenIds,
        mentionNames: ownership.mentionNames,
      }), row.id);
      store.refreshSourceRecord(row.id);
      updated += 1;
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  store.setSetting("feishu:ownership-backfill-version", version);
  return { scanned: rows.length, updated, skipped: false };
}

const collectionQueues = new Map();

export async function collectFeishu(store, config, options = {}) {
  // Full reconciliation and quick polling use separate DB connections. Serialize
  // their cursor updates so an older full scan cannot overwrite a newer page.
  const key = store.db.prepare("PRAGMA database_list").get().file || store;
  const previous = collectionQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => collectFeishuOnce(store, config, options));
  collectionQueues.set(key, current);
  try { return await current; }
  finally { if (collectionQueues.get(key) === current) collectionQueues.delete(key); }
}

async function collectFeishuOnce(store, config, options = {}) {
  const runLark = options.runLark ?? runLarkCommand;
  const personalSources = config.feishu.personalSources ?? {};
  const sections = {
    messages: options.messages !== false,
    approvals: options.approvals !== false,
    tasks: options.tasks !== false,
    drive: options.drive !== false,
  };
  const pageLimit = Math.max(1, Number(options.pageLimit ?? config.feishu.pageLimit) || 1);
  const maxDocumentBodies = Math.max(0, Number(options.maxDocumentBodies ?? personalSources.documents?.maxBodiesPerRun) || 0);
  const metrics = {
    adapter: publicSourceAdapter(getSourceAdapter("feishu")),
    authenticated: false,
    messages: 0,
    documents: 0,
    documentBodies: 0,
    documentContentEvidence: 0,
    approvals: 0,
    tasks: 0,
    evidence: 0,
    historicalBootstrap: false,
    newMessages: [],
    newDocuments: [],
    missingScopes: [],
    errors: [],
    successfulSections: [],
  };
  if (!config.feishu.enabled) return metrics;
  const source = store.upsertSource({
    sourceKey: "feishu:user",
    kind: "feishu",
    uri: "feishu://current-user",
    status: "collecting",
    metadata: adapterSourceMetadata("feishu", {
      identity: "user",
      role: "personal_primary",
      capabilities: ["messages", "documents", "tasks", "approvals"],
    }),
  });
  // Local identity is advisory. A verification subprocess failure or an expired
  // access token must not prevent the business CLI from refreshing credentials.
  const health = await getFeishuHealth(config, { runLark, verify: false });
  const userIdentity = health.status?.identities?.user ?? {};
  if (userIdentity.openId) store.setSetting("feishu:user:openId", userIdentity.openId);
  if (userIdentity.userName) store.setSetting("feishu:user:name", userIdentity.userName);
  if (userIdentity.openId) metrics.ownershipBackfill = backfillFeishuMessageOwnership(store, {
    openId: userIdentity.openId ?? store.getSetting("feishu:user:openId", ""),
    name: userIdentity.userName ?? store.getSetting("feishu:user:name", ""),
  });

  const recordError = (sourceName, error) => {
    const detail = commandError(error);
    metrics.errors.push({ source: sourceName, error: detail });
    for (const scope of missingScopesFromError(error)) metrics.missingScopes.push(scope);
    logger.warn(`Feishu ${sourceName} collection failed`, { error: detail });
  };

  const lastMessageTime = store.getSetting("feishu.last_message_time");
  metrics.historicalBootstrap = !lastMessageTime;
  if (personalSources.messages?.enabled !== false && sections.messages) try {
  const cursorKey = "feishu.messages_scan";
  const savedCursor = store.getSetting(cursorKey, "");
  const scan = savedCursor ? JSON.parse(savedCursor) : {
    start: new Date(lastMessageTime ? Date.parse(lastMessageTime) - 120_000
      : Date.now() - config.feishu.initialLookbackDays * 86400000).toISOString(),
    end: new Date().toISOString(), pageToken: "", bootstrap: !lastMessageTime,
  };
  const startDate = new Date(scan.start);
  const endDate = new Date(scan.end);
  metrics.historicalBootstrap = scan.bootstrap;
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) throw new Error("Invalid persisted Feishu message window");
    store.setSetting(cursorKey, JSON.stringify(scan));
    const result = await runLark(config, [
      "im", "+messages-search",
      flag("--query", ""),
      flag("--start", isoWithOffset(startDate)),
      flag("--end", isoWithOffset(endDate)),
      flag("--page-size", "50"),
      ...(scan.pageToken ? [flag("--page-token", scan.pageToken)] : []),
      "--no-reactions",
      flag("--format", "json"),
      flag("--as", "user"),
    ]);
    const payload = parseJsonLoose(result.stdout);
    const messages = findFirst(payload, ["messages"]);
    const hasMore = findFirst(payload, ["has_more"]);
    const nextToken = findFirst(payload, ["page_token", "next_page_token"]);
    if (!Array.isArray(messages) || typeof hasMore !== "boolean") throw new Error("Incomplete Feishu message page: messages/has_more missing");
    if (hasMore && (!nextToken || nextToken === scan.pageToken)) throw new Error("Feishu message pagination did not advance");
    for (const message of messages) {
      const externalId = message.message_id ?? message.id;
      if (!externalId) continue;
      const occurredAt = timestampIso(message.create_time);
      const replyToMessageId = message.reply_to ?? message.parent_id ?? null;
      let replyToSelf = false;
      if (replyToMessageId) {
        const target = store.db.prepare(`
          SELECT metadata_json FROM evidence
          WHERE kind='feishu_message' AND external_id=?
          ORDER BY id DESC LIMIT 1
        `).get(replyToMessageId);
        try { replyToSelf = JSON.parse(target?.metadata_json ?? "{}").sentBySelf === true; } catch { /* invalid legacy metadata */ }
      }
      const ownership = classifyFeishuMessageOwnership({ ...message, reply_to_self: replyToSelf }, {
        openId: userIdentity.openId ?? store.getSetting("feishu:user:openId", ""),
        name: userIdentity.userName ?? store.getSetting("feishu:user:name", ""),
      });
      const messageMetadata = feishuMessageProjectionMetadata(message, {
        ownershipSignal: ownership.signal,
        senderOpenId: ownership.senderOpenId,
        senderName: ownership.senderName,
        sentBySelf: ownership.sentBySelf,
        mentionsSelf: ownership.mentionsSelf,
        mentionOpenIds: ownership.mentionOpenIds,
        mentionNames: ownership.mentionNames,
        replyToMessageId,
        replyToSelf,
      });
      const { conversationKey, senderType } = messageMetadata;
      const evidence = store.addEvidence({
        sourceId: source.id,
        kind: "feishu_message",
        occurredAt,
        threadId: message.thread_id ?? null,
        title: message.chat_name ?? message.chat?.name ?? "Feishu message",
        content: safeEvidenceText({ sender: message.sender, content: message.content, mentions: message.mentions, chat: message.chat_name ?? message.chat_id }, config.collection.maxEvidenceChars),
        sourceLocator: `feishu://message/${externalId}`,
        externalId,
        fingerprint: feishuMessageIdentity(message).fingerprint,
        metadata: messageMetadata,
      });
      if (evidence.inserted && !scan.bootstrap && occurredAt && Date.parse(occurredAt) >= startDate.getTime() - 1000) {
        metrics.evidence += 1;
        metrics.newMessages.push({
          evidenceId: evidence.id,
          externalId,
          chatId: message.chat_id ?? "unknown",
          chatType: message.chat_type ?? "unknown",
          threadId: message.thread_id ?? message.root_id ?? null,
          occurredAt,
          chatName: message.chat_name ?? message.chat?.name ?? null,
          conversationKey,
          senderType,
          ...ownership,
          replyToMessageId,
          replyToSelf,
        });
      } else if (evidence.inserted) metrics.evidence += 1;
      metrics.messages += 1;
    }
    // Only a fully drained, fixed search window advances coverage. Replaying a
    // page after a crash is safe because message identities are deduplicated.
    if (hasMore) store.setSetting(cursorKey, JSON.stringify({ ...scan, pageToken: String(nextToken) }));
    else {
      store.setSetting("feishu.last_message_time", endDate.toISOString());
      store.setSetting(cursorKey, "");
    }
    metrics.messageWindowComplete = !hasMore;
    metrics.successfulSections.push("messages");
  } catch (error) {
    recordError("messages", error);
  }

  if (personalSources.approvals?.enabled !== false && sections.approvals) {
    try {
      const result = await runLark(config, [
        "approval", "tasks", "query",
        "--params", JSON.stringify({ topic: "1" }),
        flag("--format", "json"),
        flag("--as", "user"),
      ]);
      const payload = parseJsonLoose(result.stdout);
      metrics.successfulSections.push("approvals");
      const tasks = [...findArrays(payload, "tasks"), ...findArrays(payload, "items")];
      for (const task of tasks) {
        const taskId = task.task_id;
        if (!taskId) continue;
        const evidence = store.addEvidence({
          sourceId: source.id,
          kind: "feishu_approval_task",
          occurredAt: null,
          title: task.title ?? task.definition_name ?? "Feishu approval",
          content: safeEvidenceText(task, config.collection.maxEvidenceChars),
          sourceLocator: `feishu://approval/${task.instance_code}/${taskId}`,
          externalId: taskId,
          fingerprint: sha256(`feishu-approval:${taskId}:${task.status ?? ""}`),
          metadata: { instanceCode: task.instance_code, definitionCode: task.definition_code, supportApiOperate: task.support_api_operate },
        });
        store.addTask({
          fingerprint: `feishu-approval-task:${taskId}`,
          title: `处理审批：${task.title ?? task.definition_name ?? taskId}`,
          description: safeEvidenceText(task.summaries ?? task, 4000),
          status: "new",
          priority: "high",
          riskLevel: "approval-decision",
          actionType: "review_approval",
          evidenceIds: [evidence.id],
          metadata: { taskId, instanceCode: task.instance_code },
        });
        if (evidence.inserted) metrics.evidence += 1;
        metrics.approvals += 1;
      }
    } catch (error) {
      recordError("approvals", error);
    }
  }

  if (personalSources.tasks?.enabled !== false && sections.tasks) {
    try {
      const result = await runLark(config, [
        "task", "+get-my-tasks",
        flag("--complete", "false"),
        "--page-all",
        flag("--page-limit", String(config.feishu.pageLimit)),
        flag("--format", "json"),
        flag("--as", "user"),
      ]);
      const payload = parseJsonLoose(result.stdout);
      metrics.successfulSections.push("tasks");
      const tasks = [...findArrays(payload, "tasks"), ...findArrays(payload, "items")];
      const seen = new Set();
      for (const task of tasks) {
        const taskId = task.guid ?? task.task_id ?? task.id;
        if (!taskId || seen.has(taskId)) continue;
        seen.add(taskId);
        const evidence = store.addEvidence({
          sourceId: source.id,
          kind: "feishu_task",
          occurredAt: timestampIso(task.create_time),
          title: task.summary ?? task.title ?? "Feishu task",
          content: safeEvidenceText(task, config.collection.maxEvidenceChars),
          sourceLocator: `feishu://task/${taskId}`,
          externalId: taskId,
          fingerprint: sha256(stableJson({ taskId, completed: task.completed_at ?? task.complete, updatedAt: task.update_time ?? task.updated_at })),
          metadata: { taskId, due: task.due, completed: task.completed_at ?? task.complete ?? false },
        });
        if (evidence.inserted) metrics.evidence += 1;
        metrics.tasks += 1;
      }
    } catch (error) {
      recordError("tasks", error);
    }
  }

  if (personalSources.documents?.enabled !== false && sections.drive) {
    let pageToken = options.resetDrivePage ? "" : store.getSetting("feishu.drive_page_token", "");
    let pages = 0;
    let documentBodyDisabled = false;
    try {
      while (pages < pageLimit) {
        const args = [
          "drive", "+search",
          flag("--query", ""),
          flag("--page-size", "20"),
          flag("--sort", "edit_time"),
          flag("--format", "json"),
          flag("--as", "user"),
        ];
        if (pageToken) args.push(flag("--page-token", pageToken));
        const result = await runLark(config, args);
        const payload = parseJsonLoose(result.stdout);
        const documents = [
          ...findArrays(payload, "items"),
          ...findArrays(payload, "docs"),
          ...findArrays(payload, "results"),
        ].map(normalizeDriveSearchItem);
        const seen = new Set();
        for (const document of documents) {
          const token = document.token;
          if (!token || seen.has(token)) continue;
          seen.add(token);
          const evidence = store.addEvidence({
            sourceId: source.id,
            kind: "feishu_document_index",
            occurredAt: timestampIso(document.editTime),
            title: document.title || "Feishu document",
            content: safeEvidenceText({ title: document.title, summary: document.summary, docType: document.docType, url: document.url }, config.collection.maxEvidenceChars),
            sourceLocator: document.url ?? `feishu://document/${token}`,
            externalId: token,
            fingerprint: sha256(stableJson({ version: 2, token, title: document.title, docType: document.docType, url: document.url })),
            metadata: { token, docType: document.docType, url: document.url, lastSeenEditTime: document.editTime },
          });
          if (evidence.inserted) {
            metrics.evidence += 1;
            metrics.newDocuments.push({
              evidenceId: evidence.id,
              token,
              sourceLocator: document.url ?? `feishu://document/${token}`,
              occurredAt: timestampIso(document.editTime),
            });
          }
          metrics.documents += 1;

          const docType = document.docType;
          const bodyVersion = sha256(stableJson({ token, editTime: document.editTime, title: document.title }));
          const bodySetting = `feishu:document-body:${token}`;
          if (
            personalSources.documents?.fetchBodies !== false &&
            !documentBodyDisabled &&
            metrics.documentBodies < maxDocumentBodies &&
            ["docx", "wiki", "doc"].includes(docType) &&
            store.getSetting(bodySetting) !== bodyVersion
          ) {
            try {
              const fetched = await runLark(config, [
                "docs", "+fetch",
                flag("--doc", document.url ?? token),
                flag("--doc-format", "markdown"),
                flag("--detail", "simple"),
                flag("--format", "json"),
                flag("--as", "user"),
              ]);
              const fetchedPayload = parseJsonLoose(fetched.stdout);
              const body = findFirst(fetchedPayload, ["content"]);
              if (typeof body === "string" && body.trim()) {
                const bodyHash = sha256(body);
                for (const chunk of splitTextChunks(body, Math.max(2000, config.collection.maxEvidenceChars - 1000))) {
                  const bodyEvidence = store.addEvidence({
                    sourceId: source.id,
                    kind: "feishu_document_content",
                    occurredAt: timestampIso(document.editTime),
                    title: `${document.title ?? token} [${chunk.index + 1}]`,
                    content: safeEvidenceText(chunk.text, config.collection.maxEvidenceChars),
                    sourceLocator: `${document.url ?? `feishu://document/${token}`}#chars=${chunk.start}-${chunk.end}`,
                    externalId: `${token}:${bodyHash}:${chunk.index}`,
                    fingerprint: sha256(`feishu-document-content-v1:${token}:${bodyHash}:${chunk.index}`),
                    metadata: { token, docType, url: document.url, bodyHash, chunkIndex: chunk.index },
                  });
                  if (bodyEvidence.inserted) {
                    metrics.evidence += 1;
                    metrics.documentContentEvidence += 1;
                  }
                }
                store.setSetting(bodySetting, bodyVersion);
                metrics.documentBodies += 1;
              }
            } catch (error) {
              recordError(`document:${token}`, error);
              documentBodyDisabled = true;
            }
          }
        }
        pages += 1;
        const hasMore = Boolean(findFirst(payload, ["has_more"]));
        const nextToken = findFirst(payload, ["page_token", "next_page_token"]);
        if (!hasMore || !nextToken || nextToken === pageToken) {
          pageToken = "";
          break;
        }
        pageToken = String(nextToken);
      }
      if (!options.resetDrivePage) store.setSetting("feishu.drive_page_token", pageToken);
      metrics.successfulSections.push("drive");
    } catch (error) {
      recordError("drive", error);
    }
  }

  metrics.missingScopes = [...new Set(metrics.missingScopes)].sort();
  if (metrics.missingScopes.length) {
    store.addTask({
      fingerprint: `feishu-scope-auth:${metrics.missingScopes.join(" ")}`,
      title: "补充影子 Agent 飞书只读权限",
      description: `缺少只读 scope：${metrics.missingScopes.join(", ")}。完成增量授权后重新运行采集。`,
      status: "waiting_user",
      priority: "high",
      riskLevel: "external-auth",
      actionType: "authorize_feishu_scopes",
      domain: "agent_maintenance",
      metadata: { scopes: metrics.missingScopes },
    });
  } else if (["messages", "drive", "tasks", "approvals"].every(section => metrics.successfulSections.includes(section)) && !metrics.errors.length) {
    const scopeTasks = store.db.prepare("SELECT id FROM tasks WHERE action_type='authorize_feishu_scopes' AND status NOT IN ('done','cancelled')").all();
    for (const task of scopeTasks) store.updateTask(task.id, { status: "done", result: "飞书只读 scope 已验证。" });
  }

  metrics.authenticated = metrics.successfulSections.length > 0;
  if (metrics.authenticated) {
    const oldAuthTask = store.db.prepare("SELECT id FROM tasks WHERE fingerprint='feishu-user-auth-v1'").get();
    if (oldAuthTask) store.updateTask(oldAuthTask.id, { status: "done", result: "飞书用户身份实际读取成功。" });
  }
  if (metrics.successfulSections.length) store.updateSourceCursor("feishu:user", {
    cursorBytes: metrics.messages + metrics.documents + metrics.approvals + metrics.tasks,
    sizeBytes: 0,
    mtimeMs: Date.now(),
    status: feishuCollectionState(metrics),
    lastError: metrics.errors.length ? JSON.stringify(metrics.errors) : null,
  });
  else store.upsertSource({ sourceKey: "feishu:user", kind: "feishu", uri: "feishu://current-user",
    metadata: JSON.parse(source.metadata_json || "{}"),
    status: feishuCollectionState(metrics), lastError: metrics.errors.length ? JSON.stringify(metrics.errors) : null });
  return metrics;
}
