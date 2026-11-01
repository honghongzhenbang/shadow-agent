import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  prepareCapability, publishCapability, recordCapabilityProbe, rollbackCapability, serverDefinition, digest,
} from "../src/openclaw/capability-release.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" }, manifest: { type: "string" }, proposal: { type: "string" },
    "authorization-evidence": { type: "string" }, "trust-server": { type: "boolean", default: false },
  },
});
const action = positionals[0];
if (positionals.length !== 1 || !["prepare", "probe", "publish", "rollback", "recover", "status"].includes(action) || !values.proposal) {
  throw new Error("Usage: manage-mcp-capability.mjs prepare|probe|publish|rollback|status --proposal PATH [--manifest PATH] [--config PATH]");
}
const configPath = path.resolve(values.config || process.env.OPENCLAW_CONFIG_PATH
  || path.join(root, "runtime", "openclaw-poc", "state", "openclaw.json"));
const proposalPath = path.resolve(values.proposal);
if (proposalPath === configPath) throw new Error("Proposal must not replace runtime config");
const read = (name) => JSON.parse(fs.readFileSync(name, "utf8").replace(/^\uFEFF/, ""));
function writeAtomic(name, value) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  const tmp = `${name}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, name);
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function probe(draft) {
  if (!values["trust-server"]) throw new Error("Probe can execute server code/contact its endpoint. Review it, then use --trust-server");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-mcp-probe-"));
  try {
    const probeConfig = path.join(dir, "openclaw.json");
    writeAtomic(probeConfig, { mcp: { servers: { [draft.candidate.name]: serverDefinition(draft.candidate, true) } } });
    const entry = path.join(root, "tools", "openclaw-runtime", "node_modules", "openclaw", "openclaw.mjs");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "mcp", "probe", draft.candidate.name, "--json"], {
        cwd: root, windowsHide: true, shell: false,
        env: { ...process.env, OPENCLAW_CONFIG_PATH: probeConfig, OPENCLAW_STATE_DIR: dir, OPENCLAW_HOME: dir, OPENCLAW_NO_RESPAWN: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let overflow = false;
      let timedOut = false;
      const kill = () => {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false }).on("error", () => child.kill());
        } else child.kill("SIGKILL");
      };
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) { overflow = true; kill(); }
      });
      // Diagnostics can contain vendor secrets. The receipt keeps only counts and exit status.
      child.stderr.resume();
      const timer = setTimeout(() => { timedOut = true; kill(); }, 180000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut || overflow) return resolve({ exitCode: 1, diagnostics: ["probe-incomplete"], tools: [] });
        try { resolve({ ...JSON.parse(stdout), exitCode }); }
        catch { resolve({ exitCode: 1, diagnostics: ["invalid-native-probe-output"], tools: [] }); }
      });
    });
    return recordCapabilityProbe(draft, result);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Serialize our writers; a write-ahead intent makes a process crash inspectable.
fs.mkdirSync(path.dirname(proposalPath), { recursive: true });
const lockPath = `${configPath}.capability.lock`;
let lock;
try {
  if (action !== "status") lock = fs.openSync(lockPath, "wx");
  if (action === "prepare") {
    if (!values.manifest || fs.existsSync(proposalPath)) throw new Error("Supply manifest and a new proposal path");
    writeAtomic(proposalPath, prepareCapability(read(values.manifest), read(configPath)));
  } else if (action === "probe") {
    const draft = await probe(read(proposalPath));
    writeAtomic(proposalPath, draft);
    if (!draft.probe.passed) process.exitCode = 1;
  } else if (action === "recover") {
    const intentPath = `${proposalPath}.intent.json`;
    const intent = read(intentPath);
    const currentHash = digest(read(configPath));
    if (currentHash === intent.afterHash) writeAtomic(proposalPath, intent.result);
    else if (currentHash !== intent.beforeHash) throw new Error("Config differs from both intent states; manual review required");
    fs.rmSync(intentPath);
  } else if (["publish", "rollback"].includes(action)) {
    const draft = read(proposalPath);
    const before = read(configPath);
    const result = action === "publish"
      ? publishCapability(draft, before, { authorizationEvidence: values["authorization-evidence"] || "" })
      : { config: rollbackCapability(draft, before), draft: { ...draft, publication: { ...draft.publication, rolledBackAt: new Date().toISOString() } } };
    const intentPath = `${proposalPath}.intent.json`;
    if (fs.existsSync(intentPath)) throw new Error("Unfinished publication intent exists; inspect it before retrying");
    writeAtomic(intentPath, { action, beforeHash: digest(before), afterHash: digest(result.config), result: result.draft });
    if (digest(read(configPath)) !== digest(before)) throw new Error("Runtime config changed during publication");
    writeAtomic(configPath, result.config);
    writeAtomic(proposalPath, result.draft);
    fs.rmSync(intentPath);
  }
  const draft = read(proposalPath);
  console.log(JSON.stringify({ name: draft.candidate.name, taskId: draft.candidate.taskId, probe: draft.probe, publication: draft.publication }, null, 2));
} finally {
  if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(lockPath, { force: true }); }
}
