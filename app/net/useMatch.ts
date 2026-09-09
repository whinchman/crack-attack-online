import { useCallback, useEffect, useRef, useState } from "react";
import { MatchController } from "./match.ts";
import type { MatchStart } from "./match.ts";
import type { ServerMessage, SyncMessage } from "./protocol.ts";
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

/**
 * Why the match ended, as far as the player is concerned. Distinct values
 * exist wherever the copy differs: a link that has died and a room that is
 * already full are both "the game is over" to the code but need to tell the
 * player two different things.
 */
export type MatchOutcome = "win" | "loss" | "forfeit" | "expired" | "full" | "ended" | null;

export interface MatchState {
  phase: MatchPhase;
  status: TransportStatus | null;
  room: string | null;
  link: string | null;
  /**
   * Why the match ended. The engine has no winner concept — `forfeitWin()`
   * only stops the simulation — so the outcome narrative lives here.
   */
  outcome: MatchOutcome;
}

function errorOutcome(reason: "full" | "missing" | "malformed"): MatchOutcome {
  if (reason === "missing") return "expired";
  if (reason === "full") return "full";
  return "ended";
}

/** Settle the match, unless a result is already settled. "over" is terminal. */
export function settleMatch(state: MatchState, outcome: MatchOutcome): MatchState {
  if (state.phase === "over") return state;
  return { ...state, phase: "over", outcome };
}

/**
 * What a server message implies beyond the state change. Returned rather than
 * performed so the whole transition can be tested without a React renderer or
 * a live socket — the terminal-message handling here shipped broken precisely
 * because none of it was reachable from a test.
 */
export interface MatchEffects {
  /** Start the local simulation from the relay's shared seed. */
  begin: MatchStart | null;
  /** Hand the sync to the controller. */
  sync: SyncMessage | null;
  /**
   * Stop our own board because we won without playing it out. Guarded by the
   * "over" check, so a repeated terminal message cannot finish the game twice.
   */
  winLocally: boolean;
  /**
   * Close our end of the socket. The relay closes its end straight after any
   * terminal message; without this, Transport reads that as an unexpected drop
   * and reconnects once a second forever, draining the phone and replacing the
   * result screen with whatever the reconnect attempt gets back.
   */
  closeTransport: boolean;
}

const NO_EFFECTS: MatchEffects = {
  begin: null, sync: null, winLocally: false, closeTransport: false,
};

/**
 * Fold a server message into the match state. Pure: the caller performs the
 * returned effects. Returns the SAME state object when nothing changes, so the
 * caller can skip a re-render.
 */
export function reduceMatch(
  state: MatchState,
  message: ServerMessage,
): { state: MatchState; effects: MatchEffects } {
  switch (message.t) {
    case "start":
      return {
        state: { ...state, phase: "playing" },
        effects: { ...NO_EFFECTS, begin: { seed: message.seed, role: message.role } },
      };
    case "sync":
      return { state, effects: { ...NO_EFFECTS, sync: message } };
    case "peer-left":
      // "over" is terminal. Nothing may reopen a settled match.
      if (state.phase === "over") return { state, effects: NO_EFFECTS };
      return { state: { ...state, phase: "peer-gone" }, effects: NO_EFFECTS };
    case "peer-back":
      if (state.phase !== "peer-gone") return { state, effects: NO_EFFECTS };
      return { state: { ...state, phase: "playing" }, effects: NO_EFFECTS };
    case "forfeit":
      if (state.phase === "over") return { state, effects: { ...NO_EFFECTS, closeTransport: true } };
      return {
        state: settleMatch(state, "forfeit"),
        effects: { ...NO_EFFECTS, winLocally: true, closeTransport: true },
      };
    case "error":
      // A late error must never clobber a win screen with "Match over."
      if (state.phase === "over") return { state, effects: { ...NO_EFFECTS, closeTransport: true } };
      return {
        state: settleMatch(state, errorOutcome(message.reason)),
        effects: { ...NO_EFFECTS, closeTransport: true },
      };
  }
}

export function useMatch(engine: CrackAttackEngine, relayBase: string) {
  const initial: MatchState = {
    phase: "solo", status: null, room: null, link: null, outcome: null,
  };
  const [state, setState] = useState<MatchState>(initial);
  // The reducer needs the current state synchronously, inside a socket
  // callback that React knows nothing about, so the ref is authoritative and
  // the React state exists only to render from.
  const stateRef = useRef<MatchState>(initial);
  const controllerRef = useRef<MatchController | null>(null);

  const commit = useCallback((next: MatchState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const room = roomCodeFromLocation(window.location.href);
    if (!room) return;

    const transport = new Transport(`${relayBase}/room/${room}`);
    const controller = new MatchController(engine, transport);
    controllerRef.current = controller;

    commit({
      phase: "waiting",
      status: "connecting",
      room,
      link: challengeUrl(window.location.href, room),
      outcome: null,
    });

    // Decided by play: either our board topped out, or the peer's did. The
    // controller reads the loss off the engine's status and carries it on the
    // wire; the win/lose narrative belongs here, not in the engine.
    controller.onOutcome = (outcome) => {
      controller.end();
      if (outcome === "win") engine.forfeitWin(performance.now());
      transport.close();
      commit(settleMatch(stateRef.current, outcome));
    };

    transport.onStatus((status) => commit({ ...stateRef.current, status }));
    transport.onMessage((message) => {
      const { state: next, effects } = reduceMatch(stateRef.current, message);
      if (effects.begin) controller.begin(effects.begin, performance.now());
      if (effects.sync) controller.onSync(effects.sync);
      if (effects.winLocally) engine.forfeitWin(performance.now());
      if (effects.closeTransport) transport.close();
      commit(next);
    });

    return () => { transport.close(); controllerRef.current = null; };
  }, [engine, relayBase, commit]);

  const clampNow = useCallback((now: number) => {
    return controllerRef.current ? controllerRef.current.tickTo(now) : now;
  }, []);

  return { ...state, clampNow };
}
