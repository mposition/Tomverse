import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const id = "34340477-7664-42f4-b3fe-845d10365051";
const session = { user: { id: "synthetic-owner" } };
let current: typeof session | null = session;
let role = "owner";
let recent = true;
let writes = 0;
let reads = 0;
let storeError: string | null = null;
let savedRow: { id: string; version: number; limitMicroUsd: bigint; approvalAuditLogId: string } | null = null;
class SettingError extends Error { constructor(readonly code: string) { super(code); } }

mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: { getServerSession: async () => current } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => !!current, getAdminRole: () => role } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new Error("synthetic-reauth"); },
  isAdminReauthenticationError: (e: unknown) => e instanceof Error && e.message === "synthetic-reauth",
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: async () => [] }),
  amuxIdeaAnalysisBudgetSetting: { findUnique: async () => { reads++; return savedRow; } },
} } });
mock.module(mod("lib/amux/ideaAnalysisBudgetReservationService.ts"), { namedExports: { AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH: true } });
mock.module(mod("lib/amux/ideaAnalysisBudgetSettingStore.ts"), { namedExports: {
  AnalysisBudgetSettingError: SettingError,
  readAnalysisBudgetSnapshot: async () => { reads++; return { version: 0, limitMicroUsd: "50000000",
    monthStart: "2026-10-01T00:00:00.000Z", spentMicroUsd: "42240000", reservedMicroUsd: "0", remainingMicroUsd: "7760000" }; },
  commitAnalysisBudgetSetting: async (_tx: unknown, body: { id: string; monthlyUsd: string; ownerConfirmed: boolean }) => {
    if (storeError) throw new SettingError(storeError);
    writes++; assert.equal(body.id, id); assert.equal(body.monthlyUsd, "1000"); assert.equal(body.ownerConfirmed, true);
    return { id, version: 1, limitMicroUsd: "1000000000", auditId: "synthetic-audit" };
  },
} });
const realApiSecurity = createRequire(import.meta.url)(resolve(root, "lib/apiSecurity.ts"));
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} } });
let GET: (request: Request) => Promise<Response>;
let POST: (request: Request) => Promise<Response>;
before(async () => { ({ GET, POST } = await import(mod("app/api/admin/amux/ideas/analysis-budget-settings/route.ts"))); });
function reset() {
  current = session; role = "owner"; recent = true; writes = 0; reads = 0; storeError = null; savedRow = null;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ = "enabled";
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE = "enabled";
}
const request = (body: unknown = { id, expectedPreviousVersion: 0, monthlyUsd: "1000", ownerConfirmed: true }) =>
  new Request("https://tomverse.app/api/admin/amux/ideas/analysis-budget-settings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (query = "") => new Request(`https://tomverse.app/api/admin/amux/ideas/analysis-budget-settings${query}`);

test("signed-out, non-owner, and stale sessions never read or change the budget", async () => {
  reset(); current = null; assert.equal((await GET(get())).status, 404);
  reset(); role = "ops"; assert.equal((await POST(request())).status, 403);
  reset(); recent = false; assert.equal((await POST(request())).status, 428);
  assert.equal(reads, 0); assert.equal(writes, 0);
});
test("snapshot uses private no-store and exact-ID readback exposes only numeric approval metadata", async () => {
  reset(); const snapshot = await GET(get());
  assert.match(snapshot.headers.get("cache-control")!, /private, no-store/);
  assert.equal((await snapshot.json()).remainingMicroUsd, "7760000");
  savedRow = { id, version: 1, limitMicroUsd: BigInt(1_000_000_000), approvalAuditLogId: "synthetic-audit" };
  assert.deepEqual(await (await GET(get(`?id=${id}`))).json(), { state: "saved", id, version: 1,
    limitMicroUsd: "1000000000", auditId: "synthetic-audit" });
  savedRow = null;
  assert.deepEqual(await (await GET(get(`?id=${id}`))).json(), { state: "not_visible", retryWrite: false });
});
test("existing budget switches fail closed before the writer", async () => {
  reset(); delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ;
  assert.equal((await GET(get())).status, 409);
  assert.equal((await POST(request())).status, 409);
  reset(); delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE;
  assert.equal((await POST(request())).status, 409); assert.equal(writes, 0);
});
test("strict input rejects omitted confirmation, unbounded body, extra fields and malformed IDs", async () => {
  for (const body of [{ id, expectedPreviousVersion: 0, monthlyUsd: "1000" },
    { id, expectedPreviousVersion: 0, monthlyUsd: "1000", ownerConfirmed: true, extra: true },
    { id: "not-an-id", expectedPreviousVersion: 0, monthlyUsd: "1000", ownerConfirmed: true },
    { id, expectedPreviousVersion: 0, monthlyUsd: "1".repeat(3000), ownerConfirmed: true }]) {
    reset(); assert.ok((await POST(request(body))).status >= 400); assert.equal(writes, 0);
  }
  reset(); assert.equal((await GET(get(`?id=${id}&id=${id}`))).status, 409); assert.equal(reads, 0);
});
test("success records the exact owner setting but never dispatches analysis", async () => {
  reset(); const response = await POST(request());
  assert.equal(response.status, 201); assert.equal(writes, 1);
  assert.deepEqual(await response.json(), { state: "saved", id, version: 1, limitMicroUsd: "1000000000", auditId: "synthetic-audit" });
});
test("a stale save returns a known refusal rather than claiming it was recorded", async () => {
  reset(); storeError = "revision_changed";
  const response = await POST(request()); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "revision_changed", retryWrite: false });
  assert.equal(writes, 0);
});
