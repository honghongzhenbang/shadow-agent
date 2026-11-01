import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";
import { ATTENTION_SCHEDULE_SETTING_KEY } from "../../src/attention-window.mjs";
import { openDatabase } from "../../src/db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const evidenceRoot = path.join(projectRoot, "runtime", "pet-evidence");
const databasePath = path.join(evidenceRoot, "pet-settings-e2e.sqlite");
fs.mkdirSync(evidenceRoot, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });

const executablePath = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const mainPath = path.join(projectRoot, "desktop", "main.mjs");
const app = await electron.launch({
  executablePath,
  args: [mainPath, "--open-attention-settings"],
  cwd: projectRoot,
  env: {
    ...process.env,
    SHADOW_AGENT_DATABASE: databasePath,
    SHADOW_PET_E2E: "1",
  },
});

try {
  const existingWindows = app.windows();
  let settings = null;
  for (const page of existingWindows) {
    if ((await page.title()) === "自动巡检设置") {
      settings = page;
      break;
    }
  }
  settings ??= await app.waitForEvent("window", {
    predicate: async (page) => (await page.title()) === "自动巡检设置",
  });
  await settings.waitForLoadState("domcontentloaded");
  assert.equal(await settings.locator("#enabled").isChecked(), true);
  assert.equal(await settings.locator("#startTime").inputValue(), "08:00");
  assert.equal(await settings.locator("#endTime").inputValue(), "19:00");

  await settings.locator("#startTime").fill("09:15");
  await settings.locator("#endTime").fill("18:30");
  await settings.locator("#scheduleForm").evaluate((form) => form.requestSubmit());
  // The schedule event can render after the submit reply and replace its transient success text.
  await settings.waitForFunction(async () => {
    const { schedule } = await window.shadowPet.attentionSchedule();
    return schedule.enabled && schedule.start === "09:15" && schedule.end === "18:30";
  });
  assert.notEqual(await settings.locator("#statusText").getAttribute("data-state"), "error");
  await settings.screenshot({ path: path.join(evidenceRoot, "pet-attention-settings.png") });

  const bounds = await settings.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.ok(bounds.scrollWidth <= bounds.width, JSON.stringify(bounds));
  assert.ok(bounds.scrollHeight <= bounds.height, JSON.stringify(bounds));
} finally {
  await app.close();
}

const store = openDatabase(databasePath);
try {
  assert.deepEqual(JSON.parse(store.getSetting(ATTENTION_SCHEDULE_SETTING_KEY)), {
    enabled: true,
    start: "09:15",
    end: "18:30",
  });
} finally {
  store.close();
}

process.stdout.write("PET_ATTENTION_SETTINGS_OK\n");
