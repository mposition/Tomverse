import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const commit = "a".repeat(40);
const deployment = "11111111-1111-4111-8111-111111111111";
const body = { runtimeCommitSha: commit, runtimeDeploymentId: deployment,
  confirmation: "ACTIVATE_EXACT_GUEST_CHAT_SMART_ADAPTIVE_DEPLOYMENT" };

let session, role, recentAuthError, originValid, release, readCount,
  activateCount, rateLimitCalls, activationError;

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), {
  namedExports: {
    isAdminSession: (value) => Boolean(value?.user?.id),
    getAdminRole: () => role,
  },
});
mock.module(mod("lib/adminReauthentication.ts"), {
  namedExports: {
    assertRecentAdminAuthentication: async () => {
      if (recentAuthError) throw recentAuthError;
    },
    isAdminReauthenticationError: (error) => error === recentAuthError,
  },
});
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    apiSecurityResponse: () => null,
    consumeApiRateLimit: async (...args) => { rateLimitCalls.push(args); },
    readLimitedJson: async () => body,
  },
});
mock.module(mod("lib/requestOrigin.ts"), {
  namedExports: { hasValidMutationOrigin: () => originValid },
});
mock.module(mod("lib/guestChatSmartAdaptiveRelease.ts"), {
  namedExports: {
    GUEST_CHAT_SMART_ADAPTIVE_WRITER_ENV:
      "GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_WRITE_ENABLED",
  },
});
mock.module(mod("lib/guestChatSmartAdaptiveReleaseStore.ts"), {
  namedExports: {
    readGuestChatSmartAdaptiveRelease: async () => {
      readCount += 1;
      return release;
    },
    activateGuestChatSmartAdaptiveRelease: async (input) => {
      activateCount += 1;
      if (activationError) throw activationError;
      return { activationPairDigest: "b".repeat(64),
        binding: { runtimeCommitSha: input.runtimeCommitSha,
          runtimeDeploymentId: input.runtimeDeploymentId } };
    },
  },
});

const route = await import(mod(
  "app/api/admin/prompt-refiner/guest-chat-auto-activation/route.ts"
));

const request = () => new Request(
  "https://tomverse.test/api/admin/prompt-refiner/guest-chat-auto-activation",
  { method: "POST", headers: { "content-type": "application/json",
    origin: "https://tomverse.test" }, body: JSON.stringify(body) },
);

test.beforeEach(() => {
  session = { user: { id: "owner-a", role: "admin" } };
  role = "owner";
  recentAuthError = null;
  originValid = true;
  release = { activationPairDigest: "c".repeat(64),
    binding: { runtimeCommitSha: commit, runtimeDeploymentId: deployment } };
  readCount = 0;
  activateCount = 0;
  rateLimitCalls = [];
  activationError = null;
  process.env.GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_WRITE_ENABLED = "1";
});

test.after(() => {
  delete process.env.GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_WRITE_ENABLED;
});

test("Owner readback is private, exact and does not require a write authentication", async () => {
  const response = await route.GET(new Request(
    "https://tomverse.test/api/admin/prompt-refiner/guest-chat-auto-activation"
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { release });
  assert.equal(readCount, 1);
  assert.equal(activateCount, 0);
  assert.equal(rateLimitCalls[0][2],
    "admin-guest-chat-smart-adaptive-activation-read");
});

test("readback conceals the route from guests and refuses non-owner administrators", async () => {
  session = null;
  assert.equal((await route.GET(new Request("https://tomverse.test"))).status, 404);
  role = "admin";
  session = { user: { id: "admin-a", role: "admin" } };
  assert.equal((await route.GET(new Request("https://tomverse.test"))).status, 403);
  assert.equal(readCount, 0);
});

test("exact activation requires origin, recent Owner authentication and the writer", async () => {
  originValid = false;
  assert.equal((await route.POST(request())).status, 403);
  originValid = true;
  recentAuthError = new Error("reauth");
  const stale = await route.POST(request());
  assert.equal(stale.status, 428);
  assert.equal((await stale.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  recentAuthError = null;
  delete process.env.GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_WRITE_ENABLED;
  assert.equal((await route.POST(request())).status, 409);
  assert.equal(activateCount, 0);
});

test("Owner activation binds only the submitted exact runtime tuple", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.binding.runtimeCommitSha, commit);
  assert.equal(result.binding.runtimeDeploymentId, deployment);
  assert.equal(activateCount, 1);
  assert.equal(rateLimitCalls.at(-1)[2],
    "admin-guest-chat-smart-adaptive-activation");
});

test("unknown activation outcome stops without retry authority", async () => {
  activationError = new Error("connection_lost");
  const response = await route.POST(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_OUTCOME_UNKNOWN",
    retryAuthorized: false,
    humanReviewRequired: true,
  });
  assert.equal(activateCount, 1);
});
