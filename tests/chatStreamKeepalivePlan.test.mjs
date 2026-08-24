import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_KEEPALIVE_INTERVAL_MS,
  resolveChatStreamKeepalivePlan,
} from "../lib/chatStreamKeepalivePlan.ts";
import {
  CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS,
  CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
} from "../lib/chatStreamLiveness.ts";

/*
  The operator's lever on the first-token watch.

  Two rules carry the weight here. The deadline may only be lowered, because
  the client's own absolute bound is compiled from it plus a grace and shipped
  to the browser -- a server that waited longer would simply be aborted first,
  and the classified `stalled` notice would never arrive. And a malformed
  value falls back rather than failing closed: a guardrail that refuses to
  start on a typo is worse than one that stays at the value the code already
  agreed on.
*/

test("nothing set is the compiled default", () => {
  assert.deepEqual(resolveChatStreamKeepalivePlan({}), {
    intervalMs: CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
    firstTokenDeadlineMs: CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS,
  });
});

test("an operator can lower both", () => {
  assert.deepEqual(
    resolveChatStreamKeepalivePlan({
      CHAT_STREAM_KEEPALIVE_INTERVAL_MS: "5000",
      CHAT_FIRST_TOKEN_DEADLINE_MS: "120000",
    }),
    { intervalMs: 5_000, firstTokenDeadlineMs: 120_000 }
  );
});

test("the deadline cannot be raised past what the client agreed to", () => {
  // `CHAT_LIVENESS_BUDGETS.firstResponseMs` is this value plus a grace and is
  // compiled into the browser bundle. A server that waited longer would be
  // aborted by the client first, and its `stalled` notice -- the thing that
  // makes the turn readable as a timeout rather than as an empty answer --
  // would never be written.
  const plan = resolveChatStreamKeepalivePlan({
    CHAT_FIRST_TOKEN_DEADLINE_MS: String(CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS * 4),
  });
  assert.equal(plan.firstTokenDeadlineMs, CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS);
});

test("the interval cannot be stretched to where it stops being a keepalive", () => {
  // Cloudflare closes a connection its origin has not written to for 125s.
  const plan = resolveChatStreamKeepalivePlan({
    CHAT_STREAM_KEEPALIVE_INTERVAL_MS: "600000",
  });
  assert.equal(plan.intervalMs, MAX_KEEPALIVE_INTERVAL_MS);
  assert.ok(MAX_KEEPALIVE_INTERVAL_MS * 2 <= 125_000);
});

test("a value that is not a positive whole number of milliseconds is ignored", () => {
  for (const bad of ["", "0", "-1", "abc", "1.5", "1e400", undefined]) {
    assert.deepEqual(
      resolveChatStreamKeepalivePlan({
        CHAT_STREAM_KEEPALIVE_INTERVAL_MS: bad,
        CHAT_FIRST_TOKEN_DEADLINE_MS: bad,
      }),
      {
        intervalMs: CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
        firstTokenDeadlineMs: CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS,
      },
      `"${bad}" should have fallen back to the default`
    );
  }
});

test("a millisecond-scale override is honoured, which is what a test needs", () => {
  // The contract test drives the real deadline in milliseconds through this
  // path rather than through a module mock, which is what made it pass
  // locally and fail on CI.
  assert.deepEqual(
    resolveChatStreamKeepalivePlan({
      CHAT_STREAM_KEEPALIVE_INTERVAL_MS: "25",
      CHAT_FIRST_TOKEN_DEADLINE_MS: "1500",
    }),
    { intervalMs: 25, firstTokenDeadlineMs: 1_500 }
  );
});
