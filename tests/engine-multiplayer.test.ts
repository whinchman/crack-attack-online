import { test } from "node:test";
import assert from "node:assert/strict";
import { CrackAttackEngine, VISIBLE_ROWS } from "../app/game/engine.ts";

test("outgoing attacks buffer and drain exactly once", () => {
  const engine = new CrackAttackEngine({ seed: 7 });
  engine.start(0, 7);
  // Force an attack rather than waiting for gameplay to produce one.
  engine.queueOutgoingAttack({ height: 1, width: 4, flavor: "normal", source: "clear", createdAt: 0 });
  const first = engine.drainOutgoingAttacks();
  assert.equal(first.length, 1);
  assert.equal(first[0].width, 4);
  assert.deepEqual(engine.drainOutgoingAttacks(), []);
});

test("opponent level lights round-trip onto the snapshot", () => {
  const engine = new CrackAttackEngine({ seed: 7 });
  engine.start(0, 7);
  engine.setOpponentLevelLights(0b1011);
  assert.equal(engine.getSnapshot(0).opponentLevelLights, 0b1011);
});

test("exported level lights fit inside the visible rows", () => {
  const engine = new CrackAttackEngine({ seed: 7 });
  engine.start(0, 7);
  engine.update(1000);
  const bits = engine.exportLevelLights(1000);
  assert.ok(Number.isInteger(bits));
  assert.ok(bits >= 0);
  assert.ok(bits < 2 ** VISIBLE_ROWS);
});

test("forfeit win ends the game", () => {
  const engine = new CrackAttackEngine({ seed: 7 });
  engine.start(0, 7);
  engine.update(1000);
  engine.forfeitWin(1000);
  assert.equal(engine.getSnapshot(1000).status, "gameover");
});

// Deterministic pseudo-input (identical to tests/determinism-probe.test.ts's
// driver, truncated to the tick where seed 1 is known to produce a clear
// large enough to emit exactly one attack) used to drive a real attack
// through `emitAttack` rather than calling `queueOutgoingAttack` directly.
// This is what actually pins emitAttack's routing branch.
function driveToFirstAttack(engine: CrackAttackEngine): number {
  let now = 0;
  for (let i = 0; i < 300; i += 1) {
    now += 20;
    if (i % 7 === 0) engine.moveCursor((i % 3) - 1, (i % 5) - 2, now);
    if (i % 11 === 0) engine.swap(now);
    if (i % 53 === 0) engine.setRaiseHeld(true);
    if (i % 53 === 17) engine.setRaiseHeld(false);
    engine.update(now);
  }
  return now;
}

test("emitAttack buffers instead of self-looping when multiplayer is true", () => {
  const engine = new CrackAttackEngine({ seed: 1, multiplayer: true });
  engine.start(0, 1);
  const now = driveToFirstAttack(engine);

  const outgoing = engine.drainOutgoingAttacks();
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].source, "clear");
  // The attack must not also have looped back onto our own board.
  assert.equal(engine.getSnapshot(now).incomingCount, 0);
});

test("emitAttack self-loops and does not buffer when multiplayer is false", () => {
  const engine = new CrackAttackEngine({ seed: 1 }); // multiplayer defaults to false
  engine.start(0, 1);
  const now = driveToFirstAttack(engine);

  // Same clear, same seed, same scripted input as the multiplayer case above:
  // this time it must land on our own board via receiveAttack, not the buffer.
  assert.deepEqual(engine.drainOutgoingAttacks(), []);
  assert.equal(engine.getSnapshot(now).incomingCount, 1);
});
