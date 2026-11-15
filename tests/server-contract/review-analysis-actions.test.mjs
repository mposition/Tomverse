import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { makeReviewReportFixture } from "../fixtures/reviewAnalysisReport.ts";
import { reviewReportSelection } from "../../lib/reviewAnalysisReport.ts";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let state;
const noWrite = () => { throw Error("Unexpected data creation or model execution"); };
const prisma = {
  conversation: {
    findUnique: async () => state.conversation,
    findFirst: async ({ where }) => {
      state.ownerReads++;
      if (where.shareToken) return state.published ? { shareSnapshot: state.published, shareExpiresAt: new Date(Date.now() + 60000), productKey: "review" } : null;
      if (where.userId !== state.conversation?.userId) return null;
      if (state.ownerReads > 1 && state.afterRead) return state.afterRead();
      return state.conversation;
    },
    create: noWrite, update: noWrite,
  },
  comparisonReview: { findFirst: async ({ where }) => {
    state.reviewReads++;
    if (where.id !== state.stored.id || where.userId !== "owner-a" || where.conversationId !== "qa-conversation" || state.stored.isStale) return null;
    state.stored.inputHash = where.inputHash;
    return state.stored;
  }, create: noWrite, upsert: noWrite },
  message: { findMany: async () => state.messages, create: noWrite },
  conversationContinuationBridge: { count: async () => state.bridge ? 1 : 0 },
  $queryRaw: async query => {
    state.publications++;
    state.sql = query;
    const snapshot = query.values.find(value => typeof value === "string" && value.startsWith('{"version":1'));
    state.published = JSON.parse(snapshot);
    return state.casRefused ? [] : [{ id: "qa-conversation" }];
  },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session: state.session }) } });
mock.module(mod("lib/comparisonReviewTurn.ts"), { namedExports: { latestComparableConversationTurn: async () => state.turn } });
mock.module(mod("lib/appSettings.ts"), { namedExports: { getOperationalFeatureFlags: async () => ({ publicSharingEnabled: state.sharingEnabled }), isMemoryInjectionEnabled: async () => false } });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  // Grants are bound to the stored passwordVersion (null = no password), never to the password itself.
  hasConversationUnlockGrant: (_request, _owner, _id, passwordVersion) =>
    passwordVersion === null || (Number.isSafeInteger(passwordVersion) && passwordVersion === state.grantVersion),
  conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
} });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: {
  getUserBillingPlan: async () => ({ allowDownloads: state.downloads, allowSharing: state.sharePlan }),
  featureNotIncludedResponse: () => Response.json({ code: "FEATURE_NOT_INCLUDED" }, { status: 403 }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => undefined,
  apiSecurityResponse: error => error.status ? Response.json({ code: "INVALID_REQUEST" }, { status: error.status }) : null,
  readLimitedJson: async (request, limit, schema) => {
    assert.equal(limit, 4096); const text = await request.text();
    try { if (new TextEncoder().encode(text).length > limit) throw Error("large"); return schema.parse(JSON.parse(text)); }
    catch { throw Object.assign(Error("Invalid body"), { status: 400 }); }
  },
} });
mock.module(mod("lib/securityAudit.ts"), { namedExports: { logSecurityAuditEvent: () => {} } });
mock.module(mod("lib/publicUrl.ts"), { namedExports: { getPublicAppOrigin: () => "https://tomverse.test" } });

const { POST: exportReport } = await import(mod("app/api/conversations/[conversationId]/analysis/export/route.ts"));
const { POST: shareReport } = await import(mod("app/api/conversations/[conversationId]/share/route.ts"));
const { GET: readPublic } = await import(mod("app/api/public/shares/[shareToken]/route.ts"));
const context = { params: Promise.resolve({ conversationId: "qa-conversation" }) };

beforeEach(() => {
  const source = makeReviewReportFixture();
  const createdAt = new Date("2026-11-15T00:00:00Z");
  state = { source, session: { user: { id: "owner-a" } }, sharingEnabled: true, downloads: true, sharePlan: true,
    conversation: { id: "qa-conversation", userId: "owner-a", password: null, passwordVersion: 0, kind: "chat", title: "Private source", createdAt, shareToken: null, shareEnabled: false, shareRevokedAt: null, chatRecoveryEpoch: 0, continuationBridge: null },
    messages: [{ id: "prompt-1", role: "user", content: source.setup.source.question, modelId: null, createdAt },
      ...source.setup.source.responses.map((response, index) => ({ id: response.messageId, role: "assistant", content: response.content, modelId: source.review.responseMap[index].modelId, createdAt }))],
    stored: { id: "review-1", userId: "owner-a", conversationId: "qa-conversation", inputHash: "hash", promptMessageId: "prompt-1", assistantMessageIds: ["answer-a", "answer-b"], reviewerModelId: source.review.reviewerModelId, result: source.review.result, isStale: false },
    turn: { prompt: { id: "prompt-1", content: source.setup.source.question, createdAt }, responses: source.setup.source.responses.map((response, index) => ({ ...response, ...source.review.responseMap[index] })) },
    publications: 0, reviewReads: 0, ownerReads: 0,
  };
});
const requestFor = async (action, overrides = {}) => new Request(`https://tomverse.test/api/conversations/qa-conversation/${action}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ analysis: await reviewReportSelection(state.source, "ko"), ...overrides }),
});

test("export authenticates owner, kind, unlock, downloads and continuation before reading a report", async () => {
  for (const change of [() => { state.session = null; }, () => { state.conversation.userId = "other"; }, () => { state.conversation.password = "new-lock"; }, () => { state.downloads = false; }, () => { state.conversation.kind = "image"; }, () => { state.conversation.continuationBridge = { id: "bridge" }; }]) {
    const original = structuredClone(state); change();
    const response = await exportReport(await requestFor("analysis/export", { format: "txt" }), context);
    assert.ok(response.status >= 400); assert.equal(state.reviewReads, 0); assert.equal(state.publications, 0); state = original;
  }
});
test("all four formats return actual complete bytes with an integrity digest and perform no persistent write", async () => {
  for (const format of ["txt", "md", "pdf", "docx"]) {
    state.ownerReads = 0;
    const response = await exportReport(await requestFor("analysis/export", { format }), context);
    assert.equal(response.status, 200, format);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(Number(response.headers.get("X-Export-Bytes")), bytes.length);
    assert.equal(response.headers.get("X-Export-SHA256"), createHash("sha256").update(bytes).digest("hex"));
    assert.match(response.headers.get("content-disposition"), new RegExp(`analysis\\.${format}`));
    if (format === "pdf") assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
    if (format === "docx") assert.equal(new TextDecoder().decode(bytes.slice(0, 2)), "PK");
    assert.equal(state.publications, 0);
  }
});
test("late deletion, locking and continuation changes withhold already-rendered file bytes", async () => {
  for (const afterRead of [() => null, () => ({ ...state.conversation, password: "locked" }), () => ({ ...state.conversation, continuationBridge: { id: "new" } })]) {
    state.ownerReads = 0; state.afterRead = afterRead;
    const response = await exportReport(await requestFor("analysis/export", { format: "txt" }), context);
    assert.ok(response.status >= 400); assert.match(response.headers.get("content-type"), /json/);
  }
});
test("a locked conversation exports only with a grant for its current password version", async () => {
  state.conversation.password = "hashed-lock"; state.conversation.passwordVersion = 3;
  state.grantVersion = 3;
  assert.equal((await exportReport(await requestFor("analysis/export", { format: "txt" }), context)).status, 200);
  state.grantVersion = 2;
  assert.equal((await exportReport(await requestFor("analysis/export", { format: "txt" }), context)).status, 423);
  // A password change while the file renders advances the version and withholds the bytes.
  state.grantVersion = 3; state.ownerReads = 0;
  state.afterRead = () => ({ ...state.conversation, passwordVersion: 4 });
  assert.equal((await exportReport(await requestFor("analysis/export", { format: "txt" }), context)).status, 423);
});
test("regeneration during rendering withholds the old report rather than downloading stale bytes", async () => {
  state.afterRead = () => {
    state.stored.result.primary.reviewerModelId = "regenerated-reviewer";
    return state.conversation;
  };
  const response = await exportReport(await requestFor("analysis/export", { format: "txt" }), context);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "REVIEW_REPORT_SOURCE_CHANGED");
});
test("missing, stale, regenerated and malformed snapshots never export or publish", async () => {
  const request = await requestFor("share");
  state.stored.result = { ...state.stored.result, primary: { ...state.stored.result.primary, reviewerModelId: "changed" } };
  assert.equal((await shareReport(request, context)).status, 409); assert.equal(state.publications, 0);
  state.stored.isStale = true;
  assert.equal((await exportReport(await requestFor("analysis/export", { format: "txt" }), context)).status, 409);
});
test("analysis publication contains only the selected report and keeps transcript, permission and review-version CAS", async () => {
  state.source.reviewer = "secondary";
  const response = await shareReport(await requestFor("share"), context);
  assert.equal(response.status, 200); assert.equal(state.publications, 1);
  const body = await response.json();
  const serialized = JSON.stringify(state.published);
  assert.equal(state.published.contentKind, "analysis");
  assert.ok(serialized.includes("두 번째 검토자의 별도 견해"));
  assert.ok(!serialized.includes("PRIVATE_FULL_ANSWER"));
  const sql = state.sql.sql;
  for (const guard of ["ComparisonReview", 'review."result"', 'review."assistantMessageIds"', 'review."isStale"', 'conversation."password"', 'conversation."userId"', 'conversation."chatRecoveryEpoch"', "ConversationContinuationBridge", "EXCEPT"]) assert.ok(sql.includes(guard), guard);
  const publicResponse = await readPublic(new Request(body.url), { params: Promise.resolve({ shareToken: new URL(body.url).pathname.split("/").pop() }) });
  assert.equal(publicResponse.status, 200);
  assert.equal((await publicResponse.json()).snapshot.contentKind, "analysis");
});
test("legacy transcript sharing stays unchanged and protected refusals publish nothing", async () => {
  const legacy = await shareReport(new Request("https://tomverse.test/api/conversations/qa-conversation/share", { method: "POST" }), context);
  assert.equal(legacy.status, 200); assert.ok(JSON.stringify(state.published).includes("PRIVATE_FULL_ANSWER")); assert.equal(state.reviewReads, 0);
  const original = structuredClone(state);
  for (const change of [() => { state.session = null; }, () => { state.conversation.userId = "other"; }, () => { state.conversation.password = "locked"; }, () => { state.sharingEnabled = false; }, () => { state.sharePlan = false; }, () => { state.bridge = true; }]) {
    state = structuredClone(original); state.publications = 0; change();
    assert.ok((await shareReport(await requestFor("share"), context)).status >= 400); assert.equal(state.publications, 0);
  }
});
test("Quick Summary exports and shares its own persisted shape without executing a review", async () => {
  const primary = state.source.review.result.primary.result;
  const result = { commonConclusions: primary.consensus, importantDifferences: [],
    modelKeyClaims: [{ responseId: "A", claims: [] }, { responseId: "B", claims: [] }],
    verificationNeeded: ["Quick unresolved matter"], confidence: "low", groundingStats: { totalCitations: 1, verifiedCitations: 1 } };
  state.source = { ...state.source, kind: "quick", review: { ...state.source.review, result } };
  state.stored.result = result;
  const exported = await exportReport(await requestFor("analysis/export", { format: "txt" }), context);
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /Quick unresolved matter/);
  const shared = await shareReport(await requestFor("share"), context);
  assert.equal(shared.status, 200); assert.equal(state.publications, 1);
  assert.ok(JSON.stringify(state.published).includes("Quick unresolved matter"));
  assert.ok(!JSON.stringify(state.published).includes("PRIVATE_FULL_ANSWER"));
});
