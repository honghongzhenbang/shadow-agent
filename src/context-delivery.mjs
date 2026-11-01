// Delivery cursors reference immutable Evidence; no transcript bodies are copied.
export const COMPLETE_EVIDENCE_POLICY = "complete-evidence-v1";

export function initializeContextDelivery(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_change_evidence (
      change_seq INTEGER NOT NULL REFERENCES context_changes(seq) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      consumed_offset INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(change_seq, evidence_id)
    );
    CREATE TABLE IF NOT EXISTS context_change_delivery (
      change_seq INTEGER NOT NULL REFERENCES context_changes(seq) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      lease_owner TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      total_length INTEGER NOT NULL,
      PRIMARY KEY(change_seq, evidence_id)
    );
  `);
}

export function appendChangeEvidence(db, seq, ids) {
  const insert = db.prepare("INSERT INTO context_change_evidence(change_seq,evidence_id) VALUES(?,?) ON CONFLICT DO NOTHING");
  for (const id of new Set(ids.filter(Boolean))) insert.run(seq, id);
}

export function changeCoverage(db, seq) {
  const row = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(done),0) AS completed FROM context_change_evidence WHERE change_seq=?").get(seq);
  return { total: Number(row.total), completed: Number(row.completed), remaining: Number(row.total - row.completed) };
}

function prefix(text, maxBytes) {
  let result = "", size = 0;
  for (const c of text) {
    const bytes = Buffer.byteLength(c);
    if (size + bytes > maxBytes) break;
    result += c; size += bytes;
  }
  return result;
}

export function nextEvidencePage(db, seq, { limit = 12, bodyBytes = 1800 } = {}) {
  const rows = db.prepare(`SELECT e.*, m.consumed_offset FROM context_change_evidence m
    JOIN evidence e ON e.id=m.evidence_id WHERE m.change_seq=? AND m.done=0
    ORDER BY COALESCE(e.occurred_at,e.collected_at),e.id LIMIT ?`).all(seq, limit);
  const page = [];
  for (const row of rows) {
    const text = String(row.content ?? ""), start = Number(row.consumed_offset);
    if (start > text.length) throw new Error("Immutable Evidence content changed behind a delivery cursor.");
    const content = prefix(text.slice(start), bodyBytes);
    if (start < text.length && !content) throw new Error("Delivery budget cannot fit one character.");
    const end = start + content.length;
    page.push({ ...row, content, contentRange: { start, end, total: text.length, complete: end === text.length } });
    if (end < text.length) break;
  }
  return page;
}

export function recordEvidenceDelivery(db, seq, leaseOwner, evidence) {
  db.prepare("DELETE FROM context_change_delivery WHERE change_seq=?").run(seq);
  const insert = db.prepare("INSERT INTO context_change_delivery VALUES(?,?,?,?,?,?)");
  for (const e of evidence) insert.run(seq, e.id, leaseOwner, e.contentRange.start, e.contentRange.end, e.contentRange.total);
}

export function acknowledgeEvidenceDelivery(db, seq, leaseOwner) {
  const rows = db.prepare("SELECT * FROM context_change_delivery WHERE change_seq=? AND lease_owner=?").all(seq, leaseOwner);
  if (!rows.length) throw new Error("Read the complete-evidence attention page before acknowledging it.");
  const update = db.prepare(`UPDATE context_change_evidence SET consumed_offset=?,done=?
    WHERE change_seq=? AND evidence_id=? AND consumed_offset=? AND done=0`);
  for (const r of rows) {
    const result = update.run(r.end_offset, Number(r.end_offset === r.total_length), seq, r.evidence_id, r.start_offset);
    if (Number(result.changes) !== 1) throw new Error("Stale evidence delivery; re-read the current page.");
  }
  db.prepare("DELETE FROM context_change_delivery WHERE change_seq=?").run(seq);
  return changeCoverage(db, seq);
}
