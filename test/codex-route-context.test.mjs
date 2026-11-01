import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { bindCodexRouteHandlers } from '../src/openclaw/codex-route-context.mjs';
import { applyCodexRouteContext, patchCodexRouteContext } from '../scripts/apply-codex-route-context.mjs';

const root = path.resolve(import.meta.dirname, '..');
const callbacks = ['onRequest', 'onNotification', 'onNotificationReceived'];
const projectsRelative = 'runtime/openclaw-poc/state/npm/projects';
const helperRelative = 'src/openclaw/codex-route-context.mjs';
const helperName = 'shadow-codex-route-context.mjs';
const originalAssignment = '\t\troute.handlers = handlers;';
const boundAssignment = '\t\troute.handlers = bindCodexRouteHandlers(handlers);';
const routerFixture = [
  'class ClientTurnRouter {',
  '\tactivateNow(route, handlers) {',
  '\t\tif (route.handlers) throw new Error(`route already activated: ${route.threadId}`);',
  '\t\tthis.assertRoute(route);',
  '\t\tif (!handlers.onNotification && !handlers.onRequest) throw new Error("handler required");',
  originalAssignment,
  '\t\tif (!handlers.onNotification) route.pending.length = 0;',
  '\t\telse if (route.gate !== "armed") this.flushNotifications(route);',
  '\t\troute.activated.resolve();',
  '\t}',
  '}',
  '',
].join('\n');

for (const name of callbacks) {
  test(`${name}: snapshot restores multiple ALS stores and preserves this, args and sync results`, () => {
    const first = new AsyncLocalStorage();
    const second = new AsyncLocalStorage();
    const activation = { first: {}, second: {} };
    const transport = { first: {}, second: {} };
    const receiver = {};
    const args = [{}, Symbol('argument'), undefined];
    const result = {};
    let calls = 0;
    const handler = function (...actual) {
      calls += 1;
      assert.equal(this, receiver);
      assert.deepEqual(actual, args);
      assert.equal(first.getStore(), activation.first);
      assert.equal(second.getStore(), activation.second);
      return result;
    };
    const handlers = Object.freeze({ [name]: handler, metadata: {} });
    const bound = first.run(activation.first, () => second.run(activation.second,
      () => bindCodexRouteHandlers(handlers)));
    assert.notEqual(bound, handlers);
    assert.equal(bound.metadata, handlers.metadata);
    assert.equal(handlers[name], handler);
    first.run(transport.first, () => second.run(transport.second, () => {
      assert.equal(Reflect.apply(bound[name], receiver, args), result);
      assert.equal(calls, 1);
      assert.equal(first.getStore(), transport.first);
      assert.equal(second.getStore(), transport.second);
    }));
    assert.equal(first.getStore(), undefined);
    assert.equal(second.getStore(), undefined);
  });

  test(`${name}: rootless wrapping preserves synchronous exceptions and caller context`, () => {
    const context = new AsyncLocalStorage();
    const failure = new Error('same synchronous exception');
    const bound = bindCodexRouteHandlers({ [name]() {
      assert.equal(context.getStore(), undefined);
      throw failure;
    } });
    context.run('transport', () => {
      assert.throws(() => bound[name](), error => error === failure);
      assert.equal(context.getStore(), 'transport');
    });
  });

  test(`${name}: preserves Promise identity, rejection and async activation context`, async () => {
    const context = new AsyncLocalStorage();
    const activation = {};
    const receiver = {};
    const argument = {};
    const result = {};
    let promise;
    const bound = context.run(activation, () => bindCodexRouteHandlers({ [name]: function (value) {
      assert.equal(this, receiver);
      assert.equal(value, argument);
      promise = (async () => {
        await Promise.resolve();
        assert.equal(context.getStore(), activation);
        return result;
      })();
      return promise;
    } }));
    const returned = context.run('transport', () => Reflect.apply(bound[name], receiver, [argument]));
    assert.equal(returned, promise);
    assert.equal(await returned, result);
    const failure = new Error('same rejection');
    const rejected = Promise.reject(failure);
    const rejecting = bindCodexRouteHandlers({ [name]: () => rejected });
    assert.equal(rejecting[name](), rejected);
    await assert.rejects(rejected, error => error === failure);
  });
}

test('each binding captures its own activation, permits absent callbacks and does not log', t => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(name => t.mock.method(console, name, () => {}));
  const context = new AsyncLocalStorage();
  const handlers = Object.freeze({ onRequest: () => context.getStore(), onNotification: null,
    onNotificationReceived: undefined, metadata: {} });
  const first = context.run('first', () => bindCodexRouteHandlers(handlers));
  const second = context.run('second', () => bindCodexRouteHandlers(handlers));
  const rootless = bindCodexRouteHandlers(handlers);
  context.run('transport', () => {
    assert.equal(first.onRequest(), 'first');
    assert.equal(second.onRequest(), 'second');
    assert.equal(first.onRequest(), 'first');
    assert.equal(rootless.onRequest(), undefined);
    assert.equal(first.onNotification, null);
    assert.equal(first.onNotificationReceived, undefined);
    assert.equal(first.metadata, handlers.metadata);
  });
  assert.deepEqual(bindCodexRouteHandlers({}), {});
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test('patch changes only the guarded activateNow assignment, and is LF/CRLF idempotent', () => {
  const patched = patchCodexRouteContext(routerFixture);
  assert.ok(patched.endsWith(routerFixture.replace(originalAssignment, boundAssignment)));
  assert.match(patched, /import \{ bindCodexRouteHandlers \} from ["']\.\/shadow-codex-route-context\.mjs["'];/);
  assert.equal(patched.split(boundAssignment).length, 2);
  assert.equal(patchCodexRouteContext(patched), patched);
  assert.equal(patchCodexRouteContext(routerFixture.replaceAll('\n', '\r\n')), patched);
  assert.equal(patchCodexRouteContext(patched.replaceAll('\n', '\r\n')), patched);
});

test('patch rejects drift, ambiguity, out-of-method assignments and damaged prior patches', () => {
  const patched = patchCodexRouteContext(routerFixture);
  const invalid = [
    '', 'upstream layout changed', routerFixture.repeat(2),
    routerFixture.replace(originalAssignment, ''),
    routerFixture.replace(originalAssignment, `${originalAssignment}\n${originalAssignment}`),
    routerFixture.replace('activateNow(route, handlers)', 'activateLater(route, handlers)'),
    routerFixture.replace(originalAssignment, '') + `\nfunction unrelated(route, handlers) {\n${originalAssignment}\n}\n`,
    routerFixture + `\nfunction unrelated(route, handlers) {\n${originalAssignment}\n}\n`,
    routerFixture.replace(originalAssignment, boundAssignment),
    patched.replace(boundAssignment, originalAssignment),
    patched.replace('"./shadow-codex-route-context.mjs"', '"./unexpected.mjs"'),
    patched + routerFixture,
    '// shadow-codex-route-context-v1\n' + routerFixture,
  ];
  for (const [index, source] of invalid.entries())
    assert.throws(() => patchCodexRouteContext(source), /layout|activation|unsupported/i, `invalid layout ${index}`);
});

function makeFixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-route-context-'));
  t.after(() => {
    assert.equal(fs.realpathSync(path.dirname(sandbox)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(sandbox).startsWith('shadow-route-context-'));
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const fixtureRoot = path.join(sandbox, 'selected-root');
  const outside = path.join(sandbox, 'selected-root-outside');
  fs.mkdirSync(path.join(fixtureRoot, 'src/openclaw'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, projectsRelative), { recursive: true });
  fs.mkdirSync(outside);
  fs.copyFileSync(path.join(root, helperRelative), path.join(fixtureRoot, helperRelative));
  const add = (name, source = routerFixture) => {
    const project = path.join(fixtureRoot, projectsRelative, name);
    const dist = path.join(project, 'node_modules/@openclaw/codex/dist');
    fs.mkdirSync(dist, { recursive: true });
    const router = path.join(dist, 'attempt-client-cleanup-fixture.js');
    fs.writeFileSync(router, source);
    fs.writeFileSync(path.join(dist, 'index.js'), 'export const untouched = true;\n');
    return { project, dist, router, helper: path.join(dist, helperName) };
  };
  return { sandbox, root: fixtureRoot, outside, add };
}

// Do not follow links: the fixture includes sibling escape targets separately.
function treeSnapshot(directory) {
  const entries = [];
  const visit = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const relative = path.relative(directory, file);
      if (stat.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { entries.push([relative, 'directory']); visit(file); }
      else entries.push([relative, 'file', fs.readFileSync(file).toString('base64'), stat.mtimeNs, stat.mode]);
    }
  };
  visit(directory);
  return entries;
}

test('offline fixture installs all generations, repeats safely and repairs damaged helper copies', t => {
  const fixture = makeFixture(t);
  const first = fixture.add('openclaw-codex-a');
  const second = fixture.add('openclaw-codex-b', routerFixture.replaceAll('\n', '\r\n'));
  const unrelated = fixture.add('other-plugin', 'not a Codex router');
  const unrelatedBefore = treeSnapshot(unrelated.dist);
  const helper = fs.readFileSync(path.join(fixture.root, helperRelative));
  const sourceBefore = fs.statSync(path.join(fixture.root, helperRelative), { bigint: true }).mtimeNs;
  const installed = applyCodexRouteContext(fixture.root);
  assert.equal(installed.plugins, 2);
  assert.equal(installed.changed, 2);
  assert.equal(installed.helperSha256, createHash('sha256').update(helper).digest('hex'));
  const routerTimes = [first, second].map(target => fs.statSync(target.router, { bigint: true }).mtimeNs);
  for (const target of [first, second]) {
    assert.equal(fs.readFileSync(target.router, 'utf8'), patchCodexRouteContext(routerFixture));
    assert.deepEqual(fs.readFileSync(target.helper), helper);
    assert.equal(fs.readFileSync(path.join(target.dist, 'index.js'), 'utf8'), 'export const untouched = true;\n');
  }
  assert.equal(applyCodexRouteContext(fixture.root).changed, 0);
  fs.writeFileSync(first.helper, 'damaged helper');
  fs.unlinkSync(second.helper);
  const repaired = applyCodexRouteContext(fixture.root);
  assert.equal(repaired.changed, 0);
  assert.equal(repaired.plugins, 2);
  for (const [index, target] of [first, second].entries()) {
    assert.deepEqual(fs.readFileSync(target.helper), helper);
    assert.equal(fs.statSync(target.router, { bigint: true }).mtimeNs, routerTimes[index]);
  }
  assert.deepEqual(treeSnapshot(unrelated.dist), unrelatedBefore);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, helperRelative)), helper);
  assert.equal(fs.statSync(path.join(fixture.root, helperRelative), { bigint: true }).mtimeNs, sourceBefore);
});

for (const defect of ['layout drift', 'duplicate router', 'missing router', 'damaged patched layout']) {
  test(`all-file preflight makes zero writes on ${defect}`, t => {
    const fixture = makeFixture(t);
    const first = fixture.add('openclaw-codex-a');
    fs.writeFileSync(first.helper, 'must not repair before all layouts pass');
    const last = fixture.add('openclaw-codex-z');
    if (defect === 'layout drift') fs.writeFileSync(last.router, 'upstream changed');
    if (defect === 'duplicate router') fs.copyFileSync(last.router, path.join(last.dist, 'attempt-client-cleanup-extra.js'));
    if (defect === 'missing router') fs.unlinkSync(last.router);
    if (defect === 'damaged patched layout') fs.writeFileSync(last.router,
      patchCodexRouteContext(routerFixture).replace(boundAssignment, originalAssignment));
    const before = treeSnapshot(fixture.sandbox);
    assert.throws(() => applyCodexRouteContext(fixture.root));
    assert.deepEqual(treeSnapshot(fixture.sandbox), before);
  });
}

test('missing managed plugin and CLI without explicit root fail without modifying files', t => {
  const fixture = makeFixture(t);
  const before = treeSnapshot(fixture.sandbox);
  assert.throws(() => applyCodexRouteContext(fixture.root), /missing/i);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/apply-codex-route-context.mjs')],
    { cwd: fixture.root, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit.*root/i);
  assert.deepEqual(treeSnapshot(fixture.sandbox), before);
});

for (const boundary of ['projects', 'source helper directory', 'project', 'node_modules', 'package', 'dist', 'helper target']) {
  test(`junction escape at ${boundary} is rejected before any file is modified`, t => {
    const fixture = makeFixture(t);
    const first = fixture.add('openclaw-codex-a');
    fs.writeFileSync(first.helper, 'must remain damaged on failed preflight');
    const last = fixture.add('openclaw-codex-z');
    const locations = {
      projects: path.join(fixture.root, projectsRelative),
      'source helper directory': path.join(fixture.root, 'src/openclaw'),
      project: last.project,
      node_modules: path.join(last.project, 'node_modules'),
      package: path.join(last.project, 'node_modules/@openclaw/codex'),
      dist: last.dist,
      'helper target': last.helper,
    };
    const link = locations[boundary];
    const escaped = path.join(fixture.outside, 'payload');
    if (boundary === 'helper target') {
      fs.mkdirSync(escaped);
      fs.writeFileSync(path.join(escaped, 'sentinel'), 'outside must not change');
    } else fs.renameSync(link, escaped);
    fs.symlinkSync(escaped, link, process.platform === 'win32' ? 'junction' : 'dir');
    const before = treeSnapshot(fixture.sandbox);
    assert.throws(() => applyCodexRouteContext(fixture.root), /escape|outside|root/i);
    assert.deepEqual(treeSnapshot(fixture.sandbox), before);
  });
}

test('dangling helper junction is rejected before repairing or patching any earlier generation', t => {
  const fixture = makeFixture(t);
  const first = fixture.add('openclaw-codex-a');
  const last = fixture.add('openclaw-codex-z');
  fs.writeFileSync(first.helper, 'must remain damaged on failed preflight');
  const escaped = path.join(fixture.outside, 'missing-target');
  fs.symlinkSync(escaped, last.helper, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(last.helper), false);
  assert.equal(fs.lstatSync(last.helper).isSymbolicLink(), true);
  const before = treeSnapshot(fixture.sandbox);
  let failure;
  try { applyCodexRouteContext(fixture.root); } catch (error) { failure = error; }
  assert.deepEqual(treeSnapshot(fixture.sandbox), before, 'dangling links must fail during all-file preflight');
  assert.ok(failure, 'dangling outside-root junction must be rejected');
});

for (const boundary of ['source helper', 'router', 'existing helper', 'dangling helper']) {
  test(`file symlink escape at ${boundary} is rejected before any write`, t => {
    const fixture = makeFixture(t);
    const first = fixture.add('openclaw-codex-a');
    const last = fixture.add('openclaw-codex-z');
    fs.writeFileSync(first.helper, 'must remain damaged on failed preflight');
    const link = boundary === 'source helper' ? path.join(fixture.root, helperRelative)
      : boundary === 'router' ? last.router : last.helper;
    const escaped = path.join(fixture.outside, 'payload.mjs');
    if (fs.existsSync(link)) fs.renameSync(link, escaped);
    else if (boundary !== 'dangling helper') fs.writeFileSync(escaped, 'outside helper');
    try { fs.symlinkSync(escaped, link, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        t.skip('Windows file symlinks require privilege; junction coverage runs separately');
        return;
      }
      throw error;
    }
    const before = treeSnapshot(fixture.sandbox);
    let failure;
    try { applyCodexRouteContext(fixture.root); } catch (error) { failure = error; }
    assert.deepEqual(treeSnapshot(fixture.sandbox), before, 'rejection must precede writes, including dangling targets');
    assert.ok(failure, 'outside-root symlink must be rejected');
  });
}

const nativeDist = path.join(root, 'tools/openclaw-runtime/node_modules/openclaw/dist');
const nativeProjects = path.join(root, projectsRelative);

test('installed native router and admission guards with production candidate', {
  skip: !fs.existsSync(nativeDist) || !fs.existsSync(nativeProjects),
  concurrency: false,
  timeout: 15_000,
}, async t => {
  // Native admission stays real; only its test logging is disabled in this process.
  const environment = { VITEST: 'true', OPENCLAW_LOG_LEVEL: 'silent', OPENCLAW_TEST_FILE_LOG: '0', OPENCLAW_TEST_CONSOLE: '0' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const unique = (directory, pattern) => {
    const found = fs.readdirSync(directory).filter(name => pattern.test(name));
    assert.equal(found.length, 1, `Expected unique installed module ${pattern}`);
    return path.join(directory, found[0]);
  };
  const admissionFile = unique(nativeDist, /^gateway-work-admission-.*\.js$/);
  const sessionFiles = fs.readdirSync(nativeDist).filter(name => /^session-lifecycle-admission-.*\.js$/.test(name))
    .map(name => path.join(nativeDist, name))
    .filter(file => fs.readFileSync(file, 'utf8').includes('async function beginSessionWorkAdmission(params)'));
  assert.equal(sessionFiles.length, 1);
  const routerFiles = fs.readdirSync(nativeProjects).filter(name => name.startsWith('openclaw-codex-'))
    .map(name => path.join(nativeProjects, name, 'node_modules/@openclaw/codex/dist'))
    .filter(directory => fs.existsSync(directory))
    .map(directory => unique(directory, /^attempt-client-cleanup-.*\.js$/));
  assert.ok(routerFiles.length > 0, 'installed router required');
  const originalFiles = [admissionFile, ...sessionFiles, ...routerFiles].map(file => ({
    file, bytes: fs.readFileSync(file), mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
  }));
  t.after(() => {
    for (const original of originalFiles) {
      assert.deepEqual(fs.readFileSync(original.file), original.bytes, `read-only: ${original.file}`);
      assert.equal(fs.statSync(original.file, { bigint: true }).mtimeNs, original.mtimeNs);
    }
  });
  const admission = await import(pathToFileURL(admissionFile));
  const { n: beginSession } = await import(pathToFileURL(sessionFiles[0]));
  const state = globalThis[Symbol.for('openclaw.gatewayWorkAdmissionState')];
  assert.ok(state);
  const region = source => {
    const start = source.indexOf('//#region extensions/codex/src/app-server/turn-router.ts');
    const end = source.indexOf('//#endregion', start);
    assert.ok(start >= 0 && end > start, 'native router region must be intact');
    return source.slice(start, end);
  };
  const source = fs.readFileSync(routerFiles[0], 'utf8');
  for (const file of routerFiles) {
    const installed = fs.readFileSync(file, 'utf8');
    assert.equal(region(patchCodexRouteContext(installed)), region(installed).replace(originalAssignment, boundAssignment));
  }

  const setup = async (subtest, patched = true) => {
    admission.p();
    const roots = [];
    const routes = [];
    const warnings = [];
    const seen = Object.fromEntries(callbacks.map(name => [name, []]));
    const tag = new AsyncLocalStorage();
    const current = () => ({ root: state.currentRootWork.getStore(), tag: tag.getStore() });
    const createRoot = async () => {
      const lease = admission.C();
      assert.ok(lease);
      assert.equal(lease.ownsRoot, true);
      roots.push(lease);
      const token = await lease.run(() => state.currentRootWork.getStore());
      assert.equal(token.references, 1);
      return { ...lease, token };
    };
    const check = async () => {
      const before = current();
      const lease = await beginSession({ scope: 'isolated-production-route-context-test', identities: ['fixture'],
        assertAllowed() {}, revalidateAllowed() {} });
      try { assert.deepEqual(current(), before); return before; }
      finally { lease.release(); }
    };
    const handlers = {
      onRequest() { seen.onRequest.push(current()); return check(); },
      onNotification() { seen.onNotification.push(current()); },
      onNotificationReceived() { seen.onNotificationReceived.push(current()); },
    };
    const getRouter = vm.runInNewContext(region(patched ? patchCodexRouteContext(source) : source)
      + '\ngetCodexAppServerTurnRouter', {
      bindCodexRouteHandlers, AbortController, AbortSignal, Error, setTimeout, clearTimeout,
      createDeferred: () => Promise.withResolvers(),
      isJsonObject: value => value && typeof value === 'object' && !Array.isArray(value),
      readCodexNotificationThreadId: value => value.threadId,
      readCodexNotificationTurnId: value => value.turnId,
      redactCodexEventKind: value => value,
      embeddedAgentLog: { warn: (...args) => warnings.push(args) },
    }, { filename: `${routerFiles[0]}:isolated-router-region` });
    const client = {
      addNotificationHandler(fn) { this.notify = fn; },
      addRequestHandler(fn) { this.request = fn; },
      addCloseHandler(fn) { this.close = fn; },
    };
    const transport = await createRoot();
    let emit;
    const router = await transport.run(() => {
      emit = AsyncLocalStorage.snapshot();
      return getRouter(client);
    });
    transport.release();
    assert.equal(transport.token.released, true);
    assert.equal(transport.token.references, 0);
    assert.equal(state.activeRootWork.size, 0);
    subtest.after(() => {
      router.dispose();
      for (const route of routes) route.release();
      for (const lease of roots) lease.release();
      admission.p();
      assert.equal(state.activeRootWork.size, 0);
    });
    const reserve = threadId => {
      const route = emit(() => router.reserveThread({ threadId }));
      routes.push(route);
      return route;
    };
    const activate = async (threadId, owner, selectedHandlers = handlers) => {
      const route = reserve(threadId);
      const run = () => tag.run(threadId, async () => {
        await route.activate(selectedHandlers);
        route.armTurn();
        await route.bindTurn('turn');
      });
      if (owner) await owner.run(run);
      else await admission._(run);
      return route;
    };
    return { router, client, transport, emit, createRoot, reserve, activate, seen, warnings, handlers, check,
      call: (threadId, turnId = 'turn', signal) => emit(() => client.request({
        method: 'item/tool/call', params: { threadId, turnId },
      }, signal)),
      notify: (threadId, turnId = 'turn') => emit(() => client.notify({
        method: 'item/started', params: { threadId, turnId },
      })),
    };
  };

  await t.test('unpatched router reproduces a released transport root despite an active route root', async st => {
    const h = await setup(st, false);
    const activation = await h.createRoot();
    await h.activate('baseline', activation);
    await assert.rejects(h.call('baseline'), /Gateway is draining/);
    assert.equal(h.seen.onRequest[0].root, h.transport.token);
    assert.equal(activation.token.released, false);
    assert.equal(activation.token.references, 1);
    assert.equal(admission.d(), false);
  });

  await t.test('rootless activation clears the retired transport root without bypassing real restart/drain guards', async st => {
    const h = await setup(st);
    await h.activate('rootless');
    assert.equal(state.activeRootWork.size, 0);
    assert.deepEqual(await h.call('rootless'), { root: undefined, tag: 'rootless' });
    await h.notify('rootless');
    for (const name of callbacks) assert.deepEqual(h.seen[name], [{ root: undefined, tag: 'rootless' }]);
    assert.equal(state.activeRootWork.size, 0);
    assert.equal(h.transport.token.references, 0);
    const fence = admission.n();
    assert.ok(fence);
    assert.equal(state.restartSignalPending, true);
    await assert.rejects(h.call('rootless'), /Gateway is draining/);
    assert.equal(state.activeRootWork.size, 0);
    assert.equal(fence.rollback(), true);
    assert.equal((await h.call('rootless')).root, undefined);
    admission.f();
    assert.equal(state.restartDraining, true);
    assert.equal(admission.o().aborted, true);
    await assert.rejects(h.call('rootless'), /Gateway is draining/);
    admission.p();
    assert.equal(admission.d(), false);
    assert.equal((await h.call('rootless')).root, undefined);
    assert.equal(state.activeRootWork.size, 0);
    assert.deepEqual(h.warnings, []);
  });

  await t.test('two routes isolate all three callbacks without acquiring or retaining roots', async st => {
    const h = await setup(st);
    const first = await h.createRoot();
    const second = await h.createRoot();
    await h.activate('first', first);
    await h.activate('second', second);
    assert.equal(state.activeRootWork.size, 2);
    assert.equal(first.token.references, 1);
    assert.equal(second.token.references, 1);
    for (const [threadId, owner] of [['first', first], ['second', second], ['first', first]]) {
      assert.deepEqual(await h.call(threadId), { root: owner.token, tag: threadId });
      await h.notify(threadId);
    }
    for (const name of callbacks) assert.deepEqual(h.seen[name], [
      { root: first.token, tag: 'first' }, { root: second.token, tag: 'second' }, { root: first.token, tag: 'first' },
    ]);
    assert.equal(first.token.references, 1);
    assert.equal(second.token.references, 1);
    first.release();
    assert.equal(first.token.references, 0);
    assert.equal(state.activeRootWork.size, 1);
    await assert.rejects(h.call('first'), /Gateway is draining/);
    assert.equal((await h.call('second')).root, second.token);
    assert.deepEqual(h.warnings, []);
  });

  await t.test('rootless callbacks obey real suspension while a still-live admitted root may continue', async st => {
    const h = await setup(st);
    const owner = await h.createRoot();
    await h.activate('rootless');
    await h.activate('admitted', owner);
    const suspension = admission.w(() => {});
    assert.ok(suspension);
    assert.equal(admission.s(), 'preparing');
    assert.equal(admission.d(), true);
    await assert.rejects(h.call('rootless'), /Gateway is draining/);
    assert.equal(h.seen.onRequest.at(-1).root, undefined);
    assert.equal((await h.call('admitted')).root, owner.token);
    assert.equal(owner.token.references, 1);
    assert.equal(state.activeRootWork.size, 1);
    assert.equal(suspension.rollback(), true);
    assert.equal((await h.call('rootless')).root, undefined);
  });

  await t.test('requests and notifications buffered before rootless activation restore that activation', async st => {
    const h = await setup(st);
    const route = h.reserve('delayed');
    await h.notify('delayed');
    const pending = h.call('delayed');
    await admission._(() => route.activate(h.handlers));
    assert.deepEqual(await pending, { root: undefined, tag: undefined });
    await route.drain();
    for (const name of callbacks) assert.deepEqual(h.seen[name], [{ root: undefined, tag: undefined }]);
    assert.equal(state.activeRootWork.size, 0);
    assert.deepEqual(h.warnings, []);
  });

  await t.test('implicit reserveThread activation also captures the route owner instead of transport', async st => {
    const h = await setup(st);
    const owner = await h.createRoot();
    const route = await owner.run(() => h.router.reserveThread({ threadId: 'implicit', ...h.handlers }));
    assert.equal((await h.call('implicit')).root, owner.token);
    await h.notify('implicit');
    for (const name of callbacks) assert.equal(h.seen[name][0].root, owner.token);
    assert.equal(owner.token.references, 1);
    route.release();
    assert.equal(await h.call('implicit'), undefined);
  });

  await t.test('live activation snapshots still reject restartSignal and real drain/reset retirement', async st => {
    const h = await setup(st);
    const activation = await h.createRoot();
    await h.activate('retired', activation);
    const fence = admission.n();
    assert.ok(fence);
    await assert.rejects(h.call('retired'), /Gateway is draining/);
    assert.equal(activation.token.references, 1);
    assert.equal(fence.rollback(), true);
    assert.equal((await h.call('retired')).root, activation.token);
    admission.f();
    await assert.rejects(h.call('retired'), /Gateway is draining/);
    admission.p();
    assert.equal(admission.d(), false);
    assert.equal(activation.token.retiredByReset, true);
    assert.equal(activation.token.released, true);
    assert.equal(activation.token.references, 0);
    await assert.rejects(h.call('retired'), /Gateway is draining/);
    assert.equal(state.activeRootWork.size, 0);
    const fresh = await h.createRoot();
    await h.activate('fresh', fresh);
    assert.equal((await h.call('fresh')).root, fresh.token);
    await assert.rejects(h.call('retired'), /Gateway is draining/);
    assert.equal(state.activeRootWork.size, 1);
  });

  await t.test('native route release, invalid activation, stale turn and aborted requests remain enforced', async st => {
    const h = await setup(st);
    const owner = await h.createRoot();
    const route = await h.activate('thread', owner);
    await assert.rejects(route.activate(h.handlers), /already activated/);
    assert.equal(await h.call('thread', 'stale'), undefined);
    assert.equal(await h.call('thread', 'turn', AbortSignal.abort()), undefined);
    assert.equal(h.seen.onRequest.length, 0);
    route.release();
    assert.equal(route.signal.aborted, true);
    assert.equal(await h.call('thread'), undefined);
    await h.notify('thread');
    for (const name of callbacks) assert.equal(h.seen[name].length, 0);
    await assert.rejects(route.activate(h.handlers), /released/);
    const waiting = h.reserve('waiting');
    const pending = h.call('waiting');
    waiting.release();
    assert.equal(await pending, undefined);
    await assert.rejects(waiting.activate(h.handlers), /released/);
    assert.equal(owner.token.references, 1);
  });

  await t.test('a callback already in flight cannot use snapshot to extend a released activation lease', async st => {
    const h = await setup(st);
    const owner = await h.createRoot();
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    st.after(() => resume.resolve());
    await h.activate('in-flight', owner, { onRequest: async () => {
      entered.resolve();
      await resume.promise;
      return h.check();
    } });
    const response = h.call('in-flight');
    await entered.promise;
    assert.equal(owner.token.references, 1);
    owner.release();
    assert.equal(owner.token.references, 0);
    assert.equal(state.activeRootWork.size, 0);
    const rejected = assert.rejects(response, /Gateway is draining/);
    resume.resolve();
    await rejected;
    assert.equal(state.activeRootWork.size, 0);
  });
});
