import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1, section 9: the switch route runs in
// the AMUX route budget from its first line, so a handler that spent the
// budget on the session, the rate limit or the body never starts the
// transaction. The real lib/amux/dbBoundary.ts decides that here; only the
// Prisma client beneath it is faked, and it records whether a transaction
// was asked for. The clock is mocked and advanced inside the session read.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

const START = 1_790_000_000_000;

type World = {
  authDelayMs: number;
  transactionsAsked: number;
  storeCalls: number;
  logged: string[];
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = { authDelayMs: 0, transactionsAsked: 0, storeCalls: 0, logged: [], ...changes };
};
reset();

type Route = {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

let installed = false;
async function loadRoute(): Promise<Route> {
  if (!installed) {
    installed = true;
    mock.timers.enable({ apis: ["Date"], now: START });
    mock.module("next-auth/next", {
      namedExports: {
        getServerSession: async () => {
          if (world.authDelayMs > 0) mock.timers.tick(world.authDelayMs);
          return { user: { id: "operator-1", authenticatedAt: new Date(START).toISOString() } };
        },
      },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: { isAdminSession: () => true, hasAdminPermission: () => true },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          $transaction: () => {
            world.transactionsAsked += 1;
            return Promise.reject(new Error("no database in this test"));
          },
        },
        prismaPoolUsage: () => null,
      },
    });
    mock.module(mod("lib/amux/decisionMakerSwitchStore.ts"), {
      namedExports: {
        DecisionMakerSwitchWriteError: class extends Error {},
        readDecisionMakerSwitchesOrThrow: async () => {
          world.storeCalls += 1;
          throw new Error("unreachable");
        },
        recordDecisionMakerSwitchByOperator: async () => {
          world.storeCalls += 1;
          throw new Error("unreachable");
        },
      },
    });
    mock.method(console, "error", (line: unknown) => {
      world.logged.push(String(line));
    });
  }
  return import(mod("app/api/admin/amux/decision-maker/switches/route.ts"));
}

const URL_ = "https://tomverse.app/api/admin/amux/decision-maker/switches";
const post = () =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "kill_switch", value: "on" }),
  });

const loggedCode = () => JSON.parse(world.logged.at(-1) ?? "{}").code ?? null;

test("a change whose route budget is spent before the transaction never starts one", async () => {
  const { POST } = await loadRoute();

  // Control: with the budget intact the boundary does ask the (fake)
  // database, so the refusal below is the budget's and not this fake's.
  reset();
  const intact = await POST(post());
  assert.equal(intact.status, 503);
  assert.equal(world.transactionsAsked, 1);

  // 15 s budget, 14 s spent before the body: 1 s left, less than the change
  // boundary's 9 x 300 ms + 200 ms.
  reset({ authDelayMs: 14_000 });
  const spent = await POST(post());
  assert.equal(spent.status, 503);
  assert.deepEqual(await spent.json(), { error: "switch_change_failed" });
  assert.equal(world.transactionsAsked, 0);
  assert.equal(world.storeCalls, 0);
  assert.equal(loggedCode(), "AMUX_DB_DEADLINE_EXCEEDED");
});

test("a read whose route budget is spent never starts its transaction either", async () => {
  const { GET } = await loadRoute();

  reset();
  assert.equal((await GET(new Request(URL_))).status, 503);
  assert.equal(world.transactionsAsked, 1);

  // 14.5 s spent: 500 ms left, less than the read boundary's 3 x 300 ms + 200 ms.
  reset({ authDelayMs: 14_500 });
  const spent = await GET(new Request(URL_));
  assert.equal(spent.status, 503);
  assert.deepEqual(await spent.json(), { error: "switch_state_unavailable" });
  assert.equal(world.transactionsAsked, 0);
  assert.equal(world.storeCalls, 0);
  assert.equal(loggedCode(), "AMUX_DB_DEADLINE_EXCEEDED");
});
