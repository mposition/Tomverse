import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  AMUX_ATTACHMENT_MAX_PRISMA_CALLS,
  AMUX_DB_BOUNDARIES,
  AMUX_DB_COMMIT_RESERVE_MS,
  AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS,
  AMUX_DB_MAX_WAIT_MS,
  AMUX_DB_STATEMENT_TIMEOUT_MS,
} from "../lib/amux/dbBoundary.ts";
import { isAmuxExecutionApiEnabled } from "../lib/amux/executionGate.ts";
import {
  ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH,
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  ENGINEERING_AGENT_AMUX_WORKER,
  amuxSettlementForRunOutcome,
  engineeringAgentAmuxAdapterPermitted,
  engineeringPublishResultAttachment,
  engineeringRunEndAttachment,
  engineeringRunHeartbeatAttachment,
  engineeringRunStartAttachment,
  isEngineeringAgentAmuxAdapterOpen,
  mintEngineeringAgentRunId,
} from "../lib/engineeringAgentAmuxAdapter.ts";
import {
  HALT_VALUES,
  RUNNER_REPORTABLE_HALTS,
  RUNNER_REPORTABLE_OUTCOMES,
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

test("the latch ships on, and the adapter opens only with it, the execution API and a mode that is not off", () => {
  assert.equal(ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH, true, "version 25 turns the latch on");
  // With the latch on, the fast check is exactly the execution API gate.
  assert.equal(isEngineeringAgentAmuxAdapterOpen(), isAmuxExecutionApiEnabled());
  for (const mode of ["shadow", "t1"]) {
    assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: true, executionApiEnabled: true, mode }), true, mode);
    assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: true, executionApiEnabled: false, mode }), false, mode);
    assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: false, executionApiEnabled: true, mode }), false, mode);
  }
  // Authority: the writer path runs only when the latch and the operating mode
  // are both open. Mode off closes every adapter call, not only a new run.
  assert.equal(engineeringAgentAmuxAdapterPermitted({ codeLatch: true, executionApiEnabled: true, mode: "off" }), false);
});

test("every adapter operation checks the whole gate, mode included, before it touches AMUX", () => {
  const source = readFileSync(new URL("../lib/engineeringAgentAmuxAdapter.ts", import.meta.url), "utf8");
  const sliceFrom = (start) => source.slice(source.indexOf(start), source.indexOf("\n};", source.indexOf(start)));
  const gate = sliceFrom("export const engineeringAgentAmuxAdapterPermittedNow = async");
  assert.match(gate, /readEngineeringAgentSwitches\(prisma\)/, "the gate reads the effective mode");
  assert.match(gate, /engineeringAgentAmuxAdapterPermitted\(/, "the gate applies the whole decision");
  assert.match(sliceFrom("const requireOpen = async"), /await engineeringAgentAmuxAdapterPermittedNow\(\)/, "requireOpen is that gate");
  assert.equal((source.match(/^ {2}requireOpen\(\);$/gm) ?? []).length, 0, "a requireOpen() call is not awaited");
  const exported = [...source.matchAll(/^export async function (\w+)/gm)].map((match) => match[1]);
  for (const name of exported) {
    const body = source.slice(source.indexOf(`export async function ${name}`));
    const next = body.indexOf("\nexport ", 1);
    const own = next < 0 ? body : body.slice(0, next);
    if (!/(?:register|heartbeat|pull|ack|start|finish|record|settle|claim)/i.test(name)) continue;
    if (name === "recordEngineeringAgentPublisherResult") {
      // A reported pull request already exists: a closed adapter records it on
      // the engineering side with a mismatch for a person, and never reaches AMUX.
      const closed = own.indexOf('if (!(await engineeringAgentAmuxAdapterPermittedNow())) return settleWithoutCard("adapter_closed");');
      assert.ok(closed > 0, "the publisher result checks the whole gate");
      assert.ok(closed < own.indexOf("recordAmuxReviewPullRequest("), "and checks it before AMUX");
      continue;
    }
    assert.match(own, /await requireOpen\(\);/, `${name} calls AMUX without the whole gate`);
  }
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
  assert.equal(RUNNER_REPORTABLE_OUTCOMES.includes("private_result"), false);
  assert.equal(RUNNER_REPORTABLE_OUTCOMES.includes("abandoned"), false);
  const finish = readFileSync("app/api/internal/engineering-agent/run/finish/route.ts", "utf8");
  assert.match(finish, /outcome: z\.enum\(RUNNER_REPORTABLE_OUTCOMES\)/);
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
    if (!text.includes("@/lib/engineeringAgentAmuxAdapter")) continue;
    if (file.replaceAll("\\", "/").endsWith("publish/result/route.ts")) {
      // The publisher's result: the adapter checks the latch itself, and only
      // on the path that records a pull request on the card.
      assert.match(text, /isEngineeringAgentRouteAuthorized\(request, "publisher"\)/, file);
      continue;
    }
    assert.match(text, /isEngineeringAgentRouteAuthorized\(request, "runner"\)/, `${file} is a runner route`);
    // The whole gate, mode included, before the body: a closed gate records no request row.
    const gate = 'if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);';
    assert.ok(text.includes(gate), `${file} checks the whole gate before the body`);
    assert.ok(text.indexOf(gate) < text.indexOf("readLimitedJson("), `${file} checks the gate before it reads or records anything`);
  }
  const adapter = readFileSync("lib/engineeringAgentAmuxAdapter.ts", "utf8");
  const publisherResult = adapter.slice(adapter.indexOf("export async function recordEngineeringAgentPublisherResult"));
  assert.match(
    publisherResult,
    /return settleWithoutCard\("adapter_closed"\);\r?\n\s+const item = await prisma/,
    "the AMUX path is behind the whole gate, and a closed gate still records the result",
  );
});

test("each attached writer fits the adapter routes' budget, as the AMUX routes' writers fit theirs", () => {
  const perCall = AMUX_DB_STATEMENT_TIMEOUT_MS + AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS;
  const fits = (boundary, attachment) =>
    (AMUX_DB_BOUNDARIES[boundary].prismaCallCeiling + attachment.prismaCalls) * perCall +
      AMUX_DB_COMMIT_RESERVE_MS +
      AMUX_DB_MAX_WAIT_MS <=
    ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS;
  assert.ok(fits("executionStart", engineeringRunStartAttachment({ runId: "1", baseSha: "0".repeat(40) })));
  assert.ok(fits("executionHeartbeat", engineeringRunHeartbeatAttachment({ runId: "1" })));
  assert.ok(fits("executionSettle", engineeringRunEndAttachment({ runId: "1", outcome: "t2_draft", halt: "none" })));
  assert.ok(
    fits(
      "reviewPullRequest",
      engineeringPublishResultAttachment({ workItemId: "x", fencingToken: 1n, outcome: "confirmed", pullRequest: null }),
    ),
  );
  for (const attachment of [
    engineeringRunStartAttachment({ runId: "1", baseSha: "0".repeat(40) }),
    engineeringRunEndAttachment({ runId: "1", outcome: "t2_draft", halt: "none" }),
    engineeringPublishResultAttachment({ workItemId: "x", fencingToken: 1n, outcome: "confirmed", pullRequest: null }),
  ]) {
    assert.ok(attachment.prismaCalls <= AMUX_ATTACHMENT_MAX_PRISMA_CALLS);
  }
});

test("the adapter reaches only the AMUX writers version 12 allows it", () => {
  const text = readFileSync("lib/engineeringAgentAmuxAdapter.ts", "utf8");
  const imported = [...text.matchAll(/from "@\/lib\/amux\/([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(imported)], [
    "dbBoundary",
    "delivery",
    "execution",
    "executionGate",
    "reviewPullRequest",
    "routing",
    "store",
    "workerRuntime",
  ]);
  assert.doesNotMatch(text, /\breclaimExpiredAmux/, "recovery is the AMUX recover route's alone");
  assert.doesNotMatch(text, /toStatus:\s*"done"/);
  const costs = [...text.matchAll(/actualCostMicrousd:\s*([^,\s]+)/g)].map((match) => match[1]);
  assert.deepEqual(costs, ["null"], "no agent cost enters an attempt's settlement");
});

test("a run's halt is the runner's report combined with the app's, and a report of none lowers nothing", () => {
  assert.equal(combineRunHalt({ reported: "none", circuitLatched: true, openStateMismatches: 0 }), "circuit_open");
  assert.equal(combineRunHalt({ reported: "none", circuitLatched: false, openStateMismatches: 2 }), "state_mismatch");
  assert.equal(combineRunHalt({ reported: "none", circuitLatched: false, openStateMismatches: 0 }), "none");
  // The circuit and a mismatch are the app's readings, never a runner's report.
  assert.deepEqual([...RUNNER_REPORTABLE_HALTS].sort(), ["config_missing", "none", "unbound_app_pr", "unbound_app_ref"]);
  const finish = readFileSync("app/api/internal/engineering-agent/run/finish/route.ts", "utf8");
  assert.match(finish, /halt: z\.enum\(RUNNER_REPORTABLE_HALTS\)/);
  for (const reported of RUNNER_REPORTABLE_HALTS) {
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
