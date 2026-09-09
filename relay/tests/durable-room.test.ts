// node:test / node:assert/strict types come from ./node-shims.d.ts — see
// that file for why they're declared locally instead of via @types/node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Room } from "../src/durable-room.ts";

// --- Minimal Workers-runtime stubs -----------------------------------------
// durable-room.ts references WebSocketPair, DurableObjectState, and relies on
// the Workers-only extension that lets Response carry status 101 plus a
// `webSocket` property (Node's spec-compliant Response rejects status 101
// outright: "must be in the range of 200 to 599"). None of these exist under
// Node, so we fake the smallest surface Room.fetch()/alarm() touch, and let
// the test inspect what was sent through the fake "server" socket.

class FakeSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  accept(): void {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Test-only: simulate the runtime firing an event (e.g. the peer's socket closing). */
  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const createdPairs: FakeSocket[][] = [];

class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    this[0] = new FakeSocket(); // client
    this[1] = new FakeSocket(); // server
    createdPairs.push([this[0], this[1]]);
  }
}

class FakeResponse {
  status: number;
  webSocket?: FakeSocket;
  constructor(_body: unknown, init: { status: number; webSocket?: FakeSocket }) {
    this.status = init.status;
    this.webSocket = init.webSocket;
  }
}

(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakeWebSocketPair;
(globalThis as unknown as { Response: unknown }).Response = FakeResponse;

function fakeDurableObjectState() {
  const alarms: number[] = [];
  let deletedAlarms = 0;
  return {
    alarms,
    get deletedAlarms() {
      return deletedAlarms;
    },
    state: {
      storage: {
        setAlarm: async (t: number) => {
          alarms.push(t);
        },
        deleteAlarm: async () => {
          deletedAlarms += 1;
        },
      },
    },
  };
}

function upgradeRequest(): Request {
  return new Request("https://example.com/room/ABCDEF", {
    headers: { Upgrade: "websocket" },
  });
}

/**
 * Calls Room.fetch() and completes the handshake, returning the pair it
 * created. `resume` says whether this socket belongs to a page that already
 * had a match running -- the relay cannot tell the two apart on its own.
 */
async function connect(room: Room, resume = false) {
  const before = createdPairs.length;
  await room.fetch(upgradeRequest());
  const [client, server] = createdPairs[before];
  server.dispatch("message", { data: JSON.stringify({ t: "hello", resume }) });
  return { client, server };
}

/** Connects without saying hello, for tests about the handshake itself. */
async function connectSilently(room: Room) {
  const before = createdPairs.length;
  await room.fetch(upgradeRequest());
  const [client, server] = createdPairs[before];
  return { client, server };
}

test("a socket that never says hello claims no slot", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  await connectSilently(room);
  // If the silent socket had taken the host slot, this one would be the guest
  // and the room would pair; instead it is the only peer and nothing starts.
  const real = await connect(room);
  assert.equal(real.server.sent.length, 0);
});

test("a fresh room accepts the first connection and sends no error", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  const { server } = await connect(room);
  assert.equal(server.sent.length, 0);
  assert.equal(server.closed, null);
});

test("a second connection pairs the room; both peers get start with the same seed and host/guest roles", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  const first = await connect(room);
  const second = await connect(room);

  const msg1 = JSON.parse(first.server.sent.at(-1)!);
  const msg2 = JSON.parse(second.server.sent.at(-1)!);

  assert.equal(msg1.t, "start");
  assert.equal(msg2.t, "start");
  assert.equal(msg1.seed, msg2.seed);
  assert.equal(msg1.role, "host");
  assert.equal(msg2.role, "guest");
});

test("a third connection is rejected as full", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  await connect(room);
  await connect(room);
  const third = await connect(room);

  const msg = JSON.parse(third.server.sent[0]);
  assert.equal(msg.t, "error");
  assert.equal(msg.reason, "full");
  assert.equal(third.server.closed?.code, 1008);
});

test("a room whose logic reports expired rejects new connections as missing", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  const host = await connect(room);
  // The host's socket goes away before anyone joins: never paired, so the
  // room is expired immediately (live-only challenge link dies with its host).
  host.server.dispatch("close");

  const late = await connect(room);
  const msg = JSON.parse(late.server.sent[0]);
  assert.equal(msg.t, "error");
  assert.equal(msg.reason, "missing");
});

// --- the hello handshake (final review's FINAL-6) --------------------------
// Reopening a challenge link after CLOSING the tab used to dead-end BOTH
// players. The DO sent "peer-back" only to the OTHER peer, so the fresh page
// got nothing, never called begin(), and sat on "Waiting for your opponent…"
// forever -- while deleteAlarm() fired on the survivor's side, cancelling the
// forfeit that was their only way out. They then stalled and froze with no
// overlay. Board state is never transferred between peers, so a closed tab
// genuinely cannot resume; the outcome is now defined rather than working.

test("a fresh page cannot take over a match in progress, and the survivor still wins", async () => {
  const rig = fakeDurableObjectState();
  const { state, alarms } = rig;
  const room = new Room(state as never, {} as never);
  const host = await connect(room);
  const guest = await connect(room);
  assert.equal(JSON.parse(host.server.sent.at(-1)!).t, "start", "setup: should have paired");

  // The guest closes their tab. The grace window is armed.
  guest.server.dispatch("close");
  const armed = alarms.length;
  assert.ok(armed > 0, "setup: losing a peer mid-match should arm the grace alarm");

  // They re-tap the link, which loads a brand new page: resume is false.
  const returner = await connect(room, false);
  const msg = JSON.parse(returner.server.sent[0]);
  assert.equal(msg.t, "error");
  assert.equal(msg.reason, "missing");
  assert.equal(returner.server.closed?.code, 1008);

  // Crucially, the alarm is left ARMED -- refusing the returner must not
  // cancel the forfeit -- so the host still gets a clean win.
  assert.equal(rig.deletedAlarms, 0, "refusing a fresh page cancelled the survivor's forfeit");
  assert.equal(alarms.length, armed, "and did not re-arm it either");
  await room.alarm();
  assert.equal(JSON.parse(host.server.sent.at(-1)!).t, "forfeit");
});

test("a socket-level reconnect from the same live page still resumes", async () => {
  const rig = fakeDurableObjectState();
  const room = new Room(rig.state as never, {} as never);
  const host = await connect(room);
  const guest = await connect(room);
  assert.equal(JSON.parse(host.server.sent.at(-1)!).t, "start", "setup: should have paired");

  guest.server.dispatch("close");
  assert.equal(JSON.parse(host.server.sent.at(-1)!).t, "peer-left");

  const back = await connect(room, true);
  assert.equal(JSON.parse(host.server.sent.at(-1)!).t, "peer-back");
  assert.equal(back.server.closed, null);
  assert.ok(rig.deletedAlarms > 0, "returning inside the window should cancel the forfeit");
});

test("hello is consumed by the relay and never forwarded to the peer", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  const host = await connect(room);
  const guest = await connect(room);
  host.server.sent.length = 0;

  guest.server.dispatch("message", { data: JSON.stringify({ t: "hello", resume: true }) });
  assert.deepEqual(host.server.sent, [], "the handshake leaked onto the peer-to-peer channel");

  const sync = JSON.stringify({ t: "sync", tick: 32, lights: 0, state: 0, attacks: [] });
  guest.server.dispatch("message", { data: sync });
  assert.deepEqual(host.server.sent, [sync], "syncs must still be forwarded");
});

test("a malformed hello claims no slot", async () => {
  const { state } = fakeDurableObjectState();
  const room = new Room(state as never, {} as never);
  const bad = await connectSilently(room);
  bad.server.dispatch("message", { data: JSON.stringify({ t: "hello", resume: "yes" }) });
  bad.server.dispatch("message", { data: "not json" });

  const real = await connect(room);
  assert.equal(real.server.sent.length, 0, "a malformed handshake took a slot");
});
