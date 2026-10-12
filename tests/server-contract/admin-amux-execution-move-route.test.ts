import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const world = { session: { user: { id: "owner-1" } } as
  { user: { id: string } } | null, role: "owner", recent: true,
  writes: 0, reads: 0, rateChecks: 0 };
let installed = false;
async function loadRoute(): Promise<{
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: {
      getServerSession: async () => world.session,
    } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null,
      getAdminRole: () => world.role,
    } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => {
        if (!world.recent) throw new Error("reauth");
      },
      isAdminReauthenticationError: (error: unknown) =>
        error instanceof Error && error.message === "reauth",
    } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => { world.rateChecks += 1; },
      apiSecurityResponse: (error: unknown) =>
        error instanceof Error && error.message === "invalid request" ?
          Response.json({ error: "Invalid request payload.",
            code: "INVALID_REQUEST" }, { status: 400 }) : null,
      readLimitedJson: async (request: Request, limit: number, schema: {
        safeParse: (value: unknown) => { success: boolean; data: unknown },
      }) => {
        const raw = await request.text();
        if (raw.length > limit) throw new Error("invalid request");
        const parsed = schema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new Error("invalid request");
        return parsed.data;
      },
    } });
    mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
      hasValidMutationOrigin: (request: Request) =>
        request.headers.get("origin") === "https://tomverse.test",
    } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/adminExecutionMoveService.ts"), { namedExports: {
      readAdminExecutionMove: async (taskId: string, requestId: string) => {
        world.reads += 1;
        return { state: "promoted", taskId, requestId,
          receiptId: requestId, destination: "amux_unassigned_todo",
          fromRevision: 4, revision: 5 };
      },
      moveAdminExecutionCard: async (input: { taskId: string;
        expectedRevision: number; requestId: string }) => {
        world.writes += 1;
        return { state: "promoted", promoted: true, taskId: input.taskId,
          requestId: input.requestId, receiptId: input.requestId,
          destination: "amux_unassigned_todo",
          fromRevision: input.expectedRevision,
          revision: input.expectedRevision + 1, replayed: false };
      },
    } });
  }
  return import(mod("app/api/admin/amux/execution-move/route.ts"));
}

const URL = "https://tomverse.test/api/admin/amux/execution-move";
const requestId = "a7a159cf-0c64-4bc6-b640-8fc5dc466fed";
const valid = { taskId: "task-1234", expectedRevision: 4, requestId };
const post = (body: unknown, origin = "https://tomverse.test") =>
  new Request(URL, { method: "POST", headers: {
    "content-type": "application/json", origin }, body: JSON.stringify(body) });
const read = (taskId = valid.taskId, id = requestId) =>
  new Request(`${URL}?taskId=${encodeURIComponent(taskId)}&requestId=${encodeURIComponent(id)}`);
const reset = () => { world.session = { user: { id: "owner-1" } };
  world.role = "owner"; world.recent = true; world.writes = 0;
  world.reads = 0; world.rateChecks = 0; };

test("execution move read and write require a recently authenticated owner", async () => {
  const { GET, POST } = await loadRoute();
  for (const [session, role, recent, expected] of [
    [null, "owner", true, 404],
    [{ user: { id: "owner-1" } }, "admin", true, 403],
    [{ user: { id: "owner-1" } }, "owner", false, 428],
  ] as const) {
    reset(); world.session = session; world.role = role; world.recent = recent;
    assert.equal((await POST(post(valid))).status, expected);
    assert.equal((await GET(read())).status, expected);
    assert.equal(world.writes, 0);
    assert.equal(world.reads, 0);
  }
});

test("execution move accepts only the exact bounded same-origin command", async () => {
  const { POST } = await loadRoute();
  reset();
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, taskId: "x".repeat(81) },
    { ...valid, requestId: "not-a-uuid" },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 4.5 },
  ]) {
    assert.equal((await POST(post(invalid))).status, 400);
    assert.equal(world.writes, 0);
  }
  assert.equal((await POST(post(valid, "https://elsewhere.test"))).status, 403);
  assert.equal(world.writes, 0);
  const accepted = await POST(post(valid));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { state: "promoted",
    promoted: true, taskId: valid.taskId, requestId,
    receiptId: requestId, destination: "amux_unassigned_todo",
    fromRevision: 4, revision: 5, replayed: false });
  assert.equal(world.writes, 1);
  assert.equal(accepted.headers.get("cache-control"),
    "private, no-store, max-age=0");
});

test("execution move GET is bounded read-back and never invokes the writer", async () => {
  const { GET } = await loadRoute();
  reset();
  for (const invalid of [read("bad space"), read(valid.taskId, "bad")]) {
    assert.equal((await GET(invalid)).status, 400);
    assert.equal(world.reads, 0);
  }
  const response = await GET(read());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "promoted",
    taskId: valid.taskId, requestId, receiptId: requestId,
    destination: "amux_unassigned_todo", fromRevision: 4, revision: 5 });
  assert.equal(world.reads, 1);
  assert.equal(world.writes, 0);
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
});
