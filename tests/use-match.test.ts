import { test } from "node:test";
import assert from "node:assert/strict";
import {
  challengeUrl,
  matchOverlay,
  reduceMatch,
  roomCodeFromLocation,
  soloControls,
} from "../app/net/useMatch.ts";
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
  const statuses: (MatchState["status"])[] = [null, "connecting", "open", "reconnecting", "closed"];
  const expected: Record<MatchPhase, string[]> = {
    solo: ["none"],
    waiting: ["waiting"],
    playing: ["none", "reconnecting", "waiting-peer"],
    "peer-gone": ["peer-gone"],
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
