/**
 * A lightweight callback list utility.
 *
 * Replaces the repeated pattern of:
 *   1. Store an array of callbacks
 *   2. Provide an on*() method that adds a callback and returns an unsubscribe function
 *   3. Invoke all callbacks with error isolation
 *
 * @example
 * ```ts
 * const onCreated = createCallbackList<AgentContainer>();
 * // register:
 * const unsub = onCreated.add(agent => console.log(agent.id));
 * // fire:
 * onCreated.invoke(agent);
 * // unsubscribe:
 * unsub();
 * ```
 */
export function createCallbackList<T>(): {
  add(cb: (arg: T) => void): () => void;
  invoke(arg: T): void;
} {
  const callbacks: Array<(arg: T) => void> = [];

  return {
    add(cb: (arg: T) => void): () => void {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },

    invoke(arg: T): void {
      for (const cb of callbacks) {
        try {
          cb(arg);
        } catch (err) {
          console.error('[CallbackList] callback error:', err);
        }
      }
    },
  };
}
