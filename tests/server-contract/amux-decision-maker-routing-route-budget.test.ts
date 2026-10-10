import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1, section 9: the routing route runs its
// one transaction inside the AMUX route budget, so time spent before it -- the
// body, the key ring -- counts, and a route without time for the routing
// boundary never starts the transaction. The real lib/amux/dbBoundary.ts and
// lib/amux/internalRoute.ts decide that here; only the Prisma client, the key
// ring loader and the store beneath are faked, and the clock is mocked.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const START = 1_790_000_000_000;

type World = { keyRingDelayMs: number; transactionsAsked: number; storeCalls: number };
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = { keyRingDelayMs: 0, transactionsAsked: 0, storeCalls: 0, ...changes };
};
reset();

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    process.env.TOMVERSE_AMUX_DM_ROUTING = "enabled";
    mock.timers.enable({ apis: ["Date"], now: START });
    mock.module(mod("lib/amux/guard.ts"), { namedExports: { isAmuxSyncAuthorized: () => true } });
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
    mock.module(mod("lib/amux/decisionMakerDigestKeys.ts"), {
      namedExports: {
        DecisionMakerDigestKeyError: class extends Error {},
        loadDecisionMakerDigestKeyRing: () => {
          if (world.keyRingDelayMs > 0) mock.timers.tick(world.keyRingDelayMs);
          return new Map([[20000, Buffer.alloc(32, 7)]]);
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerBodyStore.ts"), {
      namedExports: {
        DecisionMakerBodyWriteError: class extends Error {},
        recordDecisionMakerRequestWithCardText: async () => {
          world.storeCalls += 1;
          throw new Error("unreachable");
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerRequestStore.ts"), {
      namedExports: { DecisionMakerRequestWriteError: class extends Error {} },
    });
    mock.method(console, "error", () => {});
    mock.method(console, "warn", () => {});
  }
  return import(mod("app/api/internal/amux/decision-maker/requests/route.ts"));
}

const post = () =>
  new Request("https://tomverse.app/api/internal/amux/decision-maker/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ binding: {}, card: {} }),
  });

test("a routing whose route budget is spent before the transaction never starts one", async () => {
  const { POST } = await loadRoute();

  // Control: with the budget intact the boundary does ask the (fake)
  // database, so the refusal below is the budget's and not this fake's.
  reset();
  const intact = await POST(post());
  assert.ok(intact.status >= 500);
  assert.equal(world.transactionsAsked, 1);

  // 15 s budget, 14 s spent loading the key ring: 1 s left, less than the
  // routing boundary's 12 x 300 ms + 200 ms.
  reset({ keyRingDelayMs: 14_000 });
  const spent = await POST(post());
  assert.equal(spent.status, 503);
  assert.equal((await spent.json()).reason, "amux_database_deadline_exceeded");
  assert.equal(world.transactionsAsked, 0);
  assert.equal(world.storeCalls, 0);
});
