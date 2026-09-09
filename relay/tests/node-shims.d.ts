// relay/tsconfig.json deliberately carries only "@cloudflare/workers-types"
// (Ruling 9) and not "node" — @types/node's web-platform globals
// (fetch/Request/Response/crypto/URL/streams/...) collide with
// workers-types' definitions of the same names if both are in scope at once
// (verified: adding "node" to relay/tsconfig.json's types array produces
// 100+ TS2300/TS2451/TS6200 duplicate-identifier errors). So the two Node
// test modules durable-room.test.ts uses are ambient-declared here, with
// only the surface actually used. Node itself still provides these as real
// built-in modules at runtime; only their .d.ts declarations are missing
// without @types/node. This file has no imports/exports of its own so these
// count as fresh ambient module declarations rather than augmentations of an
// already-resolvable module.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface StrictAssert {
    equal(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}
