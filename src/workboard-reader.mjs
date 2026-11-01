// UI reads never execute Agent tools or contribute to tool-loop detection.
const readers = new WeakMap();

export async function readWorkboardProjection(client, { maxAgeMs = 0, now = Date.now } = {}) {
  let state = readers.get(client);
  if (!state) {
    state = { pending: null, cards: null, fetchedAt: 0 };
    readers.set(client, state);
  }
  if (state.pending) return state.pending;
  if (state.cards && maxAgeMs > 0 && now() - state.fetchedAt < maxAgeMs) return state.cards;
  state.pending = (async () => {
    const result = await client.request("workboard.cards.list", {});
    if (!Array.isArray(result?.cards)) throw new Error("Invalid Workboard read response.");
    state.cards = result.cards;
    state.fetchedAt = now();
    return state.cards;
  })();
  try { return await state.pending; }
  finally { state.pending = null; }
}
