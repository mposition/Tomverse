// What a missing environment variable costs, and what it does not.
//
// The table answered one question -- is this set? -- and the health score
// counted the "no"s at ten points each. That made `DISCORD_WEBHOOK_URL`, whose
// own description reads "Optional secondary incident notification channel",
// dearer than a provider running in a limited state, and it drove a correctly
// configured deployment toward zero: on 2026-09-14, seven of twenty-nine rows
// were reported missing and only two of them were anything to do.
//
// These tests fix the classification in place. The exhaustiveness test is the
// load-bearing one: a row added without a severity fails here rather than
// quietly costing ten points.

import assert from "node:assert/strict";
import test from "node:test";
import {
  adminEnvironmentChecks,
  blockingEnvChecks,
  groupEnvChecksBySeverity,
  processStartedAt,
} from "../lib/adminEnvironmentChecks.ts";
import { adminHealthBreakdown } from "../lib/adminHealthScore.ts";

const SEVERITIES = ["required", "conditional", "recommended", "optional"];

/** Runs `body` against a temporary environment, then puts the old one back. */
const withEnv = (patch, body) => {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const byName = (name) =>
  adminEnvironmentChecks().find((check) => check.name === name);

test("the sweep sees the whole table, so a silent pass is impossible", () => {
  const checks = adminEnvironmentChecks();
  assert.ok(
    checks.length >= 25,
    `only ${checks.length} environment checks; the table has probably moved`
  );
  assert.equal(
    new Set(checks.map((check) => check.name)).size,
    checks.length,
    "two checks share a name, so one of them cannot be acted on"
  );
});

test("every row says what its absence costs", () => {
  // The exhaustiveness rule. Adding a variable without classifying it used to
  // mean adding ten points of deduction by default; now it means a red test.
  const unclassified = adminEnvironmentChecks()
    .filter((check) => !SEVERITIES.includes(check.severity))
    .map((check) => check.name);
  assert.deepEqual(
    unclassified,
    [],
    `${unclassified.join(", ")} declare no severity. Pick one of ${SEVERITIES.join(", ")}.`
  );
});

test("every conditional row names the condition it waits on", () => {
  // Without this a conditional row is indistinguishable from a required one an
  // operator was told not to worry about, which is worse than either.
  const silent = adminEnvironmentChecks()
    .filter((check) => check.severity === "conditional")
    .filter((check) => !check.condition || check.condition.trim().length === 0)
    .map((check) => check.name);
  assert.deepEqual(
    silent,
    [],
    `${silent.join(", ")} are conditional and do not say on what.`
  );
  assert.ok(
    adminEnvironmentChecks().some((check) => check.severity === "conditional"),
    "no conditional rows at all; the classification has drifted"
  );
});

test("the optional notification channels are optional", () => {
  for (const name of [
    "DISCORD_WEBHOOK_URL",
    "SLACK_WEBHOOK_URL",
    "PROVIDER_USAGE_SLACK_WEBHOOK_URL",
  ]) {
    assert.equal(byName(name)?.severity, "optional", name);
  }
  // The aggregate is the one that matters, and it stays required: what must be
  // true is that *some* out-of-band channel exists, not that Discord does.
  assert.equal(byName("OPS_ALERT_CHANNEL")?.severity, "required");
});

test("a jurisdiction footer value is conditional, never simply missing", () => {
  // `businessIdentityProblems()` keeps these at warning severity even with
  // marketing on, because whether this deployment has recipients in that
  // jurisdiction is not a fact the environment holds. The console agrees with
  // it rather than inventing a second answer.
  for (const name of [
    "EMAIL_BUSINESS_REGISTRATION_NUMBER",
    "EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER",
    "EMAIL_BUSINESS_ABN",
  ]) {
    assert.equal(byName(name)?.severity, "conditional", name);
  }
  // The three every profile prints stay required: without them no recipient
  // anywhere gets a footer.
  for (const name of [
    "EMAIL_BUSINESS_LEGAL_NAME",
    "EMAIL_BUSINESS_POSTAL_ADDRESS",
    "EMAIL_BUSINESS_CONTACT_EMAIL",
  ]) {
    assert.equal(byName(name)?.severity, "required", name);
  }
});

test("MARKETING_EMAIL_FROM being absent is the correct state, not a debt", () => {
  // Its own description has said "Absent today and that is correct" since it
  // was written, while the score deducted ten points for it.
  withEnv({ MARKETING_EMAIL_FROM: undefined }, () => {
    assert.equal(byName("MARKETING_EMAIL_FROM")?.severity, "conditional");
  });
});

test("the unsubscribe keyring becomes blocking exactly when marketing does", () => {
  // Same switch `unsubscribeKeyringProblems()` flips: harmless while marketing
  // is off, and from the moment MARKETING_EMAIL_FROM is set every marketing
  // send is refused without it.
  withEnv({ MARKETING_EMAIL_FROM: undefined }, () => {
    assert.equal(byName("EMAIL_UNSUBSCRIBE_KEYS")?.severity, "conditional");
  });
  withEnv({ MARKETING_EMAIL_FROM: "promo@marketing.example" }, () => {
    assert.equal(byName("EMAIL_UNSUBSCRIBE_KEYS")?.severity, "required");
  });
});

test("only required rows reach the score", () => {
  const checks = adminEnvironmentChecks();
  const blocking = blockingEnvChecks(checks);
  assert.ok(
    blocking.every((check) => check.severity === "required" && !check.configured),
    "blockingEnvChecks returned something that is configured or not required"
  );
  const missing = checks.filter((check) => !check.configured);
  assert.ok(
    blocking.length <= missing.length,
    "more blocking rows than missing ones"
  );
});

test("an unset optional channel costs nothing at all", () => {
  // The regression in one assertion. Before this change the same environment
  // scored ten points lower for a variable the table itself calls optional.
  const score = (env) =>
    withEnv(env, () => {
      const checks = adminEnvironmentChecks();
      return adminHealthBreakdown({
        outageCount: 0,
        limitedCount: 0,
        blockingEnvCount: blockingEnvChecks(checks).length,
        alertFailureCount: 0,
        pendingRefundCount: 0,
        openFeedbackCount: 0,
      }).score;
    });

  const withDiscord = score({
    DISCORD_WEBHOOK_URL: "https://discord.example/hook",
  });
  const withoutDiscord = score({ DISCORD_WEBHOOK_URL: undefined });
  assert.equal(withoutDiscord, withDiscord);
});

test("grouping lists only what is unset, and never loses a row", () => {
  const checks = adminEnvironmentChecks();
  const groups = groupEnvChecksBySeverity(checks);
  const grouped = [
    ...groups.required,
    ...groups.conditional,
    ...groups.recommended,
    ...groups.optional,
  ];

  assert.ok(
    grouped.every((check) => !check.configured),
    "a configured row was rendered as something to look at"
  );
  assert.equal(
    grouped.length,
    checks.filter((check) => !check.configured).length,
    "a missing row belongs to no group, so nothing on screen would show it"
  );
});

test("the process window is a real instant in the past", () => {
  // What the panel prints so "not configured" and "configured after this
  // process started" stop looking identical.
  const now = new Date("2026-09-14T02:31:00.000Z");
  const started = processStartedAt(now);
  assert.ok(started instanceof Date);
  assert.ok(Number.isFinite(started.getTime()));
  assert.ok(
    started.getTime() <= now.getTime(),
    "the process cannot have started after the request it answered"
  );
  assert.ok(
    now.getTime() - started.getTime() < 366 * 24 * 60 * 60 * 1000,
    "an uptime over a year suggests the clock, not the process"
  );
});
