import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authenticated = true;
let role = "owner";
let recent = true;
let ownsPreview = true;
let writes = 0;
let auditReads = 0;
let hold = { id: "synthetic-hold", previewId: "synthetic-preview", status: "reserved",
  namespace: "agent/amux-intake",
  reservedMicroUsd: 10_560_000n, dispatchedAt: null as Date | null,
  settledMicroUsd: null as bigint | null, closedAt: null as Date | null,
  _count: { cliUsageEvents: 0 } };
let preview = { confirmedByUserId: "synthetic-owner", ideaId: "synthetic-idea",
  idea: { actorUserId: "synthetic-owner" }, state: "confirmed",
  consumedAt: null as Date | null, outcomeUnknownAt: null as Date | null,
  expiresAt: new Date("2026-10-01T00:00:00.000Z") };

class CancellationError extends Error {
  constructor(readonly code: string) { super(code); }
}
mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
  getServerSession: async () => authenticated ? { user: { id: "synthetic-owner" } } : null,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => authenticated, getAdminRole: () => role,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new Error("reauth"); },
  isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth",
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {},
  readLimitedJson: async (request: Request, limit: number, schema: { parse: (body: unknown) => unknown }) => {
    const text = await request.text();
    if (Buffer.byteLength(text) > limit) throw new Error("invalid-body");
    try { return schema.parse(JSON.parse(text)); } catch { throw new Error("invalid-body"); }
  },
  apiSecurityResponse: (error: unknown) => error instanceof Error && error.message === "invalid-body"
    ? Response.json({ error: "Invalid request." }, { status: 400 }) : null,
} });
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: { loadAmuxContentKeyRing: async () => {
  throw new Error("Cancellation must not load payload keys");
} } });
mock.module(mod("lib/amux/ideaAnalysisBudgetReservationService.ts"), { namedExports: {
  AmuxIdeaAnalysisReservationError: class extends Error {},
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH: true,
  commitAmuxIdeaAnalysisBudgetReservation: async () => { throw new Error("No new reservation"); },
} });
mock.module(mod("lib/amux/ideaAnalysisBudgetCancellationService.ts"), { namedExports: {
  AmuxIdeaAnalysisCancellationError: CancellationError,
  commitAmuxIdeaAnalysisUnusedReservationCancellation: async (_tx: unknown, input: Record<string, unknown>) => {
    assert.equal(input.holdId, "synthetic-hold");
    assert.equal(input.expectedPreviewId, "synthetic-preview");
    if (hold.status !== "reserved" || hold.dispatchedAt) throw new CancellationError("not_cancellable");
    writes++;
    hold = { ...hold, status: "released", settledMicroUsd: 0n, closedAt: new Date() };
    return { holdId: hold.id, releasedMicroUsd: "10560000", auditId: "synthetic-audit" };
  },
} });
const tx = {
  amuxIdeaTransferPreview: { findUnique: async () => ownsPreview ? preview : null },
  amuxIdeaSubmission: { findUnique: async () => ({ actorUserId: "synthetic-owner" }) },
  amuxIdeaAnalysisBudgetHold: { findUnique: async () => hold },
  adminAuditLog: { findFirst: async () => { auditReads++; return { id: "synthetic-audit" }; } },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  ...tx, $transaction: async (work: (db: typeof tx) => Promise<unknown>) => work(tx),
} } });
const routePromise = import(mod("app/api/admin/amux/ideas/analysis-reservations/route.ts"));
const endpoint = "https://example.test/api/admin/amux/ideas/analysis-reservations";
const request = (body: unknown = { holdId: "synthetic-hold", previewId: "synthetic-preview", confirmedUnused: true }) =>
  new Request(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("unused reservation cancellation fails closed before the writer", async () => {
  const route = await routePromise;
  authenticated = false;
  assert.equal((await route.DELETE(request())).status, 404);
  authenticated = true; role = "ops";
  assert.equal((await route.DELETE(request())).status, 403);
  role = "owner"; recent = false;
  assert.equal((await route.DELETE(request())).status, 428);
  recent = true;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ = "enabled";
  delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE;
  assert.equal((await route.DELETE(request())).status, 409);
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE = "enabled";
  for (const body of [
    { holdId: "synthetic-hold", previewId: "synthetic-preview", confirmedUnused: false },
    { holdId: "synthetic-hold", previewId: "synthetic-preview", confirmedUnused: true, extra: true },
    { holdId: "bad id", previewId: "synthetic-preview", confirmedUnused: true },
  ]) assert.equal((await route.DELETE(request(body))).status, 400);
  ownsPreview = false;
  assert.equal((await route.DELETE(request())).status, 403);
  ownsPreview = true;
  preview.idea.actorUserId = "other-owner";
  assert.equal((await route.DELETE(request())).status, 403);
  preview.idea.actorUserId = "synthetic-owner";
  assert.equal(writes, 0);
});

test("expired unused preview stays reachable; claim, usage and unknown proof disable cancellation", async () => {
  const route = await routePromise;
  const read = async () => (await (await route.GET(new Request(`${endpoint}?holdId=synthetic-hold`))).json()).hold;
  assert.equal((await read()).canCancel, true);
  for (const change of [
    { namespace: "agent/other" }, { status: "in_flight" },
    { dispatchedAt: new Date() }, { _count: { cliUsageEvents: 1 } },
  ]) {
    const prior = hold; hold = { ...hold, ...change };
    assert.equal((await read()).canCancel, false); hold = prior;
  }
  for (const change of [{ consumedAt: new Date() }, { outcomeUnknownAt: new Date() }, { state: "provider_failed" }]) {
    const prior = preview; preview = { ...preview, ...change };
    assert.equal((await read()).canCancel, false); preview = prior;
  }
  assert.equal(auditReads, 0);
});

test("one canonical cancellation, exact receipt read-back, and no second release", async () => {
  const route = await routePromise;
  const response = await route.DELETE(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { holdId: "synthetic-hold", releasedMicroUsd: "10560000",
    auditId: "synthetic-audit", modelCallStarted: false });
  const readback = await (await route.GET(new Request(`${endpoint}?holdId=synthetic-hold`))).json();
  assert.equal(readback.hold.canCancel, false);
  assert.equal(readback.hold.cancellationAuditId, "synthetic-audit");
  assert.equal((await route.DELETE(request())).status, 409);
  assert.equal(writes, 1);
});
