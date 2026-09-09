import { STATE_LOST, SYNC_PERIOD_TICKS, TICK_MS } from "./protocol.ts";
import type { SyncMessage, WireAttack } from "./protocol.ts";
import type { Transport } from "./transport.ts";
import type { CrackAttackEngine } from "../game/engine.ts";

/** How far ahead of the peer we tolerate before stalling, in ticks. */
const MAX_LEAD_TICKS = SYNC_PERIOD_TICKS * 2;

export interface MatchStart {
  seed: number;
  role: "host" | "guest";
}

/** How the match was decided by play, as opposed to by disconnection. */
export type PlayedOutcome = "win" | "loss";

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

  /**
   * Called once, when the match is decided by play: our board topped out, or
   * the peer told us theirs did. The engine has no winner concept, so the
   * signal is read off its status here and carried on the wire's state field.
   */
  onOutcome: ((outcome: PlayedOutcome) => void) | null = null;

  private engine: CrackAttackEngine;
  private transport: Transport;

  private startedAtMs = 0;
  private stalledMs = 0;
  private stallBeganAt: number | null = null;
  private lastSyncedTick = 0;
  /** Real (not simulated) time of our last transmission, for the stall heartbeat. */
  private lastSyncSentAtMs = 0;
  private outcomeReported = false;
  private ended = false;

  constructor(engine: CrackAttackEngine, transport: Transport) {
    this.engine = engine;
    this.transport = transport;
  }

  begin(start: MatchStart, nowMs: number): void {
    this.role = start.role;
    this.seed = start.seed;
    this.startedAtMs = nowMs;
    this.stalledMs = 0;
    this.stallBeganAt = null;
    this.lastSyncedTick = 0;
    this.lastSyncSentAtMs = nowMs;
    this.peerTick = 0;
    this.waitingForPeer = false;
    this.outcomeReported = false;
    this.ended = false;
    this.engine.start(nowMs, start.seed);
  }

  /**
   * Convert real time into the time the engine should see, holding it still
   * while we are too far ahead of the peer, and emitting a sync each period.
   * Returns the value to pass to engine.update().
   */
  tickTo(nowMs: number): number {
    // Once the result is settled there is nothing left to negotiate: stop
    // transmitting and stop stalling, but keep handing the engine a normally
    // advancing clock so its game-over animation still plays out.
    if (this.ended) return nowMs - this.stalledMs;

    // Bank stall time on every call, not just at exit, so simulated time is
    // frozen by construction while stalled: nowMs - stalledMs stays constant
    // regardless of how many calls or peer syncs land before we resolve.
    if (this.stallBeganAt !== null) {
      this.stalledMs += nowMs - this.stallBeganAt;
      this.stallBeganAt = nowMs;
    }

    const ourTick = Math.floor((nowMs - this.startedAtMs - this.stalledMs) / TICK_MS);

    if (ourTick > this.peerTick + MAX_LEAD_TICKS) {
      if (this.stallBeganAt === null) this.stallBeganAt = nowMs;
      this.waitingForPeer = true;
      const stalledClamp = nowMs - this.stalledMs;
      // Stall SIMULATION, not COMMUNICATION -- the original C++ Communicator
      // blocks the game loop but keeps talking. Returning here without
      // transmitting deadlocks: a phone that locks for a few seconds makes its
      // peer stall, the peer then goes silent, and on waking the first phone
      // stalls too. Neither side's peerTick can ever advance again and both
      // boards freeze permanently, with no overlay and no recovery but reload.
      // The heartbeat reports our frozen tick, which is where our engine
      // genuinely is; sending a stale lastSyncedTick would understate our
      // position and leave the peer stalled against a number that never moves.
      if (nowMs - this.lastSyncSentAtMs >= SYNC_PERIOD_TICKS * TICK_MS) {
        this.emitSync(Math.floor((stalledClamp - this.startedAtMs) / TICK_MS), stalledClamp);
        this.lastSyncSentAtMs = nowMs;
      }
      return stalledClamp;
    }

    this.stallBeganAt = null;
    this.waitingForPeer = false;

    const clamped = nowMs - this.stalledMs;
    const reachedTick = Math.floor((clamped - this.startedAtMs) / TICK_MS);
    if (reachedTick - this.lastSyncedTick >= SYNC_PERIOD_TICKS) {
      this.lastSyncedTick = reachedTick - (reachedTick % SYNC_PERIOD_TICKS);
      this.emitSync(this.lastSyncedTick, clamped);
      this.lastSyncSentAtMs = nowMs;
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
    // Topping out is the only way to lose by playing, and the peer has no
    // other way to find out: our rAF loop keeps running, so without this flag
    // we would just go quiet-but-alive and they would play on indefinitely.
    const lost = this.engine.getSnapshot(now).status === "gameover";
    this.transport.send({
      t: "sync",
      tick,
      lights: this.engine.exportLevelLights(now),
      state: lost ? STATE_LOST : 0,
      attacks,
    });
    // Reported after the send, so the loss reaches the peer even if the
    // listener responds by tearing the transport down.
    if (lost) this.reportOutcome("loss");
  }

  /**
   * Real time converted to the clock the engine has actually been fed, with no
   * side effects. Callers that end the game outside the tick loop need this:
   * handing the engine a raw performance.now() would jump its clock forward by
   * however much stall time has accumulated, and freeze the game-over
   * animation until real time caught up.
   */
  engineTime(nowMs: number): number {
    return nowMs - this.stalledMs;
  }

  /**
   * Stop driving the match. Called once the result is settled, by any route,
   * so we neither keep transmitting nor report a second outcome.
   */
  end(): void {
    this.ended = true;
    this.outcomeReported = true;
  }

  private reportOutcome(outcome: PlayedOutcome): void {
    if (this.outcomeReported) return;
    this.outcomeReported = true;
    this.onOutcome?.(outcome);
  }

  /** Apply a sync received from the peer. */
  onSync(message: SyncMessage): void {
    // We trust the peer's reported tick outright: a peer that lies and reports
    // a wildly high tick permanently defeats our stall. That's accepted here —
    // this is a friends-only game with no anti-cheat requirement.
    this.peerTick = Math.max(this.peerTick, message.tick);
    this.waitingForPeer = false;
    if ((message.state & STATE_LOST) !== 0) this.reportOutcome("win");
    this.engine.setOpponentLevelLights(message.lights);
    for (const attack of message.attacks) {
      this.engine.receiveAttack({
        height: attack.height,
        width: attack.width,
        flavor: attack.flavor,
        source: "clear",
        // The engine's clock is absolute -- engine.start() is handed a raw
        // performance.now() -- but the wire carries elapsed MATCH ticks, so
        // the peer's tick has to be rebased onto our own start time. Without
        // the offset, dropAt lands in the distant past for any realistic
        // startedAtMs and every remote attack drops on the very next update,
        // destroying the ~5.7s telegraph that is the core of the game feel.
        createdAt: this.startedAtMs + attack.tick * TICK_MS,
      });
    }
  }
}
