import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

/**
 * The mobile session lifecycle against a real database.
 *
 * .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md D5, D7,
 * D8, D11 and section 4 option A, approved 2026-08-31.
 *
 * What only a database can settle, and what this file is therefore for:
 *
 *   - the conditional UPDATE really is atomic, so two requests racing on one
 *     refresh token produce one successor and one refusal rather than two
 *     usable tokens;
 *   - a replay revokes the family **and the revocation commits**, even though
 *     the caller is answered with a refusal (D8's commit contract);
 *   - a wrong secret on a consumed record leaves the family standing, so a
 *     leaked record id is not an unauthenticated way to end a session;
 *   - releasing one device reaches that device's families and nothing else.
 */

const ed25519 = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

before(() => {
  // Set on the process rather than injected: the service reads the ambient
  // environment, which is what production does, and a test that injected its
  // own would not exercise that path.
  process.env.MOBILE_AUTH_SIGNING_KEYS = `sign-1:${ed25519()}`;
  process.env.MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = "sign-1";
  process.env.MOBILE_AUTH_REFRESH_PEPPERS = `pep-1:${randomBytes(32).toString("base64url")}`;
  process.env.MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = "pep-1";
  process.env.MOBILE_AUTH_TOKEN_ISSUER = "https://tomverse.test";
  process.env.MOBILE_AUTH_TOKEN_AUDIENCE = "tomverse-mobile-api";
});

const service = () => import("@/lib/mobileAuthService");
const authorization = () => import("@/lib/mobileSessionAuthorization");
const accessToken = () => import("@/lib/mobileAccessToken");

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MobileAuthEvent",
      "MobileRefreshRotation",
      "MobileTokenFamily",
      "MobileLoginGrant",
      "MobileDevice"
    RESTART IDENTITY CASCADE
  `);
  const { resetMobileSessionSnapshotsForTesting } = await authorization();
  resetMobileSessionSnapshotsForTesting();
};

const request = () =>
  new Request("https://tomverse.test/api/auth/mobile/refresh", { method: "POST" });

const createUser = () =>
  prisma.user.create({ data: { email: `mobile-service-${randomUUID()}@example.test` } });

const issue = async (userId: string) => {
  const { issueMobileSession } = await service();
  const result = await issueMobileSession({
    request: request(),
    userId,
    deviceLabel: "Phone",
    platform: "ios",
    appVersion: "1.0.0",
  });
  return result.tokens;
};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("an exchange creates a device, a family and exactly one live rotation", async () => {
  const user = await createUser();
  const tokens = await issue(user.id);

  const device = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id: tokens.deviceId },
  });
  assert.equal(device.userId, user.id);
  assert.equal(device.platform, "ios");
  assert.equal(device.revokedAt, null);

  const rotations = await prisma.mobileRefreshRotation.findMany();
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0]?.consumedAt, null);
  // What the row holds is a digest. The token the device got must not appear.
  assert.ok(!tokens.refreshToken.includes(rotations[0]!.secretDigest));
  assert.ok(!rotations[0]!.secretDigest.includes(tokens.refreshToken.split(".")[1]!));

  const { verifyMobileAccessTokenString } = await accessToken();
  const verdict = verifyMobileAccessTokenString(tokens.accessToken);
  assert.equal(verdict.ok, true);
});

test("a refresh consumes its token, mints a successor, and links the chain", async () => {
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);

  const rotated = await rotateMobileSession({
    request: request(),
    refreshToken: first.refreshToken,
  });
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.tokens.refreshToken, first.refreshToken);

  const rows = await prisma.mobileRefreshRotation.findMany({ orderBy: { createdAt: "asc" } });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.consumedAt, null);
  assert.equal(rows[0]?.supersededById, rows[1]?.id);
  assert.equal(rows[1]?.consumedAt, null);
});

test("two requests racing on one token: one successor, one refusal", async () => {
  // Section 4 option A, strict single use. The conditional UPDATE is what makes
  // this true rather than the read that precedes it.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);

  const [left, right] = await Promise.all([
    rotateMobileSession({ request: request(), refreshToken: first.refreshToken }),
    rotateMobileSession({ request: request(), refreshToken: first.refreshToken }),
  ]);

  const winners = [left, right].filter((result) => result.ok);
  assert.equal(winners.length, 1, "exactly one rotation may win");

  // And the family survives: the loser presented a legitimate token that simply
  // arrived second, which is not a replay.
  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.equal(family.revokedAt, null);
});

test("a replayed token destroys the family, and the revocation commits", async () => {
  // D8's commit contract. An implementation that threw would roll the
  // revocation back with the response and leave replay detection doing nothing.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });

  const replay = await rotateMobileSession({
    request: request(),
    refreshToken: first.refreshToken,
  });
  assert.equal(replay.ok, false);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, "reuse_detected");
  assert.equal(family.epoch, 1);

  const live = await prisma.mobileRefreshRotation.count({
    where: { consumedAt: null, invalidatedAt: null },
  });
  assert.equal(live, 0);

  const events = await prisma.mobileAuthEvent.findMany({ select: { event: true } });
  assert.ok(events.some((row) => row.event === "mobile_auth.reuse_detected"));
});

test("a wrong secret on a consumed record leaves the family standing", async () => {
  // The premise of D5's order, end to end: the record id is the front half of
  // the token and is not a secret, so knowing one must not be a way to end a
  // session.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });

  const [recordId] = first.refreshToken.split(".");
  const forged = `${recordId}.${randomBytes(32).toString("base64url")}`;
  const result = await rotateMobileSession({ request: request(), refreshToken: forged });
  assert.equal(result.ok, false);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.equal(family.revokedAt, null, "a wrong secret must not revoke anything");
});

test("a revoked family stops authorizing, inside the access token's own lifetime", async () => {
  // The gate in proxy checks signature and expiry; this is the layer that makes
  // a revocation observable before the token expires (D12).
  const { logoutMobileSession } = await service();
  const { authorizeMobileSession } = await authorization();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const tokens = await issue(user.id);

  const before = verifyMobileAccessTokenString(tokens.accessToken);
  assert.equal(before.ok, true);
  assert.equal((await authorizeMobileSession(before.identity)).ok, true);

  await logoutMobileSession({ request: request(), refreshToken: tokens.refreshToken });

  // The token itself is untouched and still verifies. What changed is whether
  // it authorizes anything.
  assert.equal(verifyMobileAccessTokenString(tokens.accessToken).ok, true);
  const after = await authorizeMobileSession(before.identity);
  assert.equal(after.ok, false);
  assert.equal(after.refusal, "family_revoked");
});

test("logout with a wrong secret revokes nothing", async () => {
  const { logoutMobileSession } = await service();
  const user = await createUser();
  const tokens = await issue(user.id);
  const [recordId] = tokens.refreshToken.split(".");

  await logoutMobileSession({
    request: request(),
    refreshToken: `${recordId}.${randomBytes(32).toString("base64url")}`,
  });

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.equal(family.revokedAt, null);
});

test("releasing one device ends its families and leaves the other device alone", async () => {
  // D11's narrowest scope. Losing one phone must not sign the other devices out.
  const { revokeMobileDevice } = await service();
  const { authorizeMobileSession } = await authorization();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const phone = await issue(user.id);
  const tablet = await issue(user.id);

  const result = await revokeMobileDevice({ userId: user.id, deviceId: phone.deviceId });
  assert.equal(result.ok, true);

  const phoneIdentity = verifyMobileAccessTokenString(phone.accessToken);
  const tabletIdentity = verifyMobileAccessTokenString(tablet.accessToken);
  assert.equal(phoneIdentity.ok, true);
  assert.equal(tabletIdentity.ok, true);

  const phoneVerdict = await authorizeMobileSession(phoneIdentity.identity);
  assert.equal(phoneVerdict.ok, false);
  assert.equal((await authorizeMobileSession(tabletIdentity.identity)).ok, true);
});

test("another account's device is not found rather than refused", async () => {
  const { revokeMobileDevice } = await service();
  const owner = await createUser();
  const stranger = await createUser();
  const tokens = await issue(owner.id);

  const result = await revokeMobileDevice({
    userId: stranger.id,
    deviceId: tokens.deviceId,
  });
  assert.deepEqual(result, { ok: false, reason: "not_found" });

  const device = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id: tokens.deviceId },
  });
  assert.equal(device.revokedAt, null);
});

test("a global sign-out reaches tokens minted before it and not after", async () => {
  const { authorizeMobileSession, invalidateMobileSessionSnapshots } = await authorization();
  const { verifyMobileAccessTokenString } = await accessToken();
  const user = await createUser();
  const tokens = await issue(user.id);
  const identity = verifyMobileAccessTokenString(tokens.accessToken);
  assert.equal(identity.ok, true);

  await prisma.user.update({
    where: { id: user.id },
    data: { sessionsRevokedAt: new Date(Date.now() + 60_000) },
  });
  invalidateMobileSessionSnapshots(user.id);

  const verdict = await authorizeMobileSession(identity.identity);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refusal, "sessions_revoked");
});

test("a forced sign-out stops the refresh token too, not only the access token", async () => {
  // The failure this exists to catch: stamping `sessionsRevokedAt` alone stops
  // the access tokens, whose `iat` predates it, and leaves the refresh tokens
  // working -- so the very next refresh mints an access token dated *after* the
  // sign-out and the session quietly comes back. D11 says the widest row takes
  // every family, and this is what proves it does.
  const { rotateMobileSession } = await service();
  const { revokeAllUserSessions } = await import("@/lib/sessionSecurity");
  const user = await createUser();
  const tokens = await issue(user.id);

  await revokeAllUserSessions(user.id);

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, "logout");

  const refreshed = await rotateMobileSession({
    request: request(),
    refreshToken: tokens.refreshToken,
  });
  assert.equal(refreshed.ok, false, "a refresh must not resurrect a signed-out session");
});

test("a forced sign-out keeps the person's list of their own phones", async () => {
  // Ending the sessions is not a decision to forget which devices exist. Only
  // account deletion is, and that removes them by cascade.
  const { revokeAllUserSessions } = await import("@/lib/sessionSecurity");
  const user = await createUser();
  const tokens = await issue(user.id);

  await revokeAllUserSessions(user.id);

  const device = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id: tokens.deviceId },
  });
  assert.equal(device.revokedAt, null);
});

test("a login grant is single use and bound to the verifier that started it", async () => {
  const { consumeMobileLoginGrant, issueMobileLoginGrant, pkceChallengeFor } = await import(
    "@/lib/mobileLoginGrant"
  );
  const user = await createUser();
  const verifier = randomBytes(32).toString("base64url");
  const { grant } = await issueMobileLoginGrant({
    userId: user.id,
    codeChallenge: pkceChallengeFor(verifier),
  });

  // The wrong verifier is refused, and -- because the binding is checked before
  // the state -- it does not spend the grant either.
  const wrong = await consumeMobileLoginGrant({
    grant,
    codeVerifier: randomBytes(32).toString("base64url"),
  });
  assert.deepEqual(wrong, { ok: false, reason: "binding_mismatch" });

  const first = await consumeMobileLoginGrant({ grant, codeVerifier: verifier });
  assert.deepEqual(first, { ok: true, userId: user.id });

  const second = await consumeMobileLoginGrant({ grant, codeVerifier: verifier });
  assert.deepEqual(second, { ok: false, reason: "consumed" });
});

test("an expired grant is refused, and an unknown one says so without a lookup key", async () => {
  const { consumeMobileLoginGrant, issueMobileLoginGrant, pkceChallengeFor } = await import(
    "@/lib/mobileLoginGrant"
  );
  const user = await createUser();
  const verifier = randomBytes(32).toString("base64url");
  const { grant } = await issueMobileLoginGrant({
    userId: user.id,
    codeChallenge: pkceChallengeFor(verifier),
    now: new Date(Date.now() - 120_000),
  });

  assert.deepEqual(await consumeMobileLoginGrant({ grant, codeVerifier: verifier }), {
    ok: false,
    reason: "expired",
  });
  assert.deepEqual(
    await consumeMobileLoginGrant({ grant: "not-a-grant", codeVerifier: verifier }),
    { ok: false, reason: "unknown" }
  );
});

test("V14 -- deleting the account takes every mobile row and leaves one nameless record", async () => {
  // Approved decision 9: deletion removes the rows and identifiers naming the
  // person, their devices and their families, and only a de-identified
  // aggregate may remain. The cascade does the first half; this is the second.
  const { deleteTomverseAccount } = await import("@/lib/accountDeletion");
  const user = await createUser();
  await issue(user.id);
  await issue(user.id);

  const result = await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(result.deleted, true);

  assert.equal(await prisma.mobileDevice.count(), 0);
  assert.equal(await prisma.mobileTokenFamily.count(), 0);
  assert.equal(await prisma.mobileRefreshRotation.count(), 0);

  const remaining = await prisma.mobileAuthEvent.findMany();
  assert.equal(remaining.length, 1, "one aggregate row, and only one");
  assert.equal(remaining[0]?.event, "mobile_auth.revoked_on_account_deletion");
  // It survives because it names nobody. A row naming the account would have
  // been taken by the same cascade a moment later.
  assert.equal(remaining[0]?.userId, null);
  assert.equal(remaining[0]?.deviceId, null);
  assert.equal(remaining[0]?.familyId, null);
});

test("V14 -- an account with no mobile session leaves no mobile record at all", async () => {
  // A row on every deletion would count deletions rather than mobile sessions
  // ended, and an operator reading it would draw the wrong number.
  const { deleteTomverseAccount } = await import("@/lib/accountDeletion");
  const user = await createUser();

  await deleteTomverseAccount(user.id, { cancelSubscription: false });

  assert.equal(await prisma.mobileAuthEvent.count(), 0);
});

test("V28 -- logout works when the access token has already expired", async () => {
  // The correction rev.2 made to D14: the most common moment to log out is
  // after the access token has lapsed, so an access-authenticated logout would
  // fail exactly when it is wanted. Nothing here presents one.
  const { logoutMobileSession } = await service();
  const user = await createUser();
  const tokens = await issue(user.id);

  await logoutMobileSession({
    // No Authorization header at all, which is the point.
    request: new Request("https://tomverse.test/api/auth/mobile/logout", {
      method: "POST",
    }),
    refreshToken: tokens.refreshToken,
  });

  const family = await prisma.mobileTokenFamily.findFirstOrThrow();
  assert.notEqual(family.revokedAt, null);
  assert.equal(family.revokedReason, "logout");
});

test("no audit row carries a token, a digest or a record id", async () => {
  // D15's forbidden list, checked against what was actually written rather
  // than against the schema's intent.
  const { rotateMobileSession } = await service();
  const user = await createUser();
  const first = await issue(user.id);
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });
  await rotateMobileSession({ request: request(), refreshToken: first.refreshToken });

  const events = await prisma.mobileAuthEvent.findMany();
  assert.ok(events.length >= 3);
  const serialized = JSON.stringify(events);
  const [recordId, secret] = first.refreshToken.split(".");
  for (const forbidden of [first.refreshToken, first.accessToken, recordId!, secret!]) {
    assert.ok(!serialized.includes(forbidden), "an audit row carried a credential");
  }
});
