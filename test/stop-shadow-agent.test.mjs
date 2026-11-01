import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('shutdown process-tree helper accepts already stopped background services', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../scripts/stop-shadow-agent.ps1', import.meta.url)).replaceAll("'", "''");
  // Load only the pure helper, never run the operational shutdown script in tests.
  const command = `$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$null,[ref]$null)
$helper=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ShadowProcessTree'},$true)
Invoke-Expression $helper.Extent.Text
$tree=@(Get-ShadowProcessTree -AllProcesses @() -RootProcesses @())
if($tree.Count -ne 0){throw 'Expected empty process tree'}
Write-Output 'empty-ok'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /empty-ok/);
});
