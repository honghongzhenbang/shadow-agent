import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../src/db.mjs";
import { resolveCliPath } from "../src/config.mjs";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-personalization-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI location comes from explicit configuration or PATH, never a developer drive", (t) => {
  const directory = temporary(t);
  const executable = path.join(directory, "lark-cli.ps1");
  fs.writeFileSync(executable, "# fixture");
  assert.equal(resolveCliPath("lark-cli.ps1", directory), executable);
  assert.equal(resolveCliPath(executable, ""), executable);
  assert.equal(resolveCliPath("missing-cli.ps1", directory), "missing-cli.ps1");
  const defaults = JSON.parse(fs.readFileSync("config/agent.json", "utf8"));
  assert.equal(defaults.feishu.cliPath, "lark-cli.ps1");
});

test("retired work focus importer cannot create a second profile authority", (t) => {
  const directory = temporary(t);
  const database = path.join(directory, "context.sqlite");
  const run = spawnSync(process.execPath, ["scripts/bootstrap-work-focus.mjs", "--apply"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, SHADOW_AGENT_DATABASE: database },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Independent work-focus imports are retired/);
  assert.equal(fs.existsSync(database), false);
});

test("team profile command cannot silently choose the developer's private source", (t) => {
  const directory = temporary(t);
  const output = path.join(directory, "profile.json");
  const run = spawnSync(process.execPath, ["scripts/build-team-cognitive-profile.mjs", "--output", output], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--source FILE --owner NAME --profile-id/);
  assert.equal(fs.existsSync(output), false);
});

test("runtime policy and import helpers do not contain developer-specific defaults", () => {
  for (const file of ["src/team-profile.mjs", "scripts/bootstrap-work-focus.mjs",
    "scripts/build-team-cognitive-profile.mjs", "scripts/verify-team-cognitive-profile.mjs", "config/agent.json"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /示例人员19|示例公司|ExampleUser|e94bc17ff43fc8f57e3fae4f2aad936f|E:\\\\DevTools/i, file);
  }
});
