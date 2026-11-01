import { loadConfig } from "../src/config.mjs";
import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { openDatabase } from "../src/db.mjs";
import { runOpenClawCli } from "../src/openclaw/cli.mjs";
import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from "../src/openclaw/gateway-client.mjs";
import { sha256 } from "../src/utils.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retryDatabaseLock(operation, attempts = 20) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return operation(); }
    catch (error) {
      if (!String(error.message).includes("database is locked") || attempt === attempts) throw error;
      await sleep(Math.min(2000, 100 * (2 ** Math.min(5, attempt - 1))));
    }
  }
  return null;
}

const config = loadConfig();
const store = openDatabase(config.paths.database);
const suffix = `hybrid-smoke-${Date.now()}`;
const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(config.projectRoot));
let reminderId = null;
let watchId = null;
let cronJobId = null;
try {
  await client.connect();
  await client.invokeTool("shadow_reminder_create", {
    idempotencyKey: `reminder:${suffix}`,
    title: "混合架构冒烟测试",
    message: "仅用于验证可靠调度，测试结束前会删除。",
    dueAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    sourceLocator: `shadow-agent://test/${suffix}`,
    explicit: true,
  });
  const reminder = store.db.prepare("SELECT * FROM reminders WHERE idempotency_key=?").get(`reminder:${suffix}`);
  if (!reminder) throw new Error("Reminder tool did not persist an intent.");
  reminderId = reminder.id;
  const outbox = await processControllerOutbox(store, config, { limit: 5 });
  const scheduled = store.reminder(reminder.id);
  if (scheduled.status !== "scheduled" || !scheduled.cron_job_id) throw new Error("Reminder did not reach scheduled state.");
  cronJobId = scheduled.cron_job_id;

  await client.invokeTool("shadow_condition_watch", {
    idempotencyKey: `condition:${suffix}`,
    title: "混合架构冒烟条件",
    conditionText: "仅匹配本测试生成的证据",
    selector: { sourceLocatorPrefixes: [`shadow-agent://test/${suffix}`] },
    sessionKey: `agent:main:${suffix}`,
  });
  const watch = store.db.prepare("SELECT * FROM condition_watches WHERE idempotency_key=?").get(`condition:${suffix}`);
  if (!watch) throw new Error("Condition tool did not persist a watch.");
  watchId = watch.id;
  const source = store.upsertSource({
    sourceKey: `shadow-agent:test:${suffix}`,
    kind: "test",
    uri: `shadow-agent://test/${suffix}`,
  });
  const evidence = store.addEvidence({
    sourceId: source.id,
    kind: "shadow_agent_task_result",
    title: "混合架构冒烟证据",
    content: "条件候选已生成。",
    sourceLocator: `shadow-agent://test/${suffix}/evidence`,
    externalId: suffix,
    fingerprint: sha256(suffix),
    metadata: { smokeTest: true },
  });
  const { evaluateConditionWatches } = await import("../src/condition-watches.mjs");
  const evaluated = evaluateConditionWatches(store, { limit: 5, evidenceLimit: 20 });
  const candidate = store.conditionWatch(watch.id);
  if (candidate.status !== "candidate") throw new Error("Condition did not reach candidate state.");
  let wakeSession = null;
  const conditionOutbox = await processControllerOutbox(store, config, {
    limit: 5,
    dependencies: { wake: async (_root, _text, sessionKey) => { wakeSession = sessionKey; } },
  });
  if (wakeSession !== `agent:main:${suffix}`) throw new Error("Condition did not preserve its stable session key.");

  process.stdout.write(`${JSON.stringify({
    passed: true,
    reminder: { id: reminder.id, status: scheduled.status, cronJobId },
    condition: { id: watch.id, status: candidate.status, evidenceId: evidence.id },
    outbox,
    conditionOutbox,
    evaluated,
  }, null, 2)}\n`);
} finally {
  client.stop();
  if (cronJobId) await runOpenClawCli(config.projectRoot, ["cron", "rm", cronJobId, "--json"], { timeoutMs: 30000, check: false });
  await retryDatabaseLock(() => store.transaction(() => {
    if (reminderId) store.db.prepare("DELETE FROM controller_outbox WHERE payload_json LIKE ?").run(`%${reminderId}%`);
    if (watchId) store.db.prepare("DELETE FROM controller_outbox WHERE payload_json LIKE ?").run(`%${watchId}%`);
    if (watchId) store.db.prepare("DELETE FROM condition_watches WHERE id=?").run(watchId);
    if (reminderId) store.db.prepare("DELETE FROM reminders WHERE id=?").run(reminderId);
    store.db.prepare("DELETE FROM evidence WHERE metadata_json LIKE '%\"smokeTest\":true%'").run();
    store.db.prepare("DELETE FROM sources WHERE source_key LIKE 'shadow-agent:test:hybrid-smoke-%'").run();
  }));
  store.close();
}
