import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { removeLoginMethod } from "@/lib/loginMethodsCore";

// Regression coverage for an incident where a user's login-method removal
// appeared to fail client-side ("could not remove") while the server had
// actually already removed it, sent the confirmation email, and revoked
// every session -- including, via a race, more than the one method the user
// intended to remove. See lib/loginMethodsCore.ts for the fix.

const resetLoginMethodsData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "Session", "Account", "User" RESTART IDENTITY CASCADE
  `);

beforeEach(resetLoginMethodsData);
after(async () => {
  await resetLoginMethodsData();
  await prisma.$disconnect();
});

const createUser = async (opts: {
  google?: boolean;
  azureAd?: boolean;
  emailLoginEnabled?: boolean;
  withSession?: boolean;
}) => {
  const email = `${randomUUID()}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      emailLoginEnabled: opts.emailLoginEnabled ?? false,
    },
  });
  if (opts.google) {
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "google",
        providerAccountId: `google-${randomUUID()}`,
      },
    });
  }
  if (opts.azureAd) {
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "azure-ad",
        providerAccountId: `azure-ad-${randomUUID()}`,
      },
    });
  }
  if (opts.withSession) {
    await prisma.session.create({
      data: {
        sessionToken: `integration-${randomUUID()}`,
        userId: user.id,
        expires: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
  }
  return user;
};

test("removing the only enabled login method is blocked", async () => {
  const user = await createUser({ emailLoginEnabled: true });

  const outcome = await removeLoginMethod(user.id, "email");

  assert.equal(outcome, "blocked");
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.emailLoginEnabled, true);
  assert.equal(reloaded.sessionsInvalidatedAt, null);
});

test("removing a login method disables it and revokes sessions atomically", async () => {
  const user = await createUser({ google: true, emailLoginEnabled: true, withSession: true });

  const outcome = await removeLoginMethod(user.id, "email");

  assert.equal(outcome, "removed");
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.emailLoginEnabled, false);
  assert.ok(reloaded.sessionsInvalidatedAt, "sessionsInvalidatedAt should be stamped");
  assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
});

test("a redundant removal of an already-removed method is a no-op", async () => {
  const user = await createUser({ google: true, emailLoginEnabled: true });

  const first = await removeLoginMethod(user.id, "email");
  assert.equal(first, "removed");
  const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  const second = await removeLoginMethod(user.id, "email");
  assert.equal(second, "already-removed");
  const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  // A no-op must not re-stamp the revocation timestamp (which would mean it
  // re-ran session revocation -- and, in the real route, re-sent the
  // "login method removed" email -- for a change that already happened).
  assert.equal(
    afterSecond.sessionsInvalidatedAt?.getTime(),
    afterFirst.sessionsInvalidatedAt?.getTime()
  );
});

test("concurrent removal of a user's last two methods cannot remove both", async () => {
  const user = await createUser({ google: true, emailLoginEnabled: true });

  const [googleOutcome, emailOutcome] = await Promise.all([
    removeLoginMethod(user.id, "google"),
    removeLoginMethod(user.id, "email"),
  ]);

  const outcomes = [googleOutcome, emailOutcome];
  assert.equal(
    outcomes.filter((outcome) => outcome === "removed").length,
    1,
    `expected exactly one removal to succeed, got ${JSON.stringify(outcomes)}`
  );
  assert.ok(outcomes.includes("blocked"), "the other concurrent removal should be blocked");

  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const googleLinked = await prisma.account.count({
    where: { userId: user.id, provider: "google" },
  });
  const enabledCount = googleLinked + (reloaded.emailLoginEnabled ? 1 : 0);
  assert.equal(enabledCount, 1, "exactly one login method must remain enabled");
});
