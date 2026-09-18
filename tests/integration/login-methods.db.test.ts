import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { enableEmailLoginMethod, removeLoginMethod } from "@/lib/loginMethodsCore";

// Regression coverage for an incident where a user's login-method removal
// appeared to fail client-side ("could not remove") while the server had
// actually already removed it, sent the confirmation email, and revoked
// every session -- including, via a race, more than the one method the user
// intended to remove. See lib/loginMethodsCore.ts for the fix.

const resetLoginMethodsData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "Session", "Account", "User"
    RESTART IDENTITY CASCADE
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

test("the removal queues its notice in the same transaction", async () => {
  // It used to be sent after the response, and a failure left an incident and
  // a person who had been signed out of every device and told nothing
  // (docs/policy/email-notifications.md v23).
  const user = await createUser({ google: true, emailLoginEnabled: true });

  assert.equal(await removeLoginMethod(user.id, "google"), "removed");

  const queued = await prisma.emailDelivery.findMany({
    where: { userId: user.id },
    select: { emailAddress: true, lane: true, status: true, renderDataSnapshot: true },
  });
  assert.equal(queued.length, 1, "the notice is in the queue, not in an after()");
  assert.equal(queued[0].emailAddress, user.email);
  assert.equal(queued[0].lane, "standard");
  assert.equal(queued[0].status, "pending");
  // Queued, not sent: what the lane does next -- the address lock, the
  // suppression re-check, the retries -- is the lane's, and this row is what
  // makes it happen at all.
  assert.notEqual(queued[0].renderDataSnapshot, null);
});

test("a removal that changed nothing queues nothing", async () => {
  // A redundant call returns `already-removed` without revoking sessions; it
  // must not announce a removal that did not happen either.
  const user = await createUser({ google: true, emailLoginEnabled: true });
  assert.equal(await removeLoginMethod(user.id, "azure-ad"), "already-removed");
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 0);
});

test("a removal that is refused queues nothing", async () => {
  // The last method cannot be removed, so there is nothing to announce.
  const user = await createUser({ google: true });
  assert.equal(await removeLoginMethod(user.id, "google"), "blocked");
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 0);
});

test("enabling email login queues the notice, once", async () => {
  const user = await createUser({ google: true });

  assert.equal(await enableEmailLoginMethod(user.id), "enabled");
  const queued = await prisma.emailDelivery.findMany({ where: { userId: user.id } });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].emailAddress, user.email);
  assert.equal(queued[0].status, "pending");
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailLoginEnabled,
    true
  );
});

test("verifying again announces nothing, because nothing changed", async () => {
  // `update` succeeds on a row that is already `true`, so this used to queue "a
  // login method was added" for a replayed verification -- the same false
  // security notice the OAuth callback was fixed for.
  const user = await createUser({ google: true, emailLoginEnabled: true });

  assert.equal(await enableEmailLoginMethod(user.id), "already-enabled");
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 0);
});

test("two verifications racing announce it once", async () => {
  // The conditional write is what decides, so only one of them can be the one
  // that changed anything.
  const user = await createUser({ google: true });

  const outcomes = await Promise.all([
    enableEmailLoginMethod(user.id),
    enableEmailLoginMethod(user.id),
  ]);
  assert.deepEqual(outcomes.filter((outcome) => outcome === "enabled").length, 1);
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 1);
});
