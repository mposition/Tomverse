import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let session: { user: { id: string } } | null = null;
let role = "viewer";
let adminSession = false;
let reads = 0;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => role,
  isAdminSession: () => adminSession,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => undefined,
  apiSecurityResponse: () => null,
} });
mock.module(mod("lib/amux/v22ExternalReadback.ts"), { namedExports: {
  readAmuxV22PrCreationOutcome: async () => {
    reads += 1;
    return { status: "outcome_unknown", reason: "pr_absent_or_conflicting" };
  },
} });

const route = import(mod("app/api/admin/amux/v22-pr-readback/route.ts"));
const url = "https://tomverse.test/api/admin/amux/v22-pr-readback" +
  `?branch=agent%2Fengineering%2Frun-1&base_sha=${"a".repeat(40)}` +
  `&head_sha=${"b".repeat(40)}`;

test("readback is owner-only, no-store, diagnostic and never a write", async () => {
  const { GET } = await route;
  reads = 0;
  session = null;
  assert.equal((await GET(new Request(url))).status, 404);
  session = { user: { id: "owner" } };
  role = "viewer";
  adminSession = true;
  assert.equal((await GET(new Request(url))).status, 404);
  assert.equal(reads, 0);
  role = "owner";
  adminSession = false;
  assert.equal((await GET(new Request(url))).status, 404);
  assert.equal(reads, 0);
  adminSession = true;
  const bad = await GET(new Request(`${url}&extra=1`));
  assert.equal(bad.status, 400);
  const response = await GET(new Request(url));
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), {
    status: "outcome_unknown", reason: "pr_absent_or_conflicting",
    diagnostic_only: true,
  });
  assert.equal(reads, 1);
});
