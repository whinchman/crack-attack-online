import { test } from "node:test";
import assert from "node:assert/strict";
import { drawOpponentLights } from "../app/game/renderer.ts";

/** Records the calls a 2D context receives, so we can assert on drawing. */
function recordingContext() {
  const calls: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "canvas") return { width: 800, height: 800 };
      return (...args: unknown[]) => { calls.push(`${prop}(${args.join(",")})`); };
    },
    set() { return true; },
  };
  return { calls, context: new Proxy({}, handler) as unknown as CanvasRenderingContext2D };
}

test("draws one lamp per set bit", () => {
  const { calls, context } = recordingContext();
  drawOpponentLights(context, { opponentLevelLights: 0b101 } as never);
  const fills = calls.filter((c) => c.startsWith("fillRect"));
  assert.equal(fills.length, 2);
});

test("draws nothing when the opponent's stack is empty", () => {
  const { calls, context } = recordingContext();
  drawOpponentLights(context, { opponentLevelLights: 0 } as never);
  assert.equal(calls.filter((c) => c.startsWith("fillRect")).length, 0);
});
