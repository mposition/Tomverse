// Orchestration policy version 35, section 3: the catalog derived from the
// registry -- since R2c the only catalog any assignment path reads, and since
// R2e the only one there is. Runs without a database.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY,
  amuxCardRoleLevel,
  amuxDerivedCatalogEntryIsConstant,
  amuxWorkerCeilingAllowsCard,
  deriveAmuxWorkerCatalog,
} from "../lib/amux/workerDerivedCatalogCore.ts";
import {
  AMUX_WORKER_CATALOG_EXEMPT,
  AMUX_WORKER_REGISTRY_V31_SEED,
} from "../lib/amux/workerRegistryCore.ts";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name) => name.slice(0, name.indexOf("-"));


const registration = (workerName, roleCeiling, desiredState = "active") => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName),
  roleCeiling,
  desiredState,
  revision: 1,
});
const REGISTRY = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) =>
  registration(entry.workerName, entry.roleCeiling, entry.desiredState));

// The production catalog variables as read on 2026-10-13 (names, providers,
// models, tags and tools only), in the shape the derived catalog lists them.
// The variables are gone since R2e; the derived catalog must keep listing
// exactly this for the capabilities R2a recorded from them.
const entry = (worker_name, provider, routing_roles, model = null) => ({
  worker_name, provider, model, routing_roles, tool_capabilities: [],
  archived: false, paused: false, isolated: false, blocked: false,
});
const PRODUCTION_LEGACY = [
  entry("claude-chore", "claude", ["chore"]),
  entry("claude-contract", "claude", ["contract"]),
  entry("claude-impl", "claude", ["implementation"]),
  entry("claude-review", "claude", ["review"]),
  entry("codex-chore", "codex", ["chore"]),
  entry("codex-contract", "codex", ["contract"]),
  entry("codex-impl", "codex", ["implementation"]),
  entry("engineering-runner", "claude", ["engineering"], "claude-opus-5"),
];
const PROFILES = {
  "claude-chore": ["investigate", "repo_read"],
  "claude-contract": ["design", "repo_read"],
  "claude-impl": ["implement", "repo_write"],
  "claude-review": ["review", "repo_read"],
};
// Each v22 profile overlaid on its legacy entry.
const PRODUCTION_V22 = Object.entries(PROFILES).map(([workerName, [role, tool]]) => ({
  ...PRODUCTION_LEGACY.find((row) => row.worker_name === workerName),
  provider: "anthropic",
  model: "claude-opus-5-5",
  routing_roles: [role],
  tool_capabilities: [tool],
}));

/** The capabilities R2a recorded in production from those variables, one revision each. */
const recorded = () => new Map(PRODUCTION_LEGACY
  .filter((row) => !AMUX_WORKER_CATALOG_EXEMPT.includes(row.worker_name))
  .map((row) => [row.worker_name, {
    revision: 1,
    capability: {
      model: null,
      routingTags: [...row.routing_roles],
      toolCapabilities: [],
      v22: PROFILES[row.worker_name]
        ? { model: "claude-opus-5-5", roles: [PROFILES[row.worker_name][0]], tools: [PROFILES[row.worker_name][1]] }
        : null,
    },
  }]));
const derive = (overrides = {}) => deriveAmuxWorkerCatalog({
  registrations: REGISTRY,
  capabilities: recorded(),
  latches: new Map(),
  ...overrides,
});
const names = (rows) => rows.map((row) => row.worker_name);

test("the engineering runner is a code constant equal to the production catalog entry", () => {
  // Version 35 section 3: the value is the catalog variable's entry; version
  // 34 keeps the name out of the registry; the adapter speaks for this name.
  assert.deepEqual({ ...AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY, routing_roles: [...AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.routing_roles] },
    PRODUCTION_LEGACY.find((row) => row.worker_name === "engineering-runner"));
  assert.ok(Object.isFrozen(AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY));
  assert.ok(Object.isFrozen(AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.routing_roles));
  assert.ok(AMUX_WORKER_CATALOG_EXEMPT.includes(AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.worker_name));
  assert.ok(amuxDerivedCatalogEntryIsConstant("engineering-runner"));
  assert.equal(amuxDerivedCatalogEntryIsConstant("claude-impl"), false);
  const adapter = readFileSync(new URL("../lib/engineeringAgentAmuxAdapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /export const ENGINEERING_AGENT_AMUX_WORKER = "engineering-runner";/);
});

test("for production's recorded capabilities, the derived catalog is exactly what the variables listed", () => {
  const derived = derive();
  assert.deepEqual(derived.legacy, PRODUCTION_LEGACY);
  assert.deepEqual(derived.v22, PRODUCTION_V22);
  // The six requested workers have no capability and are not active, so they are not listed.
  assert.equal(derived.legacy.some((row) => row.worker_name.startsWith("cursor-")), false);
});

test("the runner's entry is a copy: changing it cannot reach the constant", () => {
  const derived = derive();
  derived.legacy.find((row) => row.worker_name === "engineering-runner").routing_roles.push("chore");
  assert.deepEqual([...AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.routing_roles], ["engineering"]);
});

test("with no capability recorded only the runner is derived", () => {
  const derived = derive({ capabilities: new Map() });
  assert.deepEqual(names(derived.legacy), ["engineering-runner"]);
  assert.deepEqual(derived.v22, []);
});

test("an open stop latch, a desired state other than active, or a ceiling that leaves nothing removes the worker", () => {
  const latched = derive({ latches: new Map([["claude-impl", "opened"]]) });
  assert.equal(names(latched.legacy).includes("claude-impl"), false);
  assert.equal(names(latched.v22).includes("claude-impl"), false);
  const released = derive({ latches: new Map([["claude-impl", "released"]]) });
  assert.deepEqual(released, derive());
  const paused = REGISTRY.map((row) => (row.workerName === "codex-impl" ? { ...row, desiredState: "paused" } : row));
  assert.deepEqual(names(derive({ registrations: paused }).legacy), names(PRODUCTION_LEGACY).filter((name) => name !== "codex-impl"));
  const narrowed = REGISTRY.map((row) => (row.workerName === "codex-contract" ? { ...row, roleCeiling: "implementation" } : row));
  assert.deepEqual(names(derive({ registrations: narrowed }).legacy), names(PRODUCTION_LEGACY).filter((name) => name !== "codex-contract"));
});

test("a narrowed ceiling drops a v22 role the worker's entry keeps", () => {
  const capabilities = recorded();
  capabilities.set("claude-impl", {
    revision: 2,
    capability: { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: { model: "claude-opus-5-5", roles: ["design"], tools: ["repo_read"] } },
  });
  const derived = derive({ capabilities });
  // `design` needs a contract ceiling; claude-impl's is implementation, so its
  // profile has no role left and is dropped, while its legacy entry stays.
  assert.ok(names(derived.legacy).includes("claude-impl"));
  assert.equal(names(derived.v22).includes("claude-impl"), false);
  assert.deepEqual(derived.v22, PRODUCTION_V22.filter((row) => row.worker_name !== "claude-impl"));
});

test("an unreadable input makes the whole catalog absent, never shorter", () => {
  assert.equal(deriveAmuxWorkerCatalog({ registrations: null, capabilities: new Map(), latches: new Map() }), null);
  assert.equal(deriveAmuxWorkerCatalog({ registrations: REGISTRY, capabilities: null, latches: new Map() }), null);
  assert.equal(deriveAmuxWorkerCatalog({ registrations: REGISTRY, capabilities: new Map(), latches: null }), null);
});

test("version 45: a card's level comes from its tag, and review asks the highest", () => {
  // Version 16's role judgement is not built, so requiredRoutingRole stands in.
  assert.equal(amuxCardRoleLevel(null), null);
  assert.equal(amuxCardRoleLevel("chore"), "chore");
  assert.equal(amuxCardRoleLevel(" Implementation "), "implementation");
  assert.equal(amuxCardRoleLevel("contract"), "contract");
  assert.equal(amuxCardRoleLevel("review"), "contract");
  for (const other of ["tests", "bugfix", "reasoning", "engineering", "anything"]) {
    assert.equal(amuxCardRoleLevel(other), "chore", other);
  }
});

test("version 45: at selection a ceiling below the card's level is not a candidate, whatever the tags", () => {
  // The review finding (r-20261014-044758-95b679): a verified worker with a
  // chore ceiling keeps its review tag, and must not review a contract card.
  assert.equal(amuxWorkerCeilingAllowsCard("claude-chore", "chore", "review"), false);
  assert.equal(amuxWorkerCeilingAllowsCard("claude-review", "contract", "review"), true);
  assert.equal(amuxWorkerCeilingAllowsCard("codex-impl", "implementation", "contract"), false);
  assert.equal(amuxWorkerCeilingAllowsCard("codex-impl", "implementation", "implementation"), true);
  assert.equal(amuxWorkerCeilingAllowsCard("codex-chore", "chore", "tests"), true);
  // No tag asks nothing; an unknown ceiling is not a candidate for a card that asks.
  assert.equal(amuxWorkerCeilingAllowsCard("codex-chore", "chore", null), true);
  assert.equal(amuxWorkerCeilingAllowsCard("claude-impl", undefined, "chore"), false);
  // The code constant is governed by its own policy.
  assert.equal(amuxWorkerCeilingAllowsCard("engineering-runner", undefined, "engineering"), true);
});

test("version 45: the selection snapshot applies the ceiling to both readiness and every candidate", () => {
  const routing = readFileSync(new URL("../lib/amux/routing.ts", import.meta.url), "utf8");
  assert.match(routing, /const \{ workers, ceilings \} = await readAmuxAssignmentCatalogs\(tx\);/);
  assert.match(routing, /ceilings !== null &&\s+!amuxWorkerCeilingAllowsCard\(workerName, ceilings\.get\(workerName\), row\.requiredRoutingRole\)/);
  assert.equal(routing.split("!aboveCeiling(worker.worker_name)").length - 1, 2);
});

test("version 45 records the selection rule the code applies", () => {
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8")
    .split(String.fromCharCode(13)).join("");
  const heading = "## 버전 45 — R2c 선택 단계의 역할 상한 검사";
  const record = "승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-14`";
  assert.ok(policy.includes([heading, "", record].join(String.fromCharCode(10))));
  assert.ok(policy.includes("approvedBy: mposition · approvedAt: 2026-10-14 · 정책 버전: 45"));
  assert.ok(policy.includes("| `review` | `contract` (검토 대상 카드의 수준을 모르므로 가장 높게) |"));
});

test("a non-Claude v22 profile joins the catalog only behind the multi-provider switch", () => {
  const registrations = [registration("claude-impl", "implementation"),
    registration("codex-impl", "implementation"), registration("cursor-impl", "implementation")];
  const v22 = (model, roles = ["implement"], tools = ["repo_write"]) => ({ model, roles, tools });
  const capabilities = new Map([
    ["claude-impl", { capability: { model: null, routingTags: ["implementation"],
      toolCapabilities: [], v22: v22("claude-sonnet-5-5") } }],
    ["codex-impl", { capability: { model: null, routingTags: ["implementation"],
      toolCapabilities: [], v22: v22("gpt-6-luna") } }],
    ["cursor-impl", { capability: { model: null, routingTags: ["implementation"],
      toolCapabilities: [], v22: v22("composer-2.5", ["investigate"], ["repo_read"]) } }],
  ]);
  const derive = (multiProvider) => deriveAmuxWorkerCatalog({ registrations, capabilities,
    latches: new Map(), multiProvider });
  // Off (the default): only Claude runs v22; the others stay session workers.
  assert.deepEqual(derive(undefined).v22.map((row) => [row.worker_name, row.provider]),
    [["claude-impl", "anthropic"]]);
  assert.deepEqual(derive(false).v22.map((row) => row.worker_name), ["claude-impl"]);
  // On: each runs v22 under its own provider and model.
  assert.deepEqual(derive(true).v22.map((row) => [row.worker_name, row.provider, row.model]), [
    ["claude-impl", "anthropic", "claude-sonnet-5-5"],
    ["codex-impl", "openai", "gpt-6-luna"],
    ["cursor-impl", "cursor", "composer-2.5"],
  ]);
});
