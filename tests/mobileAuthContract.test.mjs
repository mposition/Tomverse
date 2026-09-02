import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_ACCESS_TOKEN_TTL_SECONDS,
  MOBILE_AUTH_ERROR_CODES,
  MOBILE_AUTH_EVENT_NAMES,
  MOBILE_AUTH_EVENT_RETENTION_DAYS,
  MOBILE_AUTH_RATE_LIMITS,
  MOBILE_CLOCK_SKEW_SECONDS,
  MOBILE_LOGIN_GRANT_TTL_SECONDS,
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
  MOBILE_REFRESH_ABSOLUTE_SECONDS,
  MOBILE_REFRESH_IDLE_SECONDS,
  MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS,
  N1B_BEARER_ROUTES,
} from "../lib/mobileAuthContract.ts";

/**
 * The relationships between the approved numbers.
 *
 * Design 8.1.1, approved 2026-08-31. Asserting that a constant equals the
 * literal it is declared as would prove nothing; what is worth pinning is what
 * has to stay true *between* them, because those are the properties a later
 * edit breaks without noticing.
 *
 * Two of these constants had no reader at all before this file. A number that
 * nothing consults is a decision nobody is held to -- the same smell as an
 * event name in a CHECK constraint that nothing writes.
 */

const DAY = 24 * 60 * 60;

test("a retired signing key outlives every token it signed", () => {
  // D6. Drop it sooner and a rotation invalidates access tokens that are still
  // inside their ten minutes, which is a self-inflicted outage rather than a
  // security measure.
  assert.ok(
    MOBILE_PREVIOUS_SIGNING_KEY_SECONDS >=
      MOBILE_ACCESS_TOKEN_TTL_SECONDS + MOBILE_CLOCK_SKEW_SECONDS,
    "the signing-key grace is shorter than an access token's own life"
  );
});

test("a retired pepper outlives every refresh token bound to it", () => {
  // The asymmetry D6 warns about, and the failure it names: retiring a pepper
  // on the signing key's schedule signs every account out at once, because a
  // pepper is bound to every refresh token still alive rather than to ten
  // minutes of access tokens.
  assert.ok(
    MOBILE_PREVIOUS_PEPPER_SECONDS >= MOBILE_REFRESH_IDLE_SECONDS,
    "a pepper rotation would strand live refresh tokens"
  );
  assert.ok(
    MOBILE_PREVIOUS_PEPPER_SECONDS > MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
    "the two windows have collapsed into one, which is the mistake D6 describes"
  );
});

test("the idle window is inside the absolute one", () => {
  // D4. An idle window at or past the absolute lifetime would make the
  // absolute limit unreachable -- a session would always lapse for inactivity
  // first, and the 180-day ceiling would be a number nothing enforces.
  assert.ok(MOBILE_REFRESH_IDLE_SECONDS < MOBILE_REFRESH_ABSOLUTE_SECONDS);
  assert.equal(MOBILE_REFRESH_IDLE_SECONDS, 30 * DAY);
  assert.equal(MOBILE_REFRESH_ABSOLUTE_SECONDS, 180 * DAY);
});

test("revocation is observed well inside an access token's life", () => {
  // D12's bound is only interesting if it is shorter than simply waiting for
  // the token to expire. Fifteen seconds against ten minutes.
  assert.ok(
    MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS < MOBILE_ACCESS_TOKEN_TTL_SECONDS
  );
});

test("a login grant is far shorter-lived than anything it produces", () => {
  // D14.1. It exists for one hop from a browser to an app.
  assert.ok(MOBILE_LOGIN_GRANT_TTL_SECONDS < MOBILE_ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(MOBILE_LOGIN_GRANT_TTL_SECONDS, 60);
});

test("the refresh limit admits an honest client and the exchange limit does not", () => {
  // D15's numbers, as a relationship: a client refreshing every ten minutes
  // needs six an hour, and the per-minute allowance has to leave room for a
  // retry after a dropped response without being a licence to loop.
  const refreshesPerDay = (24 * 60 * 60) / MOBILE_ACCESS_TOKEN_TTL_SECONDS;
  assert.ok(
    MOBILE_AUTH_RATE_LIMITS.refresh.day > refreshesPerDay,
    "an ordinary day of refreshing would hit the daily limit"
  );
  assert.ok(
    MOBILE_AUTH_RATE_LIMITS.exchange.day < MOBILE_AUTH_RATE_LIMITS.refresh.day,
    "signing in should be rarer than refreshing"
  );
  for (const limit of Object.values(MOBILE_AUTH_RATE_LIMITS)) {
    assert.ok(limit.minute < limit.day, "a minute allowance above the daily one");
  }
});

test("every refusal a client sees is one of four codes, and only one is specific", () => {
  // D15. Expired is separate because the client's action genuinely differs;
  // everything else shares one code so a refusal does not say which check it
  // tripped.
  assert.deepEqual(Object.values(MOBILE_AUTH_ERROR_CODES).sort(), [
    "MOBILE_RATE_LIMITED",
    "MOBILE_REFRESH_REJECTED",
    "MOBILE_TOKEN_EXPIRED",
    "MOBILE_TOKEN_INVALID",
  ]);
  // The deleted one. rev.2 removed MOBILE_AUTH_AMBIGUOUS along with the
  // cookie comparison that would have produced it (D13).
  assert.ok(
    !Object.values(MOBILE_AUTH_ERROR_CODES).includes("MOBILE_AUTH_AMBIGUOUS")
  );
});

test("the audit vocabulary is finer than the refusal vocabulary, deliberately", () => {
  // The two lists are not derived from each other: the client sees one message
  // for four refusal reasons, and the audit row is where those four are told
  // apart.
  assert.ok(
    MOBILE_AUTH_EVENT_NAMES.length > Object.keys(MOBILE_AUTH_ERROR_CODES).length
  );
  for (const event of MOBILE_AUTH_EVENT_NAMES) {
    assert.match(event, /^mobile_auth\.[a-z_]+$/);
  }
  assert.equal(new Set(MOBILE_AUTH_EVENT_NAMES).size, MOBILE_AUTH_EVENT_NAMES.length);
});

test("the audit retention outlives the sessions it describes", () => {
  // Ninety days against a thirty-day idle window: a support question about a
  // session that has just lapsed can still be answered.
  assert.ok(MOBILE_AUTH_EVENT_RETENTION_DAYS * DAY > MOBILE_REFRESH_IDLE_SECONDS);
});

test("N1b ships closed", () => {
  // Approved decision 13. Asserted here as well as in the gate's own tests
  // because this is the file a future change would edit.
  assert.deepEqual([...N1B_BEARER_ROUTES], []);
});
