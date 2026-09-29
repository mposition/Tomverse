import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HALT_RECOVERY_SMALL_LIMIT,
  planHaltRecovery,
  renderHaltRecoveryPlan,
} from "../scripts/agent-halt-recovery-core.mjs";
import { prBodyMarker } from "../lib/engineeringAgentCore.ts";

// The halt recovery plan (docs/policy/engineering-agent.md §12): read-only,
// a handful of items is recovered by hand, more is an incident.

const sha = (c) => c.repeat(40);
const branch = (run) => `agent/engineering/${run}`;

test("what the app bound needs nothing; what it did not is listed for a person", () => {
  const plan = planHaltRecovery({
    refs: [
      { ref: `refs/heads/${branch("1")}`, sha: sha("a") },
      { ref: `refs/heads/${branch("2")}`, sha: sha("b") },
    ],
    pulls: [
      { number: 10, state: "open", headRef: branch("1"), headSha: sha("a"), body: prBodyMarker("1") },
      { number: 11, state: "open", headRef: branch("2"), headSha: sha("b"), body: prBodyMarker("2") },
    ],
    bindings: [{ runId: "1", prNumber: 10, headSha: sha("a") }],
  });
  assert.equal(plan.verdict, "recover_by_hand");
  assert.deepEqual(
    plan.items.map((item) => [item.kind, item.status, item.runId]),
    [
      ["ref", "unbound", "2"],
      ["pull_request", "unbound", "2"],
    ],
  );
  const text = renderHaltRecoveryPlan(plan, "mposition/Tomverse");
  assert.match(text, /nothing was changed/);
  assert.match(text, /https:\/\/github\.com\/mposition\/Tomverse\/pull\/11/);
});

test("without the app's bindings nothing is called bound, and a foreign pull request is unbound", () => {
  const plan = planHaltRecovery({
    refs: [{ ref: `refs/heads/${branch("3")}`, sha: sha("c") }],
    pulls: [{ number: 12, state: "open", headRef: "someone/else", headSha: sha("d"), body: "<!-- engineering-agent run=3 -->" }],
    bindings: null,
  });
  assert.deepEqual(plan.items.map((item) => item.status), ["unverified", "unbound"]);
  assert.equal(planHaltRecovery({ refs: [], pulls: [], bindings: null }).verdict, "nothing_to_recover");
});

test("more than a handful is an incident, and the plan says how an incident closes", () => {
  const refs = Array.from({ length: HALT_RECOVERY_SMALL_LIMIT + 1 }, (_, i) => ({
    ref: `refs/heads/${branch(String(i + 1))}`,
    sha: sha("e"),
  }));
  const plan = planHaltRecovery({ refs, pulls: [], bindings: [] });
  assert.equal(plan.verdict, "incident");
  const text = renderHaltRecoveryPlan(plan, "mposition/Tomverse");
  assert.match(text, /Revoke the publisher App's key or uninstall the App/);
  assert.match(text, /mode to off/);
});

test("the tool only reads", () => {
  for (const file of ["scripts/agent-halt-recovery.mjs", "scripts/agent-halt-recovery-core.mjs"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /method:\s*"(POST|PATCH|PUT|DELETE)"/, `${file} writes nothing`);
    assert.doesNotMatch(source, /child_process|writeFile/, `${file} runs and writes nothing`);
  }
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.equal(scripts["engineering-agent:halt-plan"], "node --experimental-strip-types scripts/agent-halt-recovery.mjs");
});
