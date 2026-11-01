import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { cancelReminder } from "../src/reminders.mjs";
import { nowIso } from "../src/utils.mjs";

const ACTIVE_STATUSES = new Set([
  "pending_schedule",
  "schedule_failed",
  "scheduled",
  "notification_pending",
  "delivered",
]);
const LEGACY_CREATORS = new Set(["shadow-agent", "main", "openclaw-main"]);

function parseMetadata(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function isLegacyInternalReview(row) {
  const metadata = parseMetadata(row.metadata_json);
  return ACTIVE_STATUSES.has(row.status)
    && Number(row.explicit) === 0
    && Boolean(row.task_id)
    && String(row.title || "").trim().startsWith("复查")
    && metadata.purpose !== "user_notification"
    && LEGACY_CREATORS.has(String(metadata.createdBy || ""));
}

function groupByTask(rows) {
  const groups = new Map();
  for (const row of rows) {
    const current = groups.get(row.task_id) ?? [];
    current.push(row);
    groups.set(row.task_id, current);
  }
  return groups;
}

const apply = process.argv.includes("--apply");
const config = loadConfig();
const store = openDatabase(config.paths.database);

try {
  const candidates = store.db.prepare(`
    SELECT * FROM reminders
    WHERE task_id IS NOT NULL AND explicit=0
    ORDER BY task_id, due_at, created_at
  `).all().filter(isLegacyInternalReview);
  const groups = groupByTask(candidates);
  const preview = [...groups.entries()].map(([taskId, reminders]) => ({
    taskId,
    nextReviewAt: reminders.map((item) => item.due_at).sort()[0],
    reminders: reminders.map((item) => ({
      id: item.id,
      title: item.title,
      dueAt: item.due_at,
      status: item.status,
      cronJobId: item.cron_job_id,
    })),
  }));

  if (!apply || candidates.length === 0) {
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, tasks: groups.size, preview }, null, 2));
    process.exitCode = 0;
  } else {
    const missingAttention = [...groups.keys()].filter((taskId) => !store.db.prepare(
      "SELECT 1 FROM work_task_attention WHERE card_id=?",
    ).get(taskId));
    if (missingAttention.length) {
      throw new Error(`Missing work_task_attention rows: ${missingAttention.join(", ")}`);
    }

    const migratedAt = nowIso();
    store.transaction(() => {
      const updateAttention = store.db.prepare(`
        UPDATE work_task_attention SET
          next_review_at=?,
          continuation_kind='progress_review',
          continuation_reference_id=?,
          updated_by='v4.8.3-reminder-migration',
          updated_at=?
        WHERE card_id=?
      `);
      for (const [taskId, reminders] of groups) {
        const nextReviewAt = reminders.map((item) => item.due_at).sort()[0];
        const reference = `migrated-internal-review:${reminders.map((item) => item.id).sort().join(",")}`;
        updateAttention.run(nextReviewAt, reference, migratedAt, taskId);
      }
    });

    const cancelled = [];
    for (const reminder of candidates) {
      const result = await cancelReminder(store, config, reminder.id);
      cancelled.push({
        id: result.id,
        taskId: result.task_id,
        status: result.status,
        cronJobId: result.cron_job_id,
        lastError: result.last_error,
      });
    }
    console.log(JSON.stringify({
      mode: "apply",
      migratedAt,
      candidates: candidates.length,
      tasks: groups.size,
      preview,
      cancelled,
    }, null, 2));
  }
} finally {
  store.close();
}
