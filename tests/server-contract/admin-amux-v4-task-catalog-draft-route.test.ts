import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let role = "owner";
const rateKeys: string[] = [];
const drafts: unknown[] = [];
let draftResult: Record<string, unknown> = { ok: true, catalog: {} };

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => ({ user: { id: "owner-1" } }),
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true,
  getAdminRole: () => role,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {},
  isAdminReauthenticationError: () => false,
} });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
  hasValidMutationOrigin: () => true,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async (_request: Request, _user: string, key: string) => {
    rateKeys.push(key);
  },
  apiSecurityResponse: () => null,
  readLimitedText: (request: Request) => request.text(),
} });
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
  AmuxV4TaskCatalogApprovalError: class extends Error { code = "unavailable"; },
  approveAmuxV4TaskCatalog: async () => { throw new Error("approve must not run"); },
  previewAmuxV4TaskCatalog: async () => { throw new Error("preview must not run"); },
  draftAmuxV4TaskCatalog: async (caps: unknown) => { drafts.push(caps); return draftResult; },
} });

const route = import(mod("app/api/admin/amux/task-cost-catalog/route.ts"));
const caps = {
  routine: { inputTokens: 300_000, outputTokens: 30_000, maxAttempts: 2 },
  advanced: { inputTokens: 600_000, outputTokens: 60_000, maxAttempts: 2 },
  frontier: { inputTokens: 1_000_000, outputTokens: 128_000, maxAttempts: 3 },
};
const post = async (body: unknown) => (await route).POST(new Request(
  "https://tomverse.test/api/admin/amux/task-cost-catalog", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

test("a draft takes only grade caps and has its own rate limit", async () => {
  const response = await post({ action: "draft", caps });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(drafts, [caps]);
  assert.deepEqual(rateKeys, ["admin-amux-v4-task-cost-catalog-draft"]);
});

test("a draft request cannot carry a price or an unknown grade", async () => {
  drafts.length = 0; rateKeys.length = 0;
  for (const body of [
    { action: "draft", caps, prices: [{ modelId: "claude-sonnet-5", input: 0 }] },
    { action: "draft", caps: { ...caps, routine: { ...caps.routine,
      uncachedInputMicroUsdPerMillion: 1 } } },
    { action: "draft", caps: { ...caps, extra: caps.routine } },
    { action: "draft", caps: { ...caps, routine: { ...caps.routine, maxAttempts: 0 } } },
  ]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.deepEqual(drafts, []);
  assert.ok(rateKeys.every((key) => key === "admin-amux-v4-task-cost-catalog"),
    "a refused body counts against the write limit, not the draft limit");
});

test("a draft with no priced worker answers 409 with the skipped list", async () => {
  draftResult = { ok: false, code: "no_priced_worker",
    skipped: [{ workerName: "w", modelId: "m", reason: "price_missing" }] };
  const response = await post({ action: "draft", caps });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), draftResult);
});

test("only the owner reaches the draft", async () => {
  drafts.length = 0; role = "admin";
  assert.equal((await post({ action: "draft", caps })).status, 403);
  assert.deepEqual(drafts, []);
  role = "owner";
});
