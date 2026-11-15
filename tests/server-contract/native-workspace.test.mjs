import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { nativeParityBearerRoute, nativeWorkspaceBearerRoute } from "../../lib/nativeBearerGate.ts";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let cookies = 0, work = 0, rateLimited = false, active = true;
let cookieOwner = "cookie-owner";
let profilesEnabled = true, knowledgeEnabled = true, importsEnabled = true;
process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
const owner = "native-owner";
const account = userId => { assert.equal(userId, owner); work++; };
mock.module("next-auth/next", { namedExports: { getServerSession: async () => { cookies++; return { user: { id: cookieOwner } }; } } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
const afterCallbacks = [];
mock.module("next/server", { namedExports: { NextResponse: { json: Response.json }, after: callback => afterCallbacks.push(callback) } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  mobileAuthRefusal: code => Response.json({ code }, { status: 401 }),
  requireMobileBearer: async req => req.headers.get("authorization") === "Bearer valid" ?
    { ok: true, identity: { userId: owner } } : { ok: false, response: Response.json({ code: "MOBILE_TOKEN_INVALID" }, { status: 401 }) },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  user: { findUnique: async ({ where }) => ({ id: where.id, accountStatus: active ? "active" : "suspended" }) },
  // Use the real profile reader below, including its owner-scoped query and 404.
  assistantProfile: { findFirst: async ({ where }) => { account(where.userId); return null; } },
} } });
const security = await import("../../lib/apiSecurity.ts");
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...security, consumeApiRateLimit: async (_req, userId) => {
  assert.equal(userId, owner);
  if (rateLimited) throw new security.ApiSecurityError(429, "API_RATE_LIMITED", "Limited", 30);
} } });
class Disabled extends Error {}
mock.module(mod("lib/appSettings.ts"), { namedExports: {
  AssistantProfilesDisabledError: Disabled, ExternalImportDisabledError: Disabled, ExternalContinuationDisabledError: Disabled,
  isAssistantProfilesEnabled: async () => profilesEnabled,
  isAssistantKnowledgeEnabled: async () => profilesEnabled && knowledgeEnabled,
  isExternalImportEnabled: async () => importsEnabled,
  getOperationalFeatureFlags: async () => ({ attachmentsEnabled: true }),
  isAssistantPackageImportEnabled: async () => false,
  isImageGenerationEnabledCached: async () => false,
  isExternalContinuationEnabledCached: async () => true,
  assertExternalImportEnabled: async () => { if (!importsEnabled) throw new Disabled(); },
  assertExternalContinuationEnabled: async () => {},
} });
mock.module(mod("lib/assistantProfileModels.ts"), { namedExports: { resolveProfileModelIds: async ids => ids ?? [] } });
const profileService = await import("../../lib/assistantProfileService.ts");
mock.module(mod("lib/assistantProfileService.ts"), { namedExports: { ...profileService,
  listAssistantProfiles: async userId => { account(userId); return []; },
  createAssistantProfile: async input => { account(input.userId); return { id: "profile" }; },
  updateAssistantProfileIdentity: async input => { account(input.userId); return { id: input.profileId }; },
  publishAssistantProfileVersion: async input => { account(input.userId); return { outcome: "published", revision: 2 }; },
} });
const knowledgeService = await import("../../lib/assistantKnowledgeService.ts");
mock.module(mod("lib/assistantKnowledgeService.ts"), { namedExports: { ...knowledgeService,
  listKnowledgeFiles: async userId => { account(userId); return []; },
  knowledgeCapacity: async userId => { account(userId); return { remaining: { filesInProfile: 2 } }; },
  finalizeKnowledgeUpload: async input => { account(input.userId); return { id: "file", name: input.filename, processingStatus: "pending" }; },
} });
mock.module(mod("lib/assistantKnowledgeProcessor.ts"), { namedExports: { processKnowledgeFile: async () => { throw Error("No background execution in contract tests"); } } });
mock.module(mod("lib/externalImportMetrics.ts"), { namedExports: { recordExternalImportCounter: async () => {} } });
mock.module(mod("lib/memoryExtractionAuto.ts"), { namedExports: { startAutomaticMemoryExtraction: async () => { throw Error("No model calls in contract tests"); } } });
mock.module(mod("lib/memoryExtractionWorker.ts"), { namedExports: { kickMemoryExtractionRun: async () => { throw Error("No model calls in contract tests"); } } });
const record = input => { account(input.userId); return { idempotentReplay: true }; };
mock.module(mod("lib/externalImportService.ts"), { namedExports: {
  createExternalImport: async input => { account(input.userId); return { id: "import", status: "staging" }; },
  listExternalImports: async userId => { account(userId); return []; },
  getExternalImportCapacity: async userId => { account(userId); return { remaining: {} }; },
  appendExternalImportBatch: async input => { account(input.userId); return { results: [] }; },
  sealExternalImport: async input => record(input), finalizeExternalImport: async input => record(input),
  listExternalConversations: async userId => { account(userId); return { conversations: [], total: 0 }; },
  getExternalConversation: async userId => { account(userId); return { id: "source", messages: [] }; },
  deleteExternalConversationSnapshot: async () => { throw Error("Deletion is not enrolled"); },
  previewExternalSourceDeletion: async userId => { account(userId); return {}; },
  previewContinuationTitleImpact: async userId => { account(userId); return {}; },
} });
mock.module(mod("lib/externalContinuationService.ts"), { namedExports: { createExternalContinuation: async input => { account(input.userId); assert.equal(input.productKey, "chat"); return { conversationId: "continued", idempotentReplay: true }; } } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async userId => { assert.equal(userId, owner); return { tier: "Free", allowAttachments: true }; }, effectivePlanModelLimit: () => 1, planAllowsFeature: () => false } });
mock.module(mod("lib/modelCatalog.ts"), { namedExports: { refreshImageModelCatalog: async () => [] } });
mock.module(mod("lib/chatImageIntent.ts"), { namedExports: { chatImageTriageModelId: async () => null } });
mock.module(mod("lib/reviewRouting.ts"), { namedExports: { reviewEasyEnabled: () => true } });

const profiles = await import("../../app/api/assistant-profiles/route.ts");
const profile = await import("../../app/api/assistant-profiles/[profileId]/route.ts");
const versions = await import("../../app/api/assistant-profiles/[profileId]/versions/route.ts");
const knowledge = await import("../../app/api/assistant-profiles/[profileId]/knowledge/route.ts");
const imports = await import("../../app/api/imports/external/route.ts");
const capacity = await import("../../app/api/imports/external/capacity/route.ts");
const batches = await import("../../app/api/imports/external/[importId]/batches/route.ts");
const seal = await import("../../app/api/imports/external/[importId]/seal/route.ts");
const finalize = await import("../../app/api/imports/external/[importId]/finalize/route.ts");
const sources = await import("../../app/api/external-conversations/route.ts");
const source = await import("../../app/api/external-conversations/[conversationId]/route.ts");
const continuation = await import("../../app/api/external-conversations/[conversationId]/continuations/route.ts");
const capabilities = await import("../../app/api/products/mobile/capabilities/route.ts");
const { resolveChatRouteSession } = await import("../../lib/chatRouteSession.ts");
const context = { params: Promise.resolve({ profileId: "foreign", importId: "import", conversationId: "source" }) };
const cases = [
  ["/api/assistant-profiles", "POST", profiles.POST, { name: "Guide", instructions: "Help me", modelIds: [] }, 201],
  ["/api/assistant-profiles/foreign", "GET", profile.GET, null, 404],
  ["/api/assistant-profiles/foreign", "PATCH", profile.PATCH, { name: "Renamed" }, 200],
  ["/api/assistant-profiles/foreign/versions", "POST", versions.POST, { expectedRevision: 1, instructions: "Help", modelIds: [], toolPolicy: { webSearch: false, deepResearch: false }, memoryPolicy: { useAccountMemory: false }, starters: [], knowledgeFileIds: [] }, 201],
  ["/api/assistant-profiles/foreign/knowledge", "GET", knowledge.GET, null, 200],
  ["/api/assistant-profiles/foreign/knowledge", "POST", knowledge.POST, { action: "finalize", uploadKey: "key", filename: "guide.txt", mime: "text/plain" }, 201],
  ["/api/imports/external", "POST", imports.POST, { provider: "chatgpt", parserVersion: "fixture" }, 201],
  ["/api/imports/external/capacity", "GET", capacity.GET, null, 200],
  ["/api/imports/external/import/batches", "POST", batches.POST, { sequence: 0, conversations: [{ rawExternalConversationId: "one", title: "One", messages: [{ rawExternalMessageId: "m", role: "user", ordinal: 0, content: "Hello" }] }] }, 200],
  ["/api/imports/external/import/seal", "POST", seal.POST, { finalSequence: 0, expectedStagedConversationIds: [], expectedDuplicateCount: 0 }, 200],
  ["/api/imports/external/import/finalize", "POST", finalize.POST, { idempotencyKey: "attempt", selectedConversationIds: ["staged"] }, 200],
  ["/api/external-conversations", "GET", sources.GET, null, 200],
  ["/api/external-conversations/source", "GET", source.GET, null, 200],
  ["/api/external-conversations/source/continuations", "POST", continuation.POST, { idempotencyKey: "00000000-0000-4000-8000-000000000000" }, 200],
];
const request = (path, method, body, authorization = "Bearer valid", origin = "capacitor://localhost") => new Request("https://tomverse.app" + path, {
  method, headers: { authorization, origin, cookie: "another-account", "content-type": "application/json" },
  ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});
const enable = () => { for (const key of ["CHAT", "PARITY", "WORKSPACE"]) process.env[`TOMVERSE_NATIVE_${key}_ENABLED`] = "true"; };

test("workspace enrollment is exact, default off and excludes other methods and resources", () => {
  for (const [path, method] of cases) {
    assert.equal(nativeWorkspaceBearerRoute(path, method), false);
    assert.equal(nativeParityBearerRoute(path, method, true), false);
    assert.equal(nativeParityBearerRoute(path, method, false, true), false);
    assert.equal(nativeParityBearerRoute(path, method, true, true), true);
  }
  for (const [path, method] of [["/api/assistant-profiles/foreign", "DELETE"], ["/api/assistant-profiles/imports", "POST"], ["/api/assistant-profiles/imports", "GET"], ["/api/assistant-profiles/imports/knowledge", "GET"], ["/api/assistant-profiles/foreign/versions", "GET"], ["/api/assistant-profiles/foreign/knowledge/file", "DELETE"], ["/api/imports/external/export", "GET"], ["/api/imports/external/import", "DELETE"], ["/api/external-conversations/source", "DELETE"], ["/api/external-conversations/source/lock/verify", "POST"], ["/api/external-conversations/source/continuations/extra", "POST"], ["/api/external-conversations/source%2Fother", "GET"]]) {
    assert.equal(nativeWorkspaceBearerRoute(path, method, true), false, path);
  }
});

test("every enrolled handler rejects disabled rollout, invalid bearer and hostile origin before data work", async () => {
  enable(); const before = work;
  for (const [path, method, fn, body] of cases) {
    for (const flag of ["WORKSPACE", "PARITY", "CHAT"]) {
      process.env[`TOMVERSE_NATIVE_${flag}_ENABLED`] = "false";
      assert.ok([401, 503].includes((await fn(request(path, method, body), context)).status), `${path} ${flag}`);
      enable();
    }
    assert.equal((await fn(request(path, method, body, "Bearer invalid"), context)).status, 401, path);
    assert.equal((await fn(request(path, method, body, "Bearer valid", "https://hostile.invalid"), context)).status, 401, path);
  }
  active = false;
  try { assert.equal((await profiles.POST(request(cases[0][0], "POST", cases[0][3]))).status, 401); }
  finally { active = true; }
  assert.equal(work, before); assert.equal(cookies, 0);
});

test("the bearer owner reaches every existing service without borrowing the different web cookie", async () => {
  enable();
  for (const [path, method, fn, body, status] of cases) assert.equal((await fn(request(path, method, body), context)).status, status, path);
  assert.equal(cookies, 0);
  // Reference-file processing is scheduled through the existing after hook, never run by this test.
  assert.equal(afterCallbacks.length, 1);
});

test("real profile and knowledge ownership checks refuse foreign ids before content or upload work", async () => {
  const response = await knowledge.POST(request("/api/assistant-profiles/foreign/knowledge", "POST", { action: "prepare", filename: "guide.txt", mime: "text/plain", bytes: 10 }), context);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "ASSISTANT_PROFILE_NOT_FOUND");
  assert.equal((await profile.GET(request("/api/assistant-profiles/foreign", "GET"), context)).status, 404);
  assert.equal(cookies, 0);
});

test("existing payload limits, rate limits and feature switches still refuse native writes", async () => {
  const before = work;
  const path = "/api/assistant-profiles";
  assert.equal((await profiles.POST(request(path, "POST", { name: "Guide", instructions: "x".repeat(9000) }))).status, 413);
  rateLimited = true;
  try { const response = await imports.POST(request("/api/imports/external", "POST", cases[6][3])); assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "30"); }
  finally { rateLimited = false; }
  profilesEnabled = false;
  try { assert.equal((await profiles.POST(request(path, "POST", cases[0][3]))).status, 403); }
  finally { profilesEnabled = true; }
  importsEnabled = false;
  try { assert.equal((await capacity.GET(request("/api/imports/external/capacity", "GET"))).status, 403); }
  finally { importsEnabled = true; }
  assert.equal(work, before);
});

test("capabilities advertise only enrolled and enabled workspace features", async () => {
  const read = async () => (await capabilities.GET(request("/api/products/mobile/capabilities", "GET"))).json();
  assert.equal((await read()).generatedFileRevisions, true);
  assert.deepEqual((await read()).workspace, { assistantEditing: true, assistantKnowledge: true, externalImport: true });
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "false";
  try {
    const value = await read();
    assert.equal(value.generatedFileRevisions, false);
    assert.deepEqual(value.workspace, { assistantEditing: true, assistantKnowledge: true, externalImport: true });
  } finally { process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true"; }
  knowledgeEnabled = false;
  try { assert.equal((await read()).workspace.assistantKnowledge, false); }
  finally { knowledgeEnabled = true; }
  cookieOwner = owner;
  for (const flag of ["WORKSPACE", "CHAT", "PARITY"]) {
    process.env[`TOMVERSE_NATIVE_${flag}_ENABLED`] = "false";
    // Cookie probes remain readable with the native gates off; availability stays false.
    const req = new Request("https://tomverse.app/api/products/mobile/capabilities");
    const response = await capabilities.GET(req);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.generatedFileRevisions, true);
    assert.deepEqual(value.workspace, { assistantEditing: false, assistantKnowledge: false, externalImport: false });
    enable();
  }
  cookieOwner = "cookie-owner";
});

test("workspace and generated-file revision authentication switches remain independent", async () => {
  process.env.TOMVERSE_NATIVE_WORKSPACE_ENABLED = "false";
  try {
    const revision = await resolveChatRouteSession(request("/api/artifacts/file/versions", "GET"));
    assert.equal(revision.session?.user.id, owner);
    assert.equal((await resolveChatRouteSession(request("/api/imports/external/capacity", "GET"))).response.status, 503);
    enable();
    process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "false";
    assert.equal((await resolveChatRouteSession(request("/api/artifacts/file/versions", "GET"))).response.status, 503);
    const workspace = await resolveChatRouteSession(request("/api/imports/external/capacity", "GET"));
    assert.equal(workspace.session?.user.id, owner);
  } finally { enable(); process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true"; }
});

test("web handlers keep using their cookie owner while native workspace access is off", async () => {
  cookieOwner = owner;
  process.env.TOMVERSE_NATIVE_WORKSPACE_ENABLED = "false";
  try {
    for (const [path, method, fn, body, status] of cases) {
      const req = request(path, method, body);
      req.headers.delete("authorization");
      assert.equal((await fn(req, context)).status, status, path);
    }
  } finally { cookieOwner = "cookie-owner"; enable(); }
});
