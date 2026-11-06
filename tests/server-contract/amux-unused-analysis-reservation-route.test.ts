import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authenticated = true;
let role = "owner";
let recent = true;
let ideaOwner = "synthetic-owner";
let writes: string[] = [];
let writerFailure: Error | null = null;
type Hold = { id: string; previewId: string; status: string; namespace: string; reservedMicroUsd: bigint;
  dispatchedAt: Date | null; settledMicroUsd: bigint | null; closedAt: Date | null;
  _count: { cliUsageEvents: number };
  preview: { state: string; consumedAt: Date | null; outcomeUnknownAt: Date | null; expiresAt: Date } };
const newHold = (id: string, changes: Partial<Hold> = {}): Hold => ({ id, previewId: `${id}-preview`,
  status: "reserved", namespace: "agent/amux-intake", reservedMicroUsd: BigInt(10_560_000),
  dispatchedAt: null, settledMicroUsd: null, closedAt: null, _count: { cliUsageEvents: 0 },
  preview: { state: "confirmed", consumedAt: null, outcomeUnknownAt: null,
    expiresAt: new Date("2026-10-01T00:00:00.000Z") }, ...changes });
let holds: Hold[] = [];
let holdReads: unknown[] = [];

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
// The canonical writer: it re-checks the hold under its locks and refuses a claimed or released one.
mock.module(mod("lib/amux/ideaAnalysisBudgetCancellationService.ts"), { namedExports: {
  AmuxIdeaAnalysisCancellationError: CancellationError,
  commitAmuxIdeaAnalysisUnusedReservationCancellation: async (_tx: unknown, input: Record<string, unknown>) => {
    if (writerFailure) throw writerFailure;
    const hold = holds.find((row) => row.id === input.holdId);
    assert.equal(input.expectedPreviewId, hold?.previewId);
    if (!hold || hold.status !== "reserved" || hold.dispatchedAt) throw new CancellationError("not_cancellable");
    writes.push(hold.id);
    Object.assign(hold, { status: "released", settledMicroUsd: BigInt(0), closedAt: new Date() });
    return { holdId: hold.id, releasedMicroUsd: hold.reservedMicroUsd.toString(), auditId: `audit-${hold.id}` };
  },
} });
const tx = {
  amuxIdeaTransferPreview: { findUnique: async ({ where }: { where: { id: string } }) =>
    holds.some((hold) => hold.previewId === where.id) ? { ideaId: "synthetic-idea",
      confirmedByUserId: "synthetic-owner", idea: { actorUserId: ideaOwner } } : null },
  amuxIdeaSubmission: { findUnique: async () => ({ actorUserId: ideaOwner }) },
  // Applies the two filters the route asks for: unused candidates, or any open hold.
  amuxIdeaAnalysisBudgetHold: {
    findMany: async (query: { where: { status?: string; closedAt?: null }; take?: number }) => {
      holdReads.push(query);
      const rows = holds.filter((hold) => query.where.status === "reserved"
        ? hold.status === "reserved" && hold.closedAt === null && hold.dispatchedAt === null &&
          hold._count.cliUsageEvents === 0 && hold.preview.consumedAt === null && hold.preview.outcomeUnknownAt === null
        : query.where.closedAt === null ? hold.closedAt === null : true);
      return rows.slice(0, query.take ?? rows.length);
    },
    count: async () => holds.filter((hold) => hold.status === "released").length,
  },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  ...tx, $transaction: async (work: (db: typeof tx) => Promise<unknown>) => work(tx),
} } });
const routePromise = import(mod("app/api/admin/amux/ideas/analysis-reservations/route.ts"));
const endpoint = "https://example.test/api/admin/amux/ideas/analysis-reservations";
const request = (body: unknown = { ideaId: "synthetic-idea", confirmedUnused: true }) =>
  new Request(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const read = async () => (await routePromise).GET(new Request(`${endpoint}?ideaId=synthetic-idea`));
test.beforeEach(() => {
  authenticated = true; role = "owner"; recent = true; ideaOwner = "synthetic-owner";
  writes = []; writerFailure = null; holdReads = [];
  holds = [newHold("hold-a")];
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ = "enabled";
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE = "enabled";
});

test("the idea release fails closed before the writer", async () => {
  const route = await routePromise;
  authenticated = false;
  assert.equal((await route.DELETE(request())).status, 404);
  authenticated = true; role = "ops";
  assert.equal((await route.DELETE(request())).status, 403);
  role = "owner"; recent = false;
  assert.equal((await route.DELETE(request())).status, 428);
  recent = true;
  delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE;
  assert.equal((await route.DELETE(request())).status, 409);
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE = "enabled";
  for (const body of [
    { ideaId: "synthetic-idea", confirmedUnused: false },
    { ideaId: "synthetic-idea", confirmedUnused: true, holdId: "hold-a" },
    { holdId: "hold-a", previewId: "hold-a-preview", confirmedUnused: true },
    { ideaId: "bad id", confirmedUnused: true },
  ]) assert.equal((await route.DELETE(request(body))).status, 400);
  ideaOwner = "other-owner";
  assert.equal((await route.DELETE(request())).status, 404);
  assert.equal((await read()).status, 404);
  assert.deepEqual(writes, []);
});

test("the idea read offers only holds the writer would accept, else says why", async () => {
  const view = async () => (await read()).json();
  const first = await view();
  assert.deepEqual(first.releasable, [{ id: "hold-a", reservedMicroUsd: "10560000" }]);
  assert.equal(first.blocked, null);
  const where = (holdReads[0] as { where: Record<string, unknown> }).where;
  assert.equal(where.status, "reserved");
  assert.equal(where.closedAt, null);
  assert.deepEqual(where.cliUsageEvents, { none: {} });
  assert.deepEqual(where.preview, { ideaId: "synthetic-idea", confirmedByUserId: "synthetic-owner",
    consumedAt: null, outcomeUnknownAt: null, state: { in: ["confirmed", "expired", "owner_rejected"] } });
  // Closed holds never fill the bound: the 26th, unused hold is still offered.
  holds = [...Array.from({ length: 25 }, (_, index) => newHold(`old-${index}`, { status: "released",
    closedAt: new Date(), settledMicroUsd: BigInt(0) })), newHold("hold-late")];
  const late = await view();
  assert.deepEqual(late.releasable, [{ id: "hold-late", reservedMicroUsd: "10560000" }]);
  assert.equal(late.releasedCount, 25);
  for (const changes of [{ status: "in_flight" }, { dispatchedAt: new Date() },
    { _count: { cliUsageEvents: 1 } }, { namespace: "agent/other" }] as Array<Partial<Hold>>) {
    holds = [newHold("hold-a", changes)];
    const answer = await view();
    assert.deepEqual(answer.releasable, []);
    assert.equal(answer.blocked, "in_use");
  }
  for (const preview of [{ consumedAt: new Date() }, { outcomeUnknownAt: new Date() }]) {
    holds = [newHold("hold-a", { preview: { ...newHold("x").preview, ...preview } })];
    assert.equal((await view()).blocked, "outcome_unknown");
  }
  holds = [newHold("hold-a", { status: "released", closedAt: new Date(), settledMicroUsd: BigInt(0) })];
  assert.deepEqual(await view(), { state: "idea", ideaId: "synthetic-idea", releasable: [],
    releasedCount: 1, blocked: "none", retryWrite: false });
  holds = [];
  assert.equal((await view()).blocked, "none");
  // An expired preview's unused hold stays releasable.
  holds = [newHold("hold-a", { preview: { ...newHold("x").preview, state: "expired" } })];
  assert.equal((await view()).releasable.length, 1);
  assert.deepEqual(writes, []);
});

test("one click releases every unused hold of the idea through the writer, and never twice", async () => {
  const route = await routePromise;
  holds = [newHold("hold-a"), newHold("hold-b"), newHold("hold-c", { dispatchedAt: new Date() })];
  const response = await route.DELETE(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { ideaId: "synthetic-idea", released: [
    { holdId: "hold-a", releasedMicroUsd: "10560000", auditId: "audit-hold-a" },
    { holdId: "hold-b", releasedMicroUsd: "10560000", auditId: "audit-hold-b" },
  ], skipped: 0, modelCallStarted: false });
  assert.deepEqual(writes, ["hold-a", "hold-b"]);
  const again = await route.DELETE(request());
  assert.equal(again.status, 409);
  assert.equal((await again.json()).blocked, "in_use");
  assert.deepEqual(writes, ["hold-a", "hold-b"]);
});

test("a hold claimed meanwhile is skipped; a failure after a commit is an unknown outcome", async () => {
  const route = await routePromise;
  holds = [newHold("hold-a"), newHold("hold-b")];
  // The writer sees hold-a claimed under its lock although the read offered it.
  const { findMany } = tx.amuxIdeaAnalysisBudgetHold;
  tx.amuxIdeaAnalysisBudgetHold.findMany = async (query: Parameters<typeof findMany>[0]) => {
    const offered = structuredClone(await findMany(query));
    holds[0]!.status = "in_flight";
    return offered;
  };
  try {
    const response = await route.DELETE(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.released.map((row: { holdId: string }) => row.holdId), ["hold-b"]);
    assert.equal(body.skipped, 1);
    // Every candidate claimed meanwhile: nothing released, and the reason comes from a fresh read.
    holds = [newHold("hold-a")];
    const none = await route.DELETE(request());
    assert.equal(none.status, 409);
    assert.equal((await none.json()).blocked, "in_use");
  } finally { tx.amuxIdeaAnalysisBudgetHold.findMany = findMany; }

  holds = [newHold("hold-a"), newHold("hold-b")];
  writes = [];
  const writer = tx.amuxIdeaTransferPreview.findUnique;
  let calls = 0;
  tx.amuxIdeaTransferPreview.findUnique = async (query) => {
    if (++calls === 2) throw new Error("connection lost");
    return writer(query);
  };
  try {
    const response = await route.DELETE(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "outcome_unknown", retryWrite: false, modelCallStarted: false });
    assert.deepEqual(writes, ["hold-a"]);
  } finally { tx.amuxIdeaTransferPreview.findUnique = writer; }

  writerFailure = new Error("connection lost");
  holds = [newHold("hold-a")];
  const lost = await route.DELETE(request());
  assert.equal(lost.status, 503);
  assert.equal((await lost.json()).error, "outcome_unknown");
});
