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
