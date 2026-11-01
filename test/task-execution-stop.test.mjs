import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stopTaskExecutions, stopTaskExecutionsThroughGateway } from '../src/task-execution-stop.mjs';

function fixture(outcome = 'cancelled') {
  const target = { role: 'execution', sessionKey: 'agent:main:subagent:task-one', runId: 'run-one' };
  const payload = { cardId: 'card-one', operationId: 'close-one', outcome, targets: [target] };
  const marker = '[shadow-operation:close-one]';
  const card = { id: payload.cardId, status: outcome === 'done' ? 'done' : 'running',
    sessionKey: target.sessionKey, runId: target.runId,
    execution: { sessionKey: target.sessionKey, runId: target.runId, status: 'running' },
    metadata: { comments: [{ body: `User cancelled this task.\n\n${marker}` }],
      proof: [{ status: 'passed', label: 'Human confirmation', note: `User confirmed completion.\n\n${marker}` }],
      ...(outcome === 'cancelled' ? { archivedAt: 123456 } : {}) } };
  const calls = [];
  const f = { payload, card, calls, reads: 0,
    ack: { ok: true, status: 'aborted', abortedRunId: target.runId },
    preWait: { status: 'timeout', runId: target.runId, timeoutPhase: 'gateway_draining', runKnown: true },
    wait: { status: 'timeout', runId: target.runId, stopReason: 'rpc', endedAt: 123457 } };
  f.client = {
    async invokeTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      assert.equal(name, 'workboard_read');
      assert.deepEqual(args, { id: payload.cardId });
      f.reads += 1;
      await f.onRead?.(f.reads);
      if (f.readError) throw f.readError;
      return f.readResult ?? { ok: true, output: { details: { card: structuredClone(card) } } };
    },
    async request(method, args, timeoutMs) {
      calls.push({ method, args: structuredClone(args), timeoutMs });
      if (method === 'sessions.abort') {
        await f.onAbort?.(args);
        if (f.abortError) throw f.abortError;
        return structuredClone(f.ack);
      }
      assert.equal(method, 'agent.wait');
      if (args.timeoutMs === 0) {
        await f.onPreWait?.(args);
        if (f.preWaitError) throw f.preWaitError;
        return structuredClone(f.preWait);
      }
      await f.onWait?.(args);
      if (f.waitError) throw f.waitError;
      return structuredClone(f.wait);
    },
  };
  return f;
}

const aborts = f => f.calls.filter(call => call.method === 'sessions.abort');

for (const outcome of ['done', 'cancelled']) {
  for (const status of ['ok', 'error']) {
    test(`${outcome}: existing ordinary ${status} terminal needs no new abort`, async () => {
      const f = fixture(outcome);
      f.preWait = { runId: 'run-one', status, startedAt: 123450, endedAt: 123456,
        ...(status === 'error' ? { stopReason: 'error' } : {}) };
      const result = await stopTaskExecutions(f.client, f.payload);
      assert.equal(result.status, 'not_running');
      assert.equal(result.error, undefined);
      assert.equal(result.targets[0].reason, 'natural_terminal_before_stop');
      assert.equal(result.targets[0].observation.endedAt, 123456);
      assert.equal(result.targets[0].abort, undefined);
      assert.equal(result.targets[0].cleanupComplete, undefined);
      assert.equal(aborts(f).length, 0);
      assert.equal(f.reads, 2);
      assert.deepEqual(f.calls.filter(call => call.method).map(call => call.args), [{ runId: 'run-one', timeoutMs: 0 }]);
    });
  }
}

for (const [label, change] of [
  ['synthetic timeout', value => { value.status = 'timeout'; value.stopReason = 'rpc'; }],
  ['missing endedAt', value => { delete value.endedAt; }],
  ['string endedAt', value => { value.endedAt = '123456'; }],
  ['nonfinite endedAt', value => { value.endedAt = Infinity; }],
  ['future endedAt', value => { value.endedAt = Date.now() + 60_000; }],
  ['ended before start', value => { value.startedAt = 123457; }],
  ['missing identity', value => { delete value.runId; }],
  ['explicit unknown run', value => { value.runKnown = false; }],
  ['pending error', value => { value.pendingError = true; }],
  ['yielded', value => { value.yielded = true; }],
  ['active liveness', value => { value.livenessState = 'running'; }],
  ['unknown liveness', value => { value.livenessState = 'unknown'; }],
  ['timeout phase', value => { value.timeoutPhase = 'post_turn'; }],
  ['malformed stop reason', value => { value.stopReason = {}; }],
  ...['rpc', 'stop', 'aborted', 'restart', 'superseded', 'timeout', 'cancelled', 'unrecognized']
    .map(reason => [`stop reason ${reason}`, value => { value.stopReason = reason; }]),
]) {
  test(`preflight ${label} cannot certify an ordinary natural terminal`, async () => {
    const f = fixture();
    f.preWait = { status: 'ok', runId: 'run-one', endedAt: 123456 };
    change(f.preWait);
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(aborts(f).length, 1);
  });
}

test('preflight for another run cannot suppress or authorize an abort', async () => {
  const f = fixture();
  f.preWait = { status: 'ok', runId: 'other-run', endedAt: 123456 };
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.targets[0].reason, 'observation_identity_mismatch');
  assert.equal(aborts(f).length, 0);
});

for (const change of [
  f => { delete f.card.metadata.archivedAt; },
  f => { f.card.execution.runId = 'new-run'; },
]) {
  for (const natural of [false, true]) {
    test(`preflight revalidates native closure before ${natural ? 'not_running' : 'abort'} (${change})`, async () => {
      const f = fixture();
      if (natural) f.preWait = { status: 'ok', runId: 'run-one', endedAt: 123456 };
      f.onPreWait = () => change(f);
      assert.equal((await stopTaskExecutions(f.client, f.payload)).status, 'unconfirmed');
      assert.equal(aborts(f).length, 0);
    });
  }
}

for (const wait of [
  { status: 'timeout', runId: 'run-one', runKnown: true, timeoutPhase: 'gateway_draining' },
  { status: 'pending', runId: 'run-one', timeoutPhase: 'queue', providerStarted: false },
]) {
  test(`native registered/queued response ${JSON.stringify(wait)} remains pending`, async () => {
    const f = fixture();
    f.wait = wait;
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, 'pending');
    assert.equal(result.targets[0].reason, 'run_still_active');
    assert.match(result.error, /[\u4e00-\u9fff]/);
  });
}

for (const firstStatus of ['not_running', 'unconfirmed']) {
  test(`active owner keeps aggregate pending alongside ${firstStatus}`, async () => {
    const f = fixture();
    f.payload.targets.push({ role: 'owner', sessionKey: 'agent:main:shadow-task:card-one', runId: 'owner-run' });
    f.onPreWait = ({ runId }) => {
      f.preWait = firstStatus === 'not_running' && runId === 'run-one'
        ? { status: 'ok', runId, endedAt: 123456 }
        : { status: 'timeout', runId, runKnown: true, timeoutPhase: 'gateway_draining' };
    };
    f.onAbort = ({ runId }) => { f.ack.abortedRunId = runId; };
    f.onWait = ({ runId }) => {
      f.wait = runId === 'owner-run' ? { status: 'timeout', runId, runKnown: true }
        : { status: 'timeout', runId, endedAt: 123457, stopReason: 'rpc' };
    };
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, 'pending');
    assert.deepEqual(result.targets.map(target => target.status), [firstStatus, 'pending']);
    assert.equal(aborts(f).length, firstStatus === 'not_running' ? 1 : 2);
  });
}

for (const outcome of ['done', 'cancelled']) {
  test(`${outcome}: exact native abort ACK and synthetic RPC timeout are not stop proof`, async () => {
    const f = fixture(outcome);
    const before = structuredClone(f.payload);
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.targets[0].reason, 'native_cleanup_proof_unavailable');
    assert.equal(result.targets[0].observation.stopReason, 'rpc');
    assert.deepEqual(aborts(f).map(call => call.args), [{
      key: before.targets[0].sessionKey, agentId: 'main', runId: 'run-one',
    }]);
    assert.deepEqual(f.payload, before);
    assert.equal(result.error, '停止请求已发送，但底层尚未提供执行清理完成回执。');
    assert.equal(f.reads, 3);
    assert.equal(f.calls.length, 6);
  });
}

for (const wait of [
  { status: 'ok', runId: 'run-one', endedAt: 123458 },
  { status: 'error', runId: 'run-one', endedAt: 123458, error: 'cleanup failed' },
  { status: 'timeout', runKnown: false },
  { status: 'pending', livenessState: 'unknown' },
  { status: 'pending', livenessState: 'running', runKnown: false },
  { status: 'cancelled', cleanupComplete: true },
  null,
]) {
  test(`native wait ${JSON.stringify(wait)} does not invent cleanup proof`, async () => {
    const f = fixture();
    f.wait = wait;
    assert.equal((await stopTaskExecutions(f.client, f.payload)).status, 'unconfirmed');
  });
}

test('no-active-run is not proof that a previously aborted executor finished cleanup', async () => {
  const f = fixture();
  f.ack = { ok: true, status: 'no-active-run', abortedRunId: null };
  f.wait = { status: 'timeout', runKnown: false };
  assert.equal((await stopTaskExecutions(f.client, f.payload)).status, 'unconfirmed');
  assert.equal(aborts(f).length, 1);
});

test('positive exact-run liveness is pending, with preflight and one bounded followup', async () => {
  const f = fixture();
  f.wait = { status: 'pending', runId: 'run-one', runKnown: true, livenessState: 'running' };
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.equal(result.status, 'pending');
  assert.equal(result.targets[0].reason, 'run_still_active');
  assert.equal(f.calls.filter(call => call.method === 'agent.wait').length, 2);
  assert.deepEqual(f.calls.find(call => call.method === 'agent.wait' && call.args.timeoutMs === 1000), {
    method: 'agent.wait', args: { runId: 'run-one', timeoutMs: 1000 }, timeoutMs: 5000,
  });
});

for (const [label, change, reason] of [
  ['missing card', f => { f.readResult = { ok: true, output: { details: {} } }; }, 'card_identity_unconfirmed'],
  ['other card', f => { f.card.id = 'other-card'; }, 'card_identity_unconfirmed'],
  ['unarchived cancellation', f => { delete f.card.metadata.archivedAt; }, 'closure_state_changed'],
  ['different outcome', f => { f.card.status = 'done'; }, 'closure_state_changed'],
  ['cancelled status without archive', f => { f.card.status = 'cancelled'; delete f.card.metadata.archivedAt; }, 'closure_state_changed'],
  ['missing marker', f => { f.card.metadata.comments = []; }, 'closure_marker_unconfirmed'],
  ['different operation marker', f => { f.payload.operationId = 'close-two'; }, 'closure_marker_unconfirmed'],
  ['substring marker', f => { f.card.metadata.comments[0].body = 'quoted [shadow-operation:close-one] elsewhere'; }, 'closure_marker_unconfirmed'],
  ['metadata alone', f => { f.card.metadata.comments = []; f.card.metadata.shadowClosure = f.payload; }, 'closure_marker_unconfirmed'],
  ['new execution', f => { f.card.execution.runId = 'new-run'; }, 'execution_binding_changed'],
  ['partial execution', f => { delete f.card.execution.runId; delete f.card.runId; }, 'execution_binding_changed'],
  ['conflicting aliases', f => { f.card.runId = 'new-run'; }, 'execution_binding_conflict'],
  ['omitted bound target', f => { f.payload.targets = []; }, 'execution_binding_changed'],
]) {
  test(`${label} fails closed without any abort`, async () => {
    const f = fixture();
    change(f);
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.errorCode, reason);
    assert.match(result.error, /[\u4e00-\u9fff]/);
    assert.equal(aborts(f).length, 0);
  });
}

test('done requires passed proof with exact marker, not an arbitrary comment', async () => {
  const f = fixture('done');
  f.card.metadata.proof[0].status = 'failed';
  assert.equal((await stopTaskExecutions(f.client, f.payload)).errorCode, 'closure_marker_unconfirmed');
  assert.equal(aborts(f).length, 0);
});

for (const change of [
  f => { f.payload.targets[0].runId = null; },
  f => { f.payload.targets[0].sessionKey = 'main'; },
  f => { f.payload.targets[0].runId = ' run-one'; },
  f => { f.payload.targets[0].role = 'unknown'; },
  f => { f.payload.targets.push({ ...f.payload.targets[0] }); },
  f => { f.payload.operationId = 'close-one]\n'; },
  f => { f.payload.outcome = 'terminated'; },
  f => { delete f.payload.targets; },
]) {
  test(`invalid request ${change.toString()} never reaches transport`, async () => {
    const f = fixture();
    change(f);
    assert.equal((await stopTaskExecutions(f.client, f.payload)).errorCode, 'invalid_stop_identity');
    assert.equal(f.calls.length, 0);
  });
}

function removeExecution(f) {
  delete f.card.execution;
  delete f.card.sessionKey;
  delete f.card.runId;
  f.payload.targets = [];
}

test('verified closure with no frozen or native execution needs no abort', async () => {
  const f = fixture();
  removeExecution(f);
  assert.deepEqual(await stopTaskExecutions(f.client, f.payload), {
    status: 'not_running', targets: [], reason: 'no_frozen_executions',
  });
  assert.equal(f.calls.length, 1);
});

test('active execution without identity cannot be called not running', async () => {
  const f = fixture();
  removeExecution(f);
  f.card.execution = { status: 'running' };
  assert.equal((await stopTaskExecutions(f.client, f.payload)).errorCode, 'execution_identity_missing');
});

for (const role of ['owner', 'pending_execution']) {
  test(`trusted ${role} target is exact and does not borrow the native execution binding`, async () => {
    const f = fixture();
    removeExecution(f);
    f.payload.targets = [{ role, sessionKey: 'agent:controller:shadow-task:card-one', runId: 'owner-run' }];
    f.ack.abortedRunId = 'owner-run';
    f.preWait.runId = 'owner-run';
    f.wait.runId = 'owner-run';
    assert.equal((await stopTaskExecutions(f.client, f.payload)).status, 'unconfirmed');
    assert.deepEqual(aborts(f)[0].args, {
      key: 'agent:controller:shadow-task:card-one', agentId: 'controller', runId: 'owner-run',
    });
  });
}

test('same frozen run across all three roles is aborted and observed only once', async () => {
  const f = fixture();
  f.payload.targets.push({ ...f.payload.targets[0], role: 'owner' });
  f.payload.targets.push({ ...f.payload.targets[0], role: 'pending_execution' });
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.deepEqual(result.targets.map(target => target.role), ['execution', 'owner', 'pending_execution']);
  assert.equal(aborts(f).length, 1);
  assert.equal(f.calls.filter(call => call.method === 'agent.wait').length, 2);
});

test('owner and pending execution sharing an unbound run are deduplicated', async () => {
  const f = fixture();
  const target = { ...f.payload.targets[0], role: 'pending_execution' };
  removeExecution(f);
  f.payload.targets = [target, { ...target, role: 'owner' }];
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.deepEqual(result.targets.map(item => item.role), ['pending_execution', 'owner']);
  assert.equal(aborts(f).length, 1);
  assert.equal(f.calls.filter(call => call.method === 'agent.wait').length, 2);
});

for (const outcome of ['done', 'cancelled']) {
  test(`${outcome}: distinct pending execution receives exact abort without replacing the native binding`, async () => {
    const f = fixture(outcome);
    f.payload.targets.push({ role: 'pending_execution', sessionKey: 'agent:worker:subagent:next', runId: 'pending-run' });
    f.payload.targets.push({ role: 'owner', sessionKey: 'agent:main:shadow-task:card-one', runId: 'owner-run' });
    const beforeCard = structuredClone(f.card);
    const beforeTargets = structuredClone(f.payload.targets);
    f.onPreWait = ({ runId }) => { f.preWait.runId = runId; };
    f.onAbort = ({ runId }) => { f.ack.abortedRunId = runId; };
    f.onWait = ({ runId }) => { f.wait.runId = runId; };
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, 'unconfirmed');
    assert.deepEqual(result.targets.map(({ role, runId, sessionKey }) => ({ role, sessionKey, runId })), beforeTargets);
    assert.deepEqual(aborts(f).map(call => call.args), [
      { key: beforeTargets[0].sessionKey, agentId: 'main', runId: 'run-one' },
      { key: beforeTargets[1].sessionKey, agentId: 'worker', runId: 'pending-run' },
      { key: beforeTargets[2].sessionKey, agentId: 'main', runId: 'owner-run' },
    ]);
    assert.deepEqual(f.card, beforeCard);
  });
}

for (const status of ['not_running', 'pending']) {
  test(`unbound pending execution retains ${status} observation semantics`, async () => {
    const f = fixture();
    const target = { ...f.payload.targets[0], role: 'pending_execution' };
    removeExecution(f);
    f.payload.targets = [target];
    if (status === 'not_running') f.preWait = { status: 'ok', runId: target.runId, endedAt: 123456 };
    else f.wait = { status: 'timeout', runId: target.runId, runKnown: true };
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.status, status);
    assert.equal(result.targets[0].role, 'pending_execution');
    assert.equal(result.targets[0].status, status);
    assert.equal(aborts(f).length, status === 'not_running' ? 0 : 1);
  });
}

for (const [label, change, reason] of [
  ['cannot stand in for a native binding', () => {}, 'execution_binding_changed'],
  ['cannot fill an active native binding without identity', f => {
    delete f.card.runId; delete f.card.sessionKey; f.card.execution = { status: 'running' };
  }, 'execution_identity_missing'],
  ['cannot bypass the closure marker', f => { f.card.metadata.comments = []; }, 'closure_marker_unconfirmed'],
  ['cannot bypass reopening', f => { delete f.card.metadata.archivedAt; }, 'closure_state_changed'],
]) {
  test(`pending execution ${label}`, async () => {
    const f = fixture();
    f.payload.targets[0].role = 'pending_execution';
    change(f);
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.errorCode, reason);
    assert.equal(aborts(f).length, 0);
  });
}

for (const stage of ['before_read', 'during_preflight']) {
  test(`card rebinding to pending execution is still rejected (${stage})`, async () => {
    const f = fixture();
    const pending = { role: 'pending_execution', sessionKey: 'agent:main:subagent:next', runId: 'pending-run' };
    f.payload.targets.push(pending);
    const rebind = () => {
      f.card.runId = pending.runId; f.card.sessionKey = pending.sessionKey;
      f.card.execution = { runId: pending.runId, sessionKey: pending.sessionKey, status: 'running' };
    };
    if (stage === 'before_read') rebind();
    else f.onPreWait = ({ runId }) => {
      f.preWait.runId = runId;
      if (runId === pending.runId) rebind();
    };
    assert.equal((await stopTaskExecutions(f.client, f.payload)).errorCode, 'execution_binding_changed');
    assert.deepEqual(aborts(f).map(call => call.args.runId), stage === 'before_read' ? [] : ['run-one']);
  });
}

for (const [label, change] of [
  ['missing run', f => { f.payload.targets[1].runId = null; }],
  ['missing session', f => { delete f.payload.targets[1].sessionKey; }],
  ['session alias', f => { f.payload.targets[1].sessionKey = 'main'; }],
  ['duplicate role', f => { f.payload.targets.push({ ...f.payload.targets[1], runId: 'another-run' }); }],
]) {
  test(`invalid pending execution ${label} never reaches transport`, async () => {
    const f = fixture();
    f.payload.targets.push({ role: 'pending_execution', sessionKey: 'agent:main:subagent:next', runId: 'pending-run' });
    change(f);
    assert.equal((await stopTaskExecutions(f.client, f.payload)).errorCode, 'invalid_stop_identity');
    assert.equal(f.calls.length, 0);
  });
}

test('pending execution identity stays frozen through asynchronous native reads', async () => {
  const f = fixture();
  const target = { ...f.payload.targets[0], role: 'pending_execution' };
  removeExecution(f);
  f.payload.targets = [target];
  f.onRead = count => { if (count === 1) { target.runId = 'new-run'; target.sessionKey = 'agent:other:main'; } };
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.equal(result.targets[0].runId, 'run-one');
  assert.deepEqual(aborts(f)[0].args, { key: 'agent:main:subagent:task-one', agentId: 'main', runId: 'run-one' });
});

test('payload mutation during native read cannot change captured targets', async () => {
  const f = fixture();
  f.onRead = count => { if (count === 1) f.payload.targets[0].runId = 'new-run'; };
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.equal(result.targets[0].runId, 'run-one');
  assert.equal(aborts(f)[0].args.runId, 'run-one');
});

for (const stage of ['onAbort', 'onWait']) {
  test(`reopening during ${stage} is detected, and later owner abort is suppressed`, async () => {
    const f = fixture();
    f.payload.targets.push({ role: 'owner', sessionKey: 'agent:main:shadow-task:card-one', runId: 'owner-run' });
    f[stage] = () => { delete f.card.metadata.archivedAt; };
    const result = await stopTaskExecutions(f.client, f.payload);
    assert.equal(result.errorCode, 'closure_state_changed');
    assert.equal(result.targets.length, 2);
    assert.equal(aborts(f).length, 1);
  });
}

test('binding changes between targets are checked immediately before the next abort', async () => {
  const f = fixture();
  f.payload.targets.push({ role: 'owner', sessionKey: 'agent:main:shadow-task:card-one', runId: 'owner-run' });
  f.onRead = count => { if (count === 4) f.card.execution.runId = 'new-run'; };
  assert.equal((await stopTaskExecutions(f.client, f.payload)).errorCode, 'execution_binding_changed');
  assert.equal(aborts(f).length, 1);
});

test('mismatched abort acknowledgement is unconfirmed and never broadens cancellation', async () => {
  const f = fixture();
  f.ack.abortedRunId = 'other-run';
  assert.equal((await stopTaskExecutions(f.client, f.payload)).targets[0].reason, 'abort_identity_unconfirmed');
  assert.equal(f.calls.filter(call => call.method === 'agent.wait').length, 1);
  assert.equal(aborts(f).length, 1);
});

test('mismatched wait identity cannot report positive liveness for this run', async () => {
  const f = fixture();
  f.wait = { status: 'pending', runId: 'other-run', livenessState: 'running' };
  const result = await stopTaskExecutions(f.client, f.payload);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.targets[0].reason, 'observation_identity_mismatch');
});

for (const field of ['readError', 'abortError', 'preWaitError', 'waitError']) {
  test(`${field} propagates unchanged for durable outbox retry`, async () => {
    const f = fixture();
    const error = Object.assign(new Error('unauthorized or transport unavailable'), { rpcCode: 'INVALID_REQUEST' });
    f[field] = error;
    await assert.rejects(stopTaskExecutions(f.client, f.payload), actual => actual === error);
  });
}

test('native tool authorization rejection is not mistaken for a missing card', async () => {
  const f = fixture();
  f.readResult = { ok: false, error: { code: 'FORBIDDEN', message: 'unauthorized' } };
  await assert.rejects(stopTaskExecutions(f.client, f.payload), { message: 'unauthorized', rpcCode: 'FORBIDDEN' });
  assert.equal(aborts(f).length, 0);
});

for (const role of ['execution', 'pending_execution']) for (const rejectAbort of [false, true]) {
  test(`Gateway wrapper scopes admin to its connection and closes it (${role}, reject=${rejectAbort})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-stop-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = path.join(root, 'runtime', 'openclaw-poc', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify({ gateway: {
      port: 19011, auth: { token: 'synthetic-token-for-offline-test' },
    } }));
    const f = fixture();
    if (role === 'pending_execution') {
      const target = { ...f.payload.targets[0], role };
      removeExecution(f);
      f.payload.targets = [target];
    }
    const sockets = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      listeners = new Map();
      closed = false;
      constructor() {
        sockets.push(this);
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) }));
      }
      addEventListener(name, callback) { this.listeners.set(name, callback); }
      emit(name, event) { this.listeners.get(name)?.(event); }
      send(raw) {
        const frame = JSON.parse(raw);
        queueMicrotask(async () => {
          let payload;
          if (frame.method === 'connect') {
            assert.deepEqual(frame.params.scopes, ['operator.read', 'operator.write', 'operator.admin']);
            payload = { features: { methods: [], events: [] } };
          } else if (frame.method === 'tools.invoke') {
            payload = await f.client.invokeTool(frame.params.name, frame.params.args);
          } else if (frame.method === 'sessions.abort' && rejectAbort) {
            this.emit('message', { data: JSON.stringify({ type: 'res', id: frame.id, ok: false,
              error: { code: 'INVALID_REQUEST', message: 'unauthorized' } }) });
            return;
          } else payload = await f.client.request(frame.method, frame.params);
          this.emit('message', { data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }) });
        });
      }
      close() { this.closed = true; this.readyState = 3; this.emit('close', {}); }
    }
    const originalSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket;
    t.after(() => { globalThis.WebSocket = originalSocket; });
    if (rejectAbort) await assert.rejects(stopTaskExecutionsThroughGateway(root, f.payload), { message: 'unauthorized' });
    else {
      const result = await stopTaskExecutionsThroughGateway(root, f.payload);
      assert.equal(result.status, 'unconfirmed');
      assert.equal(result.targets[0].role, role);
      assert.deepEqual(aborts(f)[0].args, { key: 'agent:main:subagent:task-one', agentId: 'main', runId: 'run-one' });
    }
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].closed, true);
  });
}
