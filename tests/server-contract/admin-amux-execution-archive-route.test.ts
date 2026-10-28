import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const world = { session: { user: { id: "owner-1" } } as
  { user: { id: string } } | null, role: "owner", recent: true, writes: 0 };
let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
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
      consumeApiRateLimit: async () => {},
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
    mock.module(mod("lib/amux/adminExecutionArchiveService.ts"), { namedExports: {
      archiveAllAdminExecutionCards: async () => {
        world.writes += 1;
        return { archived: 12, archivedAt: "2026-10-27T08:00:00.000Z" };
      },
    } });
  }
  return import(mod("app/api/admin/amux/execution-archive/route.ts"));
}

const valid = { confirm: "archive_all_active_cards" };
const post = (body: unknown, origin = "https://tomverse.test") =>
  new Request("https://tomverse.test/api/admin/amux/execution-archive", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body) });
const reset = () => { world.session = { user: { id: "owner-1" } };
  world.role = "owner"; world.recent = true; world.writes = 0; };

test("archive all requires a recently authenticated owner", async () => {
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

test("archive all accepts only the exact same-origin confirmation", async () => {
  const { POST } = await loadRoute();
  reset();
  for (const invalid of [{}, { confirm: "yes" }, { ...valid, extra: true }]) {
    assert.equal((await POST(post(invalid))).status, 400);
    assert.equal(world.writes, 0);
  }
  assert.equal((await POST(post(valid, "https://elsewhere.test"))).status, 403);
  assert.equal(world.writes, 0);
  const accepted = await POST(post(valid));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(),
    { archived: 12, archivedAt: "2026-10-27T08:00:00.000Z" });
  assert.equal(world.writes, 1);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store, max-age=0");
});
