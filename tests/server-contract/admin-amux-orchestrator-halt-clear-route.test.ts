import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Orchestration policy version 20, section 7: clearing an orchestrator halt.
// The owner role and a recent step-up are checked by the route before the
// body is read; a stale step-up is 428 with the reauthentication code the
// Halts panel turns into the way back (docs/ui-contracts/admin-console-ia.md
// rule 7). The store is faked; the clear's transaction is the routing lane's
// (tests/integration/amux-orchestration-halt.db.test.ts).

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

const HALT = "0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b";

class FakeClearError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(code);
  }
}

type World = {
  session: { user: { id: string; authenticatedAt?: string } } | null;
  admin: boolean;
  role: string;
  clears: Array<{ haltId: string; haltKeyPrefix: unknown }>;
  clearError: Error | null;
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "owner-1", authenticatedAt: new Date().toISOString() } },
    admin: true,
    role: "owner",
    clears: [],
    clearError: null,
    ...changes,
  };
};
reset();

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.admin,
        getAdminRole: () => world.role,
      },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/amux/orchestratorHaltStore.ts"), {
      namedExports: {
        AmuxOrchestratorHaltClearError: FakeClearError,
        clearAmuxOrchestratorHalt: async (input: { haltId: string; haltKeyPrefix: unknown }) => {
          world.clears.push({ haltId: input.haltId, haltKeyPrefix: input.haltKeyPrefix });
          if (world.clearError) throw world.clearError;
          return { haltId: input.haltId, admissionClosed: true };
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/orchestrator-halts/route.ts"));
}

const request = (body: unknown) =>
  new Request("https://tomverse.app/api/admin/amux/orchestrator-halts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const valid = { haltId: HALT, haltKeyPrefix: "0b8e9a52" };

test("only an owner with a recent step-up reaches the clear", async () => {
  const { POST } = await loadRoute();

  reset({ session: null });
  assert.equal((await POST(request(valid))).status, 404);
  reset({ admin: false });
  assert.equal((await POST(request(valid))).status, 404);
  reset({ role: "ops" });
  const forbidden = await POST(request(valid));
  assert.equal(forbidden.status, 403);
  assert.equal(world.clears.length, 0);

  // A stale step-up is 428 with the code the panel turns into the way back.
  reset({
    session: {
      user: { id: "owner-1", authenticatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
    },
  });
  const stale = await POST(request(valid));
  assert.equal(stale.status, 428);
  assert.equal((await stale.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.equal(stale.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(world.clears.length, 0);

  reset();
  const cleared = await POST(request(valid));
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { cleared: true, haltId: HALT, admissionClosed: true });
  assert.deepEqual(world.clears, [{ haltId: HALT, haltKeyPrefix: "0b8e9a52" }]);
});

test("a wrong halt key prefix, a cleared or a missing halt is refused with its code", async () => {
  const { POST } = await loadRoute();
  for (const [code, status] of [
    ["halt_key_mismatch", 409],
    ["already_cleared", 409],
    ["not_found", 404],
  ] as const) {
    reset({ clearError: new FakeClearError(code, status) });
    const response = await POST(request(valid));
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code });
  }
});

test("the body is a halt id and the typed prefix, nothing else", async () => {
  const { POST } = await loadRoute();
  for (const body of [
    { haltId: "x", haltKeyPrefix: "0b8e9a52" },
    { haltId: HALT },
    { haltId: HALT, haltKeyPrefix: "0b8e9a52", resolution: "no_commit" },
    "not json",
  ]) {
    reset();
    const response = await POST(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(world.clears.length, 0);
  }
});
