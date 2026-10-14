import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// docs/policy/amux-card-display-key.md §5: the backfill route is owner-only
// with a recent step-up for both the dry run and the apply, refuses a foreign
// origin and a malformed digest before the service, and maps the service's
// refusals without retrying them.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const world = { session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner", recent: true, previews: 0, applies: 0,
  applyError: null as null | "plan_changed" | "nothing_to_apply" };

class BackfillError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) { super(code); }
}

let installed = false;
async function loadRoute(): Promise<{
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null,
      getAdminRole: () => world.role,
    } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (!world.recent) throw new Error("reauth"); },
      isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth",
    } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => undefined,
      apiSecurityResponse: (error: unknown) =>
        error instanceof Error && error.message === "invalid request" ?
          Response.json({ error: "Invalid request payload.", code: "INVALID_REQUEST" }, { status: 400 }) : null,
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
      hasValidMutationOrigin: (request: Request) => request.headers.get("origin") === "https://tomverse.test",
    } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/cardDisplayKeyBackfillService.ts"), { namedExports: {
      AmuxCardDisplayKeyBackfillError: BackfillError,
      previewAmuxCardDisplayKeyBackfill: async () => {
        world.previews += 1;
        return { digest: "a".repeat(64), plan: { version: 1, features: [],
          cards: [{ id: "card-1", prefix: "LEGACY", displayKey: "AMUX-LEGACY-001" }], unresolved: [] } };
      },
      applyAmuxCardDisplayKeyBackfill: async (input: { expectedDigest: string }) => {
        world.applies += 1;
        if (world.applyError) throw new BackfillError(world.applyError, 409);
        return { auditId: "audit-1", features: 0, cards: 1, unresolved: 0, digest: input.expectedDigest };
      },
    } });
  }
  return import(mod("app/api/admin/amux/card-display-key-backfill/route.ts"));
}

const URL = "https://tomverse.test/api/admin/amux/card-display-key-backfill";
const post = (body: unknown, origin = "https://tomverse.test") =>
  new Request(URL, { method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body) });
const reset = () => Object.assign(world, { session: { user: { id: "owner-1" } }, role: "owner",
  recent: true, previews: 0, applies: 0, applyError: null });

test("the dry run returns the plan with its digest, owner and step-up only", async () => {
  const route = await loadRoute();
  reset();
  const ok = await route.GET(new Request(URL));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store, max-age=0");
  const body = await ok.json();
  assert.equal(body.planDigest, "a".repeat(64));
  assert.deepEqual(body.cards, [{ id: "card-1", prefix: "LEGACY", displayKey: "AMUX-LEGACY-001" }]);

  world.session = null;
  assert.equal((await route.GET(new Request(URL))).status, 404);
  reset(); world.role = "ops";
  assert.equal((await route.GET(new Request(URL))).status, 403);
  reset(); world.recent = false;
  const stale = await route.GET(new Request(URL));
  assert.equal(stale.status, 428);
  assert.equal((await stale.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.equal(world.previews, 0, "a refused read never builds the plan");
});

test("the apply names a digest, refuses before the service, and maps its refusals", async () => {
  const route = await loadRoute();
  reset();
  const digest = "b".repeat(64);
  const applied = await route.POST(post({ planDigest: digest }));
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).cards, 1);
  assert.equal(world.applies, 1);

  for (const [setup, status] of [
    [() => { world.session = null; }, 404],
    [() => { world.role = "ops"; }, 403],
    [() => { world.recent = false; }, 428],
  ] as const) {
    reset(); setup();
    assert.equal((await route.POST(post({ planDigest: digest }))).status, status);
    assert.equal(world.applies, 0);
  }
  reset();
  assert.equal((await route.POST(post({ planDigest: digest }, "https://evil.test"))).status, 403);
  for (const body of [{}, { planDigest: "short" }, { planDigest: digest, extra: true }]) {
    assert.equal((await route.POST(post(body))).status, 400);
  }
  assert.equal(world.applies, 0, "nothing reached the service");

  for (const code of ["plan_changed", "nothing_to_apply"] as const) {
    reset(); world.applyError = code;
    const refused = await route.POST(post({ planDigest: digest }));
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, code);
    assert.equal(world.applies, 1, "a refusal is answered, never retried");
  }
});
