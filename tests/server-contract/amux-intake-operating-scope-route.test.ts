import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { before, mock, test } from "node:test";

// docs/policy/amux-intake.md v19 item 2: the owner operating scope route.
const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const id = "34340477-7664-42f4-b3fe-845d10365051";
const session = { user: { id: "synthetic-owner" } };
const scope = { repositories: ["mposition/Tomverse"],
  model: { provider: "anthropic", modelId: "claude-opus-5-5", reasoningEffort: "high" } };
let current: typeof session | null = session;
let role = "owner";
let recent = true;
let writes = 0;
let reads = 0;
let storeError: string | null = null;
let stored: { version: number; scope: typeof scope } | null = null;
let savedRow: Record<string, unknown> | null = null;
class ScopeError extends Error { constructor(readonly code: string) { super(code); } }

mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: { getServerSession: async () => current } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => !!current, getAdminRole: () => role } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new Error("synthetic-reauth"); },
  isAdminReauthenticationError: (e: unknown) => e instanceof Error && e.message === "synthetic-reauth",
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: async () => [] }),
  amuxIdeaOperatingScopeSetting: { findUnique: async () => { reads++; return savedRow; } },
} } });
mock.module(mod("lib/amux/ideaOperatingScopeStore.ts"), { namedExports: {
  AmuxOperatingScopeError: ScopeError,
  readAmuxOperatingScope: async () => { reads++; return stored; },
  commitAmuxOperatingScope: async (_tx: unknown, body: { id: string; scope: unknown; ownerConfirmed: boolean }) => {
    if (storeError) throw new ScopeError(storeError);
    writes++; assert.equal(body.id, id); assert.deepEqual(body.scope, scope); assert.equal(body.ownerConfirmed, true);
    return { id, version: 1, scope, auditId: "synthetic-audit" };
  },
} });
const realApiSecurity = createRequire(import.meta.url)(resolve(root, "lib/apiSecurity.ts"));
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} } });
let GET: (request: Request) => Promise<Response>;
let POST: (request: Request) => Promise<Response>;
before(async () => { ({ GET, POST } = await import(mod("app/api/admin/amux/ideas/operating-scope/route.ts"))); });
function reset() {
  current = session; role = "owner"; recent = true; writes = 0; reads = 0; storeError = null; stored = null; savedRow = null;
}
const url = "https://tomverse.app/api/admin/amux/ideas/operating-scope";
const request = (body: unknown = { id, expectedPreviousVersion: 0, scope, ownerConfirmed: true }) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (query = "") => new Request(`${url}${query}`);

test("signed-out, non-owner and stale sessions never read or change the scope", async () => {
  reset(); current = null; assert.equal((await GET(get())).status, 404);
  reset(); role = "ops"; assert.equal((await GET(get())).status, 403);
  reset(); role = "ops"; assert.equal((await POST(request())).status, 403);
  reset(); recent = false; assert.equal((await POST(request())).status, 428);
  assert.equal(reads, 0); assert.equal(writes, 0);
});

test("the current scope and an exact-ID read-back are private and no-store", async () => {
  reset();
  const none = await GET(get());
  assert.match(none.headers.get("cache-control")!, /private, no-store/);
  assert.deepEqual(await none.json(), { state: "none", version: 0 });
  stored = { version: 2, scope };
  assert.deepEqual(await (await GET(get())).json(), { state: "current", version: 2, scope });
  savedRow = { id, version: 1, repositories: scope.repositories, modelProvider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high", approvalAuditLogId: "synthetic-audit" };
  assert.deepEqual(await (await GET(get(`?id=${id}`))).json(),
    { state: "saved", id, version: 1, scope, auditId: "synthetic-audit" });
  savedRow = null;
  assert.deepEqual(await (await GET(get(`?id=${id}`))).json(), { state: "not_visible", retryWrite: false });
});

test("strict input rejects a missing confirmation, extra fields, malformed IDs and repeated query keys", async () => {
  for (const body of [{ id, expectedPreviousVersion: 0, scope },
    { id, expectedPreviousVersion: 0, scope, ownerConfirmed: true, extra: true },
    { id: "not-an-id", expectedPreviousVersion: 0, scope, ownerConfirmed: true }]) {
    reset(); assert.ok((await POST(request(body))).status >= 400); assert.equal(writes, 0);
  }
  reset(); assert.equal((await GET(get(`?id=${id}&id=${id}`))).status, 400); assert.equal(reads, 0);
  reset(); assert.equal((await GET(get("?id=not-an-id"))).status, 400);
});

test("a save records the exact scope; a refusal says what it was and never claims a write", async () => {
  reset();
  const response = await POST(request());
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { state: "saved", id, version: 1, scope, auditId: "synthetic-audit" });
  for (const [code, status] of [["revision_changed", 409], ["request_already_seen", 409],
    ["invalid_scope", 400], ["scope_unavailable", 503]] as const) {
    reset(); storeError = code;
    const refused = await POST(request());
    assert.equal(refused.status, status, code);
    assert.deepEqual(await refused.json(), { error: code, retryWrite: false });
    assert.equal(writes, 0);
  }
});
