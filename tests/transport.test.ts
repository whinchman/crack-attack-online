import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INITIAL_ATTEMPTS,
  MAX_RECONNECT_ATTEMPTS,
  Transport,
} from "../app/net/transport.ts";
import type { ServerMessage, SyncMessage } from "../app/net/protocol.ts";

/** Minimal stand-in for a browser WebSocket, driven manually by the test. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static created = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    FakeSocket.created += 1;
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.(); }
}

const factory = (url: string) => new FakeSocket(url) as unknown as WebSocket;

test("reports open once the socket connects", () => {
  const seen: string[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  assert.deepEqual(seen, ["connecting", "open"]);
  t.close();
});

test("delivers parsed messages and drops malformed ones", () => {
  const got: ServerMessage[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onMessage((m) => got.push(m));
  FakeSocket.last!.onopen!();
  FakeSocket.last!.onmessage!({ data: '{"t":"peer-left"}' });
  FakeSocket.last!.onmessage!({ data: "garbage" });
  FakeSocket.last!.onmessage!({ data: '{"t":"unknown"}' });
  assert.deepEqual(got, [{ t: "peer-left" }]);
  t.close();
});

test("queues sends made before the socket opens, then flushes", () => {
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  const sync: SyncMessage = { t: "sync", tick: 32, lights: 0, state: 0, attacks: [] };
  t.send(sync);
  assert.deepEqual(FakeSocket.last!.sent, []);
  FakeSocket.last!.onopen!();
  assert.deepEqual(FakeSocket.last!.sent, [JSON.stringify(sync)]);
  t.close();
});

test("an unexpected close moves to reconnecting and opens a new socket", () => {
  const seen: string[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  const first = FakeSocket.last!;
  first.onclose!();
  assert.equal(seen.at(-1), "reconnecting");
  assert.notEqual(FakeSocket.last, first);
  t.close();
});

test("an explicit close does not reconnect", () => {
  const seen: string[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  const first = FakeSocket.last!;
  t.close();
  assert.equal(seen.at(-1), "closed");
  assert.equal(FakeSocket.last, first);
});

test("close() cancels a pending reconnect timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: string[] = [];
  const transport = new Transport("wss://x/room/ABC123", factory, 100);
  transport.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  const first = FakeSocket.last!;
  first.onclose!();
  assert.equal(seen.at(-1), "reconnecting");
  transport.close();
  assert.equal(seen.at(-1), "closed");
  t.mock.timers.tick(200);
  assert.equal(FakeSocket.last, first);
  assert.equal(seen.at(-1), "closed");
});

test("a delayed reconnect actually reconnects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: string[] = [];
  const transport = new Transport("wss://x/room/ABC123", factory, 100);
  transport.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  const first = FakeSocket.last!;
  first.onclose!();
  assert.equal(seen.at(-1), "reconnecting");
  t.mock.timers.tick(100);
  assert.notEqual(FakeSocket.last, first);
  assert.equal(seen.at(-1), "reconnecting");
  FakeSocket.last!.onopen!();
  assert.equal(seen.at(-1), "open");
  transport.close();
});

test("a stale socket's close does not disturb the current connection", () => {
  const seen: string[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  const first = FakeSocket.last!;
  first.onclose!();
  assert.equal(seen.at(-1), "reconnecting");
  const second = FakeSocket.last!;
  assert.notEqual(second, first);
  second.onopen!();
  assert.equal(seen.at(-1), "open");
  first.onclose!();
  assert.equal(seen.at(-1), "open");
  assert.equal(FakeSocket.last, second);
  t.close();
});

// Regression for the final review's FINAL-11. A build shipped without
// VITE_RELAY_BASE points at an unreachable host, and the joiner saw only an
// infinite once-a-second reconnect with nothing to indicate misconfiguration.
test("gives up quickly when the socket never connects at all", () => {
  const seen: string[] = [];
  FakeSocket.created = 0;
  const t = new Transport("wss://relay-not-configured.invalid/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  for (let i = 0; i < MAX_INITIAL_ATTEMPTS + 3; i += 1) FakeSocket.last!.onerror?.();
  assert.equal(seen.at(-1), "failed");
  assert.equal(
    FakeSocket.created, MAX_INITIAL_ATTEMPTS,
    "should stop opening sockets, not retry forever",
  );
});

test("a connection that has worked once is given the full grace window", () => {
  const seen: string[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  FakeSocket.last!.onopen!();
  for (let i = 0; i < MAX_INITIAL_ATTEMPTS + 2; i += 1) {
    FakeSocket.last!.onclose!();
    if (i === 0) continue;
  }
  assert.equal(seen.at(-1), "reconnecting", "an ordinary blip must not be given up on early");
  assert.ok(MAX_RECONNECT_ATTEMPTS > MAX_INITIAL_ATTEMPTS);
  t.close();
});

test("a successful reconnect clears the give-up counter", () => {
  const seen: string[] = [];
  const t = new Transport("wss://x/room/ABC123", factory, 0);
  t.onStatus((s) => seen.push(s));
  for (let i = 0; i < MAX_INITIAL_ATTEMPTS - 1; i += 1) FakeSocket.last!.onerror?.();
  FakeSocket.last!.onopen!();
  assert.equal(seen.at(-1), "open");
  for (let i = 0; i < MAX_INITIAL_ATTEMPTS + 1; i += 1) FakeSocket.last!.onclose!();
  assert.equal(seen.at(-1), "reconnecting", "the counter should reset on a successful open");
  t.close();
});
