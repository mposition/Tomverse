import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The owner queue's "ask the Decision Maker" button
// (app/api/admin/amux/owner-queue/dm-request): who may press it, what refuses
// before the service runs, and how each answer of the service is returned.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

const world = {
  session: { user: { id: "operator-1" } } as { user: { id: string } } | null,
  canWrite: true,
  calls: [] as Array<Record<string, unknown>>,
  outcome: "done" as "done" | "refused" | "throw",
};
const reset = () => {
  world.session = { user: { id: "operator-1" } }; world.canWrite = true; world.calls = []; world.outcome = "done";
};

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null,
      hasAdminPermission: (_session: unknown, permission: string) => permission === "ops:write" && world.canWrite } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => {},
      apiSecurityResponse: (error: unknown) => error instanceof Error && error.message === "invalid request" ?
        Response.json({ error: "Invalid request payload." }, { status: 400 }) : null,
      readLimitedJson: async (request: Request, limit: number, schema: {
        safeParse: (value: unknown) => { success: boolean; data: unknown } }) => {
        const raw = await request.text();
        if (raw.length > limit) throw new Error("invalid request");
        const parsed = schema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new Error("invalid request");
        return parsed.data;
      } } });
    mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
      hasValidMutationOrigin: (request: Request) => request.headers.get("origin") === "https://tomverse.test" } });
    mock.module(mod("lib/amux/ownerQueueDmRequestService.ts"), { namedExports: {
      requestAmuxOwnerQueueDm: async (input: Record<string, unknown>) => {
        const { session: _session, request: _request, ...rest } = input;
        world.calls.push(rest);
        if (world.outcome === "throw") throw new Error("database gone");
        return world.outcome === "done" ? { outcome: "done", settlementId: "s-1" } :
          { outcome: "refused", reason: "not_eligible" };
      } } });
  }
  return import(mod("app/api/admin/amux/owner-queue/dm-request/route.ts"));
}

const post = (body: unknown, headers: Record<string, string> = {}) => new Request(
  "https://tomverse.test/api/admin/amux/owner-queue/dm-request", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://tomverse.test", ...headers },
    body: JSON.stringify(body) });
const valid = { taskId: "task-1", source: "settlement", action: "request", sourceId: "esc-1" };

test("an operator's press reaches the service once and answers requested", async () => {
  reset();
  const { POST } = await loadRoute();
  const response = await POST(post(valid));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "requested", settlementId: "s-1" });
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(world.calls, [valid]);
});

test("nobody without ops:write from this origin reaches the service, and only the known shapes pass", async () => {
  const { POST } = await loadRoute();
  reset(); world.session = null;
  assert.equal((await POST(post(valid))).status, 404);
  reset(); world.canWrite = false;
  assert.equal((await POST(post(valid))).status, 403);
  reset();
  assert.equal((await POST(post(valid, { origin: "https://elsewhere.test" }))).status, 403);
  assert.equal((await POST(post(valid, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await POST(post({ ...valid, source: "question" }))).status, 400);
  assert.equal((await POST(post({ ...valid, action: "delete" }))).status, 400);
  assert.equal((await POST(post({ ...valid, extra: 1 }))).status, 400);
  assert.equal((await POST(post({ ...valid, sourceId: "../x" }))).status, 400);
  assert.deepEqual(world.calls, []);
});

test("a refusal and an unknown outcome each answer as such", async () => {
  const { POST } = await loadRoute();
  reset(); world.outcome = "refused";
  let response = await POST(post(valid));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "refused", reason: "not_eligible" });
  reset(); world.outcome = "throw";
  response = await POST(post(valid));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "outcome_unknown" });
});
