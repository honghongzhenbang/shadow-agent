import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// The public SDK resolves a store selector, not its database. Reuse the host's
// own target resolver (including custom-store ownership), never guess a path.
export async function resolveNativeSessionDatabase(config, sessionKey, {
  env = process.env, sdkUrl = import.meta.resolve('openclaw/plugin-sdk/session-store-paths'),
} = {}) {
  const sdkDir = path.dirname(fileURLToPath(sdkUrl));
  const scope = await import(pathToFileURL(path.join(sdkDir, 'agent-scope-runtime.js')).href);
  const stores = await import(sdkUrl);
  const agentId = scope.resolveSessionAgentIdStrict({ sessionKey, config });
  const storePath = stores.resolveStorePath(config.session?.store, { agentId, env });
  const dist = path.dirname(sdkDir);
  const matches = fs.readdirSync(dist).filter(name => /^session-sqlite-target-[\w-]+\.js$/.test(name));
  if (matches.length !== 1) throw new Error('Native session target resolver is unavailable or ambiguous');
  const module = await import(pathToFileURL(path.join(dist, matches[0])).href);
  const resolvers = Object.values(module).filter(value => typeof value === 'function'
    && value.name === 'resolveSqliteTargetFromSessionStorePath');
  if (resolvers.length !== 1) throw new Error('Native session target resolver contract changed');
  const target = resolvers[0](storePath, { agentId, env });
  if (!target?.path || !path.isAbsolute(target.path)) throw new Error('Native session target is not absolute');
  return target.path;
}

export function readNativeSessionId(filename, sessionKey) {
  if (!filename || !fs.existsSync(filename)) return null;
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const row = db.prepare(`SELECT current_session_id,entry_valid,archived_at,entry_json
      FROM session_nodes WHERE session_key=?`).get(sessionKey);
    if (!row || row.entry_valid !== 1 || row.archived_at != null) return null;
    const entry = JSON.parse(row.entry_json);
    return row.current_session_id && entry.sessionId === row.current_session_id ? row.current_session_id : null;
  } catch { return null; }
  finally { db?.close(); }
}
