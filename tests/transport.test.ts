import { test } from "node:test";
import assert from "node:assert/strict";
import { Transport } from "../app/net/transport.ts";
import type { ServerMessage, SyncMessage } from "../app/net/protocol.ts";

/** Minimal stand-in for a browser WebSocket, driven manually by the test. */
class FakeSocket {
  static last: FakeSocket | null = null;
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
