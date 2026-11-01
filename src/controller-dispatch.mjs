export class SessionDispatchQueue {
  constructor() {
    this.queues = new Map();
  }

  run(sessionKey, operation) {
    const key = String(sessionKey ?? "").trim();
    if (!key) throw new Error("Session dispatch requires a stable session key.");
    if (typeof operation !== "function") throw new Error("Session dispatch requires an operation.");
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation).finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
    this.queues.set(key, current);
    return current;
  }

  pending(sessionKey) {
    if (sessionKey === undefined) return this.queues.size;
    return this.queues.has(String(sessionKey)) ? 1 : 0;
  }
}
