import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const world = { session: { user: { id: "owner-1" } } as
  { user: { id: string } } | null, role: "owner", recent: true,
  writes: 0, reads: 0 };
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
      consumeApiRateLimit: async () => undefined,
      apiSecurityResponse: () => null,
      readLimitedJson: async (request: Request, limit: number, schema: {
        parse: (value: unknown) => unknown,
      }) => {
        const raw = await request.text();
        if (raw.length > limit) throw new Error("too large");
        return schema.parse(JSON.parse(raw));
      },
    } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/v22LaneDecisionService.ts"), { namedExports: {
      readV22LaneDecision: async (taskId: string) => {
        world.reads += 1;
        return { taskId, lane: "sev1", sequence: "17", assigned: false };
      },
      declareV22Lane: async (input: { taskId: string; lane: string }) => {
        world.writes += 1;
        return { taskId: input.taskId, lane: input.lane, sequence: "18" };
      },
    } });
  }
  return import(mod("app/api/admin/amux/v22-lane/route.ts"));
}

const URL = "https://tomverse.test/api/admin/amux/v22-lane";
const read = (taskId: string) => new Request(`${URL}?taskId=${taskId}`);
const post = (body: unknown) => new Request(URL, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const valid = { policyVersion: 22, taskId: "task-1234", lane: "parallel",
  expectedLaneSequence: "17" };
const reset = () => { world.session = { user: { id: "owner-1" } };
  world.role = "owner"; world.recent = true; world.writes = 0;
  world.reads = 0; };

test("lane read-back is owner-only and never writes", async () => {
  const { GET } = await loadRoute();
  reset(); world.session = null;
  assert.equal((await GET(read(valid.taskId))).status, 404);
  reset(); world.role = "admin";
  assert.equal((await GET(read(valid.taskId))).status, 403);
  reset();
  assert.equal((await GET(read("bad"))).status, 400);
  const response = await GET(read(valid.taskId));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { taskId: valid.taskId,
    lane: "sev1", sequence: "17", assigned: false });
  assert.equal(world.reads, 1);
  assert.equal(world.writes, 0);
});

test("lane declaration requires owner reauthentication and exact v22 body", async () => {
  const { POST } = await loadRoute();
  reset(); world.recent = false;
  assert.equal((await POST(post(valid))).status, 428);
  reset();
  for (const invalid of [{ ...valid, policyVersion: 21 },
    { ...valid, lane: "urgent" }, { ...valid, extra: true },
    { ...valid, expectedLaneSequence: 17 }]) {
    await assert.rejects(() => POST(post(invalid)));
    assert.equal(world.writes, 0);
  }
  const accepted = await POST(post(valid));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { taskId: valid.taskId,
    lane: "parallel", sequence: "18" });
  assert.equal(world.writes, 1);
});
