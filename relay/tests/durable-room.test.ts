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

/** Calls Room.fetch() and returns the client/server pair it created. */
async function connect(room: Room, req: () => Request = upgradeRequest) {
  const before = createdPairs.length;
  await room.fetch(req());
  const [client, server] = createdPairs[before];
  return { client, server };
}

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
