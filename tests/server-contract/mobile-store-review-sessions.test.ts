import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const now = new Date();
const email = "play-review-sessions@tomverse.app";
const config = { submissionId: "synthetic-review-sessions", userId: "review-user", email, appId: "app.tomverse.shell", buildNumber: 16,
  plan: "Max", state: "in_review", validUntil: new Date(now.getTime() + 86400000).toISOString(), salt: "a".repeat(64), codeHash: "0".repeat(64) };
let user: { email: string; accountStatus: string; sessionsRevokedAt: null; plan: string; subscriptionStatus: string; subscriptionCurrentPeriodEnd: Date | null };
let snapshotReads = 0;
let secretMatches = true;
const writes: { table: string; data: Record<string, unknown> }[] = [];
const family = () => ({ id: "family", userId: "review-user", deviceId: "device", createdAt: now, lastRotatedAt: now,
  absoluteExpiresAt: new Date(now.getTime() + 86400000), revokedAt: null, device: { revokedAt: null }, user });
const db = {
  mobileTokenFamily: {
    findUnique: async () => { snapshotReads++; return family(); },
    updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ table: "family", data }); return { count: 1 }; },
  },
  mobileRefreshRotation: {
    findUnique: async () => ({ id: "rotation", familyId: "family", pepperKid: "synthetic", secretDigest: "synthetic-digest",
      expiresAt: new Date(now.getTime() + 86400000), consumedAt: null, invalidatedAt: null, family: family() }),
    updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ table: "rotation", data }); return { count: 1 }; },
  },
  mobileAuthEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ table: "audit", data }); } },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) } } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { consumeApiRateLimit: async () => {} } });
mock.module(mod("lib/securityAudit.ts"), { namedExports: { logSecurityAuditEvent: () => {} } });
mock.module(mod("lib/mobileAccessToken.ts"), { namedExports: { mintMobileAccessToken: () => { throw Error("Must not mint after review expiry"); } } });
mock.module(mod("lib/mobileRefreshToken.ts"), { namedExports: {
  parseMobileRefreshToken: () => ({ recordId: "rotation", secret: "synthetic" }),
  mobileRefreshSecretMatches: () => secretMatches,
  mintMobileRefreshToken: () => { throw Error("Must not mint after review expiry"); },
} });
let authorization: typeof import("../../lib/mobileSessionAuthorization");
let service: typeof import("../../lib/mobileAuthService");
before(async () => { authorization = await import("../../lib/mobileSessionAuthorization"); service = await import("../../lib/mobileAuthService"); });
beforeEach(() => {
  authorization.resetMobileSessionSnapshotsForTesting(); snapshotReads = 0; writes.length = 0; secretMatches = true;
  process.env.MOBILE_STORE_REVIEW_ENABLED = "true";
  process.env.MOBILE_STORE_REVIEW_CREDENTIAL_JSON = JSON.stringify(config);
  user = { email, accountStatus: "active", sessionsRevokedAt: null, plan: "Max", subscriptionStatus: "mobile_store_review", subscriptionCurrentPeriodEnd: new Date(now.getTime() + 1000) };
});
const identity = { subject: "review-user", device: "device", family: "family", tokenId: "synthetic", issuedAtSeconds: Math.floor(now.getTime() / 1000), expiresAtSeconds: Math.floor(now.getTime() / 1000) + 600 };

test("a cached bearer snapshot stops authorizing at the review plan expiry", async () => {
  assert.equal((await authorization.authorizeMobileSession(identity, now)).ok, true);
  assert.deepEqual(await authorization.authorizeMobileSession(identity, new Date(now.getTime() + 1000)), { ok: false, refusal: "account_not_active" });
  assert.equal(snapshotReads, 1, "expiry must be checked even when the database snapshot is cached");
});
test("closing or disabling review configuration rejects an already cached session", async () => {
  assert.equal((await authorization.authorizeMobileSession(identity, now)).ok, true);
  process.env.MOBILE_STORE_REVIEW_CREDENTIAL_JSON = JSON.stringify({ ...config, state: "accepted" });
  assert.equal((await authorization.authorizeMobileSession(identity, now)).ok, false);
  delete process.env.MOBILE_STORE_REVIEW_ENABLED;
  assert.equal((await authorization.authorizeMobileSession(identity, now)).ok, false);
  assert.equal(snapshotReads, 1);
});
test("ordinary manual Max accounts retain their existing authorization behavior", async () => {
  delete process.env.MOBILE_STORE_REVIEW_ENABLED;
  user.email = "ordinary@example.invalid"; user.subscriptionStatus = "manually_adjusted"; user.subscriptionCurrentPeriodEnd = null;
  assert.equal((await authorization.authorizeMobileSession(identity, now)).ok, true);
});
test("expired review refresh revokes the family and outstanding rotations before refusing", async () => {
  const expiredAt = new Date(now.getTime() + 1000);
  assert.deepEqual(await service.rotateMobileSession({ request: new Request("https://tomverse.app/api/auth/mobile/refresh"), refreshToken: "synthetic", now: expiredAt }), { ok: false, reason: "store_review_ended" });
  assert.equal(writes[0].table, "family"); assert.equal(writes[0].data.revokedReason, "logout");
  assert.deepEqual(writes[0].data.revokedAt, expiredAt);
  assert.deepEqual(writes[0].data.epoch, { increment: 1 });
  assert.equal(writes[1].table, "rotation"); assert.deepEqual(writes[1].data.invalidatedAt, expiredAt);
  assert.ok(writes.some(write => write.table === "audit" && write.data.reason === "store_review_ended"));
});
test("a wrong refresh secret cannot revoke a review family even after expiry", async () => {
  secretMatches = false;
  assert.deepEqual(await service.rotateMobileSession({ request: new Request("https://tomverse.app/api/auth/mobile/refresh"), refreshToken: "synthetic", now: new Date(now.getTime() + 1000) }), { ok: false, reason: "secret_mismatch" });
  assert.ok(writes.every(write => write.table === "audit"));
});
