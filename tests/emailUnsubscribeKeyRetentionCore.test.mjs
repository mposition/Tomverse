import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANARY_PURPOSE,
  CANARY_SUBJECT,
  mintUnsubscribeKeyCanary,
  UNSUBSCRIBE_KEY_RETENTION_DAYS,
  unsubscribeKeyRetentionVerdict,
} from "../lib/emailUnsubscribeKeyRetentionCore.ts";
import { readUnsubscribeToken } from "../lib/unsubscribeToken.ts";

// Contract: docs/policy/email-notifications.md §11.4.

const DAY = 24 * 60 * 60 * 1_000;
const now = new Date("2026-09-16T00:00:00.000Z");
const daysAgo = (days) => new Date(now.getTime() - days * DAY);

const keyring = (secrets, activeVersion = Object.keys(secrets)[0]) => ({
  activeVersion,
  secrets,
});

const v1 = keyring({ v1: "secret-one" });
const canaryV1 = { keyVersion: "v1", token: mintUnsubscribeKeyCanary(v1) };

test("a canary names nobody and no purpose", () => {
  const read = readUnsubscribeToken(canaryV1.token, v1);
  assert.equal(read.valid, true);
  assert.deepEqual(read.payload, { userId: CANARY_SUBJECT, purpose: CANARY_PURPOSE });
});

test("with no canaries there is nothing to protect", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: null,
    canaries: [],
    lastSentAt: {},
    now,
  });
  assert.deepEqual(verdict, { ready: true, errors: [], warnings: [], retirable: [] });
});

test("a version still listed and still opening its canary is fine", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v1: "secret-one", v2: "secret-two" }, "v2"),
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(3) },
    now,
  });
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.retirable, []);
});

test("dropping a version used within the window is refused, and says until when", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v2: "secret-two" }),
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(UNSUBSCRIBE_KEY_RETENTION_DAYS - 1) },
    now,
  });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].code, "EMAIL_UNSUBSCRIBE_KEY_RETIRED_TOO_EARLY");
  assert.equal(verdict.errors[0].keyVersion, "v1");
  assert.match(verdict.errors[0].message, /2026-09-17T00:00:00\.000Z/);
});

test("dropping a version whose last send is past the window is allowed and listed as retirable", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v2: "secret-two" }),
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(UNSUBSCRIBE_KEY_RETENTION_DAYS) },
    now,
  });
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.retirable, ["v1"]);
});

test("a version that minted a canary but never sent is retirable", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v2: "secret-two" }),
    canaries: [canaryV1],
    lastSentAt: {},
    now,
  });
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.retirable, ["v1"]);
});

test("editing the secret behind a version in use is refused like dropping it", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v1: "a-different-secret" }),
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(1) },
    now,
  });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].code, "EMAIL_UNSUBSCRIBE_KEY_CHANGED");
});

test("editing the secret behind a retired version is only a warning", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v1: "a-different-secret" }),
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(90) },
    now,
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.warnings[0].code, "EMAIL_UNSUBSCRIBE_KEY_CHANGED");
});

test("removing the whole keyring with recent mail is refused", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: null,
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(2) },
    now,
  });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].code, "EMAIL_UNSUBSCRIBE_KEYRING_ABSENT_WITH_RECENT_MAIL");
});

test("no message names a secret or a token", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v1: "a-different-secret" }),
    canaries: [canaryV1],
    lastSentAt: { v1: daysAgo(1) },
    now,
  });
  const text = JSON.stringify(verdict);
  assert.doesNotMatch(text, /secret-one|a-different-secret/);
  assert.equal(text.includes(canaryV1.token), false);
});

test("mail sent before versions were recorded holds every canaried version", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v2: "secret-two" }),
    canaries: [canaryV1],
    lastSentAt: {},
    unattributedLastSentAt: daysAgo(5),
    now,
  });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].code, "EMAIL_UNSUBSCRIBE_KEY_RETIRED_TOO_EARLY");
});

test("recent unattributed mail with no canary at all is not ready", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: v1,
    canaries: [],
    lastSentAt: {},
    unattributedLastSentAt: daysAgo(5),
    now,
  });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.errors[0].code, "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNPROTECTED");
});

test("unattributed mail that aged out holds nothing", () => {
  const verdict = unsubscribeKeyRetentionVerdict({
    keyring: keyring({ v2: "secret-two" }),
    canaries: [canaryV1],
    lastSentAt: {},
    unattributedLastSentAt: daysAgo(UNSUBSCRIBE_KEY_RETENTION_DAYS + 1),
    now,
  });
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.retirable, ["v1"]);
});
