import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SENDING_IDENTITY_ENV_KEYS,
  TRANSACTIONAL_FROM_FALLBACK,
  hardCodedSenders,
  resolveSendingIdentity,
  sendingIdentityInputFrom,
} from "../lib/emailSendingIdentityCore.ts";

// One resolver for every sender, and a check that finds the ones that bypass it.
// Contract: docs/policy/email-notifications.md §14.1.
// Background: docs/ops/email-sending-domains.md §1.2.

test("the transactional sender falls back rather than refusing", () => {
  // Every login code and receipt goes through this. An empty environment has
  // to produce a usable address, or a deployment that forgot the variable
  // stops sending instead of sending from the documented default.
  const resolved = resolveSendingIdentity("transactional", {});
  assert.equal(resolved.ok, true);
  assert.equal(resolved.from, TRANSACTIONAL_FROM_FALLBACK);
  assert.equal(resolved.domain, "tomverse.app");
});

test("precedence is specific first, and blank is not configured", () => {
  assert.equal(SENDING_IDENTITY_ENV_KEYS.transactional[0], "TRANSACTIONAL_EMAIL_FROM");
  assert.equal(
    resolveSendingIdentity("transactional", {
      TRANSACTIONAL_EMAIL_FROM: "A <a@mail.example.com>",
      EMAIL_FROM: "B <b@example.com>",
    }).from,
    "A <a@mail.example.com>"
  );
  assert.equal(
    resolveSendingIdentity("transactional", {
      TRANSACTIONAL_EMAIL_FROM: "   ",
      EMAIL_FROM: "B <b@example.com>",
    }).from,
    "B <b@example.com>"
  );
});

test("marketing refuses rather than borrowing the transactional sender", () => {
  // The failure this prevents has no symptom: the promotion arrives, and its
  // spam complaints land on the domain that carries login codes.
  const missing = resolveSendingIdentity("marketing", {
    TRANSACTIONAL_EMAIL_FROM: "A <a@mail.example.com>",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "MARKETING_FROM_MISSING");

  const shared = resolveSendingIdentity("marketing", {
    TRANSACTIONAL_EMAIL_FROM: "A <a@mail.example.com>",
    MARKETING_EMAIL_FROM: "B <b@mail.example.com>",
  });
  assert.equal(shared.ok, false);
  assert.equal(shared.code, "STREAMS_SHARE_A_DOMAIN");

  const separate = resolveSendingIdentity("marketing", {
    TRANSACTIONAL_EMAIL_FROM: "A <a@mail.example.com>",
    MARKETING_EMAIL_FROM: "B <b@news.example.com>",
  });
  assert.equal(separate.ok, true);
  assert.equal(separate.domain, "news.example.com");
});

test("an unreadable transactional value refuses instead of sending nonsense", () => {
  const resolved = resolveSendingIdentity("transactional", {
    TRANSACTIONAL_EMAIL_FROM: "Tomverse <hello@${DOMAIN}>",
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "TRANSACTIONAL_FROM_UNPARSEABLE");
});

test("the health input and the resolver read the same environment", () => {
  // Two readings of one environment is how the senders drifted apart. If these
  // ever disagree, the screen reporting the identity is reporting a different
  // one from the sender using it.
  const env = { EMAIL_FROM: "B <b@example.com>", MARKETING_EMAIL_FROM: "C <c@news.example.com>" };
  const input = sendingIdentityInputFrom(env);
  assert.equal(input.transactionalFrom, resolveSendingIdentity("transactional", env).from);
  assert.equal(input.marketingFrom, resolveSendingIdentity("marketing", env).from);
});

/**
 * The four senders as they were written on 2026-08-21, before they were
 * unified. This is the test that matters: a check that misses these is a check
 * that would have passed on the tree that had the bug.
 */
const HISTORICAL_BYPASSES = [
  [
    "operationalMonitoring: literal behind a fallback, on its own line",
    '      from:\n        process.env.ADMIN_ALERT_FROM?.trim() ||\n        "Tomverse Operations <alerts@tomverse.app>",',
  ],
  [
    "providerMonitoring: assigned to a const",
    '  const from = process.env.ADMIN_ALERT_FROM || "Tomverse Admin <alerts@tomverse.app>";',
  ],
  [
    "security audit script: same shape, different variable",
    '  const from =\n    process.env.SECURITY_AUDIT_EMAIL_FROM?.trim() ||\n    "Tomverse Security <hello@tomverse.app>";',
  ],
  [
    "SendGrid branch: a bare address on a from line",
    '          from: { email: from.includes("<") ? "alerts@tomverse.app" : from },',
  ],
];

for (const [name, source] of HISTORICAL_BYPASSES) {
  test(`the check catches the ${name}`, () => {
    const found = hardCodedSenders(source);
    assert.equal(found.length, 1, `expected exactly one finding, got ${found.length}`);
  });
}

test("addresses that are not senders are left alone", () => {
  // Recipients, contact addresses and fixture identities all live on the same
  // domain. Flagging them would train people to add exceptions rather than
  // read findings, and the exception list is where a real one would hide.
  for (const source of [
    'const SUPPORT = "support@tomverse.app";',
    '<a href="mailto:support@tomverse.app">Contact</a>',
    'await signIn({ email: "qa@tomverse.app", password });',
    'const demo = { email: "demo@tomverse.app" };',
    // A `from` in an unrelated sense, with no address on the line.
    'const rows = await prisma.usage.findMany({ where: { from: start } });',
  ]) {
    assert.deepEqual(hardCodedSenders(source), [], source);
  }
});

test("one line is reported once, not twice", () => {
  // The two patterns overlap on a display-name literal that also sits on a
  // `from` line, which is the commonest real case.
  const found = hardCodedSenders('  from: "Tomverse <alerts@tomverse.app>",');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});
