import { AsyncLocalStorage } from 'node:async_hooks';

// Shared-client callbacks run in the transport's context, which can outlive its
// root. Restore the context of this route without retaining or replacing leases.
export function bindCodexRouteHandlers(handlers) {
  const invoke = AsyncLocalStorage.snapshot();
  const bound = { ...handlers };
  for (const name of ['onRequest', 'onNotification', 'onNotificationReceived']) {
    const handler = handlers[name];
    if (typeof handler !== 'function') continue;
    bound[name] = function (...args) {
      return invoke(() => Reflect.apply(handler, this, args));
    };
  }
  return bound;
}
