import { test } from "node:test";
import assert from "node:assert/strict";
import { drawOpponentLights } from "../app/game/renderer.ts";

/** Records the calls a 2D context receives, so we can assert on drawing. */
function recordingContext() {
  const calls: string[] = [];
  let currentFillStyle = "";
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "canvas") return { width: 800, height: 800 };
      if (prop === "fillStyle") return currentFillStyle;
      return (...args: unknown[]) => {
        if (prop === "fillRect") {
          calls.push(`fillRect(${args.join(",")},color=${currentFillStyle})`);
        } else {
          calls.push(`${prop}(${args.join(",")})`);
        }
      };
    },
    set(_t, prop: string, value: unknown) {
      if (prop === "fillStyle") currentFillStyle = String(value);
      return true;
    },
  };
  return { calls, context: new Proxy({}, handler) as unknown as CanvasRenderingContext2D };
}

test("draws a full column with correct red/blue split for occupied bits", () => {
  const { calls, context } = recordingContext();
  // 0b101 means bits 0 and 2 are occupied (red), the rest are unoccupied (blue)
  drawOpponentLights(context, { opponentLevelLights: 0b101 } as never);

  const fills = calls.filter((c) => c.startsWith("fillRect"));
  // Should draw all VISIBLE_ROWS (12) lamps
  assert.equal(fills.length, 12);

  // Count red (rgb(255 at start) and blue (rgb(20) for LEVEL_LIGHT_BLUE [0.08, 0.1, 1])
  const redCount = fills.filter((c) => c.includes("rgb(255")).length;
  const blueCount = fills.filter((c) => c.includes("rgb(20")).length;
  assert.equal(redCount, 2, "Should have 2 red lamps for bits 0 and 2");
  assert.equal(blueCount, 10, "Should have 10 blue lamps for unoccupied rows");
});

test("draws nothing when the opponent's stack is empty", () => {
  const { calls, context } = recordingContext();
  drawOpponentLights(context, { opponentLevelLights: 0 } as never);
  assert.equal(calls.filter((c) => c.startsWith("fillRect")).length, 0);
});
