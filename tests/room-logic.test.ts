import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomLogic } from "../relay/src/room-logic.ts";
import { RECONNECT_GRACE_MS } from "../app/net/protocol.ts";

test("first peer is host, second is guest", () => {
  const room = new RoomLogic(999);
  assert.equal(room.addPeer("a"), "host");
  assert.equal(room.addPeer("b"), "guest");
  assert.equal(room.peerCount, 2);
});

test("a third peer is rejected", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  assert.equal(room.addPeer("c"), "full");
  assert.equal(room.peerCount, 2);
});

test("a departed peer frees its slot for reconnect", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("b", 1000);
  assert.equal(room.peerCount, 1);
  assert.equal(room.addPeer("b2"), "guest");
});

test("room is not expired inside the grace window", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("b", 1000);
  assert.equal(room.expiredAt(1000 + RECONNECT_GRACE_MS - 1), false);
});

test("room expires once the grace window elapses", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("b", 1000);
  assert.equal(room.expiredAt(1000 + RECONNECT_GRACE_MS + 1), true);
});

test("a fully empty room is immediately expired", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.removePeer("a", 500);
  assert.equal(room.expiredAt(501), true);
});

test("an unclaimed challenge link dies with its host, with no grace", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  assert.equal(room.wasPaired, false);
  room.removePeer("a", 100);
  // Never paired, so there is no match to preserve: expired immediately.
  assert.equal(room.expiredAt(101), true);
});

test("wasPaired stays true after a peer drops, so the grace window applies", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("b", 100);
  assert.equal(room.wasPaired, true);
});

test("both peers leaving a paired room does not expire it inside the grace window", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("a", 1000);
  room.removePeer("b", 1000);
  assert.equal(room.expiredAt(1000 + RECONNECT_GRACE_MS - 1), false);
});

test("both peers leaving a paired room expires it once the grace window passes", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("a", 1000);
  room.removePeer("b", 1000);
  assert.equal(room.expiredAt(1000 + RECONNECT_GRACE_MS + 1), true);
});

test("one peer returning after both left inside the grace window is accepted, and the room is not expired", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.addPeer("b");
  room.removePeer("a", 1000);
  room.removePeer("b", 1000);
  assert.equal(room.addPeer("a2"), "host");
  assert.equal(room.expiredAt(1000 + RECONNECT_GRACE_MS + 1), false);
});

test("a never-paired host leaving still expires the room immediately, with no grace", () => {
  const room = new RoomLogic(1);
  room.addPeer("a");
  room.removePeer("a", 100);
  assert.equal(room.expiredAt(100 + RECONNECT_GRACE_MS + 1), true);
});
