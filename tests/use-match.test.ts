import { test } from "node:test";
import assert from "node:assert/strict";
import {
  challengeUrl,
  handleServerMessage,
  liveWiring,
  matchOverCopy,
  matchOverlay,
  reduceMatch,
  roomCodeFromLocation,
  settleMatch,
  soloControls,
} from "../app/net/useMatch.ts";
import { CrackAttackEngine } from "../app/game/engine.ts";
import { MatchController } from "../app/net/match.ts";
import { STATE_LOST, SYNC_PERIOD_TICKS } from "../app/net/protocol.ts";
import type { SyncMessage } from "../app/net/protocol.ts";
import type { MatchPhase, MatchState } from "../app/net/useMatch.ts";

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

// --- reduceMatch --------------------------------------------------------
// Regression for the final review's FINAL-5. Neither terminal message closed
// the socket, so the relay's own close looked like an unexpected drop:
// Transport reconnected every second forever, the DO answered {error:missing},
// and the win screen flipped to the generic "Match over." about a second after
// the player earned it.

const PLAYING: MatchState = {
  phase: "playing", status: "open", room: "AB3K9Z", link: "https://x.dev/#room=AB3K9Z",
  outcome: null, waitingForPeer: false,
};

test("a forfeit ends the match as a win and closes our end of the socket", () => {
  const { state, effects } = reduceMatch(PLAYING, { t: "forfeit" });
  assert.equal(state.phase, "over");
  assert.equal(state.outcome, "forfeit");
  assert.equal(effects.winLocally, true);
  assert.equal(effects.closeTransport, true, "left the socket reconnecting forever");
});

test("an error closes our end of the socket too", () => {
  const { effects } = reduceMatch(PLAYING, { t: "error", reason: "missing" });
  assert.equal(effects.closeTransport, true, "left the socket reconnecting forever");
});

test("a dead link and a full room say different things", () => {
  assert.equal(reduceMatch(PLAYING, { t: "error", reason: "missing" }).state.outcome, "expired");
  assert.equal(reduceMatch(PLAYING, { t: "error", reason: "full" }).state.outcome, "full");
});

test("a late error does not clobber a settled win screen", () => {
  const won = reduceMatch(PLAYING, { t: "forfeit" }).state;
  const after = reduceMatch(won, { t: "error", reason: "missing" });
  assert.equal(after.state.outcome, "forfeit", "the win screen was replaced by a generic error");
  assert.equal(after.state, won, "a no-op transition should not force a re-render");
});

test("a late peer-left does not reopen a settled match", () => {
  const won = reduceMatch(PLAYING, { t: "forfeit" }).state;
  assert.equal(reduceMatch(won, { t: "peer-left" }).state.phase, "over");
});

test("peer-back only resumes from peer-gone", () => {
  const gone = reduceMatch(PLAYING, { t: "peer-left" }).state;
  assert.equal(reduceMatch(gone, { t: "peer-back" }).state.phase, "playing");
  const won = reduceMatch(PLAYING, { t: "forfeit" }).state;
  assert.equal(reduceMatch(won, { t: "peer-back" }).state.phase, "over");
});

test("start carries the relay's seed and role through to the controller", () => {
  const waiting: MatchState = { ...PLAYING, phase: "waiting" };
  const { state, effects } = reduceMatch(waiting, { t: "start", seed: 4242, role: "guest" });
  assert.equal(state.phase, "playing");
  assert.deepEqual(effects.begin, { seed: 4242, role: "guest" });
});

// --- overlay + control policy -------------------------------------------
// Regression for FINAL-7 (a stall froze the board with nothing on screen) and
// FINAL-8 (pause and solo restart stayed live during a match).

test("a stall is surfaced instead of freezing the board silently", () => {
  assert.equal(matchOverlay({ ...PLAYING, waitingForPeer: true }), "waiting-peer");
});

test("a healthy match in progress shows no overlay", () => {
  assert.equal(matchOverlay(PLAYING), "none");
});

test("a dropped socket outranks the stall it causes, so only one overlay shows", () => {
  // Losing our own socket is what stops syncs arriving, so it stalls us too.
  // Two .game-overlay siblings render on top of each other illegibly.
  const both: MatchState = { ...PLAYING, status: "reconnecting", waitingForPeer: true };
  assert.equal(matchOverlay(both), "reconnecting");
});

test("every match state resolves to exactly one overlay", () => {
  const phases: MatchPhase[] = ["solo", "waiting", "playing", "peer-gone", "over"];
  const statuses: (MatchState["status"])[] = [
    null, "connecting", "open", "reconnecting", "closed", "failed",
  ];
  const expected: Record<MatchPhase, string[]> = {
    solo: ["none"],
    waiting: ["waiting", "unreachable"],
    playing: ["none", "reconnecting", "waiting-peer", "unreachable"],
    "peer-gone": ["peer-gone", "unreachable"],
    over: ["over"],
  };
  for (const phase of phases) {
    for (const status of statuses) {
      for (const waitingForPeer of [false, true]) {
        const got = matchOverlay({ ...PLAYING, phase, status, waitingForPeer });
        assert.ok(
          expected[phase].includes(got),
          `phase=${phase} status=${status} waiting=${waitingForPeer} gave ${got}`,
        );
      }
    }
  }
});

test("pause and solo restart are dead during a match, whatever the game status", () => {
  for (const phase of ["waiting", "playing", "peer-gone", "over"] as MatchPhase[]) {
    for (const status of ["ready", "countdown", "playing", "paused", "gameover"]) {
      const controls = soloControls(phase, status, true);
      assert.equal(controls.canPause, false, `pause was live in phase ${phase}/${status}`);
      assert.equal(controls.canRestart, false, `restart was live in phase ${phase}/${status}`);
    }
  }
});

test("pause and solo restart keep working in solo play", () => {
  assert.equal(soloControls("solo", "playing", false).canPause, true);
  assert.equal(soloControls("solo", "ready", false).canPause, false);
  assert.equal(soloControls("solo", "gameover", true).canRestart, true);
  assert.equal(soloControls("solo", "gameover", false).canRestart, false);
});

test("a socket that has given up says so instead of leaving the waiting card up", () => {
  // FINAL-11: a build without VITE_RELAY_BASE left the joiner staring at
  // "Waiting for your opponent…" while the socket retried invisibly forever.
  assert.equal(matchOverlay({ ...PLAYING, phase: "waiting", status: "failed" }), "unreachable");
  assert.equal(matchOverlay({ ...PLAYING, status: "failed" }), "unreachable");
  // A settled result still wins: the match is already decided.
  assert.equal(
    matchOverlay({ ...PLAYING, phase: "over", outcome: "win", status: "failed" }), "over",
  );
});

// --- the message-handler wiring -----------------------------------------
// The one seam the fix wave left untested, and the one place F9 stayed
// broken. The handler used to reduce once up front and commit that result
// AFTER running the effects, so anything an effect settled was written back
// over: a peer's STATE_LOST made controller.onSync fire onOutcome("win"),
// which committed "over", and then the stale pre-message state landed on top.
// The winner ended at phase "playing" with outcome null, staring at a solo
// game-over card whose restart is disabled, with no way out but a reload.

/**
 * Drives the REAL MatchController and CrackAttackEngine through liveWiring --
 * the same construction the hook uses -- so the test cannot drift from the
 * hook by paraphrasing it. The fake transport commits a status change on
 * close(), exactly as the hook's onStatus handler does, because that is what
 * makes a naive "did the state change" guard the wrong fix.
 */
function makeWiring(phase: MatchPhase = "playing") {
  let state: MatchState = { ...PLAYING, phase };
  const commits: MatchState[] = [];
  const commit = (next: MatchState) => {
    if (next === state) return;
    state = next;
    commits.push(next);
  };
  const engine = new CrackAttackEngine({ seed: 7, multiplayer: true });
  const transport = {
    closed: false,
    close() {
      this.closed = true;
      commit({ ...state, status: "closed" });
    },
  };
  const controller = new MatchController(engine, transport as never);
  controller.begin({ seed: 7, role: "host" }, 50_000);
  controller.onOutcome = (outcome) => {
    controller.end();
    if (outcome === "win") engine.forfeitWin(controller.engineTime(performance.now()));
    transport.close();
    commit(settleMatch(state, outcome));
  };
  const wiring = liveWiring({
    engine,
    controller,
    transport,
    getState: () => state,
    commit,
    markBegun: () => {},
    now: () => 50_000,
  });
  return { wiring, engine, controller, transport, commits, get state() { return state; } };
}

const lostSync = (tick: number): SyncMessage => (
  { t: "sync", tick, lights: 0, state: STATE_LOST, attacks: [] }
);

test("a peer's STATE_LOST leaves us on the win screen, not still playing", () => {
  const rig = makeWiring();
  handleServerMessage(rig.wiring, lostSync(SYNC_PERIOD_TICKS));
  assert.equal(rig.state.phase, "over", "the winner was left mid-match with no result");
  assert.equal(rig.state.outcome, "win");
  assert.equal(matchOverCopy(rig.state.outcome), "You win! Your opponent topped out.");
});

test("the played win stops the controller and closes the socket", () => {
  const rig = makeWiring();
  handleServerMessage(rig.wiring, lostSync(SYNC_PERIOD_TICKS));
  assert.equal(rig.transport.closed, true);
  // A settled controller must stop ticking. The fake transport has no send()
  // at all, so if end() had not taken hold, the next period boundary would
  // reach emitSync and throw rather than return a clock value.
  assert.equal(rig.controller.tickTo(80_000), rig.controller.engineTime(80_000));
  assert.equal(rig.controller.waitingForPeer, false, "a settled match should not stall");
});

test("an ordinary sync leaves the state untouched", () => {
  const rig = makeWiring();
  handleServerMessage(rig.wiring, {
    t: "sync", tick: SYNC_PERIOD_TICKS, lights: 0b101, state: 0, attacks: [],
  });
  assert.equal(rig.state.phase, "playing");
  assert.equal(rig.state.outcome, null);
  assert.deepEqual(rig.commits, [], "an unremarkable sync must not force a re-render");
});

test("forfeit still reaches the win screen even though close() commits underneath it", () => {
  const rig = makeWiring();
  handleServerMessage(rig.wiring, { t: "forfeit" });
  assert.equal(rig.state.phase, "over", "close()'s status commit swallowed the transition");
  assert.equal(rig.state.outcome, "forfeit");
  assert.equal(matchOverCopy(rig.state.outcome), "Your opponent didn't come back. You win.");
  assert.equal(rig.state.status, "closed", "the status change must survive too");
});

test("error still reaches its own screen even though close() commits underneath it", () => {
  for (const [reason, copy] of [
    ["missing", "This challenge link has expired."],
    ["full", "That game already has two players."],
  ] as const) {
    const rig = makeWiring();
    handleServerMessage(rig.wiring, { t: "error", reason });
    assert.equal(rig.state.phase, "over", `close() swallowed the ${reason} transition`);
    assert.equal(matchOverCopy(rig.state.outcome), copy);
    assert.equal(rig.state.status, "closed");
  }
});

test("start and peer transitions still work through the handler", () => {
  const rig = makeWiring("waiting");
  handleServerMessage(rig.wiring, { t: "start", seed: 4242, role: "guest" });
  assert.equal(rig.state.phase, "playing");
  assert.equal(rig.controller.seed, 4242);
  assert.equal(rig.controller.role, "guest");

  handleServerMessage(rig.wiring, { t: "peer-left" });
  assert.equal(rig.state.phase, "peer-gone");
  handleServerMessage(rig.wiring, { t: "peer-back" });
  assert.equal(rig.state.phase, "playing");
});

test("a settled match cannot be reopened through the handler", () => {
  const rig = makeWiring();
  handleServerMessage(rig.wiring, lostSync(SYNC_PERIOD_TICKS));
  assert.equal(rig.state.outcome, "win");
  handleServerMessage(rig.wiring, { t: "peer-left" });
  handleServerMessage(rig.wiring, { t: "error", reason: "missing" });
  assert.equal(rig.state.phase, "over");
  assert.equal(rig.state.outcome, "win", "the win screen was relabelled after the fact");
});
