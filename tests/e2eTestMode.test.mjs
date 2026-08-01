import assert from "node:assert/strict";
import test from "node:test";

import {
  isE2EAuthBypassEnabled,
  isE2EDatabaseDisabled,
  isE2EFixtureMode,
} from "../lib/e2eTestMode.ts";

/**
 * The Playwright short-circuits, and the `/e2e/admin-console-fixture` route
 * they gate, must be unreachable on anything that is not a local test server.
 *
 * `tests/goLiveSecurityFixes.test.ts` pins the *shape* of the guard by reading
 * the source. This file pins the *behaviour* by running it: every combination
 * below is executed against the real helper, not matched against a regex.
 *
 * NODE_ENV is deliberately not part of the guard -- the fixture server runs
 * `next start`, which sets `NODE_ENV=production` -- so the only thing standing
 * between these flags and a real deployment is the loopback origin check.
 */

const FLAG_KEYS = ["E2E_AUTH_BYPASS", "E2E_DISABLE_DATABASE", "NEXTAUTH_URL"];

/**
 * Runs `body` with exactly `environment` applied on top of the current
 * process env, then restores every key -- including keys that were absent
 * before, which must go back to absent rather than to "undefined".
 */
const withEnvironment = (environment, body) => {
  const saved = new Map(FLAG_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of FLAG_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined) process.env[key] = value;
    }
    body();
  } finally {
    for (const key of FLAG_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const BOTH_FLAGS = {
  E2E_AUTH_BYPASS: "true",
  E2E_DISABLE_DATABASE: "true",
};

const assertClosed = (environment, label) =>
  withEnvironment(environment, () => {
    assert.equal(isE2EFixtureMode(), false, `${label}: fixture mode must be closed`);
    assert.equal(
      isE2EAuthBypassEnabled() && isE2EDatabaseDisabled(),
      false,
      `${label}: neither short-circuit may be open`
    );
  });

test("both flags absent leaves fixture mode closed", () => {
  assertClosed({}, "no flags");
  assertClosed(
    { NEXTAUTH_URL: "http://127.0.0.1:3100" },
    "loopback origin but no flags"
  );
});

test("both flags explicitly false leaves fixture mode closed", () => {
  assertClosed(
    {
      E2E_AUTH_BYPASS: "false",
      E2E_DISABLE_DATABASE: "false",
      NEXTAUTH_URL: "http://127.0.0.1:3100",
    },
    "flags false"
  );
});

test("either flag alone is not enough, even on a loopback origin", () => {
  assertClosed(
    {
      E2E_AUTH_BYPASS: "true",
      NEXTAUTH_URL: "http://127.0.0.1:3100",
    },
    "auth bypass alone"
  );
  assertClosed(
    {
      E2E_DISABLE_DATABASE: "true",
      NEXTAUTH_URL: "http://127.0.0.1:3100",
    },
    "database stub alone"
  );
});

test("both flags with no NEXTAUTH_URL leaves fixture mode closed", () => {
  assertClosed({ ...BOTH_FLAGS }, "flags without an origin");
  assertClosed(
    { ...BOTH_FLAGS, NEXTAUTH_URL: "   " },
    "flags with a blank origin"
  );
});

// An unparseable value is not proof of a local server, so it must fail closed
// rather than be treated as "not public, therefore local".
test("both flags with an unparseable NEXTAUTH_URL leaves fixture mode closed", () => {
  for (const value of ["not-a-url", "://missing-scheme", "localhost:3100"]) {
    assertClosed(
      { ...BOTH_FLAGS, NEXTAUTH_URL: value },
      `flags with NEXTAUTH_URL=${value}`
    );
  }
});

test("both flags with a public hostname leaves fixture mode closed", () => {
  for (const value of [
    "https://tomverse.app",
    "https://staging.tomverse.app",
    "https://tomverse.app.evil.test",
    // A hostname that merely contains a loopback name must not qualify.
    "https://localhost.evil.test",
    "https://127.0.0.1.evil.test",
  ]) {
    assertClosed(
      { ...BOTH_FLAGS, NEXTAUTH_URL: value },
      `flags with NEXTAUTH_URL=${value}`
    );
  }
});

test("both flags on a loopback origin open fixture mode", () => {
  for (const value of [
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "http://[::1]:3100",
    "http://0.0.0.0:3100",
  ]) {
    withEnvironment({ ...BOTH_FLAGS, NEXTAUTH_URL: value }, () => {
      assert.equal(
        isE2EFixtureMode(),
        true,
        `${value} is a local test server and must open fixture mode`
      );
      assert.equal(isE2EAuthBypassEnabled(), true);
      assert.equal(isE2EDatabaseDisabled(), true);
    });
  }
});

// The helper is read at call time, never cached, so a later environment change
// cannot leave a previously-opened short-circuit stuck open.
test("the gate is re-evaluated on every call", () => {
  withEnvironment(
    { ...BOTH_FLAGS, NEXTAUTH_URL: "http://127.0.0.1:3100" },
    () => {
      assert.equal(isE2EFixtureMode(), true);
      process.env.NEXTAUTH_URL = "https://tomverse.app";
      assert.equal(isE2EFixtureMode(), false);
    }
  );
});

test("the harness environment is restored after every case", () => {
  const before = { ...process.env };
  assertClosed({ ...BOTH_FLAGS, NEXTAUTH_URL: "https://tomverse.app" }, "probe");
  for (const key of FLAG_KEYS) {
    assert.equal(
      process.env[key],
      before[key],
      `${key} was not restored by the harness`
    );
    assert.equal(
      key in process.env,
      key in before,
      `${key} presence was not restored by the harness`
    );
  }
});
