import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// STG-R002: the administrator verification and recovery routes driven end to
// end against a real PostgreSQL.
//
// tests/server-contract/provider-verification-route.test.ts already proves the
// routes refuse the wrong caller and call writeAdminAuditLog with the right
// action, but it mocks the audit writer. tests/integration/admin-security.db
// .test.ts proves writeAdminAuditLog persists a hash-chained row. Neither
// joins the two, so "a recovery leaves an audit trail" was asserted in halves.
//
// That join is the claim worth pinning: the audit entry is the only durable
// record that a provider's failure block was cleared, by whom, and against
// which verification. A recovery that silently skipped it would look identical
// to one that worked.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces next-auth for every
// module that imports it.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const PROVIDER = "perplexity";

process.env.ADMIN_EMAILS = "recovery-ops@tomverse.test";
process.env.ADMIN_OPS_EMAILS = "recovery-ops@tomverse.test";
process.env.PERPLEXITY_API_KEY ||= "db-integration-test-key";
// The audit chain only computes an entry hash when a secret is configured;
// set one so the persisted row is the fully-formed shape production writes.
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "provider-recovery-audit-test-key";

// --- session seam ----------------------------------------------------------
let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

// Nothing here may reach a provider. The verification call itself is exercised
// by tests/providerVerification.test.mjs with an injected generate; what this
// file drives is the recovery route, which makes no outbound request at all.
let unexpectedHostCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  unexpectedHostCalls.push(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as Request).url)
  );
  return new Response(null, { status: 204 });
}) as typeof fetch;

type RouteModule = { POST: (request: Request) => Promise<Response> };
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let recoverRoute: RouteModule;
let claimVerificationSlot: (typeof import("@/lib/providerRecovery"))["claimVerificationSlot"];
let recordVerificationResult: (typeof import("@/lib/providerRecovery"))["recordVerificationResult"];

// Imported inside before(): the session mock has to be installed before the
// route module (and its next-auth import) is evaluated.
before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ claimVerificationSlot, recordVerificationResult } = (await import(
    mod("lib/providerRecovery.ts")
  )) as typeof import("@/lib/providerRecovery"));
  recoverRoute = (await import(
    mod("app/api/admin/provider-health/recover/route.ts")
  )) as RouteModule;
});

const resetRecoveryRouteData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog",
      "ProviderHealthCheck",
      "ProviderHealthState",
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await resetRecoveryRouteData();
  unexpectedHostCalls = [];
  sessionOverride = null;
});

after(async () => {
  await resetRecoveryRouteData();
  await prisma.$disconnect();
});

const seedOpsAdmin = async () => {
  const user = await prisma.user.create({
    data: { email: "recovery-ops@tomverse.test", lastLoginAt: new Date() },
  });
  return {
    user,
    session: {
      user: {
        id: user.id,
        email: user.email,
        name: "Recovery Ops",
        authenticatedAt: new Date().toISOString(),
      },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
};

const seedBlockedProvider = (consecutiveFailures = 5) =>
  prisma.providerHealthState.create({
    data: {
      provider: PROVIDER,
      consecutiveFailures,
      // Deliberately stale, matching the incident this feature exists for.
      lastFailureAt: new Date(Date.now() - 38 * 3_600_000),
      lastSuccessAt: null,
    },
  });

/** Records a successful live verification the way the verify route does. */
const seedSuccessfulVerification = async (actorEmail: string) => {
  const claim = await claimVerificationSlot({
    provider: PROVIDER,
    modelId: "perplexity/sonar",
    traceId: randomUUID(),
    actorId: null,
    actorEmail,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("unreachable");
  await recordVerificationResult({
    checkId: claim.checkId,
    result: {
      provider: PROVIDER,
      status: "success",
      modelId: "perplexity/sonar",
      latencyMs: 318,
      diagnosticCode: null,
      errorClassification: null,
      message: null,
      usage: { inputTokens: 6, outputTokens: 2 },
    },
  });
  return claim.checkId;
};

const postRecover = (body: unknown) =>
  recoverRoute.POST(
    new Request("https://tomverse.test/api/admin/provider-health/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("a successful recovery clears the block and leaves an audit row naming its evidence", async () => {
  const { user, session } = await seedOpsAdmin();
  await seedBlockedProvider(5);
  const checkId = await seedSuccessfulVerification(user.email!);
  sessionOverride = session;

  const response = await postRecover({ provider: PROVIDER, checkId });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    previousConsecutiveFailures: number;
    resultingConsecutiveFailures: number;
    traceId: string;
  };
  assert.equal(payload.previousConsecutiveFailures, 5);
  assert.equal(payload.resultingConsecutiveFailures, 0);

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastRecoveryCheckId, checkId);
  // The load-bearing invariant, re-asserted on the route path: recovery stops
  // expired failures counting as current, it does not invent a success.
  assert.equal(state.lastSuccessAt, null);

  const entries = await prisma.adminAuditLog.findMany({
    where: { action: "provider_recovery_succeeded" },
  });
  assert.equal(entries.length, 1, "expected exactly one audit entry");
  const entry = entries[0]!;
  assert.equal(entry.targetType, "Provider");
  assert.equal(entry.targetId, PROVIDER);
  assert.equal(entry.actorUserId, user.id);
  assert.equal(entry.actorEmail, user.email);
  // Hash-chained like every other admin action, not a bare log line.
  assert.ok(entry.entryHash);

  const metadata = entry.metadata as Record<string, unknown>;
  assert.equal(metadata.provider, PROVIDER);
  assert.equal(metadata.checkId, checkId);
  assert.equal(metadata.previousConsecutiveFailures, 5);
  assert.equal(metadata.resultingConsecutiveFailures, 0);
  assert.equal(metadata.lastSuccessAtModified, false);
  assert.equal(metadata.traceId, payload.traceId);
  assert.ok(typeof metadata.verifiedAt === "string");

  assert.deepEqual(unexpectedHostCalls, [], "recovery must make no outbound call");
});

test("a rejected recovery is audited too, and changes nothing", async () => {
  const { user, session } = await seedOpsAdmin();
  await seedBlockedProvider(4);
  const checkId = await seedSuccessfulVerification(user.email!);
  sessionOverride = session;

  // Consume the evidence, then replay the same request.
  assert.equal((await postRecover({ provider: PROVIDER, checkId })).status, 200);
  await prisma.providerHealthState.update({
    where: { provider: PROVIDER },
    data: { consecutiveFailures: 3, lastFailureAt: new Date() },
  });

  const replay = await postRecover({ provider: PROVIDER, checkId });
  assert.equal(replay.status, 409);
  const body = (await replay.json()) as { reason: string };
  assert.equal(body.reason, "VERIFICATION_ALREADY_CONSUMED");

  const rejected = await prisma.adminAuditLog.findMany({
    where: { action: "provider_recovery_rejected" },
  });
  assert.equal(rejected.length, 1, "a refused recovery must still be auditable");
  assert.equal(
    (rejected[0]!.metadata as Record<string, unknown>).reason,
    "VERIFICATION_ALREADY_CONSUMED"
  );

  // The new block raised after the first recovery is untouched by the replay.
  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 3);
});

test("a non-admin recovery attempt writes no audit entry at all", async () => {
  await seedBlockedProvider(5);
  const { user } = await seedOpsAdmin();
  const checkId = await seedSuccessfulVerification(user.email!);
  sessionOverride = null;

  const response = await postRecover({ provider: PROVIDER, checkId });
  assert.equal(response.status, 404);

  assert.equal(await prisma.adminAuditLog.count(), 0);
  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 5);
  const check = await prisma.providerHealthCheck.findUniqueOrThrow({
    where: { id: checkId },
  });
  assert.equal(check.recoveryApplied, false);
});

test("no audit entry claims a recovery that the state does not show", async () => {
  // Every provider_recovery_succeeded entry must correspond to a real cleared
  // block. This walks the entries rather than trusting the single happy path
  // above, so a future change that logs first and writes later is caught.
  const { user, session } = await seedOpsAdmin();
  await seedBlockedProvider(7);
  const checkId = await seedSuccessfulVerification(user.email!);
  sessionOverride = session;
  await postRecover({ provider: PROVIDER, checkId });

  const succeeded = await prisma.adminAuditLog.findMany({
    where: { action: "provider_recovery_succeeded" },
  });
  for (const entry of succeeded) {
    const metadata = entry.metadata as Record<string, unknown>;
    const consumed = await prisma.providerHealthCheck.findUniqueOrThrow({
      where: { id: String(metadata.checkId) },
    });
    assert.equal(consumed.recoveryApplied, true);
    assert.equal(consumed.status, "success");
    assert.equal(
      consumed.previousConsecutiveFailures,
      metadata.previousConsecutiveFailures
    );
  }
});
