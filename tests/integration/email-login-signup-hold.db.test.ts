import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  heldSignupAddressForLink,
  verifyEmailLoginCode,
  verifyEmailLoginCodeForOwnAccount,
  verifyEmailLoginLink,
} from "@/lib/emailLogin";

// A sign-in that proves an address with no account turns the login row into a
// one-time sign-up hold; only a sign-up may spend it, once.
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.2a (v25).

const SECRET = "test-secret";
const CODE = "123456";

const hmacHex = (namespace: string, value: string) =>
  createHmac("sha256", SECRET).update(`email-login:${namespace}:${value}`).digest("hex");

const request = () =>
  new Request("http://internal.invalid/auth/email-code", {
    headers: new Headers({ "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` }),
  });

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "EmailLoginAttempt", "ChatUsageBucket", "Account", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.NEXTAUTH_SECRET = SECRET;
});

/** A live row for `email` whose code is CODE and whose link is the returned token. */
const issue = async (email: string) => {
  const linkToken = randomUUID();
  const row = await prisma.emailLoginAttempt.create({
    data: {
      email,
      codeHash: hmacHex("code", `${email}:${CODE}`),
      linkTokenHash: hmacHex("link", linkToken),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  return { row, linkToken };
};

const address = () => `${randomUUID()}@example.test`;

test("a sign-in with no account holds the row in the same write, and creates nothing", async () => {
  const email = address();
  const { row } = await issue(email);

  const result = await verifyEmailLoginCode(request(), email, CODE, "signin");
  assert.deepEqual(result, { ok: false, reason: "account_not_found" });

  const after = await prisma.emailLoginAttempt.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(after.consumedAt, "consumed");
  assert.ok(after.signupHoldUntil, "held");
  assert.equal(after.signupHoldUsedAt, null);
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  // A matched code clears the lockout, as a successful sign-in does.
  assert.equal(await prisma.chatUsageBucket.count({ where: { period: "email-otp-lock" } }), 0);
});

test("a held code never signs in and never re-enables email login", async () => {
  const email = address();
  await issue(email);
  await verifyEmailLoginCode(request(), email, CODE, "signin");

  assert.deepEqual(await verifyEmailLoginCode(request(), email, CODE, "signin"), {
    ok: false,
    reason: "invalid_or_expired",
  });
  assert.deepEqual(await verifyEmailLoginCodeForOwnAccount(request(), email, CODE), {
    ok: false,
    reason: "invalid_or_expired",
  });
});

test("a sign-up spends the hold once, and names the row it spent", async () => {
  const email = address();
  const { row } = await issue(email);
  await verifyEmailLoginCode(request(), email, CODE, "signin");

  const signedUp = await verifyEmailLoginCode(request(), email, CODE, "signup");
  assert.equal(signedUp.ok, true);
  if (!signedUp.ok) return;
  assert.equal(signedUp.isNewUser, true);
  assert.equal(signedUp.emailLoginAttemptId, row.id);
  const after = await prisma.emailLoginAttempt.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(after.signupHoldUsedAt, "hold used");

  assert.deepEqual(await verifyEmailLoginCode(request(), email, CODE, "signup"), {
    ok: false,
    reason: "invalid_or_expired",
  });
  assert.equal(await prisma.user.count({ where: { email } }), 1);
});

test("two tabs spending one hold: exactly one succeeds", async () => {
  const email = address();
  await issue(email);
  await verifyEmailLoginCode(request(), email, CODE, "signin");

  const results = await Promise.allSettled([
    verifyEmailLoginCode(request(), email, CODE, "signup"),
    verifyEmailLoginCode(request(), email, CODE, "signup"),
  ]);
  const succeeded = results.filter(
    (result) => result.status === "fulfilled" && result.value.ok
  ).length;
  assert.equal(succeeded, 1);
  assert.equal(await prisma.user.count({ where: { email } }), 1);
});

test("an expired hold is spent by nothing", async () => {
  const email = address();
  const { row } = await issue(email);
  await verifyEmailLoginCode(request(), email, CODE, "signin");
  await prisma.emailLoginAttempt.update({
    where: { id: row.id },
    data: { signupHoldUntil: new Date(Date.now() - 1_000) },
  });

  assert.deepEqual(await verifyEmailLoginCode(request(), email, CODE, "signup"), {
    ok: false,
    reason: "invalid_or_expired",
  });
  assert.equal(await prisma.user.count({ where: { email } }), 0);
});

test("a hold does not sign into an account that appeared at the address since", async () => {
  const email = address();
  await issue(email);
  await verifyEmailLoginCode(request(), email, CODE, "signin");
  await prisma.user.create({ data: { email, emailLoginEnabled: true } });

  assert.deepEqual(await verifyEmailLoginCode(request(), email, CODE, "signup"), {
    ok: false,
    reason: "invalid_or_expired",
  });
});

test("an existing account signs in and is never held", async () => {
  const email = address();
  const user = await prisma.user.create({ data: { email, emailLoginEnabled: true } });
  const { row } = await issue(email);

  const result = await verifyEmailLoginCode(request(), email, CODE, "signin");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.userId, user.id);
  assert.equal(result.isNewUser, false);
  const after = await prisma.emailLoginAttempt.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.signupHoldUntil, null);
});

test("an account that disabled email login is refused, its row consumed and not held", async () => {
  const email = address();
  await prisma.user.create({ data: { email, emailLoginEnabled: false } });
  const { row } = await issue(email);

  assert.deepEqual(await verifyEmailLoginCode(request(), email, CODE, "signup"), {
    ok: false,
    reason: "invalid_or_expired",
  });
  const after = await prisma.emailLoginAttempt.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(after.consumedAt);
  assert.equal(after.signupHoldUntil, null);
});

test("a sign-up from the sign-up screen creates the account directly", async () => {
  const email = address();
  const { row } = await issue(email);

  const result = await verifyEmailLoginCode(request(), email, CODE, "signup");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.isNewUser, true);
  assert.equal(result.emailLoginAttemptId, row.id);
  const after = await prisma.emailLoginAttempt.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(after.consumedAt);
  assert.equal(after.signupHoldUntil, null);
});

test("a link that finds no account is held; its address is told only to the link", async () => {
  const email = address();
  const { row, linkToken } = await issue(email);

  // Before any proof, the link reveals nothing.
  assert.equal(await heldSignupAddressForLink(linkToken), null);

  assert.deepEqual(await verifyEmailLoginLink(request(), linkToken, "signin"), {
    ok: false,
    reason: "account_not_found",
  });
  assert.equal(await heldSignupAddressForLink(linkToken), email);
  assert.equal(await heldSignupAddressForLink(randomUUID()), null);

  const signedUp = await verifyEmailLoginLink(request(), linkToken, "signup");
  assert.equal(signedUp.ok, true);
  if (!signedUp.ok) return;
  assert.equal(signedUp.emailLoginAttemptId, row.id);
  // Spent: the address is no longer answered, and the link does nothing.
  assert.equal(await heldSignupAddressForLink(linkToken), null);
  assert.deepEqual(await verifyEmailLoginLink(request(), linkToken, "signup"), {
    ok: false,
    reason: "invalid_or_expired",
  });
});
