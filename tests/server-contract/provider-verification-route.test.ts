import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Session } from "next-auth";

/**
 * Server-side contract for the STG-R002 admin verification and recovery
 * routes.
 *
 * These endpoints spend real provider money and can clear a provider's failure
 * block, so what matters is what they refuse: a non-admin, an admin without
 * ops:write, a body that never acknowledged the cost, and a recovery that
 * names no verification. Each of those is asserted by driving the real route
 * handler and checking that the provider was never called and the state never
 * changed -- a disabled button in the console proves none of it.
 *
 * CSRF is not asserted here because it is not this handler's job: proxy.ts
 * rejects every cross-origin mutation before a route handler runs. That
 * boundary is covered by tests/goLiveSecurityFixes.test.ts, which is extended
 * alongside this file to pin these two paths as non-exempt.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "provider-verification-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.ADMIN_EMAILS = "ops@tomverse.test,readonly@tomverse.test";
process.env.ADMIN_OPS_EMAILS = "ops@tomverse.test";

type World = {
  session: Session | null;
  /** Every live verification the route actually started. */
  verifications: string[];
  /** Every recovery the route actually attempted. */
  recoveries: Array<{ provider: string; checkId: string }>;
  auditActions: string[];
};

const freshWorld = (): World => ({
  session: null,
  verifications: [],
  recoveries: [],
  auditActions: [],
});

let world = freshWorld();

const adminSession = (email: string): Session => ({
  user: {
    id: `user-${email}`,
    email,
    name: email,
    authenticatedAt: new Date().toISOString(),
  },
  expires: new Date(Date.now() + 3_600_000).toISOString(),
});

const realVerification = require(resolve(ROOT, "lib/providerVerification.ts"));
const realRecovery = require(resolve(ROOT, "lib/providerRecovery.ts"));
const realSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));

mock.module(mod("lib/auth.ts"), {
  namedExports: { authOptions: {} },
});
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => world.session },
});
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    ...realSecurity,
    consumeApiRateLimit: async () => {},
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: {
    writeAdminAuditLog: async ({ action }: { action: string }) => {
      world.auditActions.push(action);
    },
  },
});
mock.module(mod("lib/providerVerification.ts"), {
  namedExports: {
    ...realVerification,
    runProviderVerification: async (provider: string) => {
      world.verifications.push(provider);
      return {
        provider,
        status: "success",
        modelId: "perplexity/sonar",
        latencyMs: 120,
        diagnosticCode: null,
        errorClassification: null,
        message: null,
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    },
    recordVerificationUsage: async () => {},
  },
});
mock.module(mod("lib/providerRecovery.ts"), {
  namedExports: {
    ...realRecovery,
    claimVerificationSlot: async () => ({
      ok: true,
      checkId: "check-1",
      startedAt: new Date(),
    }),
    recordVerificationResult: async () => {},
    getProviderVerificationSummaries: async () => new Map(),
    applyVerifiedRecovery: async ({
      provider,
      checkId,
    }: {
      provider: string;
      checkId: string;
    }) => {
      world.recoveries.push({ provider, checkId });
      return {
        ok: true,
        previousConsecutiveFailures: 5,
        resultingConsecutiveFailures: 0,
        verifiedAt: new Date(),
      };
    },
  },
});

type RouteHandler = (request: Request) => Promise<Response>;

// Imported lazily inside each test: the module mocks above must be installed
// before the route handler pulls in its dependencies, and this file is
// transformed to CJS, where top-level await is unavailable.
const verifyPost = async (): Promise<RouteHandler> =>
  (
    (await import(mod("app/api/admin/provider-health/verify/route.ts"))) as {
      POST: RouteHandler;
    }
  ).POST;
const recoverPost = async (): Promise<RouteHandler> =>
  (
    (await import(mod("app/api/admin/provider-health/recover/route.ts"))) as {
      POST: RouteHandler;
    }
  ).POST;

const postJson = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("an anonymous caller cannot run a verification", async () => {
  world = freshWorld();
  const response = await (await verifyPost())(
    postJson("https://tomverse.test/api/admin/provider-health/verify", {
      provider: "perplexity",
      acknowledgeProviderCost: true,
    })
  );
  assert.equal(response.status, 404);
  assert.deepEqual(world.verifications, []);
});

test("an admin without ops:write cannot run a verification", async () => {
  world = freshWorld();
  world.session = adminSession("readonly@tomverse.test");
  const response = await (await verifyPost())(
    postJson("https://tomverse.test/api/admin/provider-health/verify", {
      provider: "perplexity",
      acknowledgeProviderCost: true,
    })
  );
  assert.equal(response.status, 403);
  assert.deepEqual(world.verifications, []);
});

test("a verification without the cost acknowledgement is refused before any provider call", async () => {
  world = freshWorld();
  world.session = adminSession("ops@tomverse.test");
  const response = await (await verifyPost())(
    postJson("https://tomverse.test/api/admin/provider-health/verify", {
      provider: "perplexity",
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(world.verifications, []);
});

test("an unknown provider is refused before any provider call", async () => {
  world = freshWorld();
  world.session = adminSession("ops@tomverse.test");
  const response = await (await verifyPost())(
    postJson("https://tomverse.test/api/admin/provider-health/verify", {
      provider: "not-a-provider",
      acknowledgeProviderCost: true,
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(world.verifications, []);
});

test("an ops admin runs the verification and both audit events are written", async () => {
  world = freshWorld();
  world.session = adminSession("ops@tomverse.test");
  const response = await (await verifyPost())(
    postJson("https://tomverse.test/api/admin/provider-health/verify", {
      provider: "perplexity",
      acknowledgeProviderCost: true,
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(world.verifications, ["perplexity"]);
  assert.deepEqual(world.auditActions, [
    "provider_verification_started",
    "provider_verification_succeeded",
  ]);
});

test("a non-admin cannot recover a provider", async () => {
  world = freshWorld();
  const response = await (await recoverPost())(
    postJson("https://tomverse.test/api/admin/provider-health/recover", {
      provider: "perplexity",
      checkId: "check-1",
    })
  );
  assert.equal(response.status, 404);
  assert.deepEqual(world.recoveries, []);
});

test("an admin without ops:write cannot recover a provider", async () => {
  world = freshWorld();
  world.session = adminSession("readonly@tomverse.test");
  const response = await (await recoverPost())(
    postJson("https://tomverse.test/api/admin/provider-health/recover", {
      provider: "perplexity",
      checkId: "check-1",
    })
  );
  assert.equal(response.status, 403);
  assert.deepEqual(world.recoveries, []);
});

test("a recovery naming no verification is refused by schema, never reaching the state", async () => {
  world = freshWorld();
  world.session = adminSession("ops@tomverse.test");
  const response = await (await recoverPost())(
    postJson("https://tomverse.test/api/admin/provider-health/recover", {
      provider: "perplexity",
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(world.recoveries, []);
  assert.deepEqual(world.auditActions, []);
});

test("a successful recovery is audited with the before and after failure counts", async () => {
  world = freshWorld();
  world.session = adminSession("ops@tomverse.test");
  const response = await (await recoverPost())(
    postJson("https://tomverse.test/api/admin/provider-health/recover", {
      provider: "perplexity",
      checkId: "check-1",
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    previousConsecutiveFailures: number;
    resultingConsecutiveFailures: number;
  };
  assert.equal(body.previousConsecutiveFailures, 5);
  assert.equal(body.resultingConsecutiveFailures, 0);
  assert.deepEqual(world.recoveries, [
    { provider: "perplexity", checkId: "check-1" },
  ]);
  assert.deepEqual(world.auditActions, ["provider_recovery_succeeded"]);
});
