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
