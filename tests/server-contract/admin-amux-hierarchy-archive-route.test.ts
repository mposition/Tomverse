import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const world = { session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner", recent: true, writes: 0, outcome: "ok" as "ok" | "refused" | "disabled" | "crash",
  lastIds: [] as string[] };
let installed = false;

class Refusal extends Error {
  constructor(readonly code: string, readonly nodeId: string | null) { super(code); }
}

async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null, getAdminRole: () => world.role } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (!world.recent) throw new Error("reauth"); },
      isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth",
    } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => {},
      apiSecurityResponse: (error: unknown) => error instanceof Error && error.message === "invalid request" ?
        Response.json({ error: "Invalid request payload.", code: "INVALID_REQUEST" }, { status: 400 }) : null,
      readLimitedJson: async (request: Request, limit: number, schema: {
        safeParse: (value: unknown) => { success: boolean; data: unknown } }) => {
        const raw = await request.text();
        if (raw.length > limit) throw new Error("invalid request");
        const parsed = schema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw new Error("invalid request");
        return parsed.data;
      },
    } });
    mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
      hasValidMutationOrigin: (request: Request) => request.headers.get("origin") === "https://tomverse.test" } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/adminHierarchyCore.ts"), { namedExports: {
      AMUX_HIERARCHY_ARCHIVE_MAX_NODES: 200, AmuxHierarchyArchiveRefusal: Refusal } });
    mock.module(mod("lib/amux/adminHierarchyArchiveService.ts"), { namedExports: {
      archiveAmuxHierarchyNodes: async ({ nodeIds }: { nodeIds: string[] }) => {
        world.writes += 1; world.lastIds = nodeIds;
        if (world.outcome === "refused") throw new Refusal("remaining_work", nodeIds[0]);
        if (world.outcome === "disabled") throw new Refusal("disabled", null);
        if (world.outcome === "crash") throw new Error("connection lost at commit");
        return { archived: nodeIds.map((nodeId) => ({ nodeId, archivedNodeIds: [nodeId],
          archivedAt: "2026-11-21T08:00:00.000Z", contentPurgeAfter: "2027-02-19T08:00:00.000Z" })) };
      },
    } });
  }
  return import(mod("app/api/admin/amux/hierarchy-archive/route.ts"));
}

const valid = { confirm: "archive_hierarchy_nodes", nodeIds: ["node-1", "node-2"] };
const post = (body: unknown, origin = "https://tomverse.test") =>
  new Request("https://tomverse.test/api/admin/amux/hierarchy-archive", {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const reset = () => { world.session = { user: { id: "owner-1" } }; world.role = "owner";
  world.recent = true; world.writes = 0; world.outcome = "ok"; world.lastIds = []; };

test("hierarchy archive requires a recently authenticated owner", async () => {
  const { POST } = await loadRoute();
  for (const [session, role, recent, expected] of [
    [null, "owner", true, 404],
    [{ user: { id: "owner-1" } }, "admin", true, 403],
    [{ user: { id: "owner-1" } }, "owner", false, 428],
  ] as const) {
    reset(); world.session = session; world.role = role; world.recent = recent;
    assert.equal((await POST(post(valid))).status, expected);
    assert.equal(world.writes, 0);
  }
});

test("hierarchy archive accepts only the exact same-origin confirmation with node ids", async () => {
  const { POST } = await loadRoute();
  reset();
  for (const invalid of [{}, { confirm: "archive_hierarchy_nodes" },
    { ...valid, nodeIds: [] }, { ...valid, nodeIds: ["bad id"] },
    { ...valid, nodeIds: Array.from({ length: 201 }, (_, index) => `n${index}`) },
    { ...valid, confirm: "yes" }, { ...valid, extra: true }]) {
    assert.equal((await POST(post(invalid))).status, 400);
    assert.equal(world.writes, 0);
  }
  assert.equal((await POST(post(valid, "https://elsewhere.test"))).status, 403);
  assert.equal(world.writes, 0);
  const accepted = await POST(post(valid));
  assert.equal(accepted.status, 200);
  assert.equal(((await accepted.json()) as { archived: unknown[] }).archived.length, 2);
  assert.deepEqual(world.lastIds, ["node-1", "node-2"]);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store, max-age=0");
});

test("a refusal names its reason; an unknown failure is never offered as retryable", async () => {
  const { POST } = await loadRoute();
  reset(); world.outcome = "refused";
  const refused = await POST(post(valid));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "archive_refused", code: "remaining_work", nodeId: "node-1" });
  reset(); world.outcome = "disabled";
  const disabled = await POST(post(valid));
  assert.equal(disabled.status, 403);
  assert.equal(((await disabled.json()) as { code: string }).code, "disabled");
  reset(); world.outcome = "crash";
  const crashed = await POST(post(valid));
  assert.equal(crashed.status, 500);
  assert.deepEqual(await crashed.json(), { error: "archive_failed", retry: false });
  assert.equal(world.writes, 1);
});
