import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1, section 9: each internal route the
// bridge and the broker call runs its one transaction inside the AMUX route
// budget, so time spent before it -- reading the body, loading the key ring --
// counts, and a route without time left for its boundary never starts the
// transaction. The real lib/amux/dbBoundary.ts and lib/amux/internalRoute.ts
// decide that here, with the boundaries the routes really use; only the
// Prisma client, the key ring loader and the stores beneath are faked, and the
// clock is mocked and moved while the body is read.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const START = 1_790_000_000_000;
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const ROUTES = [
  ["assignments", "app/api/internal/amux/decision-maker/assignments/route.ts", { request_id: REQUEST_ID }],
  ["assignments/discard", "app/api/internal/amux/decision-maker/assignments/discard/route.ts", { request_id: REQUEST_ID }],
  [
    "transmissions",
    "app/api/internal/amux/decision-maker/transmissions/route.ts",
    { request_id: REQUEST_ID, instance: "decision-maker-openai", transmission: {} },
  ],
  [
    "transmissions/outcome",
    "app/api/internal/amux/decision-maker/transmissions/outcome/route.ts",
    { request_id: REQUEST_ID, instance: "decision-maker-openai", outcome: "receipt" },
  ],
  [
    "results",
    "app/api/internal/amux/decision-maker/results/route.ts",
    { request_id: REQUEST_ID, instance: "decision-maker-openai", binding: {}, output: { kind: "timeout" } },
  ],
  ["results/lookup", "app/api/internal/amux/decision-maker/results/lookup/route.ts", { request_id: REQUEST_ID, result_digest: "c".repeat(64) }],
  [
    "results/unknown",
    "app/api/internal/amux/decision-maker/results/unknown/route.ts",
    { request_id: REQUEST_ID, instance: "decision-maker-openai", result_digest: "c".repeat(64) },
  ],
  [
    "cleanup/unknown",
    "app/api/internal/amux/decision-maker/cleanup/unknown/route.ts",
    { request_id: REQUEST_ID, instance: "decision-maker-openai" },
  ],
] as const;

type World = { transactionsAsked: number; storeCalls: number };
let world: World;
const reset = () => {
  world = { transactionsAsked: 0, storeCalls: 0 };
};
reset();

const unreachable = async () => {
  world.storeCalls += 1;
  throw new Error("unreachable");
};

let installed = false;
async function loadRoute(path: string): Promise<{ POST: (request: Request) => Promise<Response> }> {
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
        loadDecisionMakerDigestKeyRing: () => new Map([[20000, Buffer.alloc(32, 7)]]),
      },
    });
    mock.module(mod("lib/amux/decisionMakerBodyStore.ts"), {
      namedExports: {
        DecisionMakerBodyWriteError: class extends Error {},
        assignDecisionMakerRequestWithDigestKey: unreachable,
        submitDecisionMakerOutput: unreachable,
      },
    });
    mock.module(mod("lib/amux/decisionMakerRequestStore.ts"), {
      namedExports: {
        DecisionMakerRequestWriteError: class extends Error {},
        discardDecisionMakerAssignment: unreachable,
        recordDecisionMakerTransmitIntent: unreachable,
        recordDecisionMakerTransmitOutcome: unreachable,
        lookupDecisionMakerResult: unreachable,
        recordDecisionMakerResultUnknown: unreachable,
        recordDecisionMakerValidationLatch: unreachable,
        recordDecisionMakerCleanupUnknown: unreachable,
        recordDecisionMakerCleanupLatch: unreachable,
      },
    });
    mock.method(console, "error", () => {});
    mock.method(console, "warn", () => {});
  }
  return import(mod(path));
}

/** A body whose reading takes `spentMs` of the route's budget. */
const post = (url: string, body: unknown, spentMs: number) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Request(`https://tomverse.app/api/internal/amux/decision-maker/${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      pull(controller) {
        if (spentMs > 0) mock.timers.tick(spentMs);
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
};

test("a route whose budget is spent before its transaction never starts one", async () => {
  for (const [url, path, body] of ROUTES) {
    const { POST } = await loadRoute(path);

    // Control: with the budget intact the boundary does ask the (fake)
    // database, so the refusal below is the budget's and not this fake's.
    reset();
    const intact = await POST(post(url, body, 0));
    assert.ok(intact.status >= 500, url);
    assert.equal(world.transactionsAsked, 1, url);

    // 15 s budget, 14 s spent reading the body: 1 s left, less than any of
    // these boundaries' ceiling x 300 ms + 200 ms (the smallest, the lookup's
    // 3, needs 1.1 s).
    reset();
    const spent = await POST(post(url, body, 14_000));
    assert.equal(spent.status, 503, url);
    assert.equal((await spent.json()).reason, "amux_database_deadline_exceeded", url);
    assert.equal(world.transactionsAsked, 0, url);
    assert.equal(world.storeCalls, 0, url);
  }
});
