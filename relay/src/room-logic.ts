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
