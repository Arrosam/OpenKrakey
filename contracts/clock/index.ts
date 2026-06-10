/**
 * Contract: clock  ·  connects: clock (impl) ↔ orchestrator, agent_instance
 *
 * A per-Agent "dumb" timer. It holds a DEFAULT interval and a CURRENT interval:
 * each beat counts down `current`; after every activation `current` resets back
 * to `default`. It only activates (calls the single handler) — never schedules or
 * decides content. Its rhythm is controllable from outside, and changes take
 * effect on the CURRENT beat, not deferred to the next:
 *
 *  - setInterval(ms): set THIS beat's interval, effective immediately. If `ms` is
 *    <= the time already elapsed in the current countdown, it fires now; otherwise
 *    it reschedules to fire when `ms` is reached. (Resets to default after firing.)
 *  - setDefaultInterval(ms): change the baseline that `current` resets to (runtime).
 *
 * Lifecycle semantics: before start() and after stop() there is NO countdown in
 * progress — setInterval(ms) then only RECORDS the new current interval (it never
 * fires); the recorded value is used when the clock (re)starts. fireNow() fires
 * regardless of running state. Re-entrant calls from inside the fire handler
 * (fireNow / setInterval) are safe: the clock never leaves more than one armed
 * timer.
 *
 * The default is loaded from the Agent's config by the wirer (agent_instance), not
 * read here. The tick is bridged onto the event-system as a `clock.tick` event by
 * the wirer too. Runtime rhythm control is exposed to plugins by the orchestrator
 * via well-known actionbus actions (see shared/actions Actions.CLOCK_*).
 */
export interface Clock {
  start(): void;
  stop(): void;
  /**
   * Set the CURRENT beat's interval, effective immediately (this beat). If `ms` is
   * <= the time already elapsed in the current countdown, fires now; otherwise
   * reschedules to fire at `ms`. After each activation, `current` resets to default.
   * When the clock is NOT running (never started, or stopped), this only records
   * the new current interval — it never fires.
   */
  setInterval(ms: number): void;
  /** Set the DEFAULT interval — the baseline `current` resets to after each activation. */
  setDefaultInterval(ms: number): void;
  /** Fire immediately and reset the countdown (to the current interval). */
  fireNow(): void;
  /** Register the single handler invoked on every activation (later call replaces). */
  onFire(handler: () => void): void;
}
