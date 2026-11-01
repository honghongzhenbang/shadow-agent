#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.KIMI_CODE_HOME;
const indexPath = path.join(home, "fake-sessions.json");
fs.mkdirSync(home, { recursive: true });
const read = () => {
  try { return JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch { return []; }
};
const write = (value) => fs.writeFileSync(indexPath, JSON.stringify(value), "utf8");
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

if (args[0] === "--version") {
  console.log("2.2.0-fake");
  process.exit(0);
}
if (args[0] === "doctor") {
  console.log("fake doctor ok");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify(read()));
  process.exit(0);
}

const prompt = value("--prompt") ?? "";
if (prompt.includes("FAIL")) {
  console.error("controlled failure");
  process.exit(7);
}
if (prompt.includes("TIMEOUT")) await new Promise((resolve) => setTimeout(resolve, 5000));

const requestedSession = value("--session");
const sessions = read();
const sessionId = requestedSession || `session-${Date.now()}`;
if (requestedSession && !sessions.some((item) => item.sessionId === requestedSession)) {
  console.error("unknown session");
  process.exit(8);
}
if (!requestedSession) sessions.unshift({ sessionId, updatedAt: new Date().toISOString(), cwd: process.cwd() });
else sessions.find((item) => item.sessionId === sessionId).updatedAt = new Date().toISOString();
write(sessions);
const output = path.join(process.cwd(), "fake-result.txt");
fs.appendFileSync(output, `${requestedSession ? "resume" : "start"}:${prompt}\n`, "utf8");
console.log(JSON.stringify({ role: "assistant", content: `done:${sessionId}` }));
