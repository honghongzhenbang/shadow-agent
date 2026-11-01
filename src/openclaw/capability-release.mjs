import crypto from "node:crypto";

export const PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

export function validateCapability(candidate) {
  exactKeys(candidate, ["name", "taskId", "purpose", "tools", "server"], "capability");
  if (JSON.stringify(candidate).length > 32768) throw new Error("Capability manifest exceeds 32 KiB");
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(candidate.name)) throw new Error("Use a lowercase MCP name without separators");
  for (const key of ["taskId", "purpose"]) {
    if (typeof candidate[key] !== "string" || !candidate[key].trim() || candidate[key].length > 500) {
      throw new Error(`${key} is required and bounded`);
    }
  }
  if (!Array.isArray(candidate.tools) || !candidate.tools.length || candidate.tools.length > 64
      || candidate.tools.some((name) => typeof name !== "string" || !/^[\w.-]{1,128}$/.test(name))
      || new Set(candidate.tools).size !== candidate.tools.length) {
    throw new Error("Select 1-64 distinct exact tool names; wildcards are not allowed");
  }
  const server = candidate.server;
  exactKeys(server, ["command", "args", "cwd", "env", "url", "transport", "headers", "auth", "oauth",
    "requestTimeoutMs", "connectionTimeoutMs"], "server");
  if (Boolean(server.command) === Boolean(server.url)) throw new Error("Choose command or URL, not both");
  if (server.command) {
    if (typeof server.command !== "string" || /[\r\n]/.test(server.command)) throw new Error("Invalid command");
    if (server.transport || server.headers || server.auth || server.oauth) throw new Error("HTTP fields on stdio server");
    if (server.args && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) {
      throw new Error("args must be a string array");
    }
  } else {
    const url = new URL(server.url);
    if (url.username || url.password || url.search || url.hash) throw new Error("Credentials/query/fragment are not allowed in MCP URLs");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("Remote MCP requires HTTPS; HTTP is allowed only on loopback");
    }
    if (server.command || server.args || server.cwd || server.env) throw new Error("stdio fields on HTTP server");
    if (!["streamable-http", "sse"].includes(server.transport)) throw new Error("Specify an HTTP transport");
    if (server.auth && server.auth !== "oauth") throw new Error("Unsupported auth method");
    if (server.oauth) {
      exactKeys(server.oauth, ["identity", "scope"], "oauth");
      if (server.oauth.identity && server.oauth.identity !== "shared") {
        throw new Error("Per-requester OAuth requires a separate native deployment review");
      }
    }
  }
  for (const key of ["env", "headers"]) {
    if (!server[key]) continue;
    exactKeys(server[key], Object.keys(server[key]), key);
    for (const value of Object.values(server[key])) {
      if (typeof value !== "string" || !/^(?:Bearer )?\$\{[A-Z][A-Z0-9_]*\}$/.test(value)) {
        throw new Error(`${key} values must reference environment variables, never inline credentials`);
      }
    }
  }
  for (const key of ["requestTimeoutMs", "connectionTimeoutMs"]) {
    if (server[key] !== undefined && (!Number.isInteger(server[key]) || server[key] < 100 || server[key] > 120000)) {
      throw new Error(`Invalid ${key}`);
    }
  }
  return structuredClone(candidate);
}

export function serverDefinition(candidate, enabled) {
  validateCapability(candidate);
  return {
    ...candidate.server,
    enabled,
    toolFilter: { include: candidate.tools },
    codex: { agents: ["main"], defaultToolsApprovalMode: "prompt" },
  };
}

export function prepareCapability(candidate, config, now = new Date()) {
  validateCapability(candidate);
  if (Object.hasOwn(config.mcp?.servers ?? {}, candidate.name)) throw new Error("MCP name already exists; do not overwrite it");
  if (!config.agents?.entries?.main) throw new Error("Main agent missing");
  return {
    schemaVersion: 1,
    candidate: structuredClone(candidate),
    candidateHash: digest(candidate),
    baseConfigHash: digest(config),
    createdAt: now.toISOString(),
    probe: null,
    publication: null,
  };
}

function verifyDraft(draft) {
  if (draft.schemaVersion !== 1 || digest(draft.candidate) !== draft.candidateHash) throw new Error("Candidate changed; prepare and probe again");
  validateCapability(draft.candidate);
}

export function recordCapabilityProbe(draft, result, now = new Date()) {
  verifyDraft(draft);
  if (draft.publication) throw new Error("Published proposal is immutable; create a new proposal");
  const expectedTools = draft.candidate.tools.map((name) => `${draft.candidate.name}__${name}`);
  const discoveredTools = Array.isArray(result.tools) ? result.tools.filter((name) => typeof name === "string") : [];
  const missingTools = expectedTools.filter((name) => !discoveredTools.includes(name));
  const passed = result.exitCode === 0 && Boolean(result.servers?.[draft.candidate.name])
    && (result.diagnostics?.length ?? 0) === 0 && missingTools.length === 0;
  return {
    ...draft,
    probe: {
      passed, at: now.toISOString(), candidateHash: draft.candidateHash,
      discoveredTools: discoveredTools.filter((name) => expectedTools.includes(name)), missingTools,
      diagnosticCount: result.diagnostics?.length ?? 0,
      exitCode: result.exitCode,
      proof: "native-mcp-connection-and-tool-list",
    },
  };
}

export function publishCapability(draft, config, { authorizationEvidence = "", now = new Date() } = {}) {
  verifyDraft(draft);
  if (draft.publication) throw new Error("Already published; use the saved receipt");
  if (digest(config) !== draft.baseConfigHash) throw new Error("Runtime config changed; prepare and probe against the latest config");
  const age = now.getTime() - Date.parse(draft.probe?.at);
  if (!draft.probe?.passed || draft.probe.candidateHash !== draft.candidateHash
      || !Number.isFinite(age) || age < 0 || age > PROBE_MAX_AGE_MS) throw new Error("A fresh successful probe is required");
  if (typeof authorizationEvidence !== "string" || authorizationEvidence.length > 500) throw new Error("Invalid authorization evidence reference");
  const enabled = Boolean(authorizationEvidence.trim());
  const next = structuredClone(config);
  next.mcp ??= {};
  next.mcp.servers ??= {};
  next.mcp.servers[draft.candidate.name] = serverDefinition(draft.candidate, enabled);
  const main = next.agents.entries.main;
  const previousAllowed = main.tools?.alsoAllow ?? [];
  const tools = enabled ? draft.candidate.tools.map((name) => `${draft.candidate.name}__${name}`) : [];
  const addedTools = tools.filter((name) => !previousAllowed.includes(name));
  if (enabled) {
    main.tools ??= {};
    main.tools.alsoAllow = [...new Set([...previousAllowed, ...addedTools])];
  }
  return {
    config: next,
    draft: {
      ...draft,
      publication: {
        at: now.toISOString(), enabled, authorizationEvidence: authorizationEvidence.trim(),
        serverHash: digest(next.mcp.servers[draft.candidate.name]), addedTools,
        proof: "configuration-published", runtimeVerified: false, businessVerified: false,
      },
    },
  };
}

export function rollbackCapability(draft, config) {
  verifyDraft(draft);
  if (!draft.publication || draft.publication.rolledBackAt) throw new Error("No active publication to roll back");
  const server = config.mcp?.servers?.[draft.candidate.name];
  if (!server || digest(server) !== draft.publication.serverHash) throw new Error("Published server changed; refusing to overwrite later edits");
  const next = structuredClone(config);
  delete next.mcp.servers[draft.candidate.name];
  const main = next.agents.entries.main;
  if (main.tools?.alsoAllow) {
    main.tools.alsoAllow = main.tools.alsoAllow.filter((name) => !draft.publication.addedTools.includes(name));
  }
  return next;
}
