import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../src/db.mjs';
import { applyKnowledgeBundle } from '../src/graph-model.mjs';
import { createTaskAccessHook } from '../openclaw/shadow-policy/task-access.mjs';

const repository = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const installerRelative = 'scripts/install-shadow-context-plugin.ps1';
const pluginRelative = 'openclaw/shadow-work';
const stateRelative = 'runtime/openclaw-poc/state';
const extensionRelative = 'extensions/shadow-work/';
const slash = value => value.split(path.sep).join('/');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Check lexical bounds and every existing ancestor; never follow junctions/symlinks.
function bounded(root, relative) {
  assert.equal(fs.realpathSync(root), root);
  const target = path.resolve(root, relative);
  const local = path.relative(root, target);
  assert.ok(local && local !== '..' && !local.startsWith(`..${path.sep}`)
    && !path.isAbsolute(local), `Path escaped root: ${target}`);
  let current = root;
  for (const part of local.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      assert.equal(fs.lstatSync(current, { throwIfNoEntry: false }), undefined);
      break;
    }
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `Link forbidden: ${current}`);
    assert.equal(fs.realpathSync(current), current);
  }
  return target;
}

function files(root, directory) {
  const result = [];
  for (const name of fs.readdirSync(bounded(root, directory))) {
    const relative = path.join(directory, name);
    const file = bounded(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) result.push(...files(root, relative));
    else {
      assert.ok(stat.isFile(), `Non-file payload: ${file}`);
      result.push(slash(relative));
    }
  }
  return result.sort();
}

test('G1: actual installer artifacts and persisted knowledge in an isolated project', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell.' : false,
}, async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shadow-work-installation-'));
  const assertRoot = () => {
    assert.equal(fs.realpathSync(root), root);
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^shadow-work-installation-[A-Za-z0-9]+$/);
    assert.notEqual(root, repository);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  };
  assertRoot();
  t.after(() => {
    assertRoot();
    // Walk first so recursive cleanup cannot encounter a redirected descendant.
    files(parent, path.basename(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function copySource(relative) {
    const source = bounded(repository, relative);
    const target = bounded(root, relative);
    assert.ok(fs.statSync(source).isFile());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    assert.equal(hash(target), hash(source), `Fixture source hash: ${relative}`);
  }
  copySource(installerRelative);
  const installer = bounded(root, installerRelative);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  function runPowerShell(command) {
    assertRoot();
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${command}`], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: {
        SystemRoot: systemRoot,
        TEMP: root, TMP: root, SHADOW_INSTALLER_PATH: installer,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }

  // Derive fixture shared inputs from the actual script, not a second dependency list.
  const shared = JSON.parse(runPowerShell(String.raw`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
      $env:SHADOW_INSTALLER_PATH, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Installer parse failed' }
    $names = @($ast.FindAll({ param($node)
      $node -is [System.Management.Automation.Language.StringConstantExpressionAst]
    }, $true) | ForEach-Object {
      if ($_.Value -match '^(?:src[\\/])?([A-Za-z0-9_-]+\.mjs)$') { $Matches[1] }
    } | Sort-Object -Unique)
    ConvertTo-Json -InputObject $names -Compress
  `));
  assert.ok(Array.isArray(shared) && shared.length > 0);
  const pluginFiles = files(repository, `${pluginRelative}/src`);
  for (const relative of pluginFiles) assert.match(relative, /\.(?:js|mjs)$/);
  const sources = [...pluginFiles, `${pluginRelative}/package.json`,
    `${pluginRelative}/openclaw.plugin.json`, ...shared.map(name => `src/${name}`)];
  for (const relative of sources) copySource(relative);
  const expected = sources.map(relative => relative.startsWith(`${pluginRelative}/`)
    ? extensionRelative + relative.slice(pluginRelative.length + 1) : relative).sort();
  const state = bounded(root, stateRelative);

  function sourceFor(installedRelative) {
    assert.ok(expected.includes(installedRelative), `Unexpected installed path: ${installedRelative}`);
    return installedRelative.startsWith(extensionRelative)
      ? `${pluginRelative}/${installedRelative.slice(extensionRelative.length)}` : installedRelative;
  }
  function verifyFile(relative) {
    const source = sourceFor(relative);
    const originalHash = hash(bounded(repository, source));
    assert.equal(hash(bounded(root, source)), originalHash, `Fixture source drift: ${source}`);
    assert.equal(hash(bounded(root, `${stateRelative}/${relative}`)), originalHash,
      `Installed hash mismatch: ${relative}`);
  }
  function verifyArtifacts() {
    const actual = files(root, stateRelative).map(file => file.slice(stateRelative.length + 1));
    assert.deepEqual(actual, expected, 'Exact installed inventory (no missing/extra/nested src payload)');
    for (const relative of actual) verifyFile(relative);
  }
  function install() {
    assertRoot();
    files(parent, path.basename(root));
    bounded(root, `${stateRelative}/${extensionRelative}src`);
    bounded(root, `${stateRelative}/src`);
    assert.equal(hash(installer), hash(bounded(repository, installerRelative)));
    runPowerShell('& $env:SHADOW_INSTALLER_PATH'); // Never execute the repository installer.
  }

  let importAttempt = 0;
  async function importInstalled() {
    const nonce = String(++importAttempt);
    const moduleUrl = name => {
      const url = pathToFileURL(bounded(root, `${stateRelative}/${extensionRelative}src/${name}`));
      url.searchParams.set('installation-test', nonce);
      return url.href;
    };
    const entryUrl = moduleUrl('index.js');
    const imported = new Set();
    const sdk = {
      'openclaw/plugin-sdk/tool-plugin': 'export function defineToolPlugin(x){return Object.assign(x,{register(api){for(const tool of x.tools(v=>v))api.registerTool(tool);}});}',
      'openclaw/plugin-sdk/core': "export function delegateCompactionToRuntime(){throw new Error('Live runtime forbidden in isolated test');}",
    };
    const hook = registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === entryUrl && Object.hasOwn(sdk, specifier)) return {
        shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sdk[specifier])}`,
      };
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('file:')
        || specifier.startsWith('./') || specifier.startsWith('../'),
      `Unexpected external dependency: ${specifier}`);
      const result = next(specifier, context);
      if (result.url.startsWith('file:')) {
        const file = fileURLToPath(result.url);
        const relative = slash(path.relative(state, file));
        assert.equal(bounded(state, relative), file);
        verifyFile(relative);
        imported.add(relative);
        // Freshen the entire graph, not just index.js, for negative controls.
        const url = new URL(result.url);
        url.searchParams.set('installation-test', nonce);
        return { ...result, url: url.href };
      }
      assert.ok(result.url.startsWith('node:'), `Unexpected module URL: ${result.url}`);
      return result;
    } });
    try {
      const index = await import(entryUrl);
      const epistemic = await import(moduleUrl('epistemic.js'));
      const routing = await import(moduleUrl('routing.js'));
      const graphUrl = pathToFileURL(bounded(root, `${stateRelative}/src/graph-model.mjs`));
      const graph = await import(graphUrl.href);
      assert.equal(typeof index.default.register, 'function');
      assert.equal(typeof epistemic.captureKnowledge, 'function');
      assert.equal(typeof routing.resolveCognitiveRoute, 'function');
      assert.ok([...imported].some(relative => relative.startsWith('src/')));
      return { imported, index, epistemic, routing, graph };
    } finally { hook.deregister(); }
  }

  let imported;
  await t.test('first install: exact payload paths, source hashes and isolated imports', async () => {
    install();
    verifyArtifacts();
    ({ imported } = await importInstalled());
    t.diagnostic(`${pluginFiles.length} plugin source modules; ${shared.length} shared modules`);
  });
  await t.test('repeat install: no nested src duplication or hash drift', async () => {
    install();
    verifyArtifacts();
    await importInstalled();
  });
  await t.test('upgrade overwrites a poisoned shared dependency; hash drift fails closed', async () => {
    assert.ok(imported, 'First install must pass before mutation checks');
    const victim = [...imported].find(relative => relative.startsWith('src/'));
    const destination = bounded(root, `${stateRelative}/${victim}`);
    const donor = bounded(root, `${pluginRelative}/src/routing.js`);
    assert.notEqual(hash(destination), hash(donor));
    fs.copyFileSync(donor, destination);
    assert.throws(verifyArtifacts, /Installed hash mismatch/);
    await assert.rejects(importInstalled, /Installed hash mismatch/);
    install();
    verifyArtifacts();
    await importInstalled();
  });
  await t.test('missing real shared dependency fails inventory and import; reinstall repairs it', async () => {
    assert.ok(imported, 'First install must pass before mutation checks');
    const victim = [...imported].find(relative => relative.startsWith('src/'));
    fs.unlinkSync(bounded(root, `${stateRelative}/${victim}`));
    assert.throws(verifyArtifacts, /Exact installed inventory/);
    await assert.rejects(importInstalled, error => ['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code));
    install();
    verifyArtifacts();
    await importInstalled();
  });

  const installed = await importInstalled();
  const { index, epistemic, routing, graph } = installed;
  const evidenceProfile = { method: 'document_record', directness: 'direct', basis: 'artifact', environment: 'local' };
  const entities = [{ canonicalKey: 'topic:installation', type: 'KnowledgeTopic', name: 'InstallationFixture' }];
  const capture = (db, content) => epistemic.captureKnowledge(db, {
    sourceType: 'note', title: 'InstallationFixture', content, summary: content,
    keywords: ['installation', 'source', 'revision'], retrievalCues: ['installation revision', 'installation source'],
  }).evidenceId;
  const complete = (db, evidenceId, factId) => epistemic.completeKnowledgeAnnotation(db, {
    evidenceId, summary: 'InstallationFixture reviewed',
    graphReview: { status: 'completed', outcome: 'facts_recorded', factIds: [factId], rationale: 'Isolated source checked' },
  });
  const query = (db, asOf, scopeKey = 'version:one') => index.queryContext(db, {
    query: 'InstallationFixture', depth: 1, maxBytes: 65536, asOf, scopeKey,
  });
  const factRows = db => db.prepare(`SELECT id,object_value,status,scope_key,valid_from,valid_to,
    supersedes_fact_id,epistemic_status FROM graph_facts ORDER BY scope_key,valid_from,id`).all();
  const sourceRows = db => db.prepare('SELECT id,content,fingerprint FROM evidence ORDER BY id').all();
  const write = (db, entry, value, evidenceId, extras = {}) => {
    const fact = { predicate: 'HAS_VALUE', objectValue: value, sourceEvidenceIds: [evidenceId],
      scopeKey: 'version:one', ...extras };
    return entry === 'plugin'
      ? epistemic.proposeKnowledge(db, { createdBy: 'installation-test', entities, facts: [{ ...fact,
        subjectCanonicalKey: entities[0].canonicalKey, evidenceProfile }] }).facts[0]
      : applyKnowledgeBundle(db, { createdBy: 'installation-test', entities, facts: [{ ...fact,
        subject: entities[0].canonicalKey, evidenceAssessments: [{ evidenceId, ...evidenceProfile }] }] }).facts[0];
  };

  const outcomes = [];
  for (const entry of ['core', 'plugin']) {
    await t.test(`${entry} writer: installed queries, correction, replay and persisted references`, () => {
      const databasePath = bounded(root, `business-${entry}.sqlite`);
      // The host owns schema creation; only the installed plugin/shared modules handle plugin work.
      const store = openDatabase(databasePath);
      const { db } = store;
      const ids = [];
      let expectedFacts;
      let expectedSources;
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM graph_facts').get().n, 0);
        assert.deepEqual(query(db, '2024-06-01').verifiedFacts, []);
        let previous;
        for (const [year, value] of [[2024, 'A'], [2025, 'B'], [2026, 'A']]) {
          const evidenceId = capture(db, `InstallationFixture ${year} value ${value}`);
          const extras = { validFrom: `${year}-01-01T00:00:00Z`, ...(previous ? {
            supersedesFactId: previous, supersessionReason: 'Dated responsibility handover',
          } : {}) };
          const row = write(db, entry, value, evidenceId, extras);
          assert.equal(query(db, `${year}-06-01`).verifiedFacts.some(item => item.id === row.id), false,
            'Source pending review is not a verified fact');
          assert.equal(complete(db, evidenceId, row.id).queueStatus, 'completed');
          const replay = write(db, entry, value, evidenceId, extras);
          assert.equal(replay.id, row.id);
          assert.equal(complete(db, evidenceId, row.id).queueStatus, 'completed');
          if (previous) assert.equal(replay.supersession.alreadyApplied, true);
          ids.push({ year, value, factId: row.id, evidenceId });
          previous = row.id;
        }
        assert.notEqual(ids[0].factId, ids[2].factId);
        const otherSource = capture(db, 'InstallationFixture other scope');
        const other = write(db, entry, 'Other', otherSource, { scopeKey: 'version:two', validFrom: '2024-01-01' });
        complete(db, otherSource, other.id);
        assert.deepEqual(query(db, '2026-06-01', 'version:two').verifiedFacts.map(row => row.id), [other.id]);

        const before = factRows(db);
        assert.throws(() => epistemic.proposeKnowledge(db, { entities, facts: [
          { subjectCanonicalKey: entities[0].canonicalKey, predicate: 'HAS_VALUE', objectValue: 'rollback-first',
            sourceEvidenceIds: [otherSource] },
          { subjectCanonicalKey: entities[0].canonicalKey, predicate: 'HAS_VALUE', objectValue: 'rollback-missing',
            sourceEvidenceIds: ['missing'] },
        ] }), /Unknown evidence/);
        assert.deepEqual(factRows(db), before, 'Invalid second row must roll back the first row');

        // A legacy retry must neither reactivate an old occurrence nor relink its evidence to the new one.
        assert.equal(write(db, entry, 'A', ids[0].evidenceId).id, ids[0].factId);
        assert.equal(db.prepare('SELECT status FROM graph_facts WHERE id=?').get(ids[0].factId).status, 'superseded');
        assert.equal(db.prepare('SELECT count(*) n FROM graph_fact_evidence WHERE fact_id=? AND evidence_id=?')
          .get(ids[2].factId, ids[0].evidenceId).n, 0);
        expectedFacts = factRows(db);
        expectedSources = sourceRows(db);
      } finally { store.close(); }

      // Reopen without host migrations so a startup repair cannot mask persistence errors.
      const reopened = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.deepEqual(factRows(reopened), expectedFacts);
        assert.deepEqual(sourceRows(reopened), expectedSources);
        for (const { year, value, factId, evidenceId } of ids) {
          const asOf = `${year}-01-01T00:00:00Z`;
          const result = query(reopened, asOf);
          assert.deepEqual(result.verifiedFacts.map(row => row.id), [factId]);
          assert.equal(result.verifiedFacts[0].evidence.id, evidenceId);
          const routed = routing.resolveCognitiveRoute(reopened, { query: 'InstallationFixture', asOf, scopeKey: 'version:one' });
          assert.deepEqual(routed.verifiedFacts.map(row => row.id), [factId]);
          assert.equal(routed.verifiedFacts[0].source.evidenceId, evidenceId);
          const original = index.primaryEvidenceSearch(reopened, { evidenceIds: [evidenceId] });
          assert.deepEqual(original.matches.map(row => row.evidenceId), [evidenceId]);
          assert.equal(original.matches[0].content, `InstallationFixture ${year} value ${value}`);
          assert.equal(reopened.prepare('SELECT review_status FROM graph_episode_annotations WHERE evidence_id=?')
            .get(evidenceId).review_status, 'completed');
        }
        assert.deepEqual(query(reopened, '2023-12-31').verifiedFacts, []);
        assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
        outcomes.push({ facts: expectedFacts, sources: expectedSources,
          links: reopened.prepare('SELECT fact_id,evidence_id FROM graph_fact_evidence ORDER BY fact_id,evidence_id').all() });
      } finally { reopened.close(); }
    });
  }
  await t.test('core and installed plugin persist the same fact instances and evidence links', () => {
    assert.equal(outcomes.length, 2);
    assert.deepEqual(outcomes[0], outcomes[1]);
  });

  await t.test('installed public tool handlers share manual intake and resolution review without duplicate facts', async () => {
    const databasePath = bounded(root, 'business-tools.sqlite');
    openDatabase(databasePath).close();
    const config = { databasePath, reuseConnections: false,
      workboardDatabasePath: bounded(root, 'absent-isolated-workboard.sqlite') };
    const tools = Object.fromEntries(index.default.tools(definition => definition).map(tool => [tool.name, tool]));
    const invoke = (name, params) => {
      for (const field of tools[name].parameters.required ?? []) {
        assert.ok(Object.hasOwn(params, field), `${name} requires ${field}`);
      }
      return tools[name].execute(params, config);
    };
    const hints = { keywords: ['installation', 'source', 'revision'],
      retrievalCues: ['installation revision', 'installation source'] };
    const content = 'InstallationFixture manual decision: value A';
    const source = await invoke('shadow_context_capture', {
      sourceType: 'note', title: 'InstallationFixture', content, summary: content,
      externalId: 'installation-manual', ...hints,
    });
    const proposal = await invoke('shadow_context_propose', { entities, rationale: 'User supplied direct fixture decision', facts: [{
      subjectCanonicalKey: entities[0].canonicalKey, predicate: 'HAS_VALUE', objectValue: 'A',
      sourceEvidenceIds: [source.evidenceId], evidenceProfile, validFrom: '2024-01-01',
    }] });
    const factId = proposal.facts[0].id;
    await invoke('shadow_context_annotate', { evidenceId: source.evidenceId, summary: content, ...hints,
      graphReview: { status: 'completed', outcome: 'facts_recorded', factIds: [factId], rationale: 'Reviewed user decision' } });
    const result = await invoke('shadow_context_query', { query: 'InstallationFixture', depth: 1, maxBytes: 65536, asOf: '2026-06-01' });
    assert.deepEqual(result.verifiedFacts.map(row => row.id), [factId]);
    const deltaInput = {
      idempotencyKey: 'installation-resolved', question: 'What is the recorded fixture decision?',
      resolutionSummary: 'InstallationFixture was resolved using the existing value A decision.',
      durableCandidates: ['The fixture uses value A.'], sourceEvidenceIds: [source.evidenceId],
      ...hints,
    };
    const delta = await invoke('shadow_knowledge_delta_capture', deltaInput);
    const retry = await invoke('shadow_knowledge_delta_capture', deltaInput);
    assert.equal(retry.evidenceId, delta.evidenceId);
    assert.equal(retry.inserted, false);
    assert.equal(retry.reviewEvent.seq, delta.reviewEvent.seq);
    const audit = await invoke('shadow_evidence_search', { evidenceIds: [source.evidenceId] });
    assert.equal(audit.matches[0].content, content);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) n FROM graph_facts').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) n FROM graph_evidence_assessments WHERE fact_id=? AND evidence_id=?')
        .get(factId, delta.evidenceId).n, 0, 'A task summary is not extra independent support');
      assert.equal(db.prepare('SELECT review_status FROM graph_episode_annotations WHERE evidence_id=?')
        .get(delta.evidenceId).review_status, 'pending', 'Curator, not capture, decides whether knowledge changes');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    const reviewInput = { evidenceId: delta.evidenceId, summary: deltaInput.resolutionSummary, ...hints,
      graphReview: { status: 'completed', outcome: 'facts_recorded', alreadyRepresentedFactIds: [factId],
        rationale: 'Primary source already supports this exact fact; no new independent support' } };
    const reviewed = await invoke('shadow_context_annotate', reviewInput);
    const reviewedAgain = await invoke('shadow_context_annotate', reviewInput);
    assert.equal(reviewed.queueStatus, 'completed');
    assert.equal(reviewed.alreadyRepresentedFactCount, 1);
    assert.equal(reviewedAgain.reviewVersion, reviewed.reviewVersion);
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(reopened.prepare('SELECT count(*) n FROM graph_facts').get().n, 1);
      assert.equal(reopened.prepare('SELECT count(*) n FROM graph_evidence_assessments').get().n, 1);
      assert.deepEqual(reopened.prepare('SELECT parent_evidence_id,child_evidence_id,relation FROM evidence_links WHERE parent_evidence_id=?')
        .all(delta.evidenceId).map(row => ({ ...row })), [{ parent_evidence_id: delta.evidenceId,
        child_evidence_id: source.evidenceId, relation: 'summarizes' }]);
      assert.equal(reopened.prepare("SELECT count(*) n FROM evidence WHERE kind='shadow_agent_task_result' AND external_id=?")
        .get(`resolution-delta:${deltaInput.idempotencyKey}`).n, 1);
      assert.equal(reopened.prepare("SELECT count(*) n FROM context_changes WHERE evidence_id=? AND kind='knowledge_delta_due'")
        .get(delta.evidenceId).n, 1);
      const row = reopened.prepare('SELECT review_status,metadata_json FROM graph_episode_annotations WHERE evidence_id=?')
        .get(delta.evidenceId);
      assert.equal(row.review_status, 'completed');
      const review = JSON.parse(row.metadata_json).graphReview;
      assert.deepEqual(review.alreadyRepresentedFactIds, [factId]);
      assert.equal(review.materialChange, false);
      assert.equal(reopened.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?')
        .get(delta.evidenceId).status, 'completed');
    } finally { reopened.close(); }
  });

  await t.test('installed old review migration, canonical status and expiry survive reopen', () => {
    const databasePath = bounded(root, 'business-legacy.sqlite');
    const store = openDatabase(databasePath);
    let rows;
    let supported;
    try {
      rows = ['linked', 'no_durable_facts', 'needs_followup', 'pending'].map(status => {
        const evidenceId = capture(store.db, `InstallationFixture legacy ${status}`);
        store.db.prepare('UPDATE graph_episode_annotations SET metadata_json=? WHERE evidence_id=?')
          .run(JSON.stringify({ graphReview: { status } }), evidenceId);
        return { status, evidenceId };
      });
      supported = write(store.db, 'plugin', 'Expires', rows[0].evidenceId, { validFrom: '2024-01-01' });
      store.db.prepare('UPDATE graph_evidence_assessments SET valid_until=? WHERE fact_id=?')
        .run('2025-01-01T00:00:00Z', supported.id);
      store.db.exec('ALTER TABLE graph_episode_annotations DROP COLUMN review_status');
      store.db.exec('ALTER TABLE graph_episode_annotations DROP COLUMN review_outcome');
    } finally { store.close(); }
    const migrated = new DatabaseSync(databasePath);
    try {
      graph.initializeEpistemicGraph(migrated);
      const states = () => rows.map(({ evidenceId }) => ({ ...migrated.prepare(
        'SELECT review_status,review_outcome FROM graph_episode_annotations WHERE evidence_id=?').get(evidenceId) }));
      const expected = [
        { review_status: 'completed', review_outcome: 'facts_recorded' },
        { review_status: 'completed', review_outcome: 'no_durable_facts' },
        { review_status: 'needs_input', review_outcome: null },
        { review_status: 'pending', review_outcome: null },
      ];
      assert.deepEqual(states(), expected);
      migrated.exec("UPDATE graph_episode_annotations SET metadata_json='{}'");
      graph.initializeEpistemicGraph(migrated);
      assert.deepEqual(states(), expected, 'Canonical fields do not require the old metadata mirror');
    } finally { migrated.close(); }
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(query(reopened, '2024-06-01').verifiedFacts.map(row => row.id), [supported.id]);
      const expired = query(reopened, '2025-01-01T00:00:00Z');
      assert.deepEqual(expired.verifiedFacts, []);
      assert.equal(expired.reviewPending.find(row => row.id === supported.id).epistemic_status, 'proposed');
      assert.equal(reopened.prepare('SELECT epistemic_status FROM graph_facts WHERE id=?').get(supported.id).epistemic_status,
        'supported', 'Read-time expiry does not overwrite stored cache');
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { reopened.close(); }
  });
  await t.test('installed real worker: SDK knowledge tools, owned queue ACK and close/recreate readback', {
    timeout: 60000,
  }, async workerTest => {
    assert.equal(process.version, 'v24.19.0');
    assert.equal(fs.realpathSync(process.execPath), bounded(repository, 'tools/node-v24.19.0-win-x64/node.exe'));
    verifyArtifacts();
    const databasePath = bounded(root, 'business-worker.sqlite');
    const config = { databasePath, reuseConnections: true,
      workboardDatabasePath: bounded(root, 'absent-worker-workboard.sqlite') };
    const store = openDatabase(databasePath);
    const ownedClients = [];
    workerTest.after(async () => {
      try {
        for (const owned of ownedClients) await owned.close();
      } finally { store.close(); }
    });
    const guard = createTaskAccessHook(config);
    const clientPath = bounded(root, `${stateRelative}/${extensionRelative}src/database-worker-client.js`);
    const workerPath = bounded(root, `${stateRelative}/${extensionRelative}src/database-worker.js`);
    const indexPath = bounded(root, `${stateRelative}/${extensionRelative}src/index.js`);
    const sdkRoot = bounded(repository, 'tools/openclaw-runtime/node_modules');
    const sdkPath = bounded(sdkRoot, 'openclaw/dist/plugin-sdk/tool-plugin.js');
    const sdkUrl = pathToFileURL(sdkPath).href;
    const payloadHashes = Object.fromEntries(expected.map(relative => [relative,
      hash(bounded(state, relative))]));
    const { DatabaseWorkerClient } = await import(pathToFileURL(clientPath).href);
    const { routePendingContextChanges } = await import(pathToFileURL(bounded(state, 'src/work-sessions.mjs')).href);

    // Only module resolution is bootstrapped. The installed client, message loop,
    // handlers and real tool-plugin SDK are unmodified; no handler/call is mocked.
    // Compaction is out of scope and fails closed instead of loading Gateway code.
    const bootstrap = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { createHash } from 'node:crypto';
      import { registerHooks } from 'node:module';
      import { fileURLToPath } from 'node:url';
      import { parentPort, threadId, isMainThread } from 'node:worker_threads';
      const bounded = ${bounded.toString()};
      const hash = ${hash.toString()};
      const state = ${JSON.stringify(state)};
      const sdkRoot = ${JSON.stringify(sdkRoot)};
      const sdkUrl = ${JSON.stringify(sdkUrl)};
      const payloadHashes = ${JSON.stringify(payloadHashes)};
      const imported = new Map();
      const core = 'data:text/javascript,' + encodeURIComponent(
        "export function delegateCompactionToRuntime(){throw new Error('G1 forbids Gateway/compaction');}");
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'openclaw/plugin-sdk/core') return { shortCircuit: true, url: core };
        if (specifier.startsWith('openclaw/') && specifier !== 'openclaw/plugin-sdk/tool-plugin') {
          throw new Error('G1 forbids runtime SDK entry: ' + specifier);
        }
        const result = specifier === 'openclaw/plugin-sdk/tool-plugin'
          ? { shortCircuit: true, url: sdkUrl } : next(specifier, context);
        if (result.url.startsWith('file:')) {
          const file = fileURLToPath(result.url);
          const local = path.relative(state, file).split(path.sep).join('/');
          if (Object.hasOwn(payloadHashes, local)) {
            assert.equal(bounded(state, local), file);
            assert.equal(hash(file), payloadHashes[local], 'Installed worker dependency hash: ' + local);
          } else {
            assert.equal(bounded(sdkRoot, path.relative(sdkRoot, file)), file);
          }
          imported.set(file, hash(file));
        } else assert.ok(result.url.startsWith('node:'), 'Unexpected module URL: ' + result.url);
        return result;
      } });
      await import(${JSON.stringify(pathToFileURL(workerPath).href)});
      const { default: plugin } = await import(${JSON.stringify(pathToFileURL(indexPath).href)});
      const { getToolPluginMetadata } = await import(sdkUrl);
      const metadata = getToolPluginMetadata(plugin);
      assert.ok(metadata?.tools.some(tool => tool.name === 'shadow_context_propose'));
      parentPort.postMessage({ g1Ready: { threadId, isMainThread,
        workerPath: ${JSON.stringify(workerPath)}, sdkUrl, sdkToolNames: metadata.tools.map(tool => tool.name),
        imported: [...imported], compaction: 'blocked-test-only' } });
    `;
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
    const threadIds = [];
    let client;
    let worker;
    async function startWorker() {
      client = new DatabaseWorkerClient(config, { workerUrl });
      ownedClients.push(client);
      // A real worker rejection also proves the message/error transport is live.
      const started = client.call('g1_unknown_operation', {});
      worker = client.worker;
      let ready;
      worker.on('message', message => { if (message.g1Ready) ready = message.g1Ready; });
      await assert.rejects(started, /Unknown database tool: g1_unknown_operation/);
      assert.ok(ready, 'Worker must attest actual installed entry and real SDK registration');
      assert.equal(ready.isMainThread, false);
      assert.equal(ready.threadId, worker.threadId);
      assert.ok(ready.threadId > 0 && !threadIds.includes(ready.threadId));
      assert.equal(ready.workerPath, workerPath);
      assert.equal(ready.sdkUrl, sdkUrl);
      const imports = new Map(ready.imported);
      for (const file of [workerPath, indexPath, sdkPath]) assert.equal(imports.get(file), hash(file));
      for (const name of ['shadow_context_capture', 'shadow_context_propose', 'shadow_context_annotate',
        'shadow_attention_packet', 'shadow_context_enrichment', 'shadow_context_ack', 'shadow_context_query']) {
        assert.ok(ready.sdkToolNames.includes(name), `Real SDK registration missing ${name}`);
      }
      assert.equal(client.pending.size, 0);
      threadIds.push(ready.threadId);
      workerTest.diagnostic(JSON.stringify({ phase: 'worker-ready', node: process.version,
        threadId: ready.threadId, isMainThread: ready.isMainThread, workerPath, sdkUrl,
        compaction: ready.compaction, importedModuleCount: imports.size,
        importedGraphHash: createHash('sha256').update(JSON.stringify([...imports].sort())).digest('hex'),
        entryHashes: [clientPath, workerPath, indexPath, sdkPath].map(file => [file, hash(file)]) }));
    }
    const invoke = async (name, params) => {
      const result = await client.call(name, params);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(Array.isArray(result.content), 'Real SDK must wrap the worker result');
      return JSON.parse(result.content.find(item => item.type === 'text').text);
    };
    const invokeAs = async (ctx, name, params) => {
      const access = guard({ toolName: name, params }, ctx);
      if (access?.block) throw new Error(`Policy blocked: ${access.blockReason}`);
      return invoke(name, params);
    };
    const snapshot = () => {
      const db = new DatabaseSync(bounded(root, 'business-worker.sqlite'), { readOnly: true });
      try {
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        return Object.fromEntries([
          ['evidence', 'id'], ['graph_facts', 'id'], ['graph_fact_evidence', 'fact_id,evidence_id'],
          ['graph_evidence_assessments', 'fact_id,evidence_id'], ['graph_episode_annotations', 'evidence_id'],
          ['graph_enrichment_queue', 'evidence_id'], ['context_changes', 'seq'], ['conversation_bindings', 'id'],
        ].map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
      } finally { db.close(); }
    };
    async function recreateWorker(expectedState) {
      assert.equal(client.pending.size, 0, 'Never terminate an in-flight mutation');
      const previousWorker = worker;
      await client.close();
      assert.equal(previousWorker.threadId, -1);
      assert.equal(client.worker, null);
      assert.deepEqual(snapshot(), expectedState, 'Raw read-only reopen before any new worker operation');
      await startWorker();
      assert.notEqual(worker, previousWorker);
      assert.deepEqual(snapshot(), expectedState, 'Worker recreation must not repair or replay writes');
    }

    await startWorker();
    const hints = { keywords: ['worker', 'fixture', 'decision'],
      retrievalCues: ['WorkerFixture value', 'WorkerFixture original decision'] };
    const intake = { sourceType: 'dialogue', title: 'WorkerFixture',
      content: 'WorkerFixture manual decision: the accepted value is A.',
      summary: 'WorkerFixture accepted value A.', externalId: 'g1-worker-manual', ...hints };
    const [captured, duplicate] = await Promise.all([
      invoke('shadow_context_capture', intake), invoke('shadow_context_capture', intake),
    ]);
    assert.equal(captured.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.evidenceId, captured.evidenceId);
    assert.equal(duplicate.reviewEvent.seq, captured.reviewEvent.seq);
    const evidenceId = captured.evidenceId;
    const seq = captured.reviewEvent.seq;
    assert.deepEqual(routePendingContextChanges(store), { routed: 1, sessions: 1 });
    const routed = store.db.prepare('SELECT * FROM context_changes WHERE seq=?').get(seq);
    const binding = store.db.prepare('SELECT * FROM conversation_bindings WHERE session_key=?').get(routed.session_key);
    assert.equal(binding.conversation_key, 'knowledge-curation');
    assert.equal(binding.session_kind, 'workstream');
    assert.equal(routed.kind, 'knowledge_review_due');
    assert.equal(routed.evidence_id, evidenceId);
    assert.ok(Date.parse(routed.not_before) > 0);
    assert.deepEqual(routePendingContextChanges(store), { routed: 0, sessions: 0 });
    // Advance only this synthetic event past debounce; no service, timer or other queue is touched.
    store.db.prepare('UPDATE context_changes SET not_before=? WHERE seq=?').run('2020-01-01T00:00:00.000Z', seq);
    const ctx = { sessionKey: routed.session_key };
    const otherCtx = { sessionKey: 'agent:main:shadow:workstream:g1-unrelated' };
    const leaseOwner = 'g1-worker-curator';
    assert.equal((await invoke('shadow_attention_packet', {
      sessionKey: otherCtx.sessionKey, leaseOwner, limit: 1, maxBytes: 8192,
    })).count, 0);
    const packet = await invoke('shadow_attention_packet', { sessionKey: ctx.sessionKey, leaseOwner, limit: 1, maxBytes: 8192 });
    assert.deepEqual(packet.changes.map(change => change.seq), [seq]);
    assert.deepEqual(packet.changes[0].evidence.map(row => row.id), [evidenceId]);
    const enrichment = await invoke('shadow_context_enrichment', { evidenceIds: [evidenceId], leaseOwner });
    assert.deepEqual(enrichment.episodes.map(row => row.evidence_id), [evidenceId]);
    assert.equal(enrichment.episodes[0].content, intake.content);
    const leased = snapshot();
    assert.equal(leased.evidence.length, 1);
    assert.equal(leased.graph_facts.length, 0, 'Manual intake/lease must not invent a fact');
    for (const table of ['context_changes', 'graph_enrichment_queue']) {
      assert.equal(leased[table].length, 1);
      assert.equal(leased[table][0].status, 'leased');
      assert.equal(leased[table][0].lease_owner, leaseOwner);
    }
    await assert.rejects(invoke('shadow_context_enrichment', { evidenceIds: [evidenceId], leaseOwner: 'wrong' }),
      /not available for review/);
    assert.deepEqual(snapshot(), leased);
    await recreateWorker(leased);
    await assert.rejects(invoke('shadow_context_enrichment', { evidenceIds: [evidenceId], leaseOwner }),
      /not available for review/, 'The same lease cannot acquire the episode twice');
    assert.equal((await invoke('shadow_attention_packet', {
      sessionKey: ctx.sessionKey, leaseOwner: 'competing-lease', limit: 1, maxBytes: 8192,
    })).count, 0, 'An unexpired lease survives worker close/recreate');
    assert.deepEqual(snapshot(), leased);

    const proposalInput = { entities: [{ canonicalKey: 'topic:worker-fixture', type: 'KnowledgeTopic', name: 'WorkerFixture' }],
      rationale: 'Explicit synthetic user decision checked against original evidence', facts: [{
        subjectCanonicalKey: 'topic:worker-fixture', predicate: 'HAS_VALUE', objectValue: 'A',
        sourceEvidenceIds: [evidenceId], evidenceProfile, validFrom: '2024-01-01',
      }] };
    const proposal = await invoke('shadow_context_propose', proposalInput);
    assert.equal(proposal.facts.length, 1);
    const factId = proposal.facts[0].id;
    const queryInput = { query: 'WorkerFixture', depth: 1, maxBytes: 65536, asOf: '2026-06-01' };
    assert.deepEqual((await invoke('shadow_context_query', queryInput)).verifiedFacts, []);
    const reviewInput = { evidenceId, leaseOwner, summary: intake.summary, ...hints,
      graphReview: { status: 'completed', outcome: 'facts_recorded', factIds: [factId],
        rationale: 'Original manual decision supports this exact fact' } };
    const beforeReview = snapshot();
    await assert.rejects(invoke('shadow_context_annotate', { ...reviewInput, leaseOwner: 'wrong' }), /is leased by/);
    assert.deepEqual(snapshot(), beforeReview, 'Rejected worker mutation must leave no partial review');
    const review = await invoke('shadow_context_annotate', reviewInput);
    assert.equal(review.queueStatus, 'completed');
    const verified = (await invoke('shadow_context_query', queryInput)).verifiedFacts;
    assert.deepEqual(verified.map(row => row.id), [factId]);
    assert.equal(verified[0].evidence.id, evidenceId);

    const ack = { sequences: [seq], leaseOwner, disposition: 'processed', note: 'G1 worker review completed.' };
    const beforeAck = snapshot();
    for (const [identity, params] of [[ctx, { ...ack, leaseOwner: 'wrong' }], [otherCtx, ack],
      [ctx, { ...ack, sequences: [seq, seq + 1000] }]]) {
      const dispatched = client.sequence;
      await assert.rejects(invokeAs(identity, 'shadow_context_ack', params), /Policy blocked:/);
      assert.equal(client.sequence, dispatched, 'Rejected policy call never reaches the worker');
      assert.deepEqual(snapshot(), beforeAck);
    }
    assert.equal((await invoke('shadow_context_ack', { ...ack, leaseOwner: 'wrong' })).updated, 0);
    assert.deepEqual(snapshot(), beforeAck, 'Worker independently rejects a wrong lease');
    const receipt = await invokeAs(ctx, 'shadow_context_ack', ack);
    assert.deepEqual(receipt, { updated: 1, disposition: 'processed', sequences: [seq] });
    const acknowledged = snapshot();
    const queueReceipt = acknowledged.context_changes[0];
    assert.equal(queueReceipt.seq, seq);
    assert.equal(queueReceipt.evidence_id, evidenceId);
    assert.equal(queueReceipt.session_key, ctx.sessionKey);
    assert.equal(queueReceipt.status, 'acknowledged');
    assert.equal(queueReceipt.lease_owner, leaseOwner);
    assert.equal(queueReceipt.lease_until, null);
    assert.equal(queueReceipt.ack_note, ack.note);
    assert.ok(Number.isFinite(Date.parse(queueReceipt.acknowledged_at)));
    const persistedReview = JSON.parse(acknowledged.graph_episode_annotations[0].metadata_json).graphReview;
    assert.equal(persistedReview.reviewVersion, review.reviewVersion);
    assert.deepEqual(persistedReview.factIds, [factId]);
    await assert.rejects(invokeAs(ctx, 'shadow_context_ack', ack), /Policy blocked:/);
    assert.equal((await invoke('shadow_context_ack', ack)).updated, 0, 'Duplicate ACK is not another receipt');
    assert.deepEqual(snapshot(), acknowledged);

    await recreateWorker(acknowledged);
    assert.deepEqual((await invoke('shadow_context_query', queryInput)).verifiedFacts, verified);
    const originals = await invoke('shadow_evidence_search', { evidenceIds: [evidenceId] });
    assert.deepEqual(originals.matches.map(row => row.evidenceId), [evidenceId]);
    assert.equal(originals.matches[0].content, intake.content);
    assert.equal((await invoke('shadow_attention_packet', {
      sessionKey: ctx.sessionKey, leaseOwner, limit: 1, maxBytes: 8192,
    })).count, 0);
    assert.deepEqual(snapshot(), acknowledged, 'Exact IDs, facts, review and ACK receipt survive recreation/readback');
    assert.deepEqual(routePendingContextChanges(store), { routed: 0, sessions: 0 });
    await assert.rejects(invokeAs(ctx, 'shadow_context_ack', ack), /Policy blocked:/);
    assert.equal((await invoke('shadow_context_ack', ack)).updated, 0);
    const replayCapture = await invoke('shadow_context_capture', intake);
    assert.equal(replayCapture.evidenceId, evidenceId);
    assert.equal(replayCapture.inserted, false);
    assert.deepEqual(snapshot().graph_episode_annotations, acknowledged.graph_episode_annotations,
      'Intake replay alone must preserve the completed review before any explicit re-review');
    assert.deepEqual(snapshot().context_changes, acknowledged.context_changes);
    assert.equal((await invoke('shadow_context_propose', proposalInput)).facts[0].id, factId);
    const reviewedAgain = await invoke('shadow_context_annotate', reviewInput);
    assert.equal(reviewedAgain.reviewVersion, review.reviewVersion);
    const final = snapshot();
    assert.deepEqual(final.context_changes, acknowledged.context_changes);
    assert.equal(final.evidence.length, 1);
    assert.equal(final.evidence[0].id, evidenceId);
    assert.equal(final.graph_facts.length, 1);
    assert.equal(final.graph_facts[0].id, factId);
    assert.equal(JSON.parse(final.graph_facts[0].object_value), 'A');
    for (const table of ['graph_fact_evidence', 'graph_evidence_assessments']) {
      assert.deepEqual(final[table].map(({ fact_id, evidence_id }) => ({ fact_id, evidence_id })),
        [{ fact_id: factId, evidence_id: evidenceId }]);
    }
    assert.equal(final.graph_episode_annotations[0].review_status, 'completed');
    // Explicit re-review refreshes its audit time; recreation above must preserve even timestamps.
    const { reviewedAt: originalReviewTime, ...originalReview } = persistedReview;
    const { reviewedAt: replayReviewTime, ...replayedReview } = JSON.parse(final.graph_episode_annotations[0].metadata_json).graphReview;
    assert.deepEqual(replayedReview, originalReview);
    assert.ok(Date.parse(replayReviewTime) >= Date.parse(originalReviewTime));
    assert.equal(final.graph_enrichment_queue[0].status, 'completed');
    assert.deepEqual((await invoke('shadow_context_query', queryInput)).verifiedFacts.map(row => row.id), [factId]);
    assert.equal(fs.existsSync(config.workboardDatabasePath), false);
    assert.ok(fs.statSync(databasePath).size < 16 * 1024 * 1024, 'Synthetic small SQLite, never the production baseline');
    verifyArtifacts();
    workerTest.diagnostic(JSON.stringify({ phase: 'persisted-worker-chain', threadIds, evidenceId, factId,
      receipt, queueReceipt, review: persistedReview, databaseBytes: fs.statSync(databasePath).size,
      boundary: 'Real SDK registration and worker transport; policy invoked explicitly, not Gateway hook dispatch; worker close/recreate, not service restart.' }));
  });
  verifyArtifacts();
});
