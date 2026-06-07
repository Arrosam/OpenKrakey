/**
 * Contract: clock  ·  connects: clock (impl) ↔ orchestrator, agent_instance
 *
 * A per-Agent "dumb" timer. Counts down and, on each tick, ACTIVATES by calling
 * the registered handler — it only activates, never schedules or decides content.
 * Its rhythm is controllable from outside (the orchestrator coordinates it; the
 * tick is bridged onto the event-system as a `clock.tick` event by the wirer).
 */
export interface Clock {
  start(): void;
  stop(): void;
  /** Countdown length (ms) for subsequent ticks. */
  setInterval(ms: number): void;
  /** Fire immediately and reset the countdown. */
  fireNow(): void;
  /** Register the single handler invoked on every activation. */
  onFire(handler: () => void): void;
}
