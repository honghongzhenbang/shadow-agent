import { createHash } from 'node:crypto';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function id(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) {
    fail('INVALID_INPUT', `Invalid ${name}.`);
  }
  return value.trim();
}
function token(row) {
  return createHash('sha256').update(JSON.stringify([row.id, row.person_id, row.recording_id,
    row.speaker_label, row.embedding_model, row.embedding_json, row.evidence_id, row.active, row.created_at])).digest('hex');
}

export function checkedVoiceSample(store, { sampleId, revisionToken } = {}) {
  sampleId = id(sampleId, 'sampleId');
  if (revisionToken !== undefined && (typeof revisionToken !== 'string' || !/^[a-f0-9]{64}$/.test(revisionToken))) {
    fail('INVALID_INPUT', 'Invalid sample revisionToken.');
  }
  const row = store.db.prepare('SELECT * FROM voice_speaker_samples WHERE id=?').get(sampleId);
  if (row && revisionToken !== undefined && token(row) !== revisionToken) {
    fail('STALE_SAMPLE', '声纹样本已变更，请刷新后重新选择。');
  }
  return row;
}

// Template management never revises the source transcript, identity evidence or knowledge.
export function forgetVoiceSample(store, input) {
  return store.transaction(() => {
    const row = checkedVoiceSample(store, input);
    const removed = row ? Number(store.db.prepare('DELETE FROM voice_speaker_samples WHERE id=?').run(row.id).changes) : 0;
    return { removed, note: 'Embedding removed; original audio and annotation evidence are unchanged.' };
  });
}

export function listVoiceSamples(store, { personId, recordingId, query = '', status = 'all', page = 1, pageSize = 25 } = {}) {
  if (!['all', 'active', 'inactive'].includes(status) || !Number.isSafeInteger(page) || page < 1
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('INVALID_INPUT', 'Invalid sample page or status.');
  const conditions = [], params = [];
  if (typeof query !== 'string' || query.length > 160) fail('INVALID_INPUT', 'Invalid sample query.');
  query = query.trim();
  if (query) {
    conditions.push("(instr(COALESCE(p.name,''),?)>0 OR instr(s.recording_id,?)>0 OR instr(COALESCE(json_extract(r.metadata_json,'$.title'),''),?)>0)");
    params.push(query, query, query);
  }
  if (personId !== undefined) { conditions.push('s.person_id=?'); params.push(id(personId, 'personId')); }
  if (recordingId !== undefined) { conditions.push('s.recording_id=?'); params.push(id(recordingId, 'recordingId')); }
  if (status !== 'all') { conditions.push('s.active=?'); params.push(status === 'active' ? 1 : 0); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM voice_speaker_samples s LEFT JOIN graph_entities p ON p.id=s.person_id
    LEFT JOIN voice_recordings r ON r.id=s.recording_id`;
  const total = store.db.prepare(`SELECT COUNT(*) n ${from} ${where}`).get(...params).n;
  const totalPages = Math.ceil(total / pageSize);
  page = Math.min(page, Math.max(1, totalPages));
  const rows = store.db.prepare(`SELECT s.*,p.name,r.recorded_at,r.metadata_json AS recording_metadata,
    r.status AS recording_status, EXISTS(SELECT 1 FROM voice_segments v WHERE v.recording_id=s.recording_id
      AND v.speaker_label=s.speaker_label) AS current_label
    ${from} ${where}
    ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  return {
    pagination: { page, pageSize, total, totalPages, hasPrevious: page > 1, hasNext: page < totalPages },
    samples: rows.map(row => {
      let metadata;
      try { metadata = JSON.parse(row.recording_metadata ?? '{}'); } catch { metadata = {}; }
      return { id: row.id, name: row.name ?? null, person_id: row.person_id, recording_id: row.recording_id,
        speaker_label: row.speaker_label, embedding_model: row.embedding_model, active: row.active,
        created_at: row.created_at, revisionToken: token(row), recordedAt: row.recorded_at,
        title: String(metadata?.title ?? 'Voice recording').slice(0, 120),
        sourceVersion: row.current_label ? 'current' : row.recording_status === 'ready' ? 'historical' : 'unavailable' };
    }),
  };
}
