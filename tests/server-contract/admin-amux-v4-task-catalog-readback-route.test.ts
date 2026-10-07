import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let session: { user: { id: string } } | null = null;
let admin = false;
let role = "viewer";
let stepups = 0;
let rateCalls = 0;
let reads = 0;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => admin,
  getAdminRole: () => role,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { stepups += 1; },
  isAdminReauthenticationError: () => false,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => { rateCalls += 1; },
  apiSecurityResponse: () => null,
} });
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
  AmuxV4TaskCatalogApprovalError: class extends Error { code = "not_ready"; },
  readAmuxV4TaskCatalogApproval: async () => { reads += 1; return { ok: true }; },
} });

const route = import(mod("app/api/admin/amux/task-cost-catalog/[approvalId]/route.ts"));
const request = new Request("https://tomverse.test/api/admin/amux/task-cost-catalog/readback");
const context = { params: Promise.resolve({
  approvalId: "00000000-0000-4000-8000-000000000001" }) };

test("catalog readback conceals itself before owner check, step-up and rate limit", async () => {
  const { GET } = await route;
  assert.equal((await GET(request, context)).status, 404);
  session = { user: { id: "caller" } };
  assert.equal((await GET(request, context)).status, 404);
  admin = true;
  assert.equal((await GET(request, context)).status, 404);
  assert.deepEqual([stepups, rateCalls, reads], [0, 0, 0]);
  role = "owner";
  const response = await GET(request, context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual([stepups, rateCalls, reads], [1, 1, 1]);
});
