// Orchestration policy version 35, stage R2a: the worker capability core.
// Runs without a database: the closed tag and v22-role lists, the role-ceiling
// rule at write and at derivation, and the Admin view of what is recorded.
// R2a's import from the catalog variables went with them at R2e.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_WORKER_CAPABILITY_WRITES_LATCH,
  AMUX_WORKER_ROUTING_TAGS,
  AMUX_WORKER_ROUTING_TAG_REQUIREMENTS,
  AMUX_WORKER_V22_ROLES,
  AMUX_WORKER_V22_ROLE_REQUIREMENTS,
  amuxWorkerCapabilitiesEqual,
  amuxWorkerCapabilityRefusal,
  amuxWorkerCapabilityWithinCeiling,
  amuxWorkerCapabilityWritesOpen,
  buildAmuxWorkerCapabilityAdminView,
  parseAmuxWorkerCapabilityAdminView,
} from "../lib/amux/workerCapabilityCore.ts";
import { AMUX_WORKER_REGISTRY_V31_SEED, amuxWorkerProviderClassOf } from "../lib/amux/workerRegistryCore.ts";

const registration = (workerName, roleCeiling, desiredState = "active") => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName),
  roleCeiling,
  desiredState,
  revision: 1,
});

const capability = (routingTags, v22 = null, extra = {}) => ({
  model: null,
  routingTags,
  toolCapabilities: [],
  v22,
  ...extra,
});

test("the closed lists are version 35's table", () => {
  assert.deepEqual({ ...AMUX_WORKER_ROUTING_TAG_REQUIREMENTS }, {
    chore: "any",
    bugfix: "any",
    tests: "any",
    multi_file: "any",
    reasoning: "any",
    integration: "any",
    long_running: "any",
    fallback: "any",
    implementation: "implementation",
    contract: "contract",
    architecture: "contract",
    security: "contract",
    review: "verified",
  });
  assert.deepEqual({ ...AMUX_WORKER_V22_ROLE_REQUIREMENTS }, {
    investigate: "any",
    implement: "implementation",
    design: "contract",
    review: "verified",
  });
  assert.deepEqual([...AMUX_WORKER_ROUTING_TAGS], [...AMUX_WORKER_ROUTING_TAGS].sort());
  assert.deepEqual([...AMUX_WORKER_V22_ROLES], ["design", "implement", "investigate", "review"]);
  assert.ok(Object.isFrozen(AMUX_WORKER_ROUTING_TAG_REQUIREMENTS));
});

test("version 36 turns R2a's capability writes on, and the policy records it", () => {
  // Version 35 section 5: R2a shipped latched off; version 36 is the
  // operator's activation record. The latch and its record move together.
  assert.equal(AMUX_WORKER_CAPABILITY_WRITES_LATCH, true);
  assert.equal(amuxWorkerCapabilityWritesOpen(), true);
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8");
  const normalized = policy.split(String.fromCharCode(13)).join("");
  const heading = "## 버전 36 — worker 능력 R2a 코드 래치";
  const record = "승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-13`";
  assert.ok(normalized.includes([heading, "", record].join(String.fromCharCode(10))));
  assert.ok(normalized.includes("`AMUX_WORKER_CAPABILITY_WRITES_LATCH`(`lib/amux/workerCapabilityCore.ts`)를 false로 둔 채 출고됐고, 이 버전이 그 래치를 true로 바꾼다"));
  assert.ok(normalized.includes("approvedBy: mposition · approvedAt: 2026-10-13 · 정책 버전: 36"));
});

test("a tag is an authority: it never exceeds the worker's ceiling or its class", () => {
  const chore = registration("claude-chore", "chore");
  const impl = registration("codex-impl", "implementation");
  const contract = registration("claude-contract", "contract");
  const cursor = registration("cursor-impl", "implementation", "requested");
  assert.equal(amuxWorkerCapabilityRefusal(chore, capability(["chore", "bugfix"])), null);
  assert.equal(amuxWorkerCapabilityRefusal(chore, capability(["implementation"])), "tag_above_ceiling");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation", "tests"])), null);
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["architecture"])), "tag_above_ceiling");
  assert.equal(amuxWorkerCapabilityRefusal(contract, capability(["contract", "security", "architecture"])), null);
  // Review needs a verified class, whatever the ceiling.
  assert.equal(amuxWorkerCapabilityRefusal(chore, capability(["review"])), null);
  assert.equal(amuxWorkerCapabilityRefusal(cursor, capability(["review"])), "tag_requires_verified");
  assert.equal(amuxWorkerCapabilityRefusal(cursor, capability(["implementation"])), null);
  // Closed list, no duplicates, at least one.
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["Implementation"])), "tag_unknown");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["engineering"])), "tag_unknown");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["constructor"])), "tag_unknown");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["tests", "tests"])), "tag_duplicate");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability([])), "tags_empty");
  // Only a registered, non-retired worker has capabilities.
  assert.equal(amuxWorkerCapabilityRefusal(null, capability(["chore"])), "not_registered");
  assert.equal(amuxWorkerCapabilityRefusal(registration("codex-chore", "chore", "retired"), capability(["chore"])), "retired");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["chore"], null, { model: "" })), "model_invalid");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["chore"], null, { model: "x".repeat(161) })), "model_invalid");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["chore"], null, { toolCapabilities: ["a", "a"] })), "tools_invalid");
});

test("a v22 profile is on its provider's model, with each role's tool, within the ceiling", () => {
  const chore = registration("claude-chore", "chore");
  const impl = registration("claude-impl", "implementation");
  const v22 = (roles, tools, model = "claude-opus-5-5") => ({ model, roles, tools });
  // investigate is read-only and needs no ceiling (the post-approval correction).
  assert.equal(amuxWorkerCapabilityRefusal(chore, capability(["chore"], v22(["investigate"], ["repo_read"]))), null);
  assert.equal(amuxWorkerCapabilityRefusal(chore, capability(["chore"], v22(["implement"], ["repo_write"]))), "v22_role_above_ceiling");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation"], v22(["implement"], ["repo_write"]))), null);
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation"], v22(["design"], ["repo_read"]))), "v22_role_above_ceiling");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation"], v22(["implement"], ["repo_read"]))), "v22_tool_missing");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation"], v22(["verify"], ["repo_read"]))), "v22_role_unknown");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation"], v22(["implement"], ["shell"]))), "v22_tools_invalid");
  assert.equal(amuxWorkerCapabilityRefusal(impl, capability(["implementation"], v22(["implement"], ["repo_write"], "gpt-5")))
    , "v22_model_unsupported");
  // Owner decision 2026-10-26: every provider class may run v22; only a
  // Claude worker is held to a claude-* model.
  for (const worker of ["codex-impl", "copilot-impl", "cursor-impl"]) {
    assert.equal(amuxWorkerCapabilityRefusal(registration(worker, "implementation"),
      capability(["implementation"], v22(["implement"], ["repo_write"], "gpt-6-luna"))), null);
  }
  assert.equal(amuxWorkerCapabilityRefusal(registration("cursor-impl", "implementation"),
    capability(["implementation"], v22(["review"], ["repo_read"], "auto"))), "v22_role_requires_verified");
});

test("a ceiling narrowed after the write drops what it no longer allows", () => {
  const written = capability(["implementation", "tests", "chore"], { model: "claude-opus-5-5", roles: ["implement", "investigate"], tools: ["repo_read", "repo_write"] });
  const narrowed = amuxWorkerCapabilityWithinCeiling(registration("claude-impl", "chore"), written);
  assert.deepEqual(narrowed.routingTags, ["tests", "chore"]);
  assert.deepEqual(narrowed.v22.roles, ["investigate"]);
  assert.equal(amuxWorkerCapabilityWithinCeiling(registration("claude-impl", "chore"), capability(["implementation"])), null);
  const whole = amuxWorkerCapabilityWithinCeiling(registration("claude-impl", "implementation"), written);
  assert.ok(amuxWorkerCapabilitiesEqual(whole, written));
});

const PRODUCTION_REGISTRY = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) =>
  registration(entry.workerName, entry.roleCeiling, entry.desiredState));

test("the Admin view lists every registered, non-retired worker with what is recorded, and nothing else", () => {
  const recorded = new Map([[
    "claude-chore",
    { revision: 2, capability: capability(["chore"], { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] }), changedAt: "2026-10-13T00:00:00.000Z" },
  ]]);
  const registrations = [...PRODUCTION_REGISTRY, registration("codex-old", "chore", "retired")];
  const view = buildAmuxWorkerCapabilityAdminView({ registrations, current: recorded });
  // Defaults to the code latch (true since version 36).
  assert.equal(view.writesLatch, AMUX_WORKER_CAPABILITY_WRITES_LATCH);
  assert.deepEqual(Object.keys(view).sort(), ["rows", "writesLatch"]);
  assert.equal(view.rows.length, 13);
  assert.deepEqual(view.rows.map((row) => row.workerName), [...PRODUCTION_REGISTRY.map((row) => row.workerName)].sort());
  for (const row of view.rows) {
    // R2a's import columns went with the catalog variables at R2e.
    assert.deepEqual(Object.keys(row).sort(), ["current", "desiredState", "roleCeiling", "workerName"]);
  }
  const byName = Object.fromEntries(view.rows.map((row) => [row.workerName, row]));
  assert.deepEqual(byName["claude-chore"].current, recorded.get("claude-chore"));
  assert.equal(byName["cursor-impl"].current, null);
  assert.equal(byName["cursor-impl"].desiredState, "requested");
  assert.deepEqual(parseAmuxWorkerCapabilityAdminView(JSON.parse(JSON.stringify(view))), view);
});

test("the GET body is accepted only in its exact shape", () => {
  const recorded = new Map([[
    "codex-impl",
    { revision: 1, capability: capability(["implementation"]), changedAt: "2026-10-13T00:00:00.000Z" },
  ]]);
  const view = buildAmuxWorkerCapabilityAdminView({ registrations: PRODUCTION_REGISTRY, current: recorded });
  const body = JSON.parse(JSON.stringify(view));
  const index = body.rows.findIndex((row) => row.workerName === "codex-impl");
  const withRow = (row) => ({ ...body, rows: body.rows.map((entry, at) => (at === index ? row : entry)) });
  for (const broken of [
    null,
    { ...body, writesLatch: "no" },
    { ...body, rows: "none" },
    withRow({ ...body.rows[index], workerName: "devin-worker" }),
    withRow({ ...body.rows[index], roleCeiling: "review" }),
    withRow({ ...body.rows[index], desiredState: "retired" }),
    withRow({ ...body.rows[index], current: { ...body.rows[index].current, revision: 0 } }),
    withRow({ ...body.rows[index], current: { ...body.rows[index].current, capability: { routingTags: "chore" } } }),
  ]) {
    assert.equal(parseAmuxWorkerCapabilityAdminView(broken), null, JSON.stringify(broken)?.slice(0, 60));
  }
});

test("the server read takes nothing from the environment", () => {
  const source = readFileSync(new URL("../lib/amux/workerCapabilityAdminRead.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(source, /process\.env|getConfiguredAmux|parseAmuxV22WorkerCatalog/);
  assert.match(source, /buildAmuxWorkerCapabilityAdminView\(\{ registrations: registry\.registrations, current \}\)/);
});
