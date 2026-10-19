// Orchestration policy version 55, section 1 (stage S1): the bridge scope --
// which workers a bridge started with `--worker` may serve, and of which
// kind. It ships latched off and sits beside the R2d session list.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AMUX_WORKER_BRIDGE_SCOPE_LATCH,
  amuxWorkerBridgeScope,
  amuxWorkerBridgeScopeOpen,
  deriveAmuxWorkerCatalog,
} from "../lib/amux/workerDerivedCatalogCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const registration = (workerName, roleCeiling, desiredState = "active") => ({
  workerName,
  providerClass: workerName.split("-")[0],
  roleCeiling,
  desiredState,
  revision: 1,
});
const capability = (routingTags, v22 = null) => ({ capability: { model: null, routingTags, toolCapabilities: [], v22 } });

test("S3 turns the bridge scope on", () => {
  assert.equal(AMUX_WORKER_BRIDGE_SCOPE_LATCH, true);
  assert.equal(amuxWorkerBridgeScopeOpen(), true);
});

test("the scope is every derived worker but the code constants, v22 where a v22 profile is recorded", () => {
  const derived = deriveAmuxWorkerCatalog({
    registrations: [
      registration("codex-impl", "implementation"),
      registration("claude-impl", "implementation"),
      registration("claude-review", "contract"),
      registration("cursor-impl", "implementation", "requested"),
    ],
    capabilities: new Map([
      ["codex-impl", capability(["implementation"])],
      ["claude-impl", capability(["implementation"], { model: "claude-opus-5-5", roles: ["implement"], tools: ["repo_read", "repo_write"] })],
      ["claude-review", capability(["review"], { model: "claude-opus-5-5", roles: ["review"], tools: ["repo_read"] })],
      ["cursor-impl", capability(["implementation"])],
    ]),
    latches: new Map(),
  });
  assert.ok(derived.legacy.some((entry) => entry.worker_name === "engineering-runner"));
  assert.deepEqual(amuxWorkerBridgeScope(derived), [
    { name: "claude-impl", kind: "v22" },
    { name: "claude-review", kind: "v22" },
    { name: "codex-impl", kind: "session" },
  ]);
});

test("the route only reads, checks the bearer before anything, and answers off while latched", () => {
  const route = read("app/api/internal/amux/workers/bridge-scope/route.ts");
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.ok(route.indexOf("isAmuxSyncAuthorized(request)") < route.indexOf("readAmuxWorkerBridgeScope()"));
  const scope = read("lib/amux/workerBridgeScope.ts");
  assert.match(scope, /if \(!open\) return \{ listed: false, reason: "bridge_scope_off" \};/);
  assert.match(scope, /AMUX_DB_BOUNDARIES\.workerBridgeScopeRead/);
  // The R2d session list is left alone: installed bridges accept only its keys.
  assert.match(read("lib/amux/workerSessionList.ts"), /\| \{ listed: true; workers: string\[\] \}/);
});
