# Crack Attack Browser Multiplayer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people click a shared link and play Crack Attack head-to-head in their browsers, with no install, no accounts, and no lobby.

**Architecture:** Fork `leifkb/crack-attack-browser` (a deterministic, tested TypeScript reimplementation) and add the original game's proven network model: a relay assigns both peers a shared RNG seed for fairness, each peer simulates only its own board, and every 32 ticks (640 ms) they exchange queued garbage attacks, a level-light summary of their stack height, game-state flags, and a tick counter for drift correction. A Cloudflare Durable Object acts as one room per match, pairing exactly two WebSockets and forwarding messages verbatim.

**Tech Stack:** TypeScript, Vite 8, React 19, Node 22 test runner (`node --experimental-strip-types --test`), Cloudflare Workers + Durable Objects, plain WebSocket (WSS), JSON messages.

**Spec:** Assessment II — https://claude.ai/code/artifact/81457f35-10a8-426d-be34-dc8a7d0b593f

---

## Global Constraints

- **Node >= 22.13.0** (upstream `package.json` engines field). Tests run via `node --experimental-strip-types --test tests/*.test.ts` with no build step and no `npm install` required for engine tests.
- **License: GPL-2.0-or-later.** Preserve `COPYING`, `COPYRIGHT`, and `ATTRIBUTION.md`. Add our own attribution noting the fork; do not remove existing credits (Daniel Nelson, leifkb). Note: Wade Lutgen is credited in the *original C++* `obj_block.cxx` but appears nowhere in this TypeScript repo — there is nothing here to preserve on his behalf.
- **No accounts, no auth, no persistent user data.** The only server-side state is an in-flight room.
- **Zero friction to join:** opening a challenge link must go straight into the game. No name entry, no settings screen, no permission prompts, no modal before the first block.
- **Rooms are live-only pre-game:** a room exists only while the host holds an open socket on the waiting screen. Host closes the tab, the link is dead.
- **Rooms survive a 30 s disconnect in-game:** either peer may drop and reconnect within `RECONNECT_GRACE_MS`; after that the remaining player wins by forfeit.
- **Determinism discipline:** never introduce `Math.random`, `Date.now()`, or `performance.now()` into `app/game/engine.ts`. The engine's seeded xorshift32 stream is the only randomness source. Cosmetic-only randomness must not consume that stream.
- **Sync constants must match the original:** `TICK_MS = 20`, `SYNC_PERIOD_TICKS = 32` (640 ms), `GARBAGE_QUEUE_SIZE = 8`.
- **Messages are JSON.** Bandwidth is ~231 B/s at worst; readability beats compactness.

---

## File Structure

**New — network client (`app/net/`)**
- `app/net/protocol.ts` — message type definitions, constants, and validation. Pure, no I/O.
- `app/net/transport.ts` — WebSocket lifecycle: connect, heartbeat, reconnect with grace window. Knows nothing about the game.
- `app/net/match.ts` — `MatchController`: owns the tick cadence, garbage queue, level-light exchange, and drift correction. Pure logic over an injected transport; no React, no DOM.
- `app/net/useMatch.ts` — React hook binding `MatchController` to component state.

**New — relay (`relay/`)**
- `relay/src/index.ts` — Worker entry: routes `/new` and `/room/:code` to the Durable Object.
- `relay/src/room.ts` — `Room` Durable Object: pairs two sockets, mints the seed, forwards messages, enforces the 2-player cap and grace window.
- `relay/wrangler.toml` — Worker + DO binding configuration.

**Modified**
- `app/game/engine.ts` — add attack draining, opponent level-light input, and forfeit/opponent-lost status. No changes to simulation logic.
- `app/game/renderer.ts` — draw the opponent level-light column.
- `app/game/CrackAttackGame.tsx` — match mode: read room code from URL, drive the engine through the match clock, render connection state.

**Tests** — one file per new module under `tests/`, matching the existing convention.

**Deleted (Task 1)** — `next.config.ts`, `drizzle.config.ts`, `db/`, `drizzle/`, `worker/`, `app/chatgpt-auth.ts`, `scripts/sites-env.sh`, and the `vinext`/Next/Drizzle/wrangler-app dependencies. Keep `vite.pages.config.ts`, `tsconfig.pages.json`, and the Pages CI workflow.

---

## Design Notes (read before Task 5)

**This is not full lockstep.** The original does *not* replicate the opponent's board. Both peers start from the same seed so their block sequences are identical (fairness), but each simulates only its own playfield. Divergence in the RNG stream degrades fairness, it does not corrupt either player's game. This is a much softer failure mode than deterministic lockstep and drives every decision below.

**Deriving the tick from the engine.** The engine advances on wall-clock time via `update(now)` and exposes `elapsedMs` on its snapshot. The match tick is therefore `Math.floor(snapshot.elapsedMs / TICK_MS)` — we never restructure the render loop, we just read the simulation's own clock.

**Drift correction.** If we are running ahead of the peer by more than one sync period, `MatchController.clampNow()` freezes the time we feed `engine.update()` until they catch up. This mirrors `Game::syncPause` in the original.

---

## Task 1: Fork and strip to a clean, green baseline

**Files:**
- Create: `/home/whinchman/experiments/crack-attack-online/` (clone of `https://github.com/leifkb/crack-attack-browser`)
- Delete: `next.config.ts`, `drizzle.config.ts`, `db/`, `drizzle/`, `worker/`, `app/chatgpt-auth.ts`, `scripts/sites-env.sh`
- Modify: `package.json`, `eslint.config.mjs`, `README.md`, `ATTRIBUTION.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo where `npm run test:engine`, `npm run build:pages` and `npm run typecheck:pages` all pass with no Next/Cloudflare-app/Drizzle dependencies.

- [ ] **Step 1: Already done by the controller — verify only**

The repo is already cloned at `/home/whinchman/experiments/crack-attack-online` from the user's own fork (`https://github.com/whinchman/crack-attack-online`), on branch `multiplayer`. Confirm:

```bash
cd /home/whinchman/experiments/crack-attack-online
git remote -v          # origin -> whinchman/crack-attack-online
git branch --show-current   # multiplayer
```

Add the upstream remote so we can diff against leifkb later:

```bash
git remote add upstream https://github.com/leifkb/crack-attack-browser.git || true
```

- [ ] **Step 2: Record the pre-strip baseline**

```bash
node --experimental-strip-types --test tests/*.test.ts 2>&1 | tail -8
```

Expected: `# pass 128`, `# fail 0` (126 upstream tests plus the 2-test determinism probe the controller added). Write the number down; Task 1 must not change it.

- [ ] **Step 3: Delete the unrelated scaffolding**

```bash
git rm -r --cached db drizzle worker
rm -rf db drizzle worker
rm -f next.config.ts drizzle.config.ts app/chatgpt-auth.ts scripts/sites-env.sh
```

- [ ] **Step 4: Strip dependencies and scripts from `package.json`**

Remove these `scripts` entries: `dev`, `start`, `build`, `test`, `db:generate`, `validate:artifact`, `install:ci`.
Rewrite the remaining scripts to:

```json
{
  "scripts": {
    "dev": "vite --config vite.pages.config.ts",
    "build": "vite build --config vite.pages.config.ts",
    "test": "node --experimental-strip-types --test tests/*.test.ts",
    "typecheck": "tsc --project tsconfig.pages.json",
    "lint": "eslint . --ignore-pattern dist-pages",
    "validate": "node scripts/validate-pages-artifact.mjs"
  }
}
```

Remove from `dependencies` and `devDependencies` every package whose name starts with `next`, `vinext`, `drizzle`, `wrangler`, `@cloudflare/`, or `react-server-dom-webpack`. Keep `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`, `eslint` and their configs.

- [ ] **Step 5: Fix lint config**

`eslint.config.mjs` invokes the deleted `scripts/sites-env.sh` indirectly via the old `lint` script. Confirm the config itself has no Next plugin reference:

```bash
grep -nE "next|vinext" eslint.config.mjs || echo "clean"
```

If any line matches, delete that plugin entry.

- [ ] **Step 6: Reinstall and verify nothing regressed**

```bash
rm -rf node_modules package-lock.json
npm install
npm run test
npm run typecheck
npm run build
```

Expected: tests still `# pass 86 / # fail 0`; typecheck clean; `dist-pages/` produced.

- [ ] **Step 7: Record the fork in `ATTRIBUTION.md`**

Append:

```markdown
## This fork

Online two-player support added in a fork of leifkb/crack-attack-browser.
The network model (shared seed for fairness, per-peer simulation, 32-tick
garbage/level-light exchange) is reproduced from the original Crack Attack!
`src/Communicator.cxx` by Daniel Nelson, GPLv2-or-later.
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: fork and strip unrelated Next/Cloudflare/Drizzle scaffolding"
```

---

## Task 2: Wire protocol module

**Files:**
- Create: `app/net/protocol.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `AttackPayload`, `GarbageFlavor` from `app/game/engine.ts`.
- Produces: `TICK_MS`, `SYNC_PERIOD_TICKS`, `GARBAGE_QUEUE_SIZE`, `RECONNECT_GRACE_MS`, types `ClientMessage`/`ServerMessage`/`SyncMessage`/`WireAttack`, and `parseServerMessage(raw: string): ServerMessage | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/protocol.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GARBAGE_QUEUE_SIZE,
  SYNC_PERIOD_TICKS,
  TICK_MS,
  parseServerMessage,
} from "../app/net/protocol.ts";

test("sync constants match the original game", () => {
  assert.equal(TICK_MS, 20);
  assert.equal(SYNC_PERIOD_TICKS, 32);
  assert.equal(SYNC_PERIOD_TICKS * TICK_MS, 640);
  assert.equal(GARBAGE_QUEUE_SIZE, 8);
});

test("parses a well-formed start message", () => {
  const msg = parseServerMessage('{"t":"start","seed":12345,"role":"host"}');
  assert.deepEqual(msg, { t: "start", seed: 12345, role: "host" });
});

test("parses a sync message and clamps an oversized attack queue", () => {
  const attacks = Array.from({ length: 20 }, () => ({
    tick: 5, height: 1, width: 3, flavor: "normal",
  }));
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 64, lights: 3, state: 0, attacks,
  }));
  assert.equal(msg?.t, "sync");
  assert.equal(msg.t === "sync" && msg.attacks.length, GARBAGE_QUEUE_SIZE);
});

test("rejects malformed input instead of throwing", () => {
  assert.equal(parseServerMessage("not json"), null);
  assert.equal(parseServerMessage('{"t":"nope"}'), null);
  assert.equal(parseServerMessage('{"t":"start","seed":"x","role":"host"}'), null);
  assert.equal(parseServerMessage('{"t":"sync","tick":-1,"lights":0,"state":0,"attacks":[]}'), null);
});

test("rejects an attack with an unknown flavor", () => {
  const msg = parseServerMessage(JSON.stringify({
    t: "sync", tick: 1, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: 3, flavor: "purple" }],
  }));
  assert.equal(msg, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/protocol.test.ts`
Expected: FAIL — cannot find module `../app/net/protocol.ts`.

- [ ] **Step 3: Write the implementation**

Create `app/net/protocol.ts`:

```ts
import type { GarbageFlavor } from "../game/engine.ts";

/** Simulation tick length, matching GC_TIME_STEP_PERIOD in the original. */
export const TICK_MS = 20;
/** Ticks between state exchanges, matching CO_COMMUNICATION_PERIOD. */
export const SYNC_PERIOD_TICKS = 32;
/** Maximum queued attacks per exchange, matching GC_GARBAGE_QUEUE_SIZE. */
export const GARBAGE_QUEUE_SIZE = 8;
/** How long a dropped peer may take to return before forfeiting. */
export const RECONNECT_GRACE_MS = 30_000;

/** Bit flags mirroring the original's game_state field. */
export const STATE_PAUSED = 1 << 0;
export const STATE_LOST = 1 << 1;

export interface WireAttack {
  tick: number;
  height: number;
  width: number;
  flavor: GarbageFlavor;
}

export interface SyncMessage {
  t: "sync";
  tick: number;
  lights: number;
  state: number;
  attacks: WireAttack[];
}

export type ClientMessage = SyncMessage;

export type ServerMessage =
  | { t: "start"; seed: number; role: "host" | "guest" }
  | { t: "peer-left" }
  | { t: "peer-back" }
  | { t: "forfeit" }
  | { t: "error"; reason: "full" | "missing" | "malformed" }
  | SyncMessage;

const FLAVORS: readonly string[] = ["normal", "gray"];

function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseAttack(raw: unknown): WireAttack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (!isUint(a.tick) || !isUint(a.height) || !isUint(a.width)) return null;
  if (typeof a.flavor !== "string" || !FLAVORS.includes(a.flavor)) return null;
  return {
    tick: a.tick,
    height: a.height,
    width: a.width,
    flavor: a.flavor as GarbageFlavor,
  };
}

/**
 * Parse an untrusted message from the relay or peer.
 * Returns null rather than throwing, so a malformed peer can never crash us.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;

  switch (m.t) {
    case "start":
      if (!isUint(m.seed)) return null;
      if (m.role !== "host" && m.role !== "guest") return null;
      return { t: "start", seed: m.seed, role: m.role };
    case "peer-left":
      return { t: "peer-left" };
    case "peer-back":
      return { t: "peer-back" };
    case "forfeit":
      return { t: "forfeit" };
    case "error":
      if (m.reason !== "full" && m.reason !== "missing" && m.reason !== "malformed") return null;
      return { t: "error", reason: m.reason };
    case "sync": {
      if (!isUint(m.tick) || !isUint(m.lights) || !isUint(m.state)) return null;
      if (!Array.isArray(m.attacks)) return null;
      const attacks: WireAttack[] = [];
      // Bound the queue on receive. The original trusts the peer's count here,
      // which is an out-of-bounds write in the C++. We do not repeat that.
      for (const entry of m.attacks.slice(0, GARBAGE_QUEUE_SIZE)) {
        const attack = parseAttack(entry);
        if (!attack) return null;
        attacks.push(attack);
      }
      return { t: "sync", tick: m.tick, lights: m.lights, state: m.state, attacks };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/protocol.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/net/protocol.ts tests/protocol.test.ts
git commit -m "feat(net): wire protocol types and validating parser"
```

---

## Task 3: Room Durable Object

**Files:**
- Create: `relay/src/room-logic.ts`, `relay/src/durable-room.ts`, `relay/src/index.ts`, `relay/wrangler.toml`, `relay/package.json`, `relay/tsconfig.json`
- Test: `tests/room-logic.test.ts`

**Interfaces:**
- Consumes: `parseServerMessage`, `RECONNECT_GRACE_MS` from `app/net/protocol.ts`.
- Produces: `RoomLogic` class (from `relay/src/room-logic.ts`) with `addPeer(id): "host" | "guest" | "full"`, `removePeer(id, atMs)`, `expiredAt(nowMs): boolean`, `wasPaired: boolean`, `paired: boolean`, `seed: number`, `peerCount: number`. Plus the `Room` Durable Object class from `relay/src/durable-room.ts`.

**MANDATORY file split (controller Ruling 9).** `RoomLogic` is pure and lives in `relay/src/room-logic.ts`. The `Room` Durable Object — which references Workers-only globals (`DurableObjectState`, `DurableObjectNamespace`, `WebSocketPair`) — lives separately in `relay/src/durable-room.ts`. This is not optional and not a style preference: `tsconfig.pages.json` now typechecks `tests/**`, and its `types` array is `["vite/client", "node"]` with no Workers types. A test importing a module that references `DurableObjectState` would fail `npm run typecheck`. Keeping the pure half in its own file means `tests/room-logic.test.ts` never pulls Workers types into the pages program.

- [ ] **Step 1: Write the failing test**

Create `tests/room-logic.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/room-logic.test.ts`
Expected: FAIL — cannot find module `../relay/src/room.ts`.

- [ ] **Step 3: Write `RoomLogic` and the Durable Object**

Create `relay/src/room-logic.ts` — the PURE half, no Workers types anywhere:

```ts
import { RECONNECT_GRACE_MS } from "../../app/net/protocol.ts";

export type Role = "host" | "guest";

/**
 * Pure room bookkeeping: who is present, who has dropped, and when the room
 * should be reaped. Separated from the Durable Object so it is testable
 * without a Workers runtime.
 */
export class RoomLogic {
  readonly seed: number;
  private peers = new Map<string, Role>();
  private emptiedAt: number | null = null;
  private everPaired = false;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get paired(): boolean {
    return this.peers.size === 2;
  }

  /** True once two peers have been present together at least once. */
  get wasPaired(): boolean {
    return this.everPaired;
  }

  addPeer(id: string): Role | "full" {
    if (this.peers.size >= 2) return "full";
    const role: Role = this.peers.size === 0 ? "host" : "guest";
    this.peers.set(id, role);
    this.emptiedAt = null;
    if (this.peers.size === 2) this.everPaired = true;
    return role;
  }

  removePeer(id: string, atMs: number): void {
    this.peers.delete(id);
    if (this.peers.size < 2) this.emptiedAt = atMs;
  }

  /**
   * A room with nobody in it is dead immediately. A room that has been paired
   * and lost one peer stays alive for the reconnect grace window. A room that
   * was never paired dies as soon as the host leaves (live-only challenge links).
   */
  expiredAt(nowMs: number): boolean {
    if (this.peers.size === 0) return true;
    if (this.peers.size === 2 || this.emptiedAt === null) return false;
    if (!this.everPaired) return false;
    return nowMs - this.emptiedAt > RECONNECT_GRACE_MS;
  }
}

```

Then create `relay/src/durable-room.ts` — the Workers half. Note it imports `RoomLogic` from the pure module and `parseServerMessage` from the protocol:

```ts
import { RoomLogic } from "./room-logic.ts";
import { RECONNECT_GRACE_MS, parseServerMessage } from "../../app/net/protocol.ts";

interface Env {
  ROOM: DurableObjectNamespace;
}

export class Room {
  private logic = new RoomLogic(crypto.getRandomValues(new Uint32Array(1))[0]);
  private sockets = new Map<string, WebSocket>();
  /** False until the first pairing has sent "start"; true for later rejoins. */
  private rejoin = false;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();

    const role = this.logic.addPeer(id);
    if (role === "full") {
      server.accept();
      server.send(JSON.stringify({ t: "error", reason: "full" }));
      server.close(1008, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    server.accept();
    this.sockets.set(id, server);

    server.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      // Validate before forwarding so a malformed peer cannot poison the other.
      if (!parseServerMessage(raw)) return;
      for (const [otherId, socket] of this.sockets) {
        if (otherId !== id) socket.send(raw);
      }
    });

    const onGone = () => {
      this.sockets.delete(id);
      this.logic.removePeer(id, Date.now());
      for (const socket of this.sockets.values()) {
        socket.send(JSON.stringify({ t: "peer-left" }));
      }
      // A match that has actually started gets a grace window; an unclaimed
      // challenge link dies with its host.
      if (this.logic.wasPaired && this.sockets.size > 0) {
        void this.state.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
      }
    };
    server.addEventListener("close", onGone);
    server.addEventListener("error", onGone);

    if (this.logic.paired) {
      if (this.rejoin) {
        // Someone came back inside the grace window.
        void this.state.storage.deleteAlarm();
        for (const [otherId, socket] of this.sockets) {
          if (otherId !== id) socket.send(JSON.stringify({ t: "peer-back" }));
        }
      } else {
        let index = 0;
        for (const [, socket] of this.sockets) {
          socket.send(JSON.stringify({
            t: "start",
            seed: this.logic.seed,
            role: index === 0 ? "host" : "guest",
          }));
          index += 1;
        }
        this.rejoin = true;
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** The grace window expired: whoever is still here wins by forfeit. */
  async alarm(): Promise<void> {
    for (const socket of this.sockets.values()) {
      socket.send(JSON.stringify({ t: "forfeit" }));
      socket.close(1000, "opponent forfeited");
    }
    this.sockets.clear();
  }
}
```

Create `relay/src/index.ts`:

```ts
export { Room } from "./durable-room.ts";

interface Env {
  ROOM: DurableObjectNamespace;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Six characters from a 31-symbol alphabet, ambiguous glyphs removed. */
function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/new") {
      return Response.json({ room: mintCode() });
    }

    const match = url.pathname.match(/^\/room\/([A-Z2-9]{6})$/);
    if (match) {
      const id = env.ROOM.idFromName(match[1]);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
```

Create `relay/wrangler.toml`:

```toml
name = "crack-attack-relay"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

Create `relay/package.json`:

```json
{
  "name": "crack-attack-relay",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.92.0",
    "@cloudflare/workers-types": "^4.20260101.0"
  }
}
```

Create `relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "../app/net/protocol.ts"]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/room-logic.test.ts`
Expected: PASS, 8 tests.

Because `RoomLogic` lives in its own Workers-free module, this test imports only pure TypeScript — no Workers globals enter the Node test run or the pages typecheck program.

- [ ] **Step 5: Commit**

```bash
git add relay tests/room-logic.test.ts
git commit -m "feat(relay): room durable object with pairing and grace window"
```

---

## Task 4: Transport with heartbeat and reconnect

**Files:**
- Create: `app/net/transport.ts`
- Test: `tests/transport.test.ts`

**Interfaces:**
- Consumes: `parseServerMessage`, `ServerMessage`, `ClientMessage` from `app/net/protocol.ts`.
- Produces: `Transport` class with `constructor(url: string, factory?: SocketFactory)`, `send(msg: ClientMessage)`, `onMessage(cb: (m: ServerMessage) => void)`, `onStatus(cb: (s: TransportStatus) => void)`, `close()`; and type `TransportStatus = "connecting" | "open" | "reconnecting" | "closed"`.

- [ ] **Step 1: Write the failing test**

Create `tests/transport.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Transport } from "../app/net/transport.ts";
import type { ServerMessage } from "../app/net/protocol.ts";

/** Minimal stand-in for a browser WebSocket, driven manually by the test. */
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) { FakeSocket.last = this; }
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
  const sync = { t: "sync", tick: 32, lights: 0, state: 0, attacks: [] } as const;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/transport.test.ts`
Expected: FAIL — cannot find module `../app/net/transport.ts`.

- [ ] **Step 3: Write the implementation**

Create `app/net/transport.ts`:

```ts
import { parseServerMessage } from "./protocol.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

export type TransportStatus = "connecting" | "open" | "reconnecting" | "closed";
export type SocketFactory = (url: string) => WebSocket;

/**
 * A WebSocket that reconnects on unexpected close and buffers sends made
 * while it is down. Knows nothing about the game.
 *
 * `reconnectDelayMs` is injected rather than hardcoded so tests can drive
 * reconnection synchronously with a delay of 0.
 */
export class Transport {
  private socket: WebSocket | null = null;
  private status: TransportStatus = "connecting";
  private outbox: string[] = [];
  private messageHandlers: Array<(m: ServerMessage) => void> = [];
  private statusHandlers: Array<(s: TransportStatus) => void> = [];
  private deliberateClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private url: string,
    private factory: SocketFactory = (u) => new WebSocket(u),
    private reconnectDelayMs = 1_000,
  ) {
    this.open();
  }

  private setStatus(next: TransportStatus): void {
    this.status = next;
    for (const handler of this.statusHandlers) handler(next);
  }

  private open(): void {
    this.setStatus(this.socket ? "reconnecting" : "connecting");
    const socket = this.factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.setStatus("open");
      for (const queued of this.outbox.splice(0)) socket.send(queued);
    };
    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const message = parseServerMessage(raw);
      if (!message) return;
      for (const handler of this.messageHandlers) handler(message);
    };
    socket.onclose = () => this.handleDrop();
    socket.onerror = () => this.handleDrop();
  }

  private handleDrop(): void {
    if (this.deliberateClose) return;
    if (this.retryTimer !== null) return;
    this.setStatus("reconnecting");
    if (this.reconnectDelayMs === 0) {
      this.open();
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, this.reconnectDelayMs);
  }

  send(message: ClientMessage): void {
    const raw = JSON.stringify(message);
    if (this.socket && this.status === "open") this.socket.send(raw);
    else this.outbox.push(raw);
  }

  onMessage(handler: (m: ServerMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatus(handler: (s: TransportStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  close(): void {
    this.deliberateClose = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.socket?.close();
    this.setStatus("closed");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/transport.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/net/transport.ts tests/transport.test.ts
git commit -m "feat(net): reconnecting websocket transport"
```

---

## Task 5: Engine hooks for attacks and opponent lights

**Files:**
- Modify: `app/game/engine.ts`
- Test: `tests/engine-multiplayer.test.ts`

**Interfaces:**
- Consumes: existing `CrackAttackEngine`, `AttackPayload`.
- Produces: on `CrackAttackEngine` — `drainOutgoingAttacks(): AttackPayload[]`, `setOpponentLevelLights(bits: number): void`, `opponentLevelLights: number` on the snapshot, `exportLevelLights(): number`, and `forfeitWin(now: number): void`.

The engine already supports an `attackSink` callback. We add a buffered alternative so the match layer can drain on its own cadence rather than reacting per-attack, and a way to carry the opponent's light bits through to the renderer.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-multiplayer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/engine-multiplayer.test.ts`
Expected: FAIL — `engine.queueOutgoingAttack is not a function`.

- [ ] **Step 3: Add the hooks to `engine.ts`**

Add these private fields alongside the existing `attackSink` declaration (near line 939):

```ts
  private outgoingAttacks: AttackPayload[] = [];
  private opponentLights = 0;
```

Add these public methods immediately after the existing `receiveAttack` method (near line 1523):

```ts
  /** Buffer an attack for the network layer to drain on its own cadence. */
  queueOutgoingAttack(attack: AttackPayload): void {
    if (this.outgoingAttacks.length >= 8) return;
    this.outgoingAttacks.push(attack);
  }

  /** Take everything queued since the last call. */
  drainOutgoingAttacks(): AttackPayload[] {
    return this.outgoingAttacks.splice(0);
  }

  /** Record the opponent's stack-height bits for rendering. */
  setOpponentLevelLights(bits: number): void {
    this.opponentLights = bits >>> 0;
  }

  /**
   * Summarise our own stack height as one bit per visible row, mirroring the
   * original's level_lights field. Reuses the existing private
   * `topOccupiedRow(now)` helper (engine.ts:3346) rather than re-traversing.
   */
  exportLevelLights(now: number): number {
    const top = this.topOccupiedRow(now);
    let bits = 0;
    for (let row = 0; row < VISIBLE_ROWS; row += 1) {
      if (row <= top) bits |= 1 << row;
    }
    return bits >>> 0;
  }

  /** End the game as a win because the opponent failed to return. */
  forfeitWin(now: number): void {
    this.concede(now);
  }
```

In `reset()` (near line 990), clear the new state alongside the existing resets:

```ts
    this.outgoingAttacks = [];
    this.opponentLights = 0;
```

In `getSnapshot()` (near line 1619), add to the returned object:

```ts
      opponentLevelLights: this.opponentLights,
```

In the `GameSnapshot` interface (near line 599), add:

```ts
  opponentLevelLights: number;
```

Change `emitAttack` (near line 2905) so multiplayer buffers instead of self-looping:

```ts
  private emitAttack(attack: AttackPayload): void {
    if (this.attackSink) this.attackSink(attack);
    else if (this.multiplayer) this.queueOutgoingAttack(attack);
    else this.receiveAttack(attack);
  }
```

Add the `multiplayer` flag to the constructor options and field:

```ts
  private multiplayer: boolean;
  // in the constructor:
  this.multiplayer = options.multiplayer ?? false;
```

Update the constructor signature to:

```ts
  constructor(options: { seed?: number; attackSink?: AttackSink; multiplayer?: boolean } = {}) {
```

No new traversal helper is needed: `private topOccupiedRow(now: number): number` already exists at `engine.ts:3346` and is what the snapshot itself uses. `exportLevelLights` calls it directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/engine-multiplayer.test.ts tests/engine.test.ts`
Expected: PASS — the 4 new tests plus all 86 existing tests still green. The existing suite passing is the important part: solo behaviour must be unchanged.

- [ ] **Step 5: Re-run the determinism probe**

```bash
node --experimental-strip-types --test tests/determinism-probe.test.ts
```

Expected: PASS. (Copy this file over from the assessment scratchpad if it is not yet in the repo — it belongs in the fork.)

- [ ] **Step 6: Commit**

```bash
git add app/game/engine.ts tests/engine-multiplayer.test.ts tests/determinism-probe.test.ts
git commit -m "feat(engine): attack buffering and opponent level lights"
```

---

## Task 6: MatchController

**Files:**
- Create: `app/net/match.ts`
- Test: `tests/match.test.ts`

**Interfaces:**
- Consumes: `Transport`, protocol constants and types, `CrackAttackEngine`.
- Produces: `MatchController` with `constructor(engine, transport)`, `tickTo(now: number): number` (returns the clamped `now` to feed `engine.update`), `onSync(msg: SyncMessage)`, `role`, `seed`, `peerTick`, `waitingForPeer: boolean`.

This is the heart of the feature. It converts the engine's elapsed time into ticks, fires a sync every 32 ticks, applies incoming attacks and lights, and stalls us if we run ahead of the peer.

- [ ] **Step 1: Write the failing test**

Create `tests/match.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CrackAttackEngine } from "../app/game/engine.ts";
import { MatchController } from "../app/net/match.ts";
import { SYNC_PERIOD_TICKS, TICK_MS } from "../app/net/protocol.ts";
import type { ClientMessage, SyncMessage } from "../app/net/protocol.ts";

class FakeTransport {
  sent: ClientMessage[] = [];
  send(m: ClientMessage) { this.sent.push(m); }
  onMessage() {}
  onStatus() {}
  close() {}
}

function makeMatch() {
  const engine = new CrackAttackEngine({ seed: 5, multiplayer: true });
  const transport = new FakeTransport();
  const match = new MatchController(engine, transport as never);
  match.begin({ seed: 5, role: "host" }, 0);
  return { engine, transport, match };
}

const PERIOD_MS = SYNC_PERIOD_TICKS * TICK_MS;

test("emits no sync before a full period has elapsed", () => {
  const { engine, transport, match } = makeMatch();
  const now = PERIOD_MS - TICK_MS;
  engine.update(match.tickTo(now));
  assert.equal(transport.sent.length, 0);
});

test("emits exactly one sync per elapsed period", () => {
  const { engine, transport, match } = makeMatch();
  for (let ms = TICK_MS; ms <= PERIOD_MS; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].t, "sync");
});

test("a sync carries our tick, lights and drained attacks", () => {
  const { engine, transport, match } = makeMatch();
  engine.queueOutgoingAttack({ height: 2, width: 3, flavor: "normal", source: "clear", createdAt: 0 });
  for (let ms = TICK_MS; ms <= PERIOD_MS; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  const sent = transport.sent[0] as SyncMessage;
  assert.equal(sent.tick, SYNC_PERIOD_TICKS);
  assert.equal(sent.attacks.length, 1);
  assert.equal(sent.attacks[0].width, 3);
  assert.equal(typeof sent.lights, "number");
});

test("an incoming sync delivers attacks to our board", () => {
  const { engine, match } = makeMatch();
  const before = engine.getSnapshot(0).incomingCount;
  match.onSync({
    t: "sync", tick: SYNC_PERIOD_TICKS, lights: 0, state: 0,
    attacks: [{ tick: 1, height: 1, width: 6, flavor: "normal" }],
  });
  assert.ok(engine.getSnapshot(0).incomingCount > before);
});

test("an incoming sync records the opponent's lights", () => {
  const { engine, match } = makeMatch();
  match.onSync({ t: "sync", tick: SYNC_PERIOD_TICKS, lights: 0b101, state: 0, attacks: [] });
  assert.equal(engine.getSnapshot(0).opponentLevelLights, 0b101);
});

test("running more than a period ahead of the peer stalls our clock", () => {
  const { engine, match } = makeMatch();
  // Advance two full periods with no word from the peer.
  let last = 0;
  for (let ms = TICK_MS; ms <= PERIOD_MS * 3; ms += TICK_MS) {
    last = match.tickTo(ms);
    engine.update(last);
  }
  assert.ok(match.waitingForPeer, "should be waiting once far ahead of the peer");
  assert.ok(last < PERIOD_MS * 3, "clamped time must lag real time while stalled");
});

test("a peer sync releases the stall", () => {
  const { engine, match } = makeMatch();
  for (let ms = TICK_MS; ms <= PERIOD_MS * 3; ms += TICK_MS) {
    engine.update(match.tickTo(ms));
  }
  assert.equal(match.waitingForPeer, true);
  match.onSync({ t: "sync", tick: SYNC_PERIOD_TICKS * 3, lights: 0, state: 0, attacks: [] });
  assert.equal(match.waitingForPeer, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/match.test.ts`
Expected: FAIL — cannot find module `../app/net/match.ts`.

- [ ] **Step 3: Write the implementation**

Create `app/net/match.ts`:

```ts
import { SYNC_PERIOD_TICKS, TICK_MS } from "./protocol.ts";
import type { SyncMessage, WireAttack } from "./protocol.ts";
import type { Transport } from "./transport.ts";
import type { CrackAttackEngine } from "../game/engine.ts";

/** How far ahead of the peer we tolerate before stalling, in ticks. */
const MAX_LEAD_TICKS = SYNC_PERIOD_TICKS * 2;

export interface MatchStart {
  seed: number;
  role: "host" | "guest";
}

/**
 * Drives one online match. Mirrors the original's Communicator: both peers run
 * from a shared seed for fairness, each simulates only its own board, and every
 * SYNC_PERIOD_TICKS they exchange queued garbage, a level-light summary, and a
 * tick counter used to keep the two clocks from drifting apart.
 */
export class MatchController {
  role: "host" | "guest" = "host";
  seed = 0;
  peerTick = 0;
  waitingForPeer = false;

  private startedAtMs = 0;
  private stalledMs = 0;
  private stallBeganAt: number | null = null;
  private lastSyncedTick = 0;

  constructor(
    private engine: CrackAttackEngine,
    private transport: Transport,
  ) {}

  begin(start: MatchStart, nowMs: number): void {
    this.role = start.role;
    this.seed = start.seed;
    this.startedAtMs = nowMs;
    this.stalledMs = 0;
    this.stallBeganAt = null;
    this.lastSyncedTick = 0;
    this.peerTick = 0;
    this.waitingForPeer = false;
    this.engine.start(nowMs, start.seed);
  }

  /**
   * Convert real time into the time the engine should see, holding it still
   * while we are too far ahead of the peer, and emitting a sync each period.
   * Returns the value to pass to engine.update().
   */
  tickTo(nowMs: number): number {
    const ourTick = Math.floor((nowMs - this.startedAtMs - this.stalledMs) / TICK_MS);

    if (ourTick > this.peerTick + MAX_LEAD_TICKS) {
      if (this.stallBeganAt === null) this.stallBeganAt = nowMs;
      this.waitingForPeer = true;
      return this.startedAtMs + this.stalledMs + (this.peerTick + MAX_LEAD_TICKS) * TICK_MS;
    }

    if (this.stallBeganAt !== null) {
      this.stalledMs += nowMs - this.stallBeganAt;
      this.stallBeganAt = null;
      this.waitingForPeer = false;
    }

    const clamped = nowMs - this.stalledMs;
    const reachedTick = Math.floor((clamped - this.startedAtMs) / TICK_MS);
    if (reachedTick - this.lastSyncedTick >= SYNC_PERIOD_TICKS) {
      this.lastSyncedTick = reachedTick - (reachedTick % SYNC_PERIOD_TICKS);
      this.emitSync(this.lastSyncedTick, clamped);
    }
    return clamped;
  }

  private emitSync(tick: number, now: number): void {
    const attacks: WireAttack[] = this.engine.drainOutgoingAttacks().map((a) => ({
      tick,
      height: a.height,
      width: a.width,
      flavor: a.flavor,
    }));
    this.transport.send({
      t: "sync",
      tick,
      lights: this.engine.exportLevelLights(now),
      state: 0,
      attacks,
    });
  }

  /** Apply a sync received from the peer. */
  onSync(message: SyncMessage): void {
    this.peerTick = Math.max(this.peerTick, message.tick);
    this.waitingForPeer = false;
    this.engine.setOpponentLevelLights(message.lights);
    for (const attack of message.attacks) {
      this.engine.receiveAttack({
        height: attack.height,
        width: attack.width,
        flavor: attack.flavor,
        source: "clear",
        createdAt: attack.tick * TICK_MS,
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/match.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/net/match.ts tests/match.test.ts
git commit -m "feat(net): match controller with sync cadence and drift stall"
```

---

## Task 7: Render the opponent's level lights

**Files:**
- Modify: `app/game/renderer.ts`
- Test: `tests/renderer-opponent.test.ts`

**Interfaces:**
- Consumes: `GameSnapshot.opponentLevelLights` from Task 5.
- Produces: `drawOpponentLights(context, snapshot)` exported from `renderer.ts`, called inside `drawGame`.

The original shows the opponent as a column of lights beside your own (`LL_LOCAL_LIGHTS` / `LL_OPPONENT_LIGHTS` in `LevelLights.h`). The port already draws the local column via `drawLevelLights`; this mirrors it on the opposite side.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer-opponent.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/renderer-opponent.test.ts`
Expected: FAIL — `drawOpponentLights` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `app/game/renderer.ts`, near the existing `drawLevelLights` function:

```ts
/** Mirrors the original's LL_OPPONENT_LIGHTS column on the right of the board. */
export function drawOpponentLights(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
): void {
  const bits = snapshot.opponentLevelLights ?? 0;
  if (bits === 0) return;
  const lampWidth = 14;
  const lampHeight = Math.floor(CELL_SIZE * 0.5);
  const x = BOARD_X + BOARD_WIDTH + 18;
  for (let row = 0; row < VISIBLE_ROWS; row += 1) {
    if ((bits & (1 << row)) === 0) continue;
    const danger = row >= VISIBLE_ROWS - 3;
    context.fillStyle = danger ? "#FF0000" : "#3333CC";
    const y = BOARD_BOTTOM - (row + 1) * CELL_SIZE + (CELL_SIZE - lampHeight) / 2;
    context.fillRect(x, y, lampWidth, lampHeight);
  }
}
```

Call it from `drawGame`, immediately after the existing `drawLevelLights(target, snapshot);` line:

```ts
  drawOpponentLights(target, snapshot);
```

`VISIBLE_ROWS`, `CELL_SIZE`, `BOARD_X`, `BOARD_WIDTH` and `BOARD_BOTTOM` are all already in scope in `renderer.ts` (the first is imported at line 14, the rest are module constants at lines 67–72). No new imports are required.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/renderer-opponent.test.ts tests/renderer.test.ts`
Expected: PASS — the 2 new tests plus the existing renderer suite.

- [ ] **Step 5: Commit**

```bash
git add app/game/renderer.ts tests/renderer-opponent.test.ts
git commit -m "feat(render): opponent level-light column"
```

---

## Task 8: Challenge-link UI

**Files:**
- Create: `app/net/useMatch.ts`
- Modify: `app/game/CrackAttackGame.tsx`
- Test: `tests/use-match.test.ts`

**Interfaces:**
- Consumes: `Transport`, `MatchController`, `parseServerMessage`.
- Produces: `roomCodeFromLocation(href: string): string | null` and `challengeUrl(href: string, room: string): string`, both exported from `app/net/useMatch.ts`; plus the `useMatch` hook.

Flow: the page reads `#room=CODE` from the URL. No code means solo, exactly as today. A code means connect, show "waiting for your opponent" with a copyable link, and start the moment the second player arrives.

- [ ] **Step 1: Write the failing test**

Create `tests/use-match.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeUrl, roomCodeFromLocation } from "../app/net/useMatch.ts";

test("reads a room code from the fragment", () => {
  assert.equal(roomCodeFromLocation("https://x.dev/#room=AB3K9Z"), "AB3K9Z");
});

test("returns null when there is no room code", () => {
  assert.equal(roomCodeFromLocation("https://x.dev/"), null);
  assert.equal(roomCodeFromLocation("https://x.dev/#other=1"), null);
});

test("rejects a malformed room code", () => {
  assert.equal(roomCodeFromLocation("https://x.dev/#room=ab3k9z"), null);
  assert.equal(roomCodeFromLocation("https://x.dev/#room=SHORT"), null);
  assert.equal(roomCodeFromLocation("https://x.dev/#room=TOOLONG1"), null);
});

test("builds a shareable challenge url that drops any existing fragment", () => {
  assert.equal(
    challengeUrl("https://x.dev/play?a=1#room=OLDONE", "AB3K9Z"),
    "https://x.dev/play?a=1#room=AB3K9Z",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/use-match.test.ts`
Expected: FAIL — cannot find module `../app/net/useMatch.ts`.

- [ ] **Step 3: Write the URL helpers and hook**

Create `app/net/useMatch.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { MatchController } from "./match.ts";
import { Transport } from "./transport.ts";
import type { TransportStatus } from "./transport.ts";
import type { CrackAttackEngine } from "../game/engine.ts";

const ROOM_PATTERN = /^[A-Z2-9]{6}$/;

/** Extract a validated room code from a URL fragment, or null for solo play. */
export function roomCodeFromLocation(href: string): string | null {
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  const match = /(?:^|&)room=([^&]*)/.exec(hash);
  if (!match) return null;
  const code = match[1];
  return ROOM_PATTERN.test(code) ? code : null;
}

/** Build the link to send a friend, replacing any fragment already present. */
export function challengeUrl(href: string, room: string): string {
  const base = href.includes("#") ? href.slice(0, href.indexOf("#")) : href;
  return `${base}#room=${room}`;
}

export type MatchPhase = "solo" | "waiting" | "playing" | "peer-gone" | "over";

export interface MatchState {
  phase: MatchPhase;
  status: TransportStatus | null;
  room: string | null;
  link: string | null;
}

export function useMatch(engine: CrackAttackEngine, relayBase: string) {
  const [state, setState] = useState<MatchState>({
    phase: "solo", status: null, room: null, link: null,
  });
  const controllerRef = useRef<MatchController | null>(null);

  useEffect(() => {
    const room = roomCodeFromLocation(window.location.href);
    if (!room) return;

    const transport = new Transport(`${relayBase}/room/${room}`);
    const controller = new MatchController(engine, transport);
    controllerRef.current = controller;

    setState({
      phase: "waiting",
      status: "connecting",
      room,
      link: challengeUrl(window.location.href, room),
    });

    transport.onStatus((status) => setState((s) => ({ ...s, status })));
    transport.onMessage((message) => {
      switch (message.t) {
        case "start":
          controller.begin({ seed: message.seed, role: message.role }, performance.now());
          setState((s) => ({ ...s, phase: "playing" }));
          break;
        case "sync":
          controller.onSync(message);
          break;
        case "peer-left":
          setState((s) => ({ ...s, phase: "peer-gone" }));
          break;
        case "peer-back":
          setState((s) => ({ ...s, phase: "playing" }));
          break;
        case "forfeit":
          engine.forfeitWin(performance.now());
          setState((s) => ({ ...s, phase: "over" }));
          break;
        case "error":
          setState((s) => ({ ...s, phase: "over" }));
          break;
      }
    });

    return () => { transport.close(); controllerRef.current = null; };
  }, [engine, relayBase]);

  const clampNow = useCallback((now: number) => {
    return controllerRef.current ? controllerRef.current.tickTo(now) : now;
  }, []);

  return { ...state, clampNow };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/use-match.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the hook into `CrackAttackGame.tsx`**

Add the import alongside the existing game imports at the top of the file:

```ts
import { challengeUrl, roomCodeFromLocation, useMatch } from "../net/useMatch.ts";
```

Construct the engine in multiplayer mode when a room code is present (near line 305):

```ts
  const roomCode = roomCodeFromLocation(window.location.href);
  const [engine] = useState(() => new CrackAttackEngine({ multiplayer: roomCode !== null }));
  const match = useMatch(engine, RELAY_BASE);
```

In the render loop (near line 477), pass time through the match clock:

```ts
      engine.update(match.clampNow(now));
```

Add a `RELAY_BASE` constant at the top of the file, read from the Vite environment so it can differ between dev and production:

```ts
const RELAY_BASE = import.meta.env.VITE_RELAY_BASE ?? "wss://crack-attack-relay.workers.dev";
```

Add a "Create challenge" button, shown only in solo mode, that mints a room and navigates to it:

```tsx
  const createChallenge = useCallback(async () => {
    const response = await fetch(`${RELAY_BASE.replace(/^wss:/, "https:")}/new`);
    const { room } = (await response.json()) as { room: string };
    window.location.href = challengeUrl(window.location.href, room);
    window.location.reload();
  }, []);
```

Add the overlays. Reuse the existing `game-overlay` class the component already uses for the game-over screen (see `CrackAttackGame.tsx:1040`) so styling stays consistent — no modal library, no routing. Insert these just before the closing tag of the canvas wrapper:

```tsx
{match.phase === "waiting" && (
  <div className="game-overlay">
    <p>Waiting for your opponent…</p>
    <p className="challenge-link">{match.link}</p>
    <button
      type="button"
      className="original-screen-action"
      onClick={() => navigator.clipboard.writeText(match.link ?? "")}
    >
      Copy challenge link
    </button>
    <p className="keyboard-hint">Keep this tab open — the link dies if you close it.</p>
  </div>
)}

{match.phase === "peer-gone" && (
  <div className="game-overlay">
    <p>Your opponent dropped out.</p>
    <p className="keyboard-hint">Waiting 30 seconds for them to come back…</p>
  </div>
)}

{match.phase === "solo" && (
  <button type="button" className="original-screen-action" onClick={createChallenge}>
    Challenge a friend
  </button>
)}
```

Add one style rule to the existing stylesheet for the link text, so a six-character code in a long URL stays readable:

```css
.challenge-link {
  font-family: ui-monospace, monospace;
  word-break: break-all;
  user-select: all;
}
```

- [ ] **Step 6: Verify the whole suite and the build**

```bash
npm run test
npm run typecheck
npm run build
```

Expected: all tests pass, typecheck clean, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/net/useMatch.ts app/game/CrackAttackGame.tsx tests/use-match.test.ts
git commit -m "feat(ui): challenge links, waiting screen and match wiring"
```

---

## Task 9: Deploy and play a real match

**Files:**
- Create: `.github/workflows/pages.yml` (modify existing), `README.md` (modify)

**Interfaces:**
- Consumes: everything above.
- Produces: a live URL and a deployed relay.

- [ ] **Step 1: Deploy the relay**

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

Record the deployed `workers.dev` hostname. Expected output includes `https://crack-attack-relay.<subdomain>.workers.dev`.

- [ ] **Step 2: Point the client at it**

Create `.env.production` in the repo root:

```
VITE_RELAY_BASE=wss://crack-attack-relay.<subdomain>.workers.dev
```

- [ ] **Step 3: Build and deploy the client to Cloudflare Pages**

```bash
npm run build
npx wrangler pages deploy dist-pages --project-name crack-attack
```

- [ ] **Step 4: Two-browser smoke test**

Open the deployed URL, click "Create challenge", copy the link, open it in a second browser (or a phone). Verify:
- Both boards start with an identical block layout (proves the shared seed reached both peers).
- Clearing blocks on one side sends garbage to the other.
- The opponent light column tracks the other player's stack height.
- Closing one tab shows the "opponent dropped" banner on the other; reopening the link within 30 s resumes.

- [ ] **Step 5: Verify the live-only room rule**

Create a challenge link, close the host tab without anyone joining, then open the link. Expected: an error state, not a hung waiting screen.

- [ ] **Step 6: Update the README**

Replace the upstream README's solo-only description with the challenge-link flow, the relay deployment steps, and a note that the fork adds multiplayer.

- [ ] **Step 7: Commit and push**

```bash
git add -A
git commit -m "docs: deployment and multiplayer instructions"
git push -u origin main
```

---

## Deferred (explicitly out of scope)

- **X-treme mode.** Never implemented in the TypeScript port; would need engine and UI work in both.
- **Pause/resume negotiation.** The original's `GS_UNPAUSED` handshake is not reproduced; `state` is sent as 0 and reserved. Add only if pausing during a match turns out to matter.
- **Spectators, lobbies, more than 2 players.** Out of scope by decision.
- **Rematch without a new link.** A rematch currently means creating a new challenge. Worth adding if it annoys in practice.
