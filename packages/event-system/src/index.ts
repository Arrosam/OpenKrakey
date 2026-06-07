/**
 * event-system — the per-Agent independent central bus.
 *
 * Implements the {@link EventSystem} contract: a fire-and-forget pub/sub
 * {@link EventBus} and a registerable, invokable {@link ActionBus}.
 */
import type {
  EventSystem,
  EventBus,
  ActionBus,
  Unsub,
} from "../../../contracts/event-system";

function createEventBus(): EventBus {
  // Array (not Set) so each on() is an INDEPENDENT subscription: the same
  // handler may be registered twice, and each registration has its own Unsub
  // that removes exactly one occurrence (so one plugin's unsub can never remove
  // another's subscription of the same shared function).
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  return {
    emit(event: string, payload?: unknown): void {
      const arr = listeners.get(event);
      if (arr === undefined || arr.length === 0) return;
      // Snapshot so (un)subscribes during emit don't corrupt iteration.
      for (const handler of [...arr]) {
        try {
          handler(payload);
        } catch {
          // A throwing listener must not stop the others.
        }
      }
    },

    on(event: string, handler: (payload: unknown) => void): Unsub {
      let arr = listeners.get(event);
      if (arr === undefined) {
        arr = [];
        listeners.set(event, arr);
      }
      arr.push(handler);
      let active = true;
      return () => {
        if (!active) return; // stale-safe: each Unsub removes at most one occurrence
        active = false;
        const current = listeners.get(event);
        if (current === undefined) return;
        const i = current.indexOf(handler);
        if (i !== -1) current.splice(i, 1);
      };
    },
  };
}

function createActionBus(): ActionBus {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();

  return {
    register(
      action: string,
      handler: (params: unknown) => Promise<unknown>,
    ): Unsub {
      if (handlers.has(action)) {
        throw new Error("Action already registered: " + action);
      }
      handlers.set(action, handler);
      return () => {
        // Identity-safe: a stale Unsub must NOT remove a re-registered action
        // of the same name (only delete if THIS handler is still the live one).
        if (handlers.get(action) === handler) {
          handlers.delete(action);
        }
      };
    },

    invoke(action: string, params?: unknown): Promise<unknown> {
      const handler = handlers.get(action);
      if (handler === undefined) {
        return Promise.reject(new Error("Unknown action: " + action));
      }
      return handler(params);
    },

    has(action: string): boolean {
      return handlers.has(action);
    },

    list(): string[] {
      return [...handlers.keys()];
    },
  };
}

export function createEventSystem(): EventSystem {
  return {
    events: createEventBus(),
    actions: createActionBus(),
  };
}
