import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { deliverReminder } from "../src/reminders.mjs";

const reminderId = process.argv[2];
if (!reminderId) {
  console.error("Usage: fire-shadow-reminder.mjs <reminder-id>");
  process.exit(2);
}

const config = loadConfig();
const store = openDatabase(config.paths.database);
try {
  const reminder = await deliverReminder(store, config, reminderId);
  process.stdout.write(`${JSON.stringify({ id: reminder.id, status: reminder.status, deliveredAt: reminder.delivered_at })}\n`);
} finally {
  store.close();
}
