import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { CHAT_MAX_ATTACHMENT_BYTES } from "../../lib/chatAttachmentLimits.ts";

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.NEXTAUTH_SECRET ||= "generated-artifact-copy-route-contract";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
const api = require(resolve(root, "lib/apiSecurity.ts")) as typeof import("../../lib/apiSecurity");
const billing = require(resolve(root, "lib/billingEntitlements.ts")) as typeof import("../../lib/billingEntitlements");
const revision = require(resolve(root, "lib/generatedArtifactRevision.ts")) as typeof import("../../lib/generatedArtifactRevision");
const settings = require(resolve(root, "lib/appSettings.ts")) as typeof import("../../lib/appSettings");
let session: { user: { id: string; email: string } } | null;
let attachmentsEnabled: boolean, allowAttachments: boolean, rateFailure: boolean, quotaFailure: boolean;
let copyFailure: Error | null;
let copies: Array<Record<string, unknown>>, rateScopes: string[], reservations: number[];
let networkCalls = 0;
const result = { uploadId: "opaque-copy-upload", name: "exact.txt", mediaType: "text/plain", size: 17, kind: "text" };
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session }) } });
mock.module(mod("lib/appSettings.ts"), { namedExports: { ...settings, getOperationalFeatureFlags: async () => ({ attachmentsEnabled }) } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { ...billing, getUserBillingPlan: async () => ({ allowAttachments }) } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  ...api,
  consumeApiRateLimit: async (_req: Request, _userId: string, scope: string) => {
    rateScopes.push(scope);
    if (rateFailure) throw new api.ApiSecurityError(429, "API_RATE_LIMITED", "synthetic rate limit");
  },
  reserveDailyUploadBytes: async (_userId: string, bytes: number) => {
    reservations.push(bytes);
    if (quotaFailure) throw new api.ApiSecurityError(429, "UPLOAD_STORAGE_QUOTA_EXCEEDED", "synthetic quota");
  },
} });
mock.module(mod("lib/generatedArtifactRevision.ts"), { namedExports: {
  ...revision,
  copyGeneratedArtifactForRevision: async (input: Record<string, unknown>) => {
    copies.push(input);
    if (copyFailure) throw copyFailure;
    await (input.reserveBytes as (bytes: number) => Promise<void>)(result.size);
    return result;
  },
} });
globalThis.fetch = (async () => { networkCalls++; throw new Error("No provider or external I/O belongs in selection"); }) as typeof fetch;
let route: Promise<typeof import("../../app/api/chat/route")> | undefined;
const put = async (overrides = {}) => {
  route ??= import(mod("app/api/chat/route.ts")) as Promise<typeof import("../../app/api/chat/route")>;
  return (await route).PUT(new Request("http://127.0.0.1:3100/api/chat", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "generated-artifact-copy", artifactId: "exact-past-artifact", conversationId: "current-conversation", operationId: "unique-operation-1", ...overrides }),
  }));
};
beforeEach(() => {
  session = { user: { id: "owner", email: "owner@example.invalid" } };
  attachmentsEnabled = true; allowAttachments = true; rateFailure = false; quotaFailure = false; copyFailure = null;
  copies = []; rateScopes = []; reservations = []; networkCalls = 0;
});

test("exact import action reuses the existing auth, rate, byte quota and opaque finalized DTO", async () => {
  const response = await put();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(rateScopes, ["upload-prepare"]);
  assert.deepEqual(reservations, [17]);
  assert.equal(copies[0].artifactId, "exact-past-artifact");
  assert.equal(copies[0].conversationId, "current-conversation");
  assert.equal(copies[0].userId, "owner");
  assert.equal(copies[0].maxBytes, CHAT_MAX_ATTACHMENT_BYTES);
  assert.equal(networkCalls, 0);
});
for (const refusal of ["auth", "operations", "plan", "rate", "quota"] as const) {
  test(`existing ${refusal} gate refuses the copy`, async () => {
    if (refusal === "auth") session = null;
    if (refusal === "operations") attachmentsEnabled = false;
    if (refusal === "plan") allowAttachments = false;
    if (refusal === "rate") rateFailure = true;
    if (refusal === "quota") quotaFailure = true;
    const response = await put();
    assert.equal(response.status, { auth: 401, operations: 503, plan: 403, rate: 429, quota: 429 }[refusal]);
    assert.equal(copies.length, refusal === "quota" ? 1 : 0);
    assert.equal(networkCalls, 0);
  });
}
test("client object keys, URLs, filenames and MIME declarations cannot select the source", async () => {
  for (const overrides of [{ objectKey: "secret-key" }, { url: "https://example.invalid/file" }, { name: "latest.txt" }, { mediaType: "text/plain" }, { operationId: "short" }]) {
    const response = await put(overrides);
    assert.equal(response.status, 400);
  }
  assert.equal(copies.length, 0);
});
test("protected source and disabled helper refusals retain their code without internal data", async () => {
  for (const [code, status] of [["CONVERSATION_LOCKED", 423], ["ATTACHMENT_UNAVAILABLE", 404], ["GENERATED_ARTIFACT_REVISION_DISABLED", 404], ["ATTACHMENT_TEXT_TOO_LARGE", 413]] as const) {
    copyFailure = new revision.GeneratedArtifactRevisionError(code, status);
    const response = await put();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "Failed to prepare attachment.", code });
  }
  assert.equal(networkCalls, 0);
});
