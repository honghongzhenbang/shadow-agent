import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const shared = ['knowledge-policy.mjs', 'task-progress-plan.mjs', 'user-profile-view.mjs',
  'context-delivery.mjs', 'utils.mjs', 'graph-model.mjs', 'task-owner.mjs', 'work-sessions.mjs',
  'information-delivery.mjs', 'active-information.mjs', 'operation-delivery-view.mjs'];

test('isolated installation imports the plugin and minimal shared closure without application DB or reverse plugin imports', {
  skip: process.platform !== 'win32' ? 'The installer is a Windows PowerShell script.' : false,
}, async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shadow-plugin-deployment-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('shadow-plugin-deployment-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  const installer = path.join(scripts, 'install-shadow-context-plugin.ps1');
  fs.copyFileSync(path.join(repository, 'scripts', path.basename(installer)), installer);
  fs.mkdirSync(path.join(root, 'src'));
  for (const name of shared) fs.copyFileSync(path.join(repository, 'src', name), path.join(root, 'src', name));
  fs.cpSync(path.join(repository, 'openclaw', 'shadow-work'), path.join(root, 'openclaw', 'shadow-work'), { recursive: true });

  // The unchanged installer derives every target from its temporary PSScriptRoot.
  // Never execute the repository's installer or create its production runtime tree.
  const installed = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const state = path.join(root, 'runtime', 'openclaw-poc', 'state');
  const deployedShared = path.join(state, 'src');
  assert.deepEqual(fs.readdirSync(deployedShared).sort(), [...shared].sort());
  for (const name of shared) assert.equal(fs.readFileSync(path.join(deployedShared, name), 'utf8'),
    fs.readFileSync(path.join(repository, 'src', name), 'utf8'));
  for (const name of ['db.mjs', 'agent-operations.mjs', 'context-graph.mjs', 'source-records.mjs', 'operation-delivery-feedback.mjs']) {
    assert.equal(fs.existsSync(path.join(deployedShared, name)), false);
  }
  const imports = [];
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'openclaw/plugin-sdk/tool-plugin') return {
      shortCircuit: true,
      url: 'data:text/javascript,export function defineToolPlugin(x){return Object.assign(x,{register(api){for(const tool of x.tools(v=>v))api.registerTool(tool);}});}',
    };
    if (specifier === 'openclaw/plugin-sdk/core') return {
      shortCircuit: true,
      url: "data:text/javascript,export function delegateCompactionToRuntime(){throw new Error('Live runtime is forbidden in deployment tests');}",
    };
    if (specifier.startsWith('openclaw/')) throw new Error(`Unexpected eager SDK import: ${specifier}`);
    const result = next(specifier, context);
    if (result.url.startsWith('file:')) {
      const resolved = fileURLToPath(result.url);
      const relative = path.relative(state, resolved);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `Import escaped deployment: ${resolved}`);
      imports.push(relative.replaceAll(path.sep, '/'));
    }
    return result;
  } });
  try {
    const owner = await import(pathToFileURL(path.join(deployedShared, 'task-owner.mjs')).href);
    assert.equal(typeof owner.resolveTaskOwnerForDatabase, 'function');
    const entry = await import(pathToFileURL(path.join(state, 'extensions', 'shadow-work', 'src', 'index.js')).href);
    const tools = [], hooks = [];
    entry.default.register({ pluginConfig: { databasePath: path.join(root, 'must-not-open.sqlite') },
      registerTool: (definition, options) => tools.push(options?.name ?? definition.name),
      on: name => hooks.push(name), registerContextEngine() {}, logger: { warn() {} },
    });
    assert.ok(tools.includes('shadow_information_dispatch'));
    assert.ok(tools.includes('shadow_task_checkpoint'));
    assert.ok(hooks.includes('after_tool_call'));
    assert.ok(hooks.includes('agent_end'));
    assert.equal(fs.existsSync(path.join(root, 'must-not-open.sqlite')), false);
    assert.ok(imports.includes('src/task-owner.mjs'));
    assert.ok(imports.includes('src/information-delivery.mjs'));
    assert.ok(imports.includes('src/active-information.mjs'));
    assert.ok(imports.includes('src/operation-delivery-view.mjs'));
  } finally { hook.deregister(); }
});
