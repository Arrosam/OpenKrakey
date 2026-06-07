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
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  return {
    emit(event: string, payload?: unknown): void {
      const set = listeners.get(event);
      if (set === undefined || set.size === 0) return;
      // Snapshot so unsubscribes during emit don't corrupt iteration.
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch {
          // A throwing listener must not stop the others.
        }
      }
    },

    on(event: string, handler: (payload: unknown) => void): Unsub {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
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
        handlers.delete(action);
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
