import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GARBAGE_QUEUE_SIZE,
  SYNC_PERIOD_TICKS,
  TICK_MS,
  parseServerMessage,
} from "../app/net/protocol.ts";

test("sync constants match the original game", () => {
  assert.equal(TICK_MS, 20);
  assert.equal(SYNC_PERIOD_TICKS, 32);
  assert.equal(SYNC_PERIOD_TICKS * TICK_MS, 640);
  assert.equal(GARBAGE_QUEUE_SIZE, 8);
});

test("parses a well-formed start message", () => {
  const msg = parseServerMessage('{"t":"start","seed":12345,"role":"host"}');
  assert.deepEqual(msg, { t: "start", seed: 12345, role: "host" });
});

test("parses a sync message and clamps an oversized attack queue", () => {
  const attacks = Array.from({ length: 20 }, () => ({
    tick: 5, height: 1, width: 3, flavor: "normal",
  }));
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 64, lights: 3, state: 0, attacks,
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.attacks.length, GARBAGE_QUEUE_SIZE);
});

test("rejects malformed input instead of throwing", () => {
  assert.equal(parseServerMessage("not json"), null);
  assert.equal(parseServerMessage('{"t":"nope"}'), null);
  assert.equal(parseServerMessage('{"t":"start","seed":"x","role":"host"}'), null);
  assert.equal(parseServerMessage('{"t":"sync","tick":-1,"lights":0,"state":0,"attacks":[]}'), null);
});

test("rejects an attack with an unknown flavor", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: 3, flavor: "purple" }],
  }));
  assert.equal(msg, null);
});
