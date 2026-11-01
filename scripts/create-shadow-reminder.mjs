import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { scheduleReminder } from "../src/reminders.mjs";

function argsToObject(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "inferred") result.explicit = false;
    else if (key === "json") result.json = true;
    else if (key === "noWake") result.noWake = true;
    else result[key] = args[++index];
  }
  return result;
}

const input = argsToObject(process.argv.slice(2));
if (!input.title || !input.dueAt) {
  console.error("Usage: create-shadow-reminder.mjs --title <text> --due-at <ISO with timezone> [--message <text>] [--source-locator <uri>] [--task-id <id>] [--inferred] --json");
  process.exit(2);
}

const config = loadConfig();
const store = openDatabase(config.paths.database);
try {
  const reminder = await scheduleReminder(store, config, input);
  process.stdout.write(`${JSON.stringify(reminder, null, input.json ? 2 : 0)}\n`);
} finally {
  store.close();
}
