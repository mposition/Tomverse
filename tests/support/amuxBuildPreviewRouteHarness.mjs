import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let calls;
let failAt;
let session;
class SubmissionError extends Error { constructor(code, status, readBack, ideaId) { super(code); Object.assign(this, { code, status, readBack, ideaId }); } }
class PlanAccessError extends Error { constructor(code, status) { super(code); Object.assign(this, { code, status }); } }
class PlanError extends Error { constructor(code) { super(code); this.code = code; } }
class PreviewError extends Error { constructor(code) { super(code); this.code = code; } }

mock.module("next-auth/next", { namedExports: { getServerSession: async () => session } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => true, getAdminRole: (s) => s.role } });
mock.module(mod("lib/adminReauthentication.ts"), {
  namedExports: { assertRecentAdminAuthentication: async () => {}, isAdminReauthenticationError: () => false },
});
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    apiSecurityResponse: () => null,
    consumeApiRateLimit: async (_request, _id, scope) => { calls.push(["rate", scope]); },
    readLimitedText: async (request) => request.text(),
  },
});
mock.module(mod("lib/amux/ideaSubmissionService.ts"), {
  namedExports: {
    IdeaSubmissionError: SubmissionError,
    submitIdea: async ({ inspected }) => {
      calls.push(["submit", inspected.request?.requestId ?? inspected.requestId]);
      if (failAt === "submission") throw new SubmissionError("outcome_unknown", 503, "unavailable");
      return { ideaId: "11111111-1111-4111-8111-111111111111", requestId: "r", auditId: "a" };
    },
  },
});
mock.module(mod("lib/amux/ideaInitialSourcePlanAccess.ts"), {
  namedExports: {
    InitialPlanAccessError: PlanAccessError,
    prepareInitialIdeaSourcePlan: async (_s, _r, ideaId) => {
      calls.push(["plan", ideaId]);
      if (failAt === "plan") throw new PlanError("not_ready");
      return { revisionId: "rev-1" };
    },
  },
});
mock.module(mod("lib/amux/ideaInitialSourcePlanService.ts"), { namedExports: { InitialSourcePlanError: PlanError } });
mock.module(mod("lib/amux/ideaTransferPreviewService.ts"), {
  namedExports: {
    IdeaTransferPreviewError: PreviewError,
    prepareIdeaOnlyTransferPreview: async (_s, _r, choice, nonce) => {
      calls.push(["preview", choice.ideaId, choice.previewId, nonce.length]);
      if (failAt === "preview") throw new PreviewError("outcome_unknown");
      return { previewId: choice.previewId, payloadDigest: "d".repeat(64), payloadDigestKeyId: "k" };
    },
  },
});

const switches = ["TOMVERSE_AMUX_V4_IDEA_SUBMIT", "TOMVERSE_AMUX_V4_IDEA_READBACK", "TOMVERSE_AMUX_V4_INITIAL_PLAN_WRITE",
  "TOMVERSE_AMUX_V4_INITIAL_PLAN_READBACK", "TOMVERSE_AMUX_V4_TRANSFER_PREVIEW_WRITE",
  "TOMVERSE_AMUX_V4_TRANSFER_PREVIEW_READ", "TOMVERSE_AMUX_V4_FRONTIER_CATALOG_READ"];
const { POST } = await import(mod("app/api/admin/amux/ideas/build-preview/route.ts"));
const requestId = "22222222-2222-4222-8222-222222222222";
const previewId = "33333333-3333-4333-8333-333333333333";
const body = (input) => ({ version: 1, requestId, previewId,
  input: input ?? { version: 1, idea: "Make the failure alert speak the user's language.", repositories: [], pullRequests: [] },
  model: { provider: "anthropic", modelId: "claude-opus-5-5", reasoningEffort: "high",
    approvalId: "44444444-4444-4444-8444-444444444444", approvalVersion: 1 } });
const post = (value) => POST(new Request("https://t.test/api/admin/amux/ideas/build-preview", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
const reset = () => {
  calls = []; failAt = null; session = { user: { id: "owner-1" }, role: "owner" };
  for (const name of switches) process.env[name] = "enabled";
};

// Save, plan and preview, in order, one rate-limit bucket of its own; the cookie binds the preview.
reset();
let response = await post(body());
assert.equal(response.status, 201);
let json = await response.json();
assert.equal(json.state, "prepared");
assert.equal(json.transferAuthorized, false);
assert.deepEqual(calls.map(([k]) => k), ["rate", "submit", "plan", "preview"]);
assert.equal(calls[0][1], "admin-amux-v4-build-preview");
assert.equal(calls[2][1], "11111111-1111-4111-8111-111111111111");
assert.equal(calls[3][2], previewId);
assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`amux-v4-preview-${previewId}=`));
assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);

// Each step that does not finish stops the chain, names itself and its read-back id.
reset(); failAt = "submission";
response = await post(body());
json = await response.json();
assert.equal(response.status, 503);
assert.deepEqual([json.step, json.error, json.requestId, json.retryWrite], ["submission", "outcome_unknown", requestId, false]);
assert.deepEqual(calls.map(([k]) => k), ["rate", "submit"]);
reset(); failAt = "plan";
response = await post(body());
json = await response.json();
assert.equal(response.status, 409);
assert.deepEqual([json.step, json.error, json.ideaId], ["plan", "not_ready", "11111111-1111-4111-8111-111111111111"]);
assert.equal(calls.some(([k]) => k === "preview"), false);
reset(); failAt = "preview";
response = await post(body());
json = await response.json();
assert.equal(response.status, 503);
assert.deepEqual([json.step, json.previewId], ["preview", previewId]);
assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`amux-v4-preview-${previewId}=`),
  "an unknown preview keeps its browser binding");

// An idea naming sources is saved and stops: plans and previews are idea-only.
reset();
response = await post(body({ version: 1, idea: "Use the existing repo.", repositories: ["mposition/Tomverse"], pullRequests: [] }));
json = await response.json();
assert.equal(response.status, 201);
assert.deepEqual([json.state, json.hasExternalSources], ["submitted", true]);
assert.deepEqual(calls.map(([k]) => k), ["rate", "submit"]);

// Every one of the three routes' switches is required; nothing runs without one.
for (const name of switches) {
  reset(); process.env[name] = "disabled";
  response = await post(body());
  assert.equal(response.status, 503, name);
  assert.deepEqual(calls, []);
}
// Owner only; a malformed body is refused before any write.
reset(); session = { user: { id: "o" }, role: "ops" };
assert.equal((await post(body())).status, 403);
reset();
assert.equal((await post({ ...body(), extra: 1 })).status, 400);
assert.equal(calls.some(([k]) => k === "submit"), false);
