import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeAmuxV4RecentIdeaCursor,
  parseAmuxV4RecentIdeaCursor,
} from "../lib/amux/ideaRecentCursorCore.ts";

const position = {
  submittedAt: new Date("2026-10-03T01:02:03.004Z"),
  ideaId: "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0",
};

test("recent cursor round-trips a timestamp and idea id", () => {
  assert.deepEqual(parseAmuxV4RecentIdeaCursor(encodeAmuxV4RecentIdeaCursor(position)), position);
});

test("recent cursor rejects malformed and noncanonical positions", () => {
  for (const raw of [null, "", "abc!", "a".repeat(513),
    Buffer.from(JSON.stringify(["2026-10-03T01:02:03.004Z", "not-an-id"])).toString("base64url"),
    Buffer.from(JSON.stringify(["2026-02-30T01:02:03.004Z", position.ideaId])).toString("base64url"),
    Buffer.from(JSON.stringify(["2026-10-03T01:02:03.004Z", position.ideaId, "extra"]))
      .toString("base64url")]) {
    assert.equal(parseAmuxV4RecentIdeaCursor(raw), null);
  }
});
