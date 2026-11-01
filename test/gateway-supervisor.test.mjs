import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

test("supervisor tolerates short congestion and journals recovery reasons", { skip: process.platform !== "win32" }, () => {
  const library = path.resolve("scripts/openclaw-gateway-lib.ps1").replaceAll("'", "''");
  const script = `
    . '${library}'
    $OpenClawLogDirectory = Join-Path ([IO.Path]::GetTempPath()) ('shadow-health-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $OpenClawLogDirectory | Out-Null
    try {
      $short = Test-OpenClawRestartDue -Failures 3 -Threshold 3 -UnhealthySeconds 45 -MinimumSeconds 120
      $stalled = Test-OpenClawRestartDue -Failures 8 -Threshold 3 -UnhealthySeconds 121 -MinimumSeconds 120
      Write-OpenClawGatewayEvent 'health_failed' @{ pid = 123; failure = 'Timeout' }
      $entry = Get-Content -LiteralPath (Join-Path $OpenClawLogDirectory 'supervisor-events.jsonl') | ConvertFrom-Json
      @{ short=$short; stalled=$stalled; event=$entry.event; reason=$entry.data.failure } | ConvertTo-Json -Compress
    } finally {
      Remove-Item -LiteralPath (Join-Path $OpenClawLogDirectory 'supervisor-events.jsonl') -Force
      Remove-Item -LiteralPath $OpenClawLogDirectory
    }
  `;
  const output = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }));
  assert.deepEqual(output, { short: false, stalled: true, event: "health_failed", reason: "Timeout" });
});

test("diagnostic file contention does not stop supervision or mask invalid calls", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-diagnostic-io-"));
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.resolve("test/fixtures/gateway-diagnostic-io.ps1"),
      "-Library", path.resolve("scripts/openclaw-gateway-lib.ps1"), "-Root", root,
    ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    const result = JSON.parse(output);
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 11);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
