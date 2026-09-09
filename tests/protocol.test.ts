import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GARBAGE_QUEUE_SIZE,
  SYNC_PERIOD_TICKS,
  TICK_MS,
  MAX_TICK,
  parseClientMessage,
  parseServerMessage,
} from "../app/net/protocol.ts";
import { BOARD_COLUMNS, VISIBLE_ROWS } from "../app/game/engine.ts";

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

test("parses peer-left message", () => {
  const msg = parseServerMessage('{"t":"peer-left"}');
  assert.deepEqual(msg, { t: "peer-left" });
});

test("parses peer-back message", () => {
  const msg = parseServerMessage('{"t":"peer-back"}');
  assert.deepEqual(msg, { t: "peer-back" });
});

test("parses forfeit message", () => {
  const msg = parseServerMessage('{"t":"forfeit"}');
  assert.deepEqual(msg, { t: "forfeit" });
});

test("parses error message with valid reasons", () => {
  const full = parseServerMessage('{"t":"error","reason":"full"}');
  assert.deepEqual(full, { t: "error", reason: "full" });
  const missing = parseServerMessage('{"t":"error","reason":"missing"}');
  assert.deepEqual(missing, { t: "error", reason: "missing" });
  const malformed = parseServerMessage('{"t":"error","reason":"malformed"}');
  assert.deepEqual(malformed, { t: "error", reason: "malformed" });
});

test("rejects error message with invalid reason", () => {
  const msg = parseServerMessage('{"t":"error","reason":"unknown"}');
  assert.equal(msg, null);
});

test("rejects non-object JSON roots", () => {
  assert.equal(parseServerMessage("42"), null);
  assert.equal(parseServerMessage('"str"'), null);
  assert.equal(parseServerMessage("[1,2,3]"), null);
  assert.equal(parseServerMessage("null"), null);
});

test("rejects tick exceeding MAX_TICK", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: MAX_TICK + 1, lights: 0, state: 0, attacks: [],
  }));
  assert.equal(msg, null);
});

test("accepts tick at MAX_TICK boundary", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: MAX_TICK, lights: 0, state: 0, attacks: [],
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.tick, MAX_TICK);
});

test("rejects attack tick exceeding MAX_TICK", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: MAX_TICK + 1, height: 1, width: 3, flavor: "normal" }],
  }));
  assert.equal(msg, null);
});

test("rejects attack height out of bounds", () => {
  const tooSmall = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 0, width: 3, flavor: "normal" }],
  }));
  assert.equal(tooSmall, null);

  const tooLarge = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: VISIBLE_ROWS + 1, width: 3, flavor: "normal" }],
  }));
  assert.equal(tooLarge, null);
});

test("accepts attack height at VISIBLE_ROWS boundary", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: VISIBLE_ROWS, width: 3, flavor: "normal" }],
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.attacks[0]?.height, VISIBLE_ROWS);
});

test("rejects attack width out of bounds", () => {
  const tooSmall = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: 0, flavor: "normal" }],
  }));
  assert.equal(tooSmall, null);

  const tooLarge = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: BOARD_COLUMNS + 1, flavor: "normal" }],
  }));
  assert.equal(tooLarge, null);
});

test("accepts attack width at BOARD_COLUMNS boundary", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: BOARD_COLUMNS, flavor: "normal" }],
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.attacks[0]?.width, BOARD_COLUMNS);
});

test("rejects lights exceeding bit capacity", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 2 ** VISIBLE_ROWS, state: 0, attacks: [],
  }));
  assert.equal(msg, null);
});

test("accepts lights at boundary", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 2 ** VISIBLE_ROWS - 1, state: 0, attacks: [],
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.lights, 2 ** VISIBLE_ROWS - 1);
});

test("rejects state >= 256", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 256, attacks: [],
  }));
  assert.equal(msg, null);
});

test("accepts state at 255 boundary", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 255, attacks: [],
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.state, 255);
});

// --- the hello handshake ------------------------------------------------

test("parses a hello in both directions of the resume flag", () => {
  assert.deepEqual(parseClientMessage('{"t":"hello","resume":false}'), { t: "hello", resume: false });
  assert.deepEqual(parseClientMessage('{"t":"hello","resume":true}'), { t: "hello", resume: true });
});

test("rejects a hello whose resume flag is not a boolean", () => {
  assert.equal(parseClientMessage('{"t":"hello","resume":"yes"}'), null);
  assert.equal(parseClientMessage('{"t":"hello","resume":1}'), null);
  assert.equal(parseClientMessage('{"t":"hello"}'), null);
});

test("parseClientMessage still accepts syncs and rejects everything else", () => {
  const sync = '{"t":"sync","tick":32,"lights":0,"state":0,"attacks":[]}';
  assert.equal(parseClientMessage(sync)?.t, "sync");
  // Server-only messages must never be accepted from a client, or a peer
  // could inject a "start" or a "forfeit" through the relay.
  assert.equal(parseClientMessage('{"t":"start","seed":1,"role":"host"}'), null);
  assert.equal(parseClientMessage('{"t":"forfeit"}'), null);
  assert.equal(parseClientMessage('{"t":"error","reason":"missing"}'), null);
  assert.equal(parseClientMessage("not json"), null);
  assert.equal(parseClientMessage("[]"), null);
});

test("a hello is not a server message, so the relay can never forward one", () => {
  assert.equal(parseServerMessage('{"t":"hello","resume":true}'), null);
});
