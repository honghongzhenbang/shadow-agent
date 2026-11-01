import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new OpenClawGatewayClient({
  ...loadOpenClawGatewaySettings(projectRoot),
  autoReconnect: true,
});
const timeline = [];
let wasConnected = false;
let connectedCount = 0;
let sawDisconnect = false;

client.on("status", (status) => {
  timeline.push({ at: new Date().toISOString(), ...status });
  if (status.connected && !wasConnected) connectedCount += 1;
  if (!status.connected && wasConnected) sawDisconnect = true;
  wasConnected = status.connected;
});

await client.start();
console.log("RECONNECT_PROBE_READY");

const deadline = Date.now() + 240_000;
while (Date.now() < deadline && !(sawDisconnect && connectedCount >= 2)) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const passed = sawDisconnect && connectedCount >= 2;
const evidenceDirectory = path.join(projectRoot, "runtime", "openclaw-poc", "evidence");
const evidencePath = path.join(
  evidenceDirectory,
  `reconnect-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`,
);
const summary = { passed, connectedCount, sawDisconnect, timeline, evidencePath };
fs.writeFileSync(evidencePath, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
client.stop();
if (!passed) process.exitCode = 1;
