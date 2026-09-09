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
