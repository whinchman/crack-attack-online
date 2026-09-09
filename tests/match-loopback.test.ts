import { test } from "node:test";
import assert from "node:assert/strict";
import { CrackAttackEngine } from "../app/game/engine.ts";
import { MatchController } from "../app/net/match.ts";
import { SYNC_PERIOD_TICKS, TICK_MS } from "../app/net/protocol.ts";
import type { ClientMessage, SyncMessage } from "../app/net/protocol.ts";

/** Mirrors MatchController's own tolerance; not exported, so re-derived here. */
const MAX_LEAD_TICKS = SYNC_PERIOD_TICKS * 2;

/**
 * A transport that queues sends for delivery to a paired transport's peer.
 * `send()` only enqueues -- delivery happens when the test driver drains the
 * queue and calls `onSync` itself, so a message can never be re-entrant with
 * the `send()` call that produced it, the way a real network never is.
 */
class LoopbackTransport {
  queue: ClientMessage[] = [];
  send(m: ClientMessage) {
    this.queue.push(m);
  }
  onMessage() {}
  onStatus() {}
  close() {}
  drain(): ClientMessage[] {
    return this.queue.splice(0);
  }
}

/**
 * Two browsers never share a performance.now() origin, and neither one starts
 * at zero. Starting both at 0 made elapsed match ticks and absolute engine
 * time numerically identical, which hid a time-base bug in onSync for two
 * whole tasks (see the FINAL-2 regression in tests/match.test.ts). These start
 * times are deliberately unequal and deliberately non-zero.
 */
const START_A = 41_000;
const START_B = 137_500;

function makePair(seed: number) {
  const engineA = new CrackAttackEngine({ seed, multiplayer: true });
  const engineB = new CrackAttackEngine({ seed, multiplayer: true });
  const transportA = new LoopbackTransport();
  const transportB = new LoopbackTransport();
  const matchA = new MatchController(engineA, transportA as never);
  const matchB = new MatchController(engineB, transportB as never);
  matchA.begin({ seed, role: "host" }, START_A);
  matchB.begin({ seed, role: "guest" }, START_B);
  return { engineA, engineB, matchA, matchB, transportA, transportB };
}

test("two controllers stay fair and consistent over a long, skewed run", () => {
  const { engineA, engineB, matchA, matchB, transportA, transportB } = makePair(9);

  // One side queues garbage before the run starts, to prove it crosses over.
  engineA.queueOutgoingAttack({ height: 3, width: 4, flavor: "normal", source: "clear", createdAt: 0 });

  const valuesA: number[] = [];
  const valuesB: number[] = [];
  let stalledSeenA = false;
  let syncsDeliveredWhileAWasStalled = 0;
  let attackDelivered = false;
  let telegraphOnArrivalMs: number | null = null;
  // The frozen-on-entry stall (see tickTo's comment) can overshoot the lead
  // bound by up to one call's worth of ticks before it takes hold -- bounded
  // by how coarse dtA is relative to TICK_MS, not by anything unbounded.
  const overshootTolerance = Math.ceil(25 / TICK_MS);
  let maxOverA = 0;
  let maxOverB = 0;

  // Two independent, skewed real-time clocks: A's clock runs 25% "fast"
  // relative to B's, which is what produces sustained drift and a stall,
  // rather than identical nowMs sequences on both sides.
  const rounds = 400;
  const dtA = 25;
  const dtB = 20;

  for (let i = 1; i <= rounds; i += 1) {
    const nowA = START_A + i * dtA;
    const nowB = START_B + i * dtB;

    const clampedA = matchA.tickTo(nowA);
    const clampedB = matchB.tickTo(nowB);
    valuesA.push(clampedA);
    valuesB.push(clampedB);
    engineA.update(clampedA);
    engineB.update(clampedB);

    if (matchA.waitingForPeer) stalledSeenA = true;
    // tickTo returns absolute time, so the match tick is measured from each
    // side's own start. This used to read Math.floor(clamped / TICK_MS),
    // which was only correct because both matches began at 0.
    const tickA = Math.floor((clampedA - START_A) / TICK_MS);
    const tickB = Math.floor((clampedB - START_B) / TICK_MS);
    maxOverA = Math.max(maxOverA, tickA - (matchA.peerTick + MAX_LEAD_TICKS));
    maxOverB = Math.max(maxOverB, tickB - (matchB.peerTick + MAX_LEAD_TICKS));

    // Deliver this round's traffic. Queued, not synchronous with send().
    const toA = transportB.drain();
    const toB = transportA.drain();

    for (const message of toA) {
      if (matchA.waitingForPeer) syncsDeliveredWhileAWasStalled += 1;
      matchA.onSync(message as SyncMessage);
    }
    for (const message of toB) {
      const before = engineB.getSnapshot(nowB).incomingCount;
      matchB.onSync(message as SyncMessage);
      const after = engineB.getSnapshot(nowB);
      if (after.incomingCount > before) {
        attackDelivered = true;
        telegraphOnArrivalMs ??= after.nextIncomingMs;
      }
    }
  }

  // 3. Neither side's simulated clock ever ran backwards.
  for (let i = 1; i < valuesA.length; i += 1) {
    assert.ok(valuesA[i] >= valuesA[i - 1], `A went backwards: ${valuesA[i - 1]} -> ${valuesA[i]}`);
  }
  for (let i = 1; i < valuesB.length; i += 1) {
    assert.ok(valuesB[i] >= valuesB[i - 1], `B went backwards: ${valuesB[i - 1]} -> ${valuesB[i]}`);
  }

  // Sanity on the scenario itself: the skew must actually have produced a
  // stall with more than one sync landing before it fully resolved.
  assert.ok(stalledSeenA, "test setup: the faster clock should have stalled");
  assert.ok(
    syncsDeliveredWhileAWasStalled > 1,
    "test setup: expected a partial catch-up spanning more than one sync",
  );

  // 4. Fairness: neither engine ran more than MAX_LEAD_TICKS beyond what the
  // peer had last reported, beyond the unavoidable per-call polling slop.
  assert.ok(maxOverA <= overshootTolerance, `A exceeded its lead budget by ${maxOverA} ticks`);
  assert.ok(maxOverB <= overshootTolerance, `B exceeded its lead budget by ${maxOverB} ticks`);

  // 5. An attack queued on one side is eventually delivered to the other --
  // and lands with its telegraph intact. Asserting only that incomingCount
  // rose is exactly what let FINAL-2 through for two tasks: an attack that
  // drops on the very next update still "arrives". The engine spreads garbage
  // over 281..320 ticks (5.62s..6.4s), so anything materially under 5s means
  // the drop time was computed against the wrong time base.
  assert.ok(attackDelivered, "the queued attack never reached the peer's incoming queue");
  assert.ok(
    telegraphOnArrivalMs !== null && telegraphOnArrivalMs >= 5_000,
    `remote attack arrived with only ${telegraphOnArrivalMs}ms of warning, expected >= 5000ms`,
  );
});
