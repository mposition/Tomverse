import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let role = "operator";
let recent = false;
let reviewReads = 0;
let reviewSourceExists = true;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => ({ user: { id: "admin" } }),
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => role,
  isAdminSession: () => true,
  hasAdminPermission: () => true,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {
    if (!recent) throw new Error("stepup");
  },
  isAdminReauthenticationError: (error: unknown) =>
    error instanceof Error && error.message === "stepup",
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => undefined,
  readLimitedJson: async (request: Request) => request.json(),
  apiSecurityResponse: () => null,
} });
mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => true,
} });
mock.module(mod("lib/amux/reviewApprovalCore.ts"), { namedExports: {
  isAmuxAgentApprovalEnabled: () => true,
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeAdminAuditLog: async () => "audit",
} });
mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: {
    amuxHumanEscalation: { findUnique: async () => reviewSourceExists ? ({
      task: { sourceSystem: "admin-idea-v4" },
    }) : null },
    amuxReviewProposal: { findUnique: async () => reviewSourceExists ? ({
      task: { sourceSystem: "admin-idea-v4" },
    }) : null },
  },
} });
mock.module(mod("lib/amux/reviewApproval.ts"), { namedExports: {
  AmuxReviewRefusal: class extends Error {},
  getAmuxReviewDetail: async () => { reviewReads += 1; return {
    task: { id: "card", revision: 2 },
    escalation: { id: "escalation" },
    review_content: { digest: "a".repeat(64) },
    review_artifact: null,
  }; },
  acknowledgeAmuxReview: async () => { reviewReads += 1; return { success: true }; },
  getAmuxReviewDecisionStatus: async () => { reviewReads += 1; return { status: "unconfirmed" }; },
  createAmuxReviewProposal: async () => { reviewReads += 1; return { success: true }; },
  resolveAmuxReview: async () => { reviewReads += 1; return { success: true }; },
} });

const route = import(mod("app/api/internal/amux/review/route.ts"));
const url = "https://tomverse.test/api/internal/amux/review";
const request = (body: object) => new Request(url, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("v4 review detail, decision lookup and acknowledgement are owner-only", async () => {
  const { POST } = await route;
  const detail = { action: "detail", escalation_id: "cl12345678901234567890123" };
  const lookup = { action: "decision_status", decision_id:
    "9fbe32e2-2f47-4a77-84fb-faa64e20609e", subject_digest: "a".repeat(64) };
  const ack = { action: "acknowledge", escalation_id: detail.escalation_id };
  for (const command of [detail, lookup, ack]) {
    const existing = await POST(request(command));
    reviewSourceExists = false;
    const absent = await POST(request(command));
    reviewSourceExists = true;
    assert.equal(existing.status, 404);
    assert.equal(absent.status, 404);
    assert.deepEqual(await existing.json(), await absent.json());
  }
  assert.equal(reviewReads, 0);
  role = "owner";
  assert.equal((await POST(request(ack))).status, 428);
  recent = true;
  assert.equal((await POST(request(detail))).status, 200);
  assert.equal((await POST(request(lookup))).status, 200);
  assert.equal((await POST(request(ack))).status, 200);
  assert.equal(reviewReads, 3);
});
