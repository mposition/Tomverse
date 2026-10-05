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
  GET: () => Promise<Response>; POST: (request: Request) => Promise<Response>;
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
    mock.module(mod("lib/amux/v22AutoPromotionService.ts"), { namedExports: {
      readV22AutoPromotionControl: async () => {
        world.reads += 1;
        return { active: false, codeLatch: false };
      },
      configureV22AutoPromotion: async (input: { active: boolean }) => {
        world.writes += 1;
        return { active: input.active, changed: true };
      },
    } });
  }
  return import(mod("app/api/admin/amux/v22-auto-promotion/route.ts"));
}

const post = (body: unknown) => new Request(
  "https://tomverse.test/api/admin/amux/v22-auto-promotion",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
const valid = { policyVersion: 22, active: false, expectedAuditLogId: null };
const reset = () => { world.session = { user: { id: "owner-1" } };
  world.role = "owner"; world.recent = true; world.writes = 0;
  world.reads = 0; };

test("v22 activation and status are owner-only; writes require recent authentication", async () => {
  const { GET, POST } = await loadRoute();
  for (const [session, role, recent, expected] of [
    [null, "owner", true, 404],
    [{ user: { id: "owner-1" } }, "admin", true, 403],
    [{ user: { id: "owner-1" } }, "owner", false, 428],
  ] as const) {
    reset(); world.session = session; world.role = role;
    world.recent = recent;
    const response = await POST(post(valid));
    assert.equal(response.status, expected);
    assert.equal(world.writes, 0);
    assert.equal(response.headers.get("cache-control"),
      "private, no-store, max-age=0");
  }
  reset(); world.role = "admin";
  assert.equal((await GET()).status, 403);
  assert.equal(world.reads, 0);
});

test("only the exact v22 control shape reaches the writer", async () => {
  const { GET, POST } = await loadRoute();
  reset();
  const status = await GET();
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { active: false, codeLatch: false });
  for (const invalid of [
    { ...valid, policyVersion: 21 },
    { ...valid, active: "true" },
    { ...valid, extra: true },
    { policyVersion: 22, active: true },
  ]) {
    await assert.rejects(() => POST(post(invalid)));
    assert.equal(world.writes, 0);
  }
  const accepted = await POST(post(valid));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { active: false, changed: true });
  assert.equal(world.writes, 1);
});
