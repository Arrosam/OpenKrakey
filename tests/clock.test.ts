/**
 * Black-box edge tests for the `clock` contract.
 *
 * Tested ONLY against the observable behavior described in `contracts/clock/index.ts`:
 *   - start() / stop() (idempotent)
 *   - setInterval(ms): the CURRENT beat, effective immediately this beat
 *       (ms <= elapsed -> fire now;  ms > elapsed -> reschedule to absolute ms)
 *   - setDefaultInterval(ms): change the baseline that `current` resets to (does not itself fire)
 *   - fireNow(): fire immediately + reset countdown, regardless of started state
 *   - onFire(handler): single handler, later call replaces; firing with no handler must not throw
 *   - after every activation, `current` resets to `default`
 *
 * Determinism: node:test fake timers for both setTimeout and Date, because the clock
 * measures `elapsed` via Date.now(). Advance with mock.timers.tick(ms).
 */
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../packages/clock/src";
import type { Clock } from "../contracts/clock";

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
});

afterEach(() => {
  mock.timers.reset();
});

/** A fresh fire-counter wired via onFire. Returns {clock, count()} helpers. */
function makeCounter(clock: Clock) {
  let fired = 0;
  clock.onFire(() => {
    fired += 1;
  });
  return {
    count: () => fired,
  };
}

// ---------------------------------------------------------------------------
// 1. After start(), the handler fires once per defaultIntervalMs.
// ---------------------------------------------------------------------------
test("start: handler fires once per defaultIntervalMs across several intervals", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  assert.equal(c.count(), 0, "no fire before any time elapses");

  mock.timers.tick(100); // beat 1
  assert.equal(c.count(), 1);

  mock.timers.tick(100); // beat 2
  assert.equal(c.count(), 2);

  mock.timers.tick(100); // beat 3
  assert.equal(c.count(), 3);

  // Mid-interval: no extra fire until the full interval elapses.
  mock.timers.tick(50);
  assert.equal(c.count(), 3, "partial interval does not fire");

  mock.timers.tick(50); // completes beat 4
  assert.equal(c.count(), 4);
});

// ---------------------------------------------------------------------------
// 2. start() is idempotent — calling twice does not double the firing rate.
// ---------------------------------------------------------------------------
test("start: idempotent — second start() does not double the firing rate", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  clock.start(); // must be a no-op, not a second concurrent timer

  mock.timers.tick(100);
  assert.equal(c.count(), 1, "exactly one fire per interval, not two");

  mock.timers.tick(100);
  assert.equal(c.count(), 2);

  // Repeated starts mid-run still must not stack timers.
  clock.start();
  clock.start();
  mock.timers.tick(100);
  assert.equal(c.count(), 3);
});

// ---------------------------------------------------------------------------
// 3. stop() halts firing; idempotent (calling when stopped is a no-op).
// ---------------------------------------------------------------------------
test("stop: halts firing and is idempotent when already stopped", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  // Stopping before ever starting is a harmless no-op.
  clock.stop();

  clock.start();
  mock.timers.tick(100);
  assert.equal(c.count(), 1);

  clock.stop();
  mock.timers.tick(500); // plenty of intervals — none should fire
  assert.equal(c.count(), 1, "no fires after stop()");

  // Idempotent: stopping again changes nothing.
  clock.stop();
  mock.timers.tick(500);
  assert.equal(c.count(), 1);
});

// ---------------------------------------------------------------------------
// 4. onFire(h2) replaces a previously registered handler (only the latest fires).
// ---------------------------------------------------------------------------
test("onFire: a later handler replaces the earlier one (single handler)", () => {
  const clock = createClock({ defaultIntervalMs: 100 });

  let firstCount = 0;
  let secondCount = 0;
  clock.onFire(() => {
    firstCount += 1;
  });
  clock.onFire(() => {
    secondCount += 1;
  });

  clock.start();
  mock.timers.tick(100);
  mock.timers.tick(100);

  assert.equal(firstCount, 0, "replaced handler must not fire");
  assert.equal(secondCount, 2, "only the latest handler fires");
});

// ---------------------------------------------------------------------------
// 5. Firing with NO handler registered must not throw.
// ---------------------------------------------------------------------------
test("activation with no handler registered does not throw", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  // Intentionally no onFire().
  clock.start();
  assert.doesNotThrow(() => {
    mock.timers.tick(100); // activation occurs here with no handler
  });
  // A subsequent interval must also be safe.
  assert.doesNotThrow(() => {
    mock.timers.tick(100);
  });
});

// ---------------------------------------------------------------------------
// 6. fireNow() fires immediately and resets the countdown — works started or not.
// ---------------------------------------------------------------------------
test("fireNow: fires immediately while started and resets the countdown", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  mock.timers.tick(60); // partway through the first beat
  assert.equal(c.count(), 0);

  clock.fireNow(); // immediate activation
  assert.equal(c.count(), 1, "fireNow fires immediately");

  // Countdown was reset to current (default 100) at the fireNow instant,
  // so the prior 60ms no longer counts toward the next beat.
  mock.timers.tick(60); // total 120 since start, but only 60 since fireNow reset
  assert.equal(c.count(), 1, "countdown restarted from fireNow; not yet due");

  mock.timers.tick(40); // now 100ms since the fireNow reset
  assert.equal(c.count(), 2, "next beat fires one full interval after fireNow");
});

test("fireNow: fires immediately even when never started", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  // Never called start().
  clock.fireNow();
  assert.equal(c.count(), 1, "fireNow works regardless of started state");

  // Calling it again immediately fires again (each call is one activation).
  clock.fireNow();
  assert.equal(c.count(), 2);
});

// ---------------------------------------------------------------------------
// 7. setInterval(ms) IMMEDIATE this beat: ms <= elapsed -> fire now.
// ---------------------------------------------------------------------------
test("setInterval: ms <= elapsed fires immediately (this beat)", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  mock.timers.tick(60); // elapsed = 60 in the current countdown
  assert.equal(c.count(), 0, "default beat not yet due");

  clock.setInterval(50); // 50 <= 60 -> fire NOW
  assert.equal(c.count(), 1, "setInterval(ms<=elapsed) fires immediately");
});

// ---------------------------------------------------------------------------
// 8. setInterval(ms) with ms > elapsed reschedules to fire at absolute ms.
// ---------------------------------------------------------------------------
test("setInterval: ms > elapsed reschedules to fire at absolute ms", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  mock.timers.tick(30); // elapsed = 30
  clock.setInterval(200); // 200 > 30 -> reschedule to absolute 200 (170 more)

  mock.timers.tick(70); // reach t=100 (the OLD default boundary)
  assert.equal(c.count(), 0, "must NOT fire at the original default boundary");

  mock.timers.tick(100); // reach t=200 (the new absolute target)
  assert.equal(c.count(), 1, "fires at the rescheduled absolute ms");
});

// ---------------------------------------------------------------------------
// 9. After any activation, current RESETS to default — a one-off setInterval
//    affects only that beat; the next beat uses default again.
// ---------------------------------------------------------------------------
test("setInterval: one-off interval affects only that beat; next beat reverts to default", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  mock.timers.tick(30); // elapsed = 30
  clock.setInterval(200); // reschedule current beat to absolute 200

  mock.timers.tick(170); // t=200 -> beat 1 fires; current resets to default (100)
  assert.equal(c.count(), 1);

  // Next beat must use the DEFAULT (100), not the one-off 200.
  mock.timers.tick(99);
  assert.equal(c.count(), 1, "next beat not due before the default interval");
  mock.timers.tick(1); // t=300 -> 100ms after the reset
  assert.equal(c.count(), 2, "next beat uses the default interval again");

  // And the beat after that is still default.
  mock.timers.tick(100);
  assert.equal(c.count(), 3);
});

// Same reset behavior via the immediate (fire-now) branch of setInterval.
test("setInterval: immediate-fire branch also resets current to default for the next beat", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  mock.timers.tick(60); // elapsed = 60
  clock.setInterval(50); // 50 <= 60 -> fires now; current resets to default (100)
  assert.equal(c.count(), 1);

  // The next beat is one DEFAULT interval (100) after that immediate fire.
  mock.timers.tick(99);
  assert.equal(c.count(), 1, "next beat not due before default interval after immediate fire");
  mock.timers.tick(1);
  assert.equal(c.count(), 2, "next beat uses default interval after the immediate setInterval fire");
});

// ---------------------------------------------------------------------------
// 10. setDefaultInterval(ms) changes the baseline current resets to
//     (subsequent beats use the new default); it does not itself fire.
// ---------------------------------------------------------------------------
test("setDefaultInterval: does not itself fire and does not re-arm the current countdown", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  mock.timers.tick(30); // elapsed = 30 on the current (100) countdown

  clock.setDefaultInterval(40); // change baseline only; must NOT fire here
  assert.equal(c.count(), 0, "setDefaultInterval does not trigger an activation");

  // The CURRENT beat is not re-armed: it still completes at the original 100.
  mock.timers.tick(40); // t=70 — would already be past a 40ms beat, but current is still 100
  assert.equal(c.count(), 0, "current countdown is not re-armed by setDefaultInterval");

  mock.timers.tick(30); // t=100 — current beat (still 100) fires; then resets to new default 40
  assert.equal(c.count(), 1);
});

test("setDefaultInterval: subsequent beats use the new default after the next reset", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  clock.start();
  clock.setDefaultInterval(40); // new baseline; current (100) beat unaffected

  mock.timers.tick(100); // beat 1 at the original default; current resets to 40
  assert.equal(c.count(), 1);

  // From here every beat is 40ms.
  mock.timers.tick(40); // beat 2
  assert.equal(c.count(), 2);
  mock.timers.tick(40); // beat 3
  assert.equal(c.count(), 3);

  mock.timers.tick(39);
  assert.equal(c.count(), 3, "next beat not due before the new default elapses");
  mock.timers.tick(1); // beat 4
  assert.equal(c.count(), 4);
});

// ---------------------------------------------------------------------------
// 11. setInterval(ms) BEFORE start(): never fires (no countdown in progress),
//     only records. After start(), the FIRST beat uses the recorded ms (not the
//     constructor default); subsequent beats revert to the default.
// ---------------------------------------------------------------------------
test("setInterval before start: never fires; first beat after start uses recorded ms, then reverts to default", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  // No start() yet — recording only, must never fire even as time passes.
  clock.setInterval(40);
  mock.timers.tick(1000);
  assert.equal(c.count(), 0, "setInterval before start() does not fire (no countdown in progress)");

  clock.start();

  // First beat is the RECORDED interval (40), not the constructor default (100).
  mock.timers.tick(39);
  assert.equal(c.count(), 0, "first beat not due before the recorded interval elapses");
  mock.timers.tick(1); // t=40 since start -> first beat
  assert.equal(c.count(), 1, "first beat after start uses the recorded interval, not the default");

  // After that activation, current reverts to the default (100).
  mock.timers.tick(99);
  assert.equal(c.count(), 1, "second beat not due before the default interval");
  mock.timers.tick(1); // 100ms after the first beat
  assert.equal(c.count(), 2, "subsequent beats revert to the default interval");

  // And the next beat is still the default.
  mock.timers.tick(100);
  assert.equal(c.count(), 3);
});

// ---------------------------------------------------------------------------
// 12. setInterval(ms) AFTER stop() (clock previously ran, wall-clock advanced):
//     never fires, records only. If start() is called again, the next beat uses
//     the recorded current interval.
// ---------------------------------------------------------------------------
test("setInterval after stop: never fires; restart uses the recorded current interval", () => {
  const clock = createClock({ defaultIntervalMs: 100 });
  const c = makeCounter(clock);

  // Run for a while so wall-clock time has advanced before we stop.
  clock.start();
  mock.timers.tick(100); // beat 1
  mock.timers.tick(100); // beat 2
  assert.equal(c.count(), 2);

  clock.stop();
  mock.timers.tick(250); // mid wall-clock; no countdown in progress
  assert.equal(c.count(), 2, "no fires while stopped");

  // Recording while stopped must never fire, even as more time passes.
  clock.setInterval(40);
  mock.timers.tick(1000);
  assert.equal(c.count(), 2, "setInterval after stop() does not fire (no countdown in progress)");

  // Restart: the next beat uses the recorded current interval (40), not the default (100).
  clock.start();
  mock.timers.tick(39);
  assert.equal(c.count(), 2, "next beat after restart not due before the recorded interval");
  mock.timers.tick(1); // 40ms after restart
  assert.equal(c.count(), 3, "next beat after restart uses the recorded current interval");

  // After that activation, current reverts to the default (100).
  mock.timers.tick(99);
  assert.equal(c.count(), 3, "subsequent beat not due before the default interval");
  mock.timers.tick(1);
  assert.equal(c.count(), 4, "subsequent beats revert to the default interval");
});

// ---------------------------------------------------------------------------
// 13. Re-entrancy: a handler that synchronously calls fireNow() must not leave
//     more than one armed timer. After the re-entrant activation, advancing time
//     by exactly one interval yields exactly ONE further activation (no doubling).
// ---------------------------------------------------------------------------
test("re-entrancy: handler calling fireNow() does not leave a doubled cadence", () => {
  const clock = createClock({ defaultIntervalMs: 100 });

  let fired = 0;
  let reentered = false;
  clock.onFire(() => {
    fired += 1;
    // On the first activation only, synchronously re-fire from inside the handler.
    if (!reentered) {
      reentered = true;
      clock.fireNow();
    }
  });

  clock.start();
  mock.timers.tick(100); // beat fires -> handler re-enters once via fireNow()
  assert.equal(fired, 2, "one scheduled beat + one re-entrant fireNow = 2 activations");

  // Exactly one armed timer must remain: one full interval -> exactly ONE more fire.
  mock.timers.tick(100);
  assert.equal(fired, 3, "exactly one further activation after one interval (no doubled cadence)");

  // Still single-cadence on the following interval.
  mock.timers.tick(100);
  assert.equal(fired, 4, "cadence remains single (not doubled)");
});

test("re-entrancy: handler calling setInterval(small) does not leave a doubled cadence", () => {
  const clock = createClock({ defaultIntervalMs: 100 });

  let fired = 0;
  let reentered = false;
  clock.onFire(() => {
    fired += 1;
    // On the first activation only, synchronously change this beat's interval from inside.
    if (!reentered) {
      reentered = true;
      clock.setInterval(10); // small; whether it fires now or reschedules, only one timer may remain
    }
  });

  clock.start();
  mock.timers.tick(100); // scheduled beat fires -> handler re-enters via setInterval(10)
  const afterFirst = fired;
  assert.ok(afterFirst >= 1, "at least the scheduled beat activated");

  // After the re-entrant activation, exactly one armed timer should remain.
  // Advancing by one full default interval must yield exactly ONE further activation.
  const before = fired;
  mock.timers.tick(100);
  assert.equal(fired, before + 1, "exactly one further activation per interval (no doubled cadence)");

  // And again — cadence stays single.
  const before2 = fired;
  mock.timers.tick(100);
  assert.equal(fired, before2 + 1, "cadence remains single (not doubled)");
});

// ---------------------------------------------------------------------------
// 14. stop() called from INSIDE the fire handler results in no further activations.
// ---------------------------------------------------------------------------
test("re-entrancy: stop() from inside the handler halts all further activations", () => {
  const clock = createClock({ defaultIntervalMs: 100 });

  let fired = 0;
  clock.onFire(() => {
    fired += 1;
    clock.stop(); // stop from within the activation
  });

  clock.start();
  mock.timers.tick(100); // first beat fires, then stops itself
  assert.equal(fired, 1, "handler fired exactly once");

  mock.timers.tick(1000); // plenty of intervals — none should fire after the in-handler stop
  assert.equal(fired, 1, "no further activations after stop() from inside the handler");
});
