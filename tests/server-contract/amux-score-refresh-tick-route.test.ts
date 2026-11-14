import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, mock, test } from "node:test";

// Owner decision 2026-11-14: the admitted auto-promotion tick extends
// unchanged scores before claim and promotion, behind a default-off switch.
// A refusal never fails the tick; a refresh whose COMMIT outcome is lost stops
// it before any claim or promotion, answered like a lost promotion write.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const calls: string[] = [];
let refresh: () => Promise<unknown> = async () => ({ refreshed: 0, skipped: 0, failed: 0, outcomes: [], orphaned: [] });

mock.module(mod("lib/amux/guard.ts"), { namedExports: { isAmuxSyncAuthorized: () => true } });
mock.module(mod("lib/amux/internalRoute.ts"), {
  namedExports: {
    admitAmuxOrchestratorRequest: async () => null,
    amuxInternalErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
    amuxInvalidOrchestratorIdentityResponse: () => Response.json({ error: "identity" }, { status: 400 }),
    amuxJsonNoStore: (body: unknown, status: number) => Response.json(body, { status }),
    isAmuxInputError: () => false,
  },
});
mock.module(mod("lib/amux/ideaKeyConfig.ts"), {
  namedExports: { loadCurrentAmuxContentKeys: () => ({ digestKeyId: "k", digestKey: Buffer.alloc(32) }) },
});
mock.module(mod("lib/amux/portfolioScoreService.ts"), {
  namedExports: { refreshDueAmuxPortfolioScores: async () => { calls.push("refresh"); return refresh(); } },
});
mock.module(mod("lib/amux/v22WorkerClaimService.ts"), {
  namedExports: { tickV22WorkerClaim: async () => { calls.push("claim"); return { claimed: false, reason: "no_worker" }; } },
});
mock.module(mod("lib/amux/v22AutoPromotionService.ts"), {
  namedExports: { tickV22AutoPromotion: async () => { calls.push("promote"); return { promoted: false, reason: "no_candidate" }; } },
});
mock.module(mod("lib/amux/autoPromotionService.ts"), {
  namedExports: { tickAutoPromotion: async () => { calls.push("legacy"); return { promoted: false, reason: "no_grant", expired: 0 }; } },
});

const load = async () => ({
  BoardImportError: (await import(mod("lib/amux/boardImportCore.ts"))).BoardImportError,
  POST: (await import(mod("app/api/internal/amux/auto-promotion/tick/route.ts"))).POST,
});
let loaded: ReturnType<typeof load> | undefined;
const modules = () => (loaded ??= load());

const ENV = ["TOMVERSE_AMUX_V22_AUTO_PROMOTE", "TOMVERSE_AMUX_V22_WORKER_CLAIM",
  "TOMVERSE_AMUX_V4_SCORE_AUTO_REFRESH", "TOMVERSE_AMUX_BOARD_AUTO_PROMOTE"] as const;
const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
after(() => {
  for (const key of ENV) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

const tick = async (refreshSwitch: string | undefined) => {
  calls.length = 0;
  process.env.TOMVERSE_AMUX_V22_AUTO_PROMOTE = "enabled";
  process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM = "enabled";
  delete process.env.TOMVERSE_AMUX_BOARD_AUTO_PROMOTE;
  if (refreshSwitch === undefined) delete process.env.TOMVERSE_AMUX_V4_SCORE_AUTO_REFRESH;
  else process.env.TOMVERSE_AMUX_V4_SCORE_AUTO_REFRESH = refreshSwitch;
  return (await modules()).POST(new Request("http://localhost/api/internal/amux/auto-promotion/tick", {
    method: "POST", body: "{}", headers: { "content-type": "application/json",
      // The orchestrator's write identity: the tick is admitted.
      "x-amux-request-id": "00000000-0000-4000-8000-000000000001",
      "x-amux-instance-id": "00000000-0000-4000-8000-000000000002" } }));
};

test("the refresh is off by default and runs before claim and promotion when enabled", async () => {
  const off = await tick(undefined);
  assert.equal(off.status, 200);
  assert.deepEqual(calls, ["claim", "promote"]);
  assert.equal((await tick("true")).status, 200);
  assert.deepEqual(calls, ["claim", "promote"]);

  refresh = async () => ({ refreshed: 2, skipped: 1, failed: 0, outcomes: [], orphaned: [] });
  const on = await tick("enabled");
  assert.equal(on.status, 200);
  assert.deepEqual(calls, ["refresh", "claim", "promote"]);
});

test("a refused refresh never fails the tick", async () => {
  refresh = async () => { throw new Error("database unavailable"); };
  const response = await tick("enabled");
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["refresh", "claim", "promote"]);
});

test("a refresh whose commit outcome is lost stops the tick before claim and promotion", async () => {
  const { BoardImportError } = await modules();
  refresh = async () => { throw new BoardImportError("outcome_unknown", 409, "task-1"); };
  const response = await tick("enabled");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { promoted: false, policy_version: 22,
    reason: "outcome_unknown" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, ["refresh"]);
});
