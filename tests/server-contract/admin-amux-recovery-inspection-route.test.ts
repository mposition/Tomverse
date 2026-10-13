import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let signedIn = false; let role = "viewer"; let recent = false; let reads = 0;
let returnedState: "ready" | "changed" | "not_found" = "ready";
let received: unknown;
mock.module("next-auth/next", { namedExports: { getServerSession: async () =>
  signedIn ? { user: { id: "operator" } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => role, isAdminSession: () => true } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new Error("stepup"); },
  isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "stepup" } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => undefined, apiSecurityResponse: () => null } });
mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
  readAmuxExecutionBoard: async () => null, readAmuxExecutionBoardSnapshot: async () => null,
  readAmuxExecutionHierarchy: async () => null, readAmuxExecutionFeedback: async () => null,
  readAmuxExecutionTaskDetail: async () => { throw new Error("body_read_not_allowed"); } } });
mock.module(mod("lib/amux/ownerRecoveryInspectionRead.ts"), { namedExports: {
  readAmuxOwnerRecoveryInspection: async (identity: unknown) => { reads += 1; received = identity;
    return { state: returnedState, inspection: { safe: true } }; } } });
const route = import(mod("app/api/admin/amux/execution-view/route.ts"));
const url = "https://tomverse.test/api/admin/amux/execution-view?view=recovery_inspection&taskId=task-1&taskRevision=4&attemptId=attempt-1";
test("recovery inspection is owner-only, recent-authenticated, identity-bound and no-store", async () => {
  const { GET } = await route;
  assert.equal((await GET(new Request(url))).status, 404);
  signedIn = true; assert.equal((await GET(new Request(url))).status, 404);
  role = "owner"; assert.equal((await GET(new Request(url))).status, 428); assert.equal(reads, 0);
  recent = true;
  for (const bad of [url + "&attemptId=another", url + "&force=true",
    url.replace("taskRevision=4", "taskRevision=0"), url.replace("taskRevision=4", "taskRevision=04"),
    url.replace("taskRevision=4", "taskRevision=9007199254740993"),
    url.replace("attemptId=attempt-1", "attemptId=%2Fsecret")])
    assert.equal((await GET(new Request(bad))).status, 400);
  assert.equal(reads, 0);
  const response = await GET(new Request(url)); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(received, { taskId: "task-1", taskRevision: 4, attemptId: "attempt-1" });
  returnedState = "changed"; assert.equal((await GET(new Request(url))).status, 409);
  returnedState = "not_found"; assert.equal((await GET(new Request(url))).status, 404);
  returnedState = "ready"; assert.equal((await GET(new Request(url.replace("&attemptId=attempt-1", "")))).status, 200);
  assert.deepEqual(received, { taskId: "task-1", taskRevision: 4, attemptId: null });
});
