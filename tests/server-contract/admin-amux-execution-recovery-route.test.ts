import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import { BoardImportError } from "../../lib/amux/boardImportCore.ts";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const state = { session: { user: { id: "owner" } } as { user: { id: string } } | null,
  role: "owner", recent: true, calls: 0, failure: false };
mock.module("next-auth/next", { namedExports: { getServerSession: async () => state.session } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => state.session !== null, getAdminRole: () => state.role } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!state.recent) throw new Error("reauth"); },
  isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth",
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: { hasValidMutationOrigin: (request: Request) => request.headers.get("origin") === "https://tomverse.test" } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: (error: unknown) => error instanceof Error && error.message === "invalid" ?
    Response.json({ code: "INVALID_REQUEST" }, { status: 400 }) : null,
  readLimitedJson: async (request: Request, limit: number, schema: { safeParse: (raw: unknown) => { success: boolean; data: unknown } }) => {
    const text = await request.text(); if (text.length > limit) throw new Error("invalid");
    const result = schema.safeParse(JSON.parse(text)); if (!result.success) throw new Error("invalid"); return result.data;
  },
} });
const result = async () => { state.calls++; if (state.failure) throw new BoardImportError("outcome_unknown", 409);
  return { state: "pending", retryWrite: false }; };
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  requestAmuxV22RecoveryInspection: result, approveAmuxV22TaskRecovery: result, readAmuxV22TaskRecovery: result,
} });
const url = "https://tomverse.test/api/admin/amux/execution-recovery";
const requestId = "530abfe8-b2e0-4b58-bef9-ea5a63a2e90d";
const valid = { action: "request_inspection", taskId: "task-1234", expectedRevision: 8, priorAttemptId: requestId, requestId };
const post = (value: unknown, origin = "https://tomverse.test") => new Request(url, {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
const read = () => new Request(`${url}?taskId=task-1234&requestId=${requestId}`);
const route = () => import(mod("app/api/admin/amux/execution-recovery/route.ts"));
const reset = () => { state.session = { user: { id: "owner" } }; state.role = "owner";
  process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED = "true";
  state.recent = true; state.calls = 0; state.failure = false; };
test("read and mutation require exact owner authentication before touching the service", async () => {
  const { GET, POST } = await route();
  for (const variant of ["missing", "role", "reauth"] as const) {
    reset(); if (variant === "missing") state.session = null;
    if (variant === "role") state.role = "ops";
    if (variant === "reauth") state.recent = false;
    const expected = variant === "missing" ? 404 : variant === "role" ? 403 : 428;
    assert.equal((await GET(read())).status, expected); assert.equal((await POST(post(valid))).status, expected);
    assert.equal(state.calls, 0);
  }
});
test("strict same-origin requests cannot provide arbitrary commands, bodies, or cap amounts", async () => {
  reset(); const { POST } = await route();
  assert.equal((await POST(post(valid, "https://other.test"))).status, 403);
  for (const changed of [{ command: "restart" }, { stdout: "secret" }, { newCapMicroUsd: "0" },
    { expectedRevision: -1 }, { requestId: "not-a-uuid" }])
    assert.equal((await POST(post({ ...valid, ...changed }))).status, 400);
  assert.equal(state.calls, 0);
  const response = await POST(post(valid)); assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-store/);
});
test("uncertain writes return a closed outcome and read-back never exposes a retry grant", async () => {
  reset(); const { POST, GET } = await route(); state.failure = true;
  const response = await POST(post(valid)); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "outcome_unknown", retry: false });
  state.failure = false; assert.deepEqual(await (await GET(read())).json(), { state: "pending", retryWrite: false, recoveryEnabled: true });
});
test("the independent recovery master flag defaults off while owner metadata read remains available", async () => {
  reset(); delete process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED;
  const { POST, GET } = await route();
  const response = await POST(post(valid)); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "recovery_disabled" });
  assert.equal(state.calls, 0);
  assert.deepEqual(await (await GET(read())).json(), { state: "pending", retryWrite: false, recoveryEnabled: false });
});
