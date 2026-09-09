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
   * True while our clock is held still because we have run too far ahead of
   * the peer. Without this on screen a slow, backgrounded or laggy opponent
   * freezes the board with no explanation -- the same silent-freeze failure
   * the reconnect overlay exists to prevent, from the more common cause.
   */
  waitingForPeer: boolean;
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

export type MatchOverlay =
  | "none"
  | "waiting"
  | "reconnecting"
  | "unreachable"
  | "waiting-peer"
  | "peer-gone"
  | "over";

/**
 * Which match overlay to show, at most one. `.game-overlay` carries no
 * centring or padding of its own, so two rendered as siblings overlap into
 * illegible text. Deciding here rather than with five independent JSX
 * conditions makes "never more than one" a property a test can hold, instead
 * of a coincidence between booleans.
 */
export function matchOverlay(state: MatchState): MatchOverlay {
  if (state.phase !== "solo" && state.phase !== "over" && state.status === "failed") {
    // Outranks everything below. Nothing on this page can progress, and the
    // waiting card would otherwise sit there forever claiming an opponent is
    // on the way -- which is exactly what a build shipped without a relay URL
    // looks like to whoever taps the link.
    return "unreachable";
  }
  switch (state.phase) {
    case "solo": return "none";
    case "over": return "over";
    case "waiting": return "waiting";
    case "peer-gone": return "peer-gone";
    case "playing":
      // Our own socket being down is the better explanation, and takes
      // priority: losing it is exactly what stops syncs arriving and stalls us.
      if (state.status === "reconnecting" || state.status === "connecting") return "reconnecting";
      return state.waitingForPeer ? "waiting-peer" : "none";
  }
}

/**
 * Whether the solo score card should render. It and the match-result overlay
 * are both `.game-overlay` at `inset: 0; z-index: 5` with no padding or
 * centring of their own, so rendering both puts two siblings in the same box.
 * It reads cramped rather than broken, and before the played-win outcome
 * existed only a forfeit reached it -- but that is now how every match ends,
 * so the match result gets the frame to itself.
 */
export function showSoloGameOverCard(gameStatus: string, overlay: MatchOverlay): boolean {
  return gameStatus === "gameover" && overlay !== "over";
}

/**
 * Whether the single-player controls are live. Pause desyncs a match --
 * MatchController keeps advancing ourTick from real time while the engine is
 * frozen, so the pauser broadcasts ticks their board never simulated, their
 * opponent never stalls, and it is free thinking time besides. Restart is
 * worse: it would fork the simulation onto a fresh, unrelated seed while still
 * connected and still sending garbage.
 */
export function soloControls(
  phase: MatchPhase,
  gameStatus: string,
  restartReady: boolean,
): { canPause: boolean; canRestart: boolean } {
  const solo = phase === "solo";
  return {
    canPause: solo && gameStatus !== "ready" && gameStatus !== "gameover",
    canRestart: solo && restartReady,
  };
}

/**
 * What the match-over overlay says. Every reason a match can end gets its own
 * sentence: "Match over." on a dead link tells a player nothing about what to
 * do next, and this audience is six friends on phones, not developers reading
 * a console. Lives here rather than in the component so it can be tested
 * against the state that produces it.
 */
export function matchOverCopy(outcome: MatchOutcome): string {
  switch (outcome) {
    case "win": return "You win! Your opponent topped out.";
    case "loss": return "You topped out. Your opponent wins.";
    case "forfeit": return "Your opponent didn't come back. You win.";
    case "expired": return "This challenge link has expired.";
    case "full": return "That game already has two players.";
    default: return "Match over.";
  }
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

/** Effects for a message that ends the match, whatever the state it lands in. */
const TERMINAL: MatchEffects = { ...NO_EFFECTS, closeTransport: true };

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
      if (state.phase === "over") return { state, effects: TERMINAL };
      return {
        state: settleMatch(state, "forfeit"),
        effects: { ...TERMINAL, winLocally: true },
      };
    case "error":
      // A late error must never clobber a win screen with "Match over."
      if (state.phase === "over") return { state, effects: TERMINAL };
      return {
        state: settleMatch(state, errorOutcome(message.reason)),
        effects: TERMINAL,
      };
  }
}

/**
 * The collaborators the message handler drives, as narrow structural types
 * rather than the concrete classes. This is the seam: the handler used to live
 * inline in an effect inside a hook, reachable only through a React renderer
 * and a live WebSocket, and that is exactly where the F9 wiring bug survived
 * a fix wave that tested everything around it.
 */
export interface MatchWiring {
  getState(): MatchState;
  commit(next: MatchState): void;
  begin(start: MatchStart): void;
  applySync(sync: SyncMessage): void;
  winLocally(): void;
  closeTransport(): void;
}

/**
 * Apply one server message: compute the effects from the current state,
 * perform them, then re-derive the state from whatever they left behind.
 *
 * The two reductions are not redundant. Effects can settle the match out from
 * under us -- `applySync` on a peer's STATE_LOST is a WIN for us and commits
 * "over" -- and `closeTransport` commits a status change of its own. Reducing
 * once up front and committing that result would write the pre-effect state
 * back over both, which is the bug this shape exists to prevent: the winner
 * ended at phase "playing" with outcome null, looking at a solo game-over card
 * with its restart disabled and no way out but a reload.
 *
 * Guarding instead on "did the state change while the effects ran" does not
 * work: closeTransport legitimately changes it on the forfeit and error paths,
 * so that guard drops their own "over" transition and trades one bug for
 * another.
 */
export function handleServerMessage(wiring: MatchWiring, message: ServerMessage): void {
  const { effects } = reduceMatch(wiring.getState(), message);
  if (effects.begin) wiring.begin(effects.begin);
  if (effects.sync) wiring.applySync(effects.sync);
  if (effects.winLocally) wiring.winLocally();
  if (effects.closeTransport) wiring.closeTransport();
  wiring.commit(reduceMatch(wiring.getState(), message).state);
}

/**
 * The wiring the hook actually runs on. Exported so a test drives the real
 * MatchController and CrackAttackEngine through the same code path the hook
 * does, rather than a paraphrase of it that can drift.
 */
export function liveWiring(options: {
  engine: Pick<CrackAttackEngine, "forfeitWin">;
  controller: Pick<MatchController, "begin" | "onSync" | "end" | "engineTime">;
  transport: Pick<Transport, "close">;
  getState(): MatchState;
  commit(next: MatchState): void;
  markBegun(): void;
  now(): number;
}): MatchWiring {
  const { engine, controller, transport, getState, commit, markBegun, now } = options;
  return {
    getState,
    commit,
    begin: (start) => {
      markBegun();
      controller.begin(start, now());
    },
    applySync: (sync) => controller.onSync(sync),
    winLocally: () => engine.forfeitWin(controller.engineTime(now())),
    closeTransport: () => transport.close(),
  };
}

export function useMatch(engine: CrackAttackEngine, relayBase: string) {
  const initial: MatchState = {
    phase: "solo", status: null, room: null, link: null, outcome: null,
    waitingForPeer: false,
  };
  const [state, setState] = useState<MatchState>(initial);
  // The reducer needs the current state synchronously, inside a socket
  // callback that React knows nothing about, so the ref is authoritative and
  // the React state exists only to render from.
  const stateRef = useRef<MatchState>(initial);
  const controllerRef = useRef<MatchController | null>(null);
  /**
   * Whether this page has ever been in a running match. It is the difference
   * between a socket-level reconnect, which the relay can resume, and a fresh
   * page load, which it cannot: board state is never transferred, so a new
   * page has nothing to resume onto.
   */
  const begunRef = useRef(false);

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
    begunRef.current = false;

    commit({
      phase: "waiting",
      status: "connecting",
      room,
      link: challengeUrl(window.location.href, room),
      outcome: null,
      waitingForPeer: false,
    });

    // Decided by play: either our board topped out, or the peer's did. The
    // controller reads the loss off the engine's status and carries it on the
    // wire; the win/lose narrative belongs here, not in the engine.
    controller.onOutcome = (outcome) => {
      controller.end();
      if (outcome === "win") engine.forfeitWin(controller.engineTime(performance.now()));
      transport.close();
      commit(settleMatch(stateRef.current, outcome));
    };

    transport.onStatus((status) => {
      // Sent on every (re)connect, before anything else. setStatus assigns the
      // new status before invoking handlers, so this goes straight down the
      // live socket rather than into the outbox behind buffered syncs.
      if (status === "open") transport.send({ t: "hello", resume: begunRef.current });
      commit({ ...stateRef.current, status });
    });
    const wiring = liveWiring({
      engine,
      controller,
      transport,
      getState: () => stateRef.current,
      commit,
      markBegun: () => { begunRef.current = true; },
      now: () => performance.now(),
    });
    transport.onMessage((message) => handleServerMessage(wiring, message));

    return () => { transport.close(); controllerRef.current = null; };
  }, [engine, relayBase, commit]);

  const clampNow = useCallback((now: number) => {
    const controller = controllerRef.current;
    if (!controller) return now;
    const clamped = controller.tickTo(now);
    // Called once per animation frame, so only commit on an actual edge.
    if (controller.waitingForPeer !== stateRef.current.waitingForPeer) {
      commit({ ...stateRef.current, waitingForPeer: controller.waitingForPeer });
    }
    return clamped;
  }, [commit]);

  return { ...state, clampNow };
}
