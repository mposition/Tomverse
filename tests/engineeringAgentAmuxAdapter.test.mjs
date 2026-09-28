import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH,
  ENGINEERING_AGENT_AMUX_WORKER,
  amuxSettlementForRunOutcome,
  engineeringAgentAmuxAdapterPermitted,
  isEngineeringAgentAmuxAdapterOpen,
  mintEngineeringAgentRunId,
} from "../lib/engineeringAgentAmuxAdapter.ts";
import {
  HALT_VALUES,
  RUN_OUTCOMES,
  combineRunHalt,
  decideHalt,
  isRunId,
  parseSettingInstant,
} from "../lib/engineeringAgentCore.ts";
import { ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES } from "../lib/engineeringAgentStore.ts";
import {
  ENGINEERING_AGENT_RESPONSE_MAX_BYTES,
  requireSendableResult,
} from "../lib/engineeringAgentRouteAuth.ts";

// The engineering adapter (docs/policy/engineering-agent.md §8;
// docs/policy/development-agent-orchestration.md, Authority, version 12) and
// the round-5 review fixes that sit beside it.

test("the adapter ships closed, and opens only with both its latch and the execution API", () => {
  assert.equal(ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH, false, "version 12 ships the latch off");
  assert.equal(isEngineeringAgentAmuxAdapterOpen(), false);
  assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: true, executionApiEnabled: true }), true);
  assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: true, executionApiEnabled: false }), false);
  assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: false, executionApiEnabled: true }), false);
});

test("the worker is the policy's one identity, and a run id is minted in the widest run-id form", () => {
  assert.equal(ENGINEERING_AGENT_AMUX_WORKER, "engineering-runner");
  for (let i = 0; i < 50; i += 1) {
    const runId = mintEngineeringAgentRunId();
    assert.ok(isRunId(runId), runId);
    assert.equal(runId.length, 12);
  }
});

test("a run's outcome settles its attempt to review, todo or blocked, never done, and abandoned is not the runner's", () => {
  for (const outcome of RUN_OUTCOMES) {
    if (outcome === "abandoned") {
      assert.throws(() => amuxSettlementForRunOutcome(outcome), /outcome_not_settled_by_agent/);
      continue;
    }
    const settlement = amuxSettlementForRunOutcome(outcome);
    assert.ok(["review", "todo", "blocked"].includes(settlement.toStatus), `${outcome} -> ${settlement.toStatus}`);
    assert.notEqual(settlement.toStatus, "done");
  }
});

const routeFiles = (() => {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name === "route.ts") files.push(next);
    }
  };
  walk("app/api/internal/engineering-agent");
  return files;
})();

test("no engineering route takes a worker from its body, and only runner routes reach the adapter", () => {
  assert.ok(routeFiles.length >= 6, "the engineering routes were found");
  for (const file of routeFiles) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\bworker\s*:/, `${file} names no worker`);
    if (text.includes("@/lib/engineeringAgentAmuxAdapter")) {
      assert.match(text, /isEngineeringAgentRouteAuthorized\(request, "runner"\)/, `${file} is a runner route`);
      assert.match(text, /isEngineeringAgentAmuxAdapterOpen\(\)/, `${file} checks the latch before the body`);
    }
  }
});

test("the adapter reaches only the AMUX writers version 12 allows it", () => {
  const text = readFileSync("lib/engineeringAgentAmuxAdapter.ts", "utf8");
  const imported = [...text.matchAll(/from "@\/lib\/amux\/([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(imported)], ["dbBoundary", "delivery", "execution", "executionGate", "routing", "store", "workerRuntime"]);
  assert.doesNotMatch(text, /\breclaimExpiredAmux/, "recovery is the AMUX recover route's alone");
  assert.doesNotMatch(text, /toStatus:\s*"done"/);
  const costs = [...text.matchAll(/actualCostMicrousd:\s*([^,\s]+)/g)].map((match) => match[1]);
  assert.deepEqual(costs, ["null"], "no agent cost enters an attempt's settlement");
});

test("a run's halt is the runner's report combined with the app's, and a report of none lowers nothing", () => {
  assert.equal(combineRunHalt({ reported: "none", circuitLatched: true, openStateMismatches: 0 }), "circuit_open");
  assert.equal(combineRunHalt({ reported: "none", circuitLatched: false, openStateMismatches: 2 }), "state_mismatch");
  assert.equal(combineRunHalt({ reported: "none", circuitLatched: false, openStateMismatches: 0 }), "none");
  for (const reported of HALT_VALUES) {
    for (const circuitLatched of [false, true]) {
      for (const openStateMismatches of [0, 1]) {
        const halt = combineRunHalt({ reported, circuitLatched, openStateMismatches });
        if (reported !== "none") assert.notEqual(halt, "none", `${reported} is never lowered`);
        if (circuitLatched || openStateMismatches > 0) assert.notEqual(halt, "none");
        // The result is a value decideHalt can give.
        assert.ok(HALT_VALUES.includes(halt));
      }
    }
  }
  assert.equal(
    combineRunHalt({ reported: "config_missing", circuitLatched: true, openStateMismatches: 1 }),
    decideHalt({ appIdentityConfigured: false, circuitLatched: true, unboundAppPrs: 0, unboundAppRefs: 0, openStateMismatches: 1 }),
  );
});

test("a stored instant is exactly what toISOString writes, or no record", () => {
  const at = new Date("2026-09-28T01:02:03.456Z");
  assert.equal(parseSettingInstant(at.toISOString())?.getTime(), at.getTime());
  for (const raw of [null, undefined, "", "yesterday", "2026-09-28", "2026-09-28T01:02:03+10:00", "2026-13-45T99:99:99.000Z"]) {
    assert.equal(parseSettingInstant(raw), null, String(raw));
  }
});

test("the response ceiling holds the widest claim, and a result that cannot be sent is refused before commit", () => {
  // JSON writes each control character as six bytes.
  const worstPatch = "\u0001".repeat(ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES);
  assert.equal(JSON.stringify(worstPatch).length, ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES * 6 + 2);
  assert.ok(ENGINEERING_AGENT_RESPONSE_MAX_BYTES >= ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES * 6 + 16 * 1024);
  const claim = {
    mode: "write",
    workItemId: "00000000-0000-4000-8000-000000000000",
    runId: "123456789012",
    branch: "agent/engineering/123456789012",
    fencingToken: 1n,
    patchBody: worstPatch,
    patchDigest: "0".repeat(64),
    commitDigest: "0".repeat(64),
  };
  assert.doesNotThrow(() => requireSendableResult(claim));
  assert.throws(
    () => requireSendableResult({ ...claim, patchBody: "\u0001".repeat(ENGINEERING_AGENT_RESPONSE_MAX_BYTES) }),
    /response_too_large/,
  );
});
