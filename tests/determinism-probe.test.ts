import { test } from "node:test";
import assert from "node:assert/strict";
import { CrackAttackEngine } from "../app/game/engine.ts";

const STEP = 20;                 // 50 Hz, matches SIMULATION_STEP_MS
const TICKS = 4000;              // 80 seconds of simulated play

function drive(seed: number, collectAt: number[]) {
  const captured: string[] = [];
  const attacks: string[] = [];
  const e = new CrackAttackEngine({ seed, attackSink: (a) => attacks.push(JSON.stringify(a)) });
  e.start(0, seed);
  let now = 0;
  for (let i = 0; i < TICKS; i++) {
    now += STEP;
    // deterministic pseudo-input derived only from tick index
    if (i % 7 === 0)  e.moveCursor((i % 3) - 1, (i % 5) - 2, now);
    if (i % 11 === 0) e.swap(now);
    if (i % 53 === 0) e.setRaiseHeld(true);
    if (i % 53 === 17) e.setRaiseHeld(false);
    e.update(now);
    if (collectAt.includes(i)) captured.push(JSON.stringify(e.getSnapshot(now)));
  }
  return { captured, attacks, final: JSON.stringify(e.getSnapshot(now)) };
}

const CHECKPOINTS = [100, 500, 1000, 2000, 3000, 3999];

test("two engines with the same seed stay bit-identical", () => {
  for (const seed of [1, 42, 0xC0FFEE, 123456789]) {
    const a = drive(seed, CHECKPOINTS);
    const b = drive(seed, CHECKPOINTS);
    for (let i = 0; i < CHECKPOINTS.length; i++) {
      assert.equal(a.captured[i], b.captured[i], `seed ${seed} diverged at tick ${CHECKPOINTS[i]}`);
    }
    assert.equal(a.final, b.final, `seed ${seed} final state differs`);
    assert.deepEqual(a.attacks, b.attacks, `seed ${seed} attack stream differs`);
    console.log(`  seed ${seed}: identical through ${TICKS} ticks, ${a.attacks.length} attacks emitted, snapshot ${a.final.length} bytes`);
  }
});

test("different seeds actually diverge (guards against a no-op test)", () => {
  const a = drive(1, CHECKPOINTS);
  const b = drive(2, CHECKPOINTS);
  assert.notEqual(a.final, b.final, "different seeds produced identical state - RNG not driving the sim?");
  console.log("  seeds 1 vs 2 diverge as expected");
});
