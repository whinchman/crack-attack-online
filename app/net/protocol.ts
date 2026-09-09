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
