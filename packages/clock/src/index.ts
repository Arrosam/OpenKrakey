import type { Clock } from "../../../contracts/clock";

/**
 * Per-Agent "dumb" timer with dual intervals (default + current).
 *
 * Each beat counts down `currentIntervalMs`; after every activation `current`
 * resets back to `defaultIntervalMs`. Arming uses a recursive setTimeout so each
 * (re-)arm captures the value current at arm time. The tick is NOT bridged to any
 * event-system here — that wiring lives in agent_instance.
 */
export function createClock(opts: { defaultIntervalMs: number }): Clock {
  let defaultIntervalMs = opts.defaultIntervalMs;
  let currentIntervalMs = defaultIntervalMs;
  let handler: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let countdownStart = 0;

  /** Arm a fresh countdown for `currentIntervalMs` and stamp its start. */
  function arm(): void {
    countdownStart = Date.now();
    timer = setTimeout(onTimer, currentIntervalMs);
  }

  /** Re-arm for an explicit duration WITHOUT moving countdownStart (used when a
   *  shortened/lengthened interval must still fire at absolute `ms` from origin). */
  function rearmRemaining(ms: number): void {
    timer = setTimeout(onTimer, ms);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Perform one activation: invoke the handler (if any), reset current to default,
   * then — only if still running — re-arm a fresh countdown. The handler runs
   * BEFORE re-arming, and `running` is re-checked afterwards in case it called stop.
   */
  function activate(): void {
    if (handler !== null) {
      handler();
    }
    currentIntervalMs = defaultIntervalMs;
    if (running) {
      arm();
    }
  }

  /** Fired when a pending timer elapses. */
  function onTimer(): void {
    timer = null;
    if (!running) {
      return;
    }
    activate();
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      arm();
    },

    stop(): void {
      if (!running) {
        return;
      }
      running = false;
      clearTimer();
    },

    setInterval(ms: number): void {
      currentIntervalMs = ms;
      const elapsed = Date.now() - countdownStart;
      if (ms <= elapsed) {
        // The new interval is already satisfied — behave as if the countdown completed.
        clearTimer();
        activate();
      } else if (running) {
        // Reschedule to fire at absolute `ms` from the original start.
        clearTimer();
        rearmRemaining(ms - elapsed);
      }
      // If not running and ms > elapsed: just record the new current (done above).
    },

    setDefaultInterval(ms: number): void {
      defaultIntervalMs = ms;
    },

    fireNow(): void {
      clearTimer();
      activate();
    },

    onFire(h: () => void): void {
      handler = h;
    },
  };
}
