// Orchestration policy version 35, section 3 and stage R2b: the catalog
// derived from the registry, and its shadow comparison with the catalog
// variables. Runs without a database.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseAmuxV22WorkerCatalog } from "../lib/amux/v22WorkerCatalogCore.ts";
import { amuxWorkerCapabilityImport } from "../lib/amux/workerCapabilityCore.ts";
import {
  AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY,
  AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH,
  amuxDerivedCatalogEntryIsConstant,
  amuxWorkerDerivedCatalogShadowOpen,
  compareAmuxDerivedCatalogWithEnv,
  deriveAmuxWorkerCatalog,
} from "../lib/amux/workerDerivedCatalogCore.ts";
import {
  AMUX_WORKER_CATALOG_EXEMPT,
  AMUX_WORKER_REGISTRY_V31_SEED,
  amuxWorkerProviderClassOf,
} from "../lib/amux/workerRegistryCore.ts";

const registration = (workerName, roleCeiling, desiredState = "active") => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName),
  roleCeiling,
  desiredState,
  revision: 1,
});
const REGISTRY = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) =>
  registration(entry.workerName, entry.roleCeiling, entry.desiredState));

// The production catalogs as read on 2026-10-13 (names, providers, models,
// tags and tools only), in the shape getConfiguredAmuxWorkerCatalog() returns.
const env = (worker_name, provider, routing_roles, model = null) => ({
  worker_name, provider, model, routing_roles, tool_capabilities: [],
  archived: false, paused: false, isolated: false, blocked: false,
});
const PRODUCTION_LEGACY = [
  env("codex-chore", "codex", ["chore"]),
  env("codex-impl", "codex", ["implementation"]),
  env("codex-contract", "codex", ["contract"]),
  env("claude-chore", "claude", ["chore"]),
  env("claude-impl", "claude", ["implementation"]),
  env("claude-contract", "claude", ["contract"]),
  env("claude-review", "claude", ["review"]),
  env("engineering-runner", "claude", ["engineering"], "claude-opus-5"),
];
const PRODUCTION_V22 = [
  { worker_name: "claude-chore", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["investigate"], tool_capabilities: ["repo_read"] },
  { worker_name: "claude-contract", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["design"], tool_capabilities: ["repo_read"] },
  { worker_name: "claude-impl", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["implement"], tool_capabilities: ["repo_write"] },
  { worker_name: "claude-review", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["review"], tool_capabilities: ["repo_read"] },
];

/** The capabilities R2a's import records from those catalogs. */
const imported = () => new Map(
  amuxWorkerCapabilityImport(REGISTRY, PRODUCTION_LEGACY, PRODUCTION_V22)
    .map((row) => [row.workerName, { revision: 1, capability: row.proposed }]),
);
const derive = (overrides = {}) => deriveAmuxWorkerCatalog({
  registrations: REGISTRY,
  capabilities: imported(),
  latches: new Map(),
  ...overrides,
});
const compare = (derived, legacy = PRODUCTION_LEGACY, v22 = PRODUCTION_V22) =>
  compareAmuxDerivedCatalogWithEnv({ derived, legacy, v22 });
const verdicts = (comparison) => Object.fromEntries(comparison.rows.map((row) => [row.workerName, row.verdict]));

test("version 43 turns R2b's shadow on, and the policy records it", () => {
  // Version 35 section 5: R2b shipped latched off; version 43 is the
  // operator's activation record. The latch and its record move together.
  assert.equal(AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH, true);
  assert.equal(amuxWorkerDerivedCatalogShadowOpen(), true);
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8");
  const normalized = policy.split(String.fromCharCode(13)).join("");
  const heading = "## 버전 43 — 유도 카탈로그 shadow R2b 코드 래치";
  const record = "승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-14`";
  assert.ok(normalized.includes([heading, "", record].join(String.fromCharCode(10))));
  assert.ok(normalized.includes("`AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH`(`lib/amux/workerDerivedCatalogCore.ts`)를 false로 둔 채 출고됐고, 이 버전이 그 래치를 true로 바꾼다"));
  assert.ok(normalized.includes("approvedBy: mposition · approvedAt: 2026-10-14 · 정책 버전: 43"));
});

test("the engineering runner is a code constant equal to the production catalog entry", () => {
  // Version 35 section 3: the value is the catalog variable's entry; version
  // 34 keeps the name out of the registry; the adapter speaks for this name.
  assert.deepEqual({ ...AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY, routing_roles: [...AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.routing_roles] },
    PRODUCTION_LEGACY.find((entry) => entry.worker_name === "engineering-runner"));
  assert.ok(Object.isFrozen(AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY));
  assert.ok(Object.isFrozen(AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.routing_roles));
  assert.ok(AMUX_WORKER_CATALOG_EXEMPT.includes(AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.worker_name));
  assert.ok(amuxDerivedCatalogEntryIsConstant("engineering-runner"));
  assert.equal(amuxDerivedCatalogEntryIsConstant("claude-impl"), false);
  const adapter = readFileSync(new URL("../lib/engineeringAgentAmuxAdapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /export const ENGINEERING_AGENT_AMUX_WORKER = "engineering-runner";/);
});

test("once production's seven are imported, the derived catalog equals the catalog variables", () => {
  const derived = derive();
  assert.deepEqual(derived.legacy.map((entry) => entry.worker_name), PRODUCTION_LEGACY.map((entry) => entry.worker_name).sort());
  assert.deepEqual(derived.v22.map((entry) => entry.worker_name), PRODUCTION_V22.map((entry) => entry.worker_name));
  const comparison = compare(derived);
  assert.equal(comparison.status, "equal");
  assert.equal(comparison.rows.length, 8);
  assert.ok(comparison.rows.every((row) => row.verdict === "equal" && row.differences.length === 0));
  // The six requested workers are on neither side, so they are not rows.
  assert.equal(comparison.rows.some((row) => row.workerName.startsWith("cursor-")), false);
});

test("derived entries take the shape the catalog's consumers read", () => {
  const derived = derive();
  const impl = derived.legacy.find((entry) => entry.worker_name === "claude-impl");
  assert.deepEqual(impl, {
    worker_name: "claude-impl", provider: "claude", model: null, routing_roles: ["implementation"], tool_capabilities: [],
    archived: false, paused: false, isolated: false, blocked: false,
  });
  // The v22 parser overlays a profile on its legacy entry; the derived v22
  // list is exactly that overlay.
  const reparsed = parseAmuxV22WorkerCatalog(JSON.stringify(PRODUCTION_V22), derived.legacy);
  assert.deepEqual(derived.v22, reparsed);
  // The runner's entry is a copy: changing it cannot reach the constant.
  derived.legacy.find((entry) => entry.worker_name === "engineering-runner").routing_roles.push("chore");
  assert.deepEqual([...AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY.routing_roles], ["engineering"]);
});

test("before the import only the runner is derived, and the seven are reported as variable-only", () => {
  const comparison = compare(derive({ capabilities: new Map() }));
  assert.equal(comparison.status, "different");
  const result = verdicts(comparison);
  assert.equal(result["engineering-runner"], "equal");
  assert.equal(Object.values(result).filter((verdict) => verdict === "env_only").length, 7);
});

test("an open stop latch, a desired state other than active, or a ceiling that leaves nothing removes the worker", () => {
  const latched = verdicts(compare(derive({ latches: new Map([["claude-impl", "opened"]]) })));
  assert.equal(latched["claude-impl"], "env_only");
  const released = verdicts(compare(derive({ latches: new Map([["claude-impl", "released"]]) })));
  assert.equal(released["claude-impl"], "equal");
  const paused = REGISTRY.map((row) => (row.workerName === "codex-impl" ? { ...row, desiredState: "paused" } : row));
  assert.equal(verdicts(compare(derive({ registrations: paused })))["codex-impl"], "env_only");
  const narrowed = REGISTRY.map((row) => (row.workerName === "codex-contract" ? { ...row, roleCeiling: "implementation" } : row));
  assert.equal(verdicts(compare(derive({ registrations: narrowed })))["codex-contract"], "env_only");
});

test("a narrowed ceiling drops a v22 role, and the comparison names the field", () => {
  const capabilities = imported();
  capabilities.set("claude-impl", {
    revision: 2,
    capability: { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: { model: "claude-opus-5-5", roles: ["design"], tools: ["repo_read"] } },
  });
  const comparison = compare(derive({ capabilities }), PRODUCTION_LEGACY, [
    ...PRODUCTION_V22.filter((entry) => entry.worker_name !== "claude-impl"),
    { worker_name: "claude-impl", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["design"], tool_capabilities: ["repo_read"] },
  ]);
  const row = comparison.rows.find((entry) => entry.workerName === "claude-impl");
  assert.equal(row.verdict, "differs");
  assert.deepEqual(row.differences, ["v22"]);
});

test("each differing field is named: provider, model, routing tags, tools", () => {
  const legacy = PRODUCTION_LEGACY.map((entry) => {
    if (entry.worker_name === "codex-impl") return { ...entry, provider: "cursor" };
    if (entry.worker_name === "codex-chore") return { ...entry, model: "gpt-5.6-sol" };
    if (entry.worker_name === "claude-chore") return { ...entry, routing_roles: ["chore", "tests"] };
    if (entry.worker_name === "claude-review") return { ...entry, tool_capabilities: ["shell"] };
    return entry;
  });
  const rows = Object.fromEntries(compare(derive(), legacy).rows.map((row) => [row.workerName, row.differences]));
  assert.deepEqual(rows["codex-impl"], ["provider"]);
  assert.deepEqual(rows["codex-chore"], ["model"]);
  assert.deepEqual(rows["claude-chore"], ["routing_roles"]);
  assert.deepEqual(rows["claude-review"], ["tool_capabilities"]);
  // Case and order are not differences: the catalog's own parser normalizes them.
  const shuffled = PRODUCTION_LEGACY.map((entry) => (entry.worker_name === "claude-chore" ? { ...entry, routing_roles: [" CHORE "] } : entry));
  assert.equal(compare(derive(), shuffled).status, "equal");
});

test("a held catalog entry agrees with an absent derived one, and not with a present one", () => {
  const held = PRODUCTION_LEGACY.map((entry) => (entry.worker_name === "codex-impl" ? { ...entry, paused: true } : entry));
  const both = compare(derive(), held).rows.find((row) => row.workerName === "codex-impl");
  assert.deepEqual([both.env, both.derived, both.verdict], ["held", "present", "derived_only"]);
  const paused = REGISTRY.map((row) => (row.workerName === "codex-impl" ? { ...row, desiredState: "paused" } : row));
  const neither = compare(derive({ registrations: paused }), held).rows.find((row) => row.workerName === "codex-impl");
  assert.deepEqual([neither.env, neither.derived, neither.verdict], ["held", "absent", "equal"]);
});

test("an unreadable side is reported as unreadable, never as a difference", () => {
  assert.equal(deriveAmuxWorkerCatalog({ registrations: null, capabilities: new Map(), latches: new Map() }), null);
  assert.equal(deriveAmuxWorkerCatalog({ registrations: REGISTRY, capabilities: null, latches: new Map() }), null);
  assert.equal(deriveAmuxWorkerCatalog({ registrations: REGISTRY, capabilities: new Map(), latches: null }), null);
  assert.deepEqual(compare(null), { status: "derived_unreadable", rows: [] });
  assert.deepEqual(compare(derive(), null), { status: "catalog_unreadable", rows: [] });
  assert.deepEqual(compare(derive(), PRODUCTION_LEGACY, null), { status: "catalog_unreadable", rows: [] });
  // An absent v22 variable is no profiles: the four Claude profiles then differ.
  const noProfiles = compare(derive(), PRODUCTION_LEGACY, []);
  assert.equal(noProfiles.status, "different");
  assert.equal(noProfiles.rows.filter((row) => row.differences.includes("v22")).length, 4);
});

test("the Admin read reads nothing while the latch is off, and hands the v22 variable over untouched", () => {
  const source = readFileSync(new URL("../lib/amux/workerDerivedCatalogAdminRead.ts", import.meta.url), "utf8");
  const off = source.indexOf('if (!amuxWorkerDerivedCatalogShadowOpen()) return { shadow: "off" };');
  assert.ok(off > 0);
  assert.ok(off < source.indexOf("withAmuxDbBoundary("));
  assert.ok(off < source.indexOf("getConfiguredAmuxWorkerCatalog()"));
  assert.match(source, /amuxWorkerCapabilityV22Catalog\(process\.env\[AMUX_V22_WORKER_CATALOG_ENV\],/);
  assert.doesNotMatch(source, /\.trim\(\)/);
});
