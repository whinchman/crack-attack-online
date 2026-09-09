import { test } from "node:test";
import assert from "node:assert/strict";
import { CrackAttackEngine } from "../app/game/engine.ts";
import { MatchController } from "../app/net/match.ts";
import { SYNC_PERIOD_TICKS, TICK_MS } from "../app/net/protocol.ts";
import type { ClientMessage, SyncMessage } from "../app/net/protocol.ts";

class FakeTransport {
  sent: ClientMessage[] = [];
  send(m: ClientMessage) { this.sent.push(m); }
  onMessage() {}
  onStatus() {}
  close() {}
}

function makeMatch() {
  const engine = new CrackAttackEngine({ seed: 5, multiplayer: true });
  const transport = new FakeTransport();
  const match = new MatchController(engine, transport as never);
  match.begin({ seed: 5, role: "host" }, 0);
  return { engine, transport, match };
}

const PERIOD_MS = SYNC_PERIOD_TICKS * TICK_MS;

test("emits no sync before a full period has elapsed", () => {
  const { engine, transport, match } = makeMatch();
  const now = PERIOD_MS - TICK_MS;
  engine.update(match.tickTo(now));
  assert.equal(transport.sent.length, 0);
});

test("emits exactly one sync per elapsed period", () => {
  const { engine, transport, match } = makeMatch();
  for (let ms = TICK_MS; ms <= PERIOD_MS; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].t, "sync");
});

test("a sync carries our tick, lights and drained attacks", () => {
  const { engine, transport, match } = makeMatch();
  engine.queueOutgoingAttack({ height: 2, width: 3, flavor: "normal", source: "clear", createdAt: 0 });
  for (let ms = TICK_MS; ms <= PERIOD_MS; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  const sent = transport.sent[0] as SyncMessage;
  assert.equal(sent.tick, SYNC_PERIOD_TICKS);
  assert.equal(sent.attacks.length, 1);
  assert.equal(sent.attacks[0].width, 3);
  assert.equal(typeof sent.lights, "number");
});

test("an incoming sync delivers attacks to our board", () => {
  const { engine, match } = makeMatch();
  const before = engine.getSnapshot(0).incomingCount;
  match.onSync({
    t: "sync", tick: SYNC_PERIOD_TICKS, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: 6, flavor: "normal" }],
  });
  assert.ok(engine.getSnapshot(0).incomingCount > before);
});

test("an incoming sync records the opponent's lights", () => {
  const { engine, match } = makeMatch();
  match.onSync({ t: "sync", tick: SYNC_PERIOD_TICKS, lights: 0b101, state: 0, attacks: [] });
  assert.equal(engine.getSnapshot(0).opponentLevelLights, 0b101);
});

test("running more than a period ahead of the peer stalls our clock", () => {
  const { engine, match } = makeMatch();
  // Advance two full periods with no word from the peer.
  let last = 0;
  for (let ms = TICK_MS; ms <= PERIOD_MS * 3; ms += TICK_MS) {
    last = match.tickTo(ms);
    engine.update(last);
  }
  assert.ok(match.waitingForPeer, "should be waiting once far ahead of the peer");
  assert.ok(last < PERIOD_MS * 3, "clamped time must lag real time while stalled");
});

test("a peer sync releases the stall", () => {
  const { engine, match } = makeMatch();
  for (let ms = TICK_MS; ms <= PERIOD_MS * 3; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  assert.equal(match.waitingForPeer, true);
  match.onSync({ t: "sync", tick: SYNC_PERIOD_TICKS * 3, lights: 0, state: 0, attacks: [] });
  assert.equal(match.waitingForPeer, false);
});

// Regression for a Fix Round 1 bug: while stalled, a partial peer sync (one
// that advances peerTick but not enough to clear our lead) must not cause
// tickTo's later, fully-resolving return value to fall BELOW a value it
// already fed to engine.update(). The engine has no defense against time
// running backwards, so a caller trusting tickTo's contract here could
// corrupt tick counts, garbage timers, and delta-time math.
test("tickTo never goes backwards across a partial catch-up while stalled", () => {
  const { engine, match } = makeMatch();
  const values: number[] = [];

  // Run far ahead of the peer with no word from them at all, until we stall.
  for (let ms = TICK_MS; ms <= PERIOD_MS * 3; ms += TICK_MS) {
    values.push(match.tickTo(ms));
    engine.update(values[values.length - 1]);
  }
  assert.ok(match.waitingForPeer, "test setup: should be stalled before the partial sync");

  // A partial sync: the peer has advanced, but nowhere near enough to clear
  // our lead. This is the normal case -- peers report their OWN tick, which
  // typically advances by one sync period at a time.
  match.onSync({ t: "sync", tick: 5, lights: 0, state: 0, attacks: [] });
  values.push(match.tickTo(PERIOD_MS * 3 + TICK_MS));
  engine.update(values[values.length - 1]);

  // A fuller sync that actually clears the stall.
  match.onSync({ t: "sync", tick: 400, lights: 0, state: 0, attacks: [] });
  values.push(match.tickTo(PERIOD_MS * 3 + TICK_MS * 2));
  engine.update(values[values.length - 1]);

  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i] >= values[i - 1],
      `tickTo went backwards: ${values[i - 1]} -> ${values[i]} at index ${i}`,
    );
  }
});

// Regression for the final review's FINAL-2. The engine's time base is
// absolute (engine.start() takes a raw performance.now()) but the wire carries
// elapsed match ticks, so onSync has to rebase the peer's tick onto our start
// time. Before the fix, createdAt was the raw elapsed ms, which for any real
// startedAtMs put dropAt far in the past and dropped every remote attack on
// the very next update. The whole 281..320-tick telegraph was gone.
test("a remote attack keeps its telegraph when the match did not start at time zero", () => {
  const START = 50_000;
  const engine = new CrackAttackEngine({ seed: 5, multiplayer: true });
  const transport = new FakeTransport();
  const match = new MatchController(engine, transport as never);
  match.begin({ seed: 5, role: "host" }, START);

  match.onSync({
    t: "sync", tick: SYNC_PERIOD_TICKS, lights: 0, state: 0,
    attacks: [{ tick: SYNC_PERIOD_TICKS, height: 1, width: 6, flavor: "normal" }],
  });
  assert.equal(engine.getSnapshot(START).incomingCount, 1);

  // The sharpest pre-fix failure: a single update dropped it immediately.
  engine.update(START + TICK_MS);
  assert.equal(
    engine.getSnapshot(START + TICK_MS).incomingCount, 1,
    "the remote attack landed on the first tick instead of being telegraphed",
  );

  // The engine's spread is 281..320 ticks (5.62s..6.4s), so nothing may land
  // inside the first 5 seconds.
  for (let ms = START + TICK_MS; ms <= START + 5_000; ms += TICK_MS) engine.update(ms);
  assert.equal(
    engine.getSnapshot(START + 5_000).incomingCount, 1,
    "the remote attack dropped inside its telegraph window",
  );

  // ...and it must still actually arrive, or the assertions above would also
  // pass against an attack that never drops at all.
  for (let ms = START + 5_000; ms <= START + 9_000; ms += TICK_MS) engine.update(ms);
  assert.equal(
    engine.getSnapshot(START + 9_000).incomingCount, 0,
    "the remote attack never landed",
  );
});

// Regression for the final review's FINAL-1. tickTo used to return before the
// sync block whenever stalled, so a stalled peer stopped transmitting
// entirely. Two peers that stall at the same time then each wait forever for a
// sync the other can no longer send. Reachable by a phone locking for a few
// seconds: rAF suspends while the real clock runs on.
test("two simultaneously stalled peers recover instead of deadlocking", () => {
  const a = makeMatch();
  const b = makeMatch();
  const relay = () => {
    for (const m of a.transport.sent.splice(0)) b.match.onSync(m as SyncMessage);
    for (const m of b.transport.sent.splice(0)) a.match.onSync(m as SyncMessage);
  };

  // Phase 1: A's tab is suspended for 4s -- tickTo is simply never called for
  // it -- while B keeps running. B outruns its silent peer and stalls.
  for (let ms = TICK_MS; ms <= 4_000; ms += TICK_MS) {
    b.engine.update(b.match.tickTo(ms));
    relay();
  }
  assert.equal(b.match.waitingForPeer, true, "setup: B should stall while A is suspended");

  // Phase 2: A wakes with a 4s jump. B has been silent since it stalled, so A
  // is now far ahead of B's last reported tick and stalls too.
  a.engine.update(a.match.tickTo(4_000));
  relay();
  assert.equal(a.match.waitingForPeer, true, "setup: A should stall on waking");

  // Phase 3: both stalled. Without the heartbeat neither ever transmits again,
  // neither peerTick advances, and neither can resolve.
  let aRecovered = false;
  let bRecovered = false;
  for (let ms = 4_000 + TICK_MS; ms <= 9_000; ms += TICK_MS) {
    a.engine.update(a.match.tickTo(ms));
    b.engine.update(b.match.tickTo(ms));
    if (!a.match.waitingForPeer) aRecovered = true;
    if (!b.match.waitingForPeer) bRecovered = true;
    relay();
  }

  assert.ok(bRecovered, "B never recovered: a stalled peer stopped transmitting");
  assert.ok(aRecovered, "A never recovered: a stalled peer stopped transmitting");
});

test("a stalled peer keeps transmitting at most one heartbeat per sync period", () => {
  const { engine, transport, match } = makeMatch();
  for (let ms = TICK_MS; ms <= PERIOD_MS * 3; ms += TICK_MS) engine.update(match.tickTo(ms));
  assert.equal(match.waitingForPeer, true, "setup: should be stalled");

  transport.sent.length = 0;
  // Two further periods of real time, all of it stalled.
  for (let ms = PERIOD_MS * 3 + TICK_MS; ms <= PERIOD_MS * 5; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  assert.equal(transport.sent.length, 2, "expected exactly one heartbeat per elapsed period");
});
