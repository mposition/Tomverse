import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isWithinDomain,
  parseFromAddress,
  rootDomainOf,
  sendingIdentityProblems,
  sendingIdentityReadiness,
  streamForClassification,
} from "../lib/emailSendingIdentityCore.ts";

// Which domain a message is sent from.
// Contract: docs/policy/email-notifications.md §5.3, §14.1, §17.3.

const problemCodes = (input) =>
  sendingIdentityProblems(input).map((problem) => problem.code);

test("marketing is its own stream and everything else is transactional", () => {
  // §14.1 gives marketing a domain and everything else the transactional one.
  // service and legal are separate classifications because they retry
  // differently, not because they are separately deliverable.
  assert.equal(streamForClassification("marketing"), "marketing");
  for (const classification of ["transactional", "service", "legal"]) {
    assert.equal(streamForClassification(classification), "transactional");
  }
  // An unknown classification is transactional rather than marketing: the
  // wrong answer in that direction sends a message from the safe domain, and
  // in the other it puts an unknown message on the marketing domain.
  assert.equal(streamForClassification("something-new"), "transactional");
});

test("both header shapes parse, and the domain is normalised", () => {
  assert.deepEqual(parseFromAddress("Tomverse <hello@Mail.Tomverse.App>"), {
    displayName: "Tomverse",
    address: "hello@Mail.Tomverse.App",
    domain: "mail.tomverse.app",
  });
  assert.deepEqual(parseFromAddress("hello@tomverse.app"), {
    displayName: null,
    address: "hello@tomverse.app",
    domain: "tomverse.app",
  });
  assert.equal(parseFromAddress('"Tomverse Review" <a@b.co>').displayName, "Tomverse Review");
});

test("an unusable value is unparseable rather than half-read", () => {
  for (const value of [
    null,
    undefined,
    "",
    "   ",
    "hello",
    "hello@",
    "@tomverse.app",
    "hello@localhost",
    "hello@tomverse app",
    // An unexpanded template, which is what this actually catches in practice.
    "Tomverse <hello@${DOMAIN}>",
  ]) {
    assert.equal(parseFromAddress(value), null, `${JSON.stringify(value)} parsed`);
  }
});

test("a missing transactional address is an error", () => {
  // Every login code and receipt goes from it.
  assert.deepEqual(
    problemCodes({ transactionalFrom: "", marketingFrom: null }),
    ["TRANSACTIONAL_FROM_UNPARSEABLE"]
  );
});

test("an absent marketing address is not a finding", () => {
  // It is the state of every deployment today. A health check that warned
  // about it everywhere would be a warning nobody reads by the time it means
  // something; the send path refuses instead.
  assert.deepEqual(
    problemCodes({
      transactionalFrom: "Tomverse <hello@mail.tomverse.app>",
      marketingFrom: null,
    }),
    []
  );
});

test("a marketing address that is set and unreadable is an error", () => {
  // Configured-and-broken is worse than absent: it looks done.
  assert.deepEqual(
    problemCodes({
      transactionalFrom: "Tomverse <hello@mail.tomverse.app>",
      marketingFrom: "news@",
    }),
    ["MARKETING_FROM_UNPARSEABLE"]
  );
});

test("two streams on one domain is an error even before marketing is used", () => {
  // Domain reputation is the one layer that separates (§5.3). A configuration
  // that gives it up is wrong before it is used, and the moment it is used is
  // the moment it was needed.
  const codes = problemCodes({
    transactionalFrom: "Tomverse <hello@mail.tomverse.app>",
    marketingFrom: "Tomverse <news@mail.tomverse.app>",
  });
  assert.deepEqual(codes, ["STREAMS_SHARE_A_DOMAIN"]);
  assert.equal(
    sendingIdentityReadiness({
      transactionalFrom: "Tomverse <hello@mail.tomverse.app>",
      marketingFrom: "Tomverse <news@mail.tomverse.app>",
    }).ready,
    false
  );
});

test("separate subdomains of one registrable domain are fine", () => {
  // This is the target state, not a violation: `sp=` policies and receiver
  // reputation both work per hostname.
  assert.deepEqual(
    problemCodes({
      transactionalFrom: "Tomverse <hello@mail.tomverse.app>",
      marketingFrom: "Tomverse <news@news.tomverse.app>",
    }),
    []
  );
});

test("sending from the registrable domain warns in production only", () => {
  // §17.3 step 3, and the state the deployment is actually in. A warning
  // rather than an error: gating on it would refuse readiness on today's
  // production in order to announce a planned migration.
  const input = {
    transactionalFrom: "Tomverse Review <hello@tomverse.app>",
    marketingFrom: null,
  };
  assert.deepEqual(problemCodes({ ...input, nodeEnv: "production" }), [
    "TRANSACTIONAL_ON_ROOT_DOMAIN",
  ]);
  assert.deepEqual(problemCodes({ ...input, nodeEnv: "development" }), []);

  const readiness = sendingIdentityReadiness({ ...input, nodeEnv: "production" });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.warnings.length, 1);
  assert.equal(readiness.errors.length, 0);
});

test("the registrable parent is what the DMARC note points at", () => {
  assert.equal(rootDomainOf("mail.tomverse.app"), "tomverse.app");
  assert.equal(rootDomainOf("tomverse.app"), "tomverse.app");
  assert.equal(rootDomainOf("a.b.c.example.com"), "example.com");
});

test("subdomain containment is by label, not by suffix", () => {
  assert.equal(isWithinDomain("mail.tomverse.app", "tomverse.app"), true);
  assert.equal(isWithinDomain("tomverse.app", "tomverse.app"), true);
  // The one that matters: a lookalike registered by somebody else.
  assert.equal(isWithinDomain("nottomverse.app", "tomverse.app"), false);
});
