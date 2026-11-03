import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The owner's CLI model link route (owner decision 2026-10-27). A link decides
// what a worker's model costs, so it needs the owner role, the capability
// writes latch and a recent step-up, all checked before the body is read. The
// store and the DB boundary are faked; the store's statements are pinned by
// tests/amuxCliModelCatalogStore.test.mjs and the table by
// tests/integration/amux-cli-model-catalog.db.test.ts.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

class FakeBoundaryError extends Error {
  constructor(readonly code: string) { super(code); }
}
class FakeWriteError extends Error {
  constructor(readonly code: string) { super(code); }
}

type World = {
  session: { user: { id: string; authenticatedAt?: string } } | null;
  admin: boolean;
  role: string | null;
  latch: boolean;
  boundaries: string[];
  links: unknown[];
  boundaryError: Error | null;
  storeError: Error | null;
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "owner-1", authenticatedAt: new Date().toISOString() } },
    admin: true, role: "owner", latch: true, boundaries: [], links: [], boundaryError: null, storeError: null,
    ...changes,
  };
};
reset();

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: { isAdminSession: () => world.admin, getAdminRole: () => world.role },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: { cliModelLinkChange: { operation: "cli_model_link_change" } },
        AmuxDbBoundaryError: FakeBoundaryError,
        withAmuxRouteBudget: async (work: () => Promise<unknown>) => work(),
        withAmuxDbBoundary: async (boundary: { operation: string }, work: (tx: unknown) => Promise<unknown>) => {
          world.boundaries.push(boundary.operation);
          if (world.boundaryError) throw world.boundaryError;
          return work({ fake: "tx" });
        },
      },
    });
    mock.module(mod("lib/amux/workerCapabilityCore.ts"), {
      namedExports: { amuxWorkerCapabilityWritesOpen: () => world.latch },
    });
    mock.module(mod("lib/amux/cliModelCatalogStore.ts"), {
      namedExports: {
        AmuxCliModelLinkWriteError: FakeWriteError,
        recordAmuxCliModelLinkByOwner: async (tx: unknown, input: Record<string, unknown>) => {
          assert.deepEqual(tx, { fake: "tx" });
          const { cli, cliModel, pricedModelId } = input;
          world.links.push({ cli, cliModel, pricedModelId });
          if (world.storeError) throw world.storeError;
          return { eventId: "event-1", auditLogId: "audit-1", cli, cliModel, pricedModelId };
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/cli-models/route.ts"));
}

const post = (body: unknown) =>
  new Request("https://tomverse.app/api/admin/amux/cli-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const VALID = { cli: "cursor", cliModel: "claude-opus-5-5-high", pricedModelId: "claude-opus-5-5" };

test("only the owner links, with the latch on and a recent step-up, before the body is read", async () => {
  const { POST } = await loadRoute();
  for (const [changes, status] of [
    [{ session: null }, 404], [{ admin: false }, 404], [{ role: "admin" }, 403], [{ latch: false }, 409],
    [{ session: { user: { id: "owner-1", authenticatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() } } }, 428],
  ] as const) {
    reset(changes as Partial<World>);
    assert.equal((await POST(post(VALID))).status, status, JSON.stringify(changes));
    assert.deepEqual(world.boundaries, []);
  }
  reset();
  const answer = await POST(post(VALID));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { action: "amux.cli_model.link", eventId: "event-1", ...VALID });
  assert.deepEqual(world.boundaries, ["cli_model_link_change"]);
  assert.deepEqual(world.links, [VALID]);
  // Holding a name is a link to nothing.
  reset();
  assert.equal((await POST(post({ ...VALID, pricedModelId: null }))).status, 200);
});

test("a body outside the strict shape never reaches the store; a refusal is 409 with its code", async () => {
  const { POST } = await loadRoute();
  for (const body of [{ ...VALID, note: 1 }, { cli: "cursor" }, { ...VALID, pricedModelId: 7 }, { ...VALID, cliModel: "x".repeat(161) }, "nope"]) {
    reset();
    assert.equal((await POST(post(body))).status, 400, JSON.stringify(body));
    assert.deepEqual(world.boundaries, []);
  }
  for (const [code, status] of [["invalid_change", 400], ["no_change", 409], ["model_not_found", 409]] as const) {
    reset({ storeError: new FakeWriteError(code) });
    const answer = await POST(post(VALID));
    assert.equal(answer.status, status, code);
    assert.deepEqual(await answer.json(), { error: code });
  }
  reset({ storeError: new FakeWriteError("no_operator") });
  assert.equal((await POST(post(VALID))).status, 404);
});

test("an unknown outcome says so, and any other failure says it was not recorded", async () => {
  const { POST } = await loadRoute();
  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_OUTCOME_UNKNOWN") });
  assert.deepEqual([(await POST(post(VALID))).status], [503]);
  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_OUTCOME_UNKNOWN") });
  assert.deepEqual(await (await POST(post(VALID))).json(), { error: "outcome_unknown" });
  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_TIMEOUT") });
  assert.deepEqual(await (await POST(post(VALID))).json(), { error: "cli_model_link_failed" });
});
