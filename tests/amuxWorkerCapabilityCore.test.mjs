// Orchestration policy version 35, stage R2a: the worker capability core.
// Runs without a database: the closed tag and v22-role lists, the role-ceiling
// rule at write and at derivation, and the import from the catalog variables.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_WORKER_CAPABILITY_WRITES_LATCH,
  AMUX_WORKER_ROUTING_TAGS,
  AMUX_WORKER_ROUTING_TAG_REQUIREMENTS,
  AMUX_WORKER_V22_ROLES,
  AMUX_WORKER_V22_ROLE_REQUIREMENTS,
  amuxWorkerCapabilitiesEqual,
  amuxWorkerCapabilityImport,
  amuxWorkerCapabilityRefusal,
  amuxWorkerCapabilityWithinCeiling,
  amuxWorkerCapabilityWritesOpen,
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

test("R2a ships with capability writes latched off", () => {
  assert.equal(AMUX_WORKER_CAPABILITY_WRITES_LATCH, false);
  assert.equal(amuxWorkerCapabilityWritesOpen(), false);
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

test("a v22 profile is Claude-only, on a supported model, with each role's tool, within the ceiling", () => {
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
  assert.equal(
    amuxWorkerCapabilityRefusal(registration("codex-impl", "implementation"), capability(["implementation"], v22(["implement"], ["repo_write"]))),
    "v22_not_claude",
  );
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

// The production catalogs as read on 2026-10-13: names, providers, models,
// tags and tools only.
const PRODUCTION_LEGACY = [
  { worker_name: "codex-chore", provider: "codex", model: null, routing_roles: ["chore"], tool_capabilities: [] },
  { worker_name: "codex-impl", provider: "codex", model: null, routing_roles: ["implementation"], tool_capabilities: [] },
  { worker_name: "codex-contract", provider: "codex", model: null, routing_roles: ["contract"], tool_capabilities: [] },
  { worker_name: "claude-chore", provider: "claude", model: null, routing_roles: ["chore"], tool_capabilities: [] },
  { worker_name: "claude-impl", provider: "claude", model: null, routing_roles: ["implementation"], tool_capabilities: [] },
  { worker_name: "claude-contract", provider: "claude", model: null, routing_roles: ["contract"], tool_capabilities: [] },
  { worker_name: "claude-review", provider: "claude", model: null, routing_roles: ["review"], tool_capabilities: [] },
  { worker_name: "engineering-runner", provider: "claude", model: "claude-opus-5", routing_roles: ["engineering"], tool_capabilities: [] },
];
const PRODUCTION_V22 = [
  { worker_name: "claude-chore", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["investigate"], tool_capabilities: ["repo_read"] },
  { worker_name: "claude-contract", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["design"], tool_capabilities: ["repo_read"] },
  { worker_name: "claude-impl", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["implement"], tool_capabilities: ["repo_write"] },
  { worker_name: "claude-review", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["review"], tool_capabilities: ["repo_read"] },
];
const PRODUCTION_REGISTRY = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) =>
  registration(entry.workerName, entry.roleCeiling, entry.desiredState));

test("production's catalogs import for the seven with no refusal; the exempt runner is not imported", () => {
  const rows = amuxWorkerCapabilityImport(PRODUCTION_REGISTRY, PRODUCTION_LEGACY, PRODUCTION_V22);
  assert.deepEqual(rows.map((row) => row.workerName), [
    "claude-chore", "claude-contract", "claude-impl", "claude-review", "codex-chore", "codex-contract", "codex-impl",
  ]);
  assert.deepEqual(rows.filter((row) => row.refusal !== null), []);
  const chore = rows.find((row) => row.workerName === "claude-chore");
  assert.deepEqual(chore.proposed, {
    model: null,
    routingTags: ["chore"],
    toolCapabilities: [],
    v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] },
  });
  assert.equal(rows.find((row) => row.workerName === "codex-impl").proposed.v22, null);
});

test("an import shows the refusal a write would meet, and skips unregistered or retired names", () => {
  const registry = [registration("claude-chore", "chore"), registration("codex-impl", "implementation", "retired")];
  const rows = amuxWorkerCapabilityImport(
    registry,
    [
      { worker_name: "claude-chore", provider: "claude", routing_roles: ["implementation"] },
      { worker_name: "codex-impl", provider: "codex", routing_roles: ["implementation"] },
      { worker_name: "devin-worker", provider: "devin", routing_roles: ["chore"] },
    ],
    null,
  );
  assert.deepEqual(rows.map((row) => [row.workerName, row.refusal]), [["claude-chore", "tag_above_ceiling"]]);
});
