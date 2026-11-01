// Applied at the native Codex tool boundary, before redaction and JSON rendering.
export function boundCodexSession(thread, params = {}) {
  const integer = (value, fallback, min, max) => Number.isInteger(Number(value))
    ? Math.max(min, Math.min(max, Number(value))) : fallback;
  const limit = integer(params.turn_limit, 2, 1, 10);
  const offset = integer(params.turn_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const itemLimit = integer(params.item_limit, 12, 1, 40);
  const itemOffset = integer(params.item_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxBytes = integer(params.max_bytes, 16384, 4096, 32768);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const end = Math.max(0, turns.length - offset);
  const start = Math.max(0, end - limit);
  const window = {
    totalTurns: turns.length, start, end,
    nextTurnOffset: start > 0 ? turns.length - start : null,
    items: [], truncated: false,
    guidance: 'Bounded transcript, not complete history. Offsets count from newest; use turn_limit=1 and item_offset to page older items. Truncated text is not full verification evidence; inspect the source locator for exact details.',
  };
  let remaining = Math.max(512, Math.floor((maxBytes - 1800) / 2));
  let nodes = 0;
  const omitted = () => { window.truncated = true; return '[omitted: use a smaller page or source locator]'; };
  const clip = (value, depth = 0) => {
    if (++nodes > 300 || depth > 10 || remaining <= 0) return omitted();
    if (typeof value === 'string') {
      const allowed = Math.min(remaining, 2048);
      let text = value.slice(0, allowed);
      while (Buffer.byteLength(JSON.stringify(text), 'utf8') > allowed && text.length) text = text.slice(0, Math.floor(text.length * 0.8));
      remaining -= Buffer.byteLength(JSON.stringify(text), 'utf8');
      if (text.length !== value.length) { window.truncated = true; text += ` [truncated; original ${value.length} chars]`; }
      return text;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') { remaining -= 16; return value; }
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value.slice(0, 40)) { if (remaining <= 0 || nodes > 300) break; result.push(clip(item, depth + 1)); }
      if (result.length !== value.length) result.push(omitted());
      return result;
    }
    if (value && typeof value === 'object') {
      const result = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (++count > 40 || nodes > 300 || remaining <= 0) { result._omitted = omitted(); break; }
        const safeKey = key.slice(0, 100);
        remaining -= Buffer.byteLength(safeKey, 'utf8') + 8;
        result[safeKey] = clip(value[key], depth + 1);
      }
      return result;
    }
    return null;
  };
  const result = {};
  for (const key of ['id', 'name', 'cwd', 'path', 'createdAt', 'updatedAt', 'status', 'modelProvider']) {
    if (thread?.[key] !== undefined) result[key] = clip(thread[key]);
  }
  // Budget newest outcomes first, but render turns and items in chronological order.
  result.turns = turns.slice(start, end).reverse().map(turn => {
    const items = Array.isArray(turn.items) ? turn.items : [];
    const itemEnd = Math.max(0, items.length - itemOffset);
    const itemStart = Math.max(0, itemEnd - itemLimit);
    window.items.push({ turnId: String(turn.id ?? '').slice(0, 200), totalItems: items.length,
      start: itemStart, end: itemEnd, nextItemOffset: itemStart > 0 ? items.length - itemStart : null });
    return { id: clip(turn.id), status: clip(turn.status),
      ...(turn.error ? { error: clip(turn.error) } : {}),
      items: items.slice(itemStart, itemEnd).reverse().map(item => clip(item)).reverse() };
  }).reverse();
  result.transcriptWindow = window;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    result.turns = result.turns.map(turn => ({ id: turn.id, status: turn.status, items: [omitted()] }));
  }
  return result;
}
