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
mock.module(mod("lib/amux/routing.ts"), { namedExports: {
  getConfiguredAmuxV22WorkerCatalog: () => [{ worker_name: "claude-chore", provider: "anthropic" }],
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async (client: unknown) => { assert.equal(client, tx); lockOrder.push("audit"); },
  writeSystemAuditLog: async (input: { tx: unknown; action: string }) => {
    assert.equal(input.tx, tx); assert.equal(input.action, "amux.quota.observed"); auditCalls += 1;
  },
} });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: { quotaObservationWrite: {}, quotaObservationRead: {} },
  withAmuxDbBoundary: async (_boundary: unknown, work: (tx: unknown, context: unknown) => Promise<unknown>) =>
    work(tx, { dbNow: now }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
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
  authorized = true;
  assert.equal((await post()).status, 200);
  assert.deepEqual(lockOrder.slice(0, 2), ["audit", "observation"]);
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
});
