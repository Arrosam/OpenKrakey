/**
 * Contract: event-system  ·  connects: event-system (impl) ↔ orchestrator, loader, agent_instance
 *
 * The per-Agent INDEPENDENT central bus. clock (tick), loader (plugin wiring),
 * orchestrator (subscribe/dispatch) and all plugins connect here. Kept separate
 * precisely because so many parts plug in.
 */
export type Unsub = () => void;

/** Publish/subscribe notifications. */
export interface EventBus {
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: (payload: unknown) => void): Unsub;
}

/** Registerable, invokable operations. */
export interface ActionBus {
  register(action: string, handler: (params: unknown) => Promise<unknown>): Unsub;
  invoke(action: string, params?: unknown): Promise<unknown>;
  has(action: string): boolean;
  list(): string[];
}

export interface EventSystem {
  readonly events: EventBus;
  readonly actions: ActionBus;
}
