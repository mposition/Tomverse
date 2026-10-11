import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authenticated = false;
let role = "owner";
let recent = true;
let reads = 0;
const result = { stageId: "prompt-refiner-vnext-one-shot-v4",
  stageStatus: "run_approved", valid: true, reservedSlots: 80,
  terminalReceipts: 0, unknownReceipts: 0, consumedWithoutReceipt: 0,
  observedCostMicroUsd: 0, unresolvedCostUpperBoundMicroUsd: 0, slots: [] };

mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
  getServerSession: async () => authenticated ? { user: { id: "synthetic-owner" } } : null,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => authenticated, getAdminRole: () => role,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {
    if (!recent) throw new Error("reauth");
  },
  isAdminReauthenticationError: (error: unknown) =>
    error instanceof Error && error.message === "reauth",
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
} });
mock.module(mod("lib/readOnlySnapshotTransaction.ts"), { namedExports: {
  readOnlySnapshotTransaction: async (work: (tx: object) => Promise<unknown>) =>
    work({}),
} });
mock.module(mod("lib/promptRefinerVnextOneShotTerminalReceipt.ts"), {
  namedExports: { readPromptRefinerVnextOneShotTerminalReceipts: async () => {
    reads++;
    return result;
  } },
});

const request = () => new Request(
  "https://example.test/api/admin/prompt-refiner/vnext-terminal-readback");

test("terminal readback requires owner and recent authentication", async () => {
  const route = await import(mod(
    "app/api/admin/prompt-refiner/vnext-terminal-readback/route.ts"));
  assert.equal((await route.GET(request())).status, 404);
  authenticated = true;
  role = "ops";
  assert.equal((await route.GET(request())).status, 403);
  role = "owner";
  recent = false;
  assert.equal((await route.GET(request())).status, 428);
  assert.equal(reads, 0);
  recent = true;
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { readback: result });
  assert.equal(reads, 1);
  assert.equal(route.POST, undefined);
});
