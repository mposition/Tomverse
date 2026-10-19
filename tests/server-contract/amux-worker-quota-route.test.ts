import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authorized = true, auditCalls = 0, writeCalls = 0;
const lockOrder: string[] = [];
const rows = new Map<string, Record<string, unknown>>();
const now = new Date("2026-10-12T00:00:00.000Z");
const tx = {
  $executeRaw: async () => { lockOrder.push("observation"); return 1; },
  amuxQuotaObservation: {
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writeCalls += 1; const row = { ...data, createdAt: now }; rows.set(String(data.id), row); return row;
    },
  },
};
mock.module(mod("lib/amux/guard.ts"), { namedExports: { isAmuxSyncAuthorized: () => authorized } });
// Orchestration policy version 35, section 3: the route checks the worker
// against the derived catalog, read inside the write's own transaction.
mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxAssignmentCatalogs: async (client: unknown, ...rest: unknown[]) => {
    assert.equal(client, tx); assert.deepEqual(rest, []); lockOrder.push("catalog");
    return { workers: null, ceilings: null,
      v22: [{ worker_name: "claude-chore", provider: "anthropic" }] };
  },
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async (client: unknown) => { assert.equal(client, tx); lockOrder.push("audit"); },
  writeSystemAuditLog: async (input: { tx: unknown; action: string }) => {
    assert.equal(input.tx, tx); assert.equal(input.action, "amux.quota.observed"); auditCalls += 1;
  },
} });
// The real shared error answer (lib/amux/internalRoute.ts) runs against these
// stand-ins, so the classification under test is the production one.
class AmuxDbBoundaryError extends Error {
  constructor(readonly code: string, operation: string) { super(`${code}:${operation}`); this.name = "AmuxDbBoundaryError"; }
}
let boundaryFailure: unknown = null;
// Only inside a route budget does the real boundary call a transaction that
// never started busy; outside one it stays an outcome-unknown P2028.
const LIFECYCLE_BUDGET_MS = 12_000;
let openRouteBudgets = 0;
const routeBudgetsUsed: number[] = [];
const quotaWriteBoundary = {};
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: { quotaObservationWrite: quotaWriteBoundary, quotaObservationRead: {} },
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: LIFECYCLE_BUDGET_MS,
  AmuxDbBoundaryError,
  admitAmuxOrchestratorWrite: async () => ({ admitted: true }),
  amuxRouteOrchestratorReceiptsMayHaveCommitted: () => false,
  withAmuxRouteBudget: async (work: () => Promise<unknown>, maxMs: number) => {
    routeBudgetsUsed.push(maxMs); openRouteBudgets += 1;
    try { return await work(); } finally { openRouteBudgets -= 1; }
  },
  withAmuxDbBoundary: async (boundary: unknown, work: (tx: unknown, context: unknown) => Promise<unknown>) => {
    if (boundary === quotaWriteBoundary) assert.ok(openRouteBudgets > 0, "quota write outside a route budget");
    if (boundaryFailure) throw boundaryFailure;
    return work(tx, { dbNow: now });
  },
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  ApiSecurityError: class ApiSecurityError extends Error {},
  readLimitedJson: async (request: Request, _limit: number, schema: { parse: (v: unknown) => unknown }) =>
    schema.parse(JSON.parse(await request.text())),
  apiSecurityResponse: () => null,
} });
const routeModule = import(mod("app/api/internal/amux/quota/route.ts"));
const id = "00000000-0000-4000-8000-000000000001";
const body = { observation_id: id, worker: "claude-chore", provider: "anthropic",
  remaining_basis_points: 7400, confidence_basis_points: 10000, exhausted: false,
  source: "provider_api", observed_at: now.toISOString(), reset_at: "2026-10-12T07:00:00.000Z" };
const post = async (payload = body) => (await routeModule).POST(new Request("https://test.invalid/api/internal/amux/quota",
  { method: "POST", body: JSON.stringify(payload) }));

test("quota report authenticates, stores and audits once, and supports exact lost-response lookup", async () => {
  const route = await routeModule;
  authorized = false;
  assert.equal((await post()).status, 401);
  assert.equal(writeCalls, 0);
  assert.deepEqual(routeBudgetsUsed, [], "an unauthorized call starts no route budget");
  authorized = true;
  assert.equal((await post()).status, 200);
  // The bridge allows 15 s for a quota POST: the lifecycle route budget.
  assert.deepEqual(routeBudgetsUsed, [LIFECYCLE_BUDGET_MS]);
  // The derived catalog is read before anything is locked or written.
  assert.deepEqual(lockOrder.slice(0, 3), ["catalog", "audit", "observation"]);
  assert.equal(writeCalls, 1); assert.equal(auditCalls, 1);
  assert.equal((await post()).status, 200, "same observation must be idempotent");
  assert.equal(writeCalls, 1); assert.equal(auditCalls, 1);
  assert.equal((await post({ ...body, remaining_basis_points: 7300 })).status, 409);
  const lookup = await route.GET(new Request(`https://test.invalid/api/internal/amux/quota?observation_id=${id}`));
  assert.equal(lookup.headers.get("cache-control"), "no-store");
  assert.deepEqual(await lookup.json(), { found: true, observation: body });
  authorized = false;
  assert.equal((await route.GET(new Request(`https://test.invalid/api/internal/amux/quota?observation_id=${id}`))).status, 401);
  authorized = true;
});

test("quota report cannot invent a worker/provider or launder old/future evidence", async () => {
  assert.equal((await post({ ...body, worker: "other-worker" })).status, 409);
  assert.equal((await post({ ...body, provider: "openai" })).status, 409);
  for (const observed_at of ["2026-10-11T23:00:00.000Z", "2026-10-12T01:00:00.000Z"]) {
    const result = await post({ ...body, observation_id: "00000000-0000-4000-8000-000000000002", observed_at });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).reason, "observation_not_fresh");
  }
  assert.equal(writeCalls, 1); assert.equal(auditCalls, 1);
});

test("quota lookup is exact and distinct observations keep separate identities", async () => {
  const route = await routeModule;
  const missingId = "00000000-0000-4000-8000-000000000003";
  const lookup = (key: string) => route.GET(new Request(`https://test.invalid/api/internal/amux/quota?observation_id=${key}`));
  assert.deepEqual(await (await lookup(missingId)).json(), { found: false });
  assert.equal((await lookup("not-an-id")).status, 400);
  const secondId = "00000000-0000-4000-8000-000000000004";
  const results = await Promise.all([post({ ...body, observation_id: missingId }),
    post({ ...body, observation_id: secondId })]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(writeCalls, 3); assert.equal(auditCalls, 3);
  assert.equal(rows.size, 3);
  for (const observation_id of [missingId, secondId]) assert.deepEqual(await (await lookup(observation_id)).json(),
    { found: true, observation: { ...body, observation_id } });
});

test("a failed quota write is logged and says whether anything committed", async () => {
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  const before = { writes: writeCalls, audits: auditCalls };
  const fresh = (n: number) => ({ ...body, observation_id: `00000000-0000-4000-8000-00000000001${n}` });
  try {
    // A transaction the pool never started wrote nothing: busy, not unknown.
    boundaryFailure = new AmuxDbBoundaryError("AMUX_DB_NOT_STARTED", "quota_observation_write");
    const busy = await post(fresh(1));
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).reason, "amux_database_busy");
    assert.ok(busy.headers.get("retry-after"));
    const busyLine = JSON.parse(String(warn.mock.calls.at(-1)?.arguments[0]));
    assert.equal(busyLine.event, "internal_route_database_busy");
    assert.equal(busyLine.operation, "quota_observation_write");

    // A statement timeout rolled the transaction back: deadline, not unknown.
    boundaryFailure = Object.assign(new Error("raw query failed"), { code: "P2010", meta: { code: "57014" } });
    const late = await post(fresh(2));
    assert.equal(late.status, 503);
    assert.equal((await late.json()).reason, "amux_database_deadline_exceeded");
    // Usually a wait for the audit chain lock; the line is the only trace.
    assert.deepEqual(JSON.parse(String(warn.mock.calls.at(-1)?.arguments[0])), {
      subsystem: "amux", event: "internal_route_deadline_exceeded",
      operation: "quota_observation_write", error_code: "57014",
    });

    // Anything else is still a 500, but no longer a silent one.
    boundaryFailure = new Error("unexpected");
    const failed = await post(fresh(3));
    assert.equal(failed.status, 500);
    const incidentId = failed.headers.get("x-amux-incident-id");
    assert.ok(incidentId);
    assert.equal((await failed.json()).incident_id, incidentId);
    const failureLine = JSON.parse(String(error.mock.calls.at(-1)?.arguments[0]));
    assert.equal(failureLine.event, "internal_route_failure");
    assert.equal(failureLine.operation, "quota_observation_write");
    assert.equal(failureLine.incident_id, incidentId);
    assert.deepEqual({ writes: writeCalls, audits: auditCalls }, before);
  } finally {
    boundaryFailure = null;
    warn.mock.restore();
    error.mock.restore();
  }
});
