import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { deleteScheduledAccounts } from "@/lib/maintenance";

after(async () => { await prisma.$disconnect(); });

test("account deletion preserves encrypted Apple credentials until token revocation succeeds", async () => {
  const keys = ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY", "OAUTH_TOKEN_ENCRYPTION_KEY", "NEXTAUTH_SECRET"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@apple-delete.example.test` } });
  try {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    Object.assign(process.env, { APPLE_ID: "app.tomverse.signin", APPLE_TEAM_ID: "ABCDEFGHIJ", APPLE_KEY_ID: "1234567890", APPLE_PRIVATE_KEY: key.export({ type: "pkcs8", format: "pem" }).toString(), OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-apple-token-encryption-secret-long-enough", NEXTAUTH_SECRET: "synthetic-apple-deletion-auth-secret-long-enough" });
    const account = encryptOAuthAccountTokens({ userId: user.id, provider: "apple", providerAccountId: randomUUID(), type: "oauth", refresh_token: "private-test-refresh" });
    assert.notEqual(account.refresh_token, "private-test-refresh");
    await prisma.account.create({ data: account });
    let status = 503, calls = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://appleid.apple.com/auth/revoke");
      assert.ok(await prisma.user.findUnique({ where: { id: user.id } }));
      const body = init!.body as URLSearchParams;
      assert.equal(body.get("token"), "private-test-refresh");
      assert.equal(body.get("token_type_hint"), "refresh_token");
      calls++; return new Response(null, { status });
    };
    await assert.rejects(deleteTomverseAccount(user.id, { cancelSubscription: false }), /APPLE_TOKEN_REVOCATION_FAILED/);
    assert.equal(await prisma.account.count({ where: { userId: user.id } }), 1);
    assert.ok(await prisma.user.findUnique({ where: { id: user.id } }));
    status = 200;
    assert.equal((await deleteTomverseAccount(user.id, { cancelSubscription: false })).deleted, true);
    assert.equal(await prisma.account.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.user.findUnique({ where: { id: user.id } }), null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.user.deleteMany({ where: { id: user.id } });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("scheduled Apple deletion releases a failed claim, continues the batch and retries without losing the deadline", async () => {
  const keys = ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY", "OAUTH_TOKEN_ENCRYPTION_KEY", "NEXTAUTH_SECRET"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const deadline = new Date(Date.now() - 60_000);
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@apple-scheduled.example.test`, accountStatus: "pending_deletion", accountDeletionScheduledFor: deadline } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@ordinary-scheduled.example.test`, accountStatus: "pending_deletion", accountDeletionScheduledFor: new Date(deadline.getTime() + 1000) } });
  try {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    Object.assign(process.env, { APPLE_ID: "app.tomverse.signin", APPLE_TEAM_ID: "ABCDEFGHIJ", APPLE_KEY_ID: "1234567890", OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-scheduled-apple-encryption-key", NEXTAUTH_SECRET: "synthetic-scheduled-deletion-secret-long-enough" });
    delete process.env.APPLE_PRIVATE_KEY;
    await prisma.account.create({ data: encryptOAuthAccountTokens({ userId: user.id, provider: "apple", providerAccountId: randomUUID(), type: "oauth", refresh_token: "private-scheduled-refresh" }) });
    let status = 503;
    globalThis.fetch = async url => { assert.equal(String(url), "https://appleid.apple.com/auth/revoke"); return new Response(null, { status }); };
    assert.equal(await deleteScheduledAccounts(new Date()), 1);
    assert.equal(await prisma.user.findUnique({ where: { id: other.id } }), null);
    process.env.APPLE_PRIVATE_KEY = key;
    assert.equal(await deleteScheduledAccounts(new Date()), 0);
    const pending = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(pending.accountStatus, "pending_deletion");
    assert.equal(pending.accountDeletionScheduledFor?.getTime(), deadline.getTime());
    assert.equal(await prisma.account.count({ where: { userId: user.id } }), 1);
    status = 200;
    assert.equal(await deleteScheduledAccounts(new Date()), 1);
    assert.equal(await prisma.user.findUnique({ where: { id: user.id } }), null);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
