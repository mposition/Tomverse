import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The owner re-approves a waiting Task's cost ceiling
// (app/api/admin/amux/task-ceiling): who may act, what refuses before the
// service runs, and how each answer of the service is returned.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

class FakeOwnerError extends Error {
  constructor(readonly code: "forbidden" | "busy") { super(code); }
}

const world = {
  session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner", recent: true,
  closes: [] as Array<Record<string, unknown>>,
  outcome: "reapproved" as "reapproved" | "refused" | "not_found" | "busy" | "throw",
};
const reset = () => {
  world.session = { user: { id: "owner-1" } }; world.role = "owner"; world.recent = true;
  world.closes = []; world.outcome = "reapproved";
};

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null, getAdminRole: () => world.role } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth" } });
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
    mock.module(mod("lib/amux/legacyCardOwnerService.ts"), { namedExports: {
      AmuxLegacyCardOwnerError: FakeOwnerError,
      assertAmuxLegacyCardOwner: async () => { if (!world.recent) throw new Error("reauth"); } } });
    mock.module(mod("lib/amux/v4TaskCeilingReapprovalService.ts"), { namedExports: {
      reapproveAmuxV4TaskCeilingForOwner: async (input: Record<string, unknown>) => {
        const rest = { ...input };
        delete rest.session;
        delete rest.request;
        world.closes.push(rest);
        if (world.outcome === "busy") throw new FakeOwnerError("busy");
        if (world.outcome === "throw") throw new Error("database gone");
        if (world.outcome === "not_found") return { outcome: "not_found" };
        return world.outcome === "reapproved" ?
          { outcome: "reapproved", auditId: "a1", ceilingMicroUsd: "11800000" } :
          { outcome: "refused", reason: "cost_changed" };
      } } });
  }
  return import(mod("app/api/admin/amux/task-ceiling/route.ts"));
}

const post = (body: unknown, headers: Record<string, string> = {}) => new Request(
  "https://tomverse.test/api/admin/amux/task-ceiling", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://tomverse.test", ...headers },
    body: JSON.stringify(body) });
const valid = { taskId: "task-1", revision: 4, catalogDigest: "a".repeat(64),
  ceilingMicroUsd: "11800000", ownerConfirmed: true };

test("the owner's confirmed re-approval runs once with what they were shown", async () => {
  reset();
  const { POST } = await loadRoute();
  const response = await POST(post(valid));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "reapproved", ceilingMicroUsd: "11800000" });
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(world.closes, [{ taskId: "task-1", revision: 4, catalogDigest: "a".repeat(64),
    ceilingMicroUsd: "11800000", ownerConfirmed: true }]);
});

test("nobody but a recently authenticated owner from this origin reaches the service", async () => {
  const { POST } = await loadRoute();
  reset(); world.session = null;
  assert.equal((await POST(post(valid))).status, 404);
  reset(); world.role = "operator";
  assert.equal((await POST(post(valid))).status, 403);
  reset();
  assert.equal((await POST(post(valid, { origin: "https://elsewhere.test" }))).status, 403);
  reset(); world.recent = false;
  assert.equal((await POST(post(valid))).status, 428);
  reset();
  assert.equal((await POST(post(valid, { "content-type": "text/plain" }))).status, 415);
  reset();
  assert.equal((await POST(post({ ...valid, ownerConfirmed: false }))).status, 400);
  assert.equal((await POST(post({ ...valid, extra: 1 }))).status, 400);
  assert.equal((await POST(post({ ...valid, taskId: "../x" }))).status, 400);
  assert.equal((await POST(post({ ...valid, ceilingMicroUsd: "-1" }))).status, 400);
  assert.equal((await POST(post({ ...valid, ceilingMicroUsd: 11800000 }))).status, 400);
  assert.equal((await POST(post({ ...valid, catalogDigest: "short" }))).status, 400);
  assert.equal((await POST(post({ ...valid, revision: -1 }))).status, 400);
  assert.deepEqual(world.closes, []);
});

test("a refusal, a missing card, a held card and an unknown outcome each answer as such", async () => {
  const { POST } = await loadRoute();
  reset(); world.outcome = "refused";
  let response = await POST(post(valid));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "not_reapprovable", reason: "cost_changed" });
  reset(); world.outcome = "not_found";
  assert.equal((await POST(post(valid))).status, 404);
  reset(); world.outcome = "busy";
  response = await POST(post(valid));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "busy" });
  reset(); world.outcome = "throw";
  response = await POST(post(valid));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "outcome_unknown" });
});
