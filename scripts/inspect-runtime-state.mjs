import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { feishuCapabilitySnapshot } from "../src/feishu-capabilities.mjs";

const config = loadConfig();
const store = openDatabase(config.paths.database);
try {
  const adapters = store.db.prepare(`
    SELECT key, value, updated_at FROM settings
    WHERE key LIKE 'runtime:feishu:event:%' OR key LIKE 'runtime:feishu:quick:%'
    ORDER BY key
  `).all();
  process.stdout.write(`${JSON.stringify({
    adapters,
    feishu: feishuCapabilitySnapshot(store, config),
    runtime: {
      phase: store.getSetting("runtime:context:phase"),
      detail: store.getSetting("runtime:context:detail"),
      heartbeat: store.getSetting("runtime:context:lastHeartbeat"),
    },
  }, null, 2)}\n`);
} finally {
  store.close();
}
