// Orchestration policy version 35, section 3: the one reader the assignment
// paths ask for the worker catalog. Stage R2c (version 53) made it the catalog
// derived from the registry; stage R2e removed the catalog variables and R2c's
// latch, so it is always one statement whose result, for production's values,
// is exactly what the variables gave.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  amuxDerivedCatalogAsConfigured,
  amuxWorkerCatalogRefusal,
  readAmuxAssignmentCatalogs,
  readAmuxRegistryAndDerivedCatalog,
  readAmuxDerivedWorkerCatalog,
} from "../lib/amux/workerAssignmentCatalog.ts";
import * as derivedCatalogCore from "../lib/amux/workerDerivedCatalogCore.ts";
import { AMUX_WORKER_REGISTRY_V31_SEED } from "../lib/amux/workerRegistryCore.ts";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name) => name.slice(0, name.indexOf("-"));



// What the catalog variables' parser returned for production's catalog
// variables as read on 2026-10-13 (names, providers, models, tags and tools
// only), recorded from that parser before R2e removed it. The derived
// catalog must keep giving exactly this for the capabilities R2a recorded
// from those variables.
const staticRow = (worker_name, provider, routing_roles, extra = {}) => ({
  worker_name, provider, model: null, routing_roles, tool_capabilities: [],
  running: false, status: "stopped", dispatch_ready: false,
  archived: false, paused: false, isolated: false, blocked: false,
  ...extra,
});
const PRODUCTION_WORKERS = [
  staticRow("claude-chore", "claude", ["chore"]),
  staticRow("claude-contract", "claude", ["contract"]),
  staticRow("claude-impl", "claude", ["implementation"]),
  staticRow("claude-review", "claude", ["review"]),
  staticRow("codex-chore", "codex", ["chore"]),
  staticRow("codex-contract", "codex", ["contract"]),
  staticRow("codex-impl", "codex", ["implementation"]),
  staticRow("engineering-runner", "claude", ["engineering"], { model: "claude-opus-5" }),
];
const v22Row = (worker_name, role, tool) => staticRow(worker_name, "anthropic", [role], {
  model: "claude-opus-5-5", tool_capabilities: [tool],
});
const PRODUCTION_V22 = [
  v22Row("claude-chore", "investigate", "repo_read"),
  v22Row("claude-contract", "design", "repo_read"),
  v22Row("claude-impl", "implement", "repo_write"),
  v22Row("claude-review", "review", "repo_read"),
];

// What the one statement returns once R2a's import has run in production.
const REGISTRY_ROWS = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => ({
  workerName: entry.workerName,
  providerClass: amuxWorkerProviderClassOf(entry.workerName),
  roleCeiling: entry.roleCeiling,
  desiredState: entry.desiredState,
  revision: 1,
}));
const v22Profile = {
  "claude-chore": ["investigate", "repo_read"],
  "claude-contract": ["design", "repo_read"],
  "claude-impl": ["implement", "repo_write"],
  "claude-review": ["review", "repo_read"],
};
const CAPABILITY_ROWS = [
  ["codex-chore", "chore"], ["codex-impl", "implementation"], ["codex-contract", "contract"],
  ["claude-chore", "chore"], ["claude-impl", "implementation"], ["claude-contract", "contract"], ["claude-review", "review"],
].map(([workerName, tag]) => ({
  workerName,
  revision: 1,
  model: null,
  routingTags: [tag],
  toolCapabilities: [],
  v22Model: v22Profile[workerName] ? "claude-opus-5-5" : null,
  v22Roles: v22Profile[workerName] ? [v22Profile[workerName][0]] : null,
  v22Tools: v22Profile[workerName] ? [v22Profile[workerName][1]] : null,
  changedAtEpochMs: 1_791_850_000_000,
}));

const fakeClient = (row) => {
  const sent = [];
  return {
    sent,
    $queryRaw: async (sql) => {
      sent.push(sql);
      return row === undefined ? [] : [row];
    },
  };
};
const statement = (registry = REGISTRY_ROWS, latches = [], capabilities = CAPABILITY_ROWS) => ({ registry, latches, capabilities });

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("R2e: R2c's latch is gone and the reader always derives, one statement each time", async () => {
  // Version 53 turned R2c's latch on; R2e removed it with the variables it
  // could fall back to, so no switch is left that sends assignment back.
  for (const name of [
    "AMUX_WORKER_DERIVED_CATALOG_ASSIGNMENT_LATCH",
    "amuxWorkerDerivedCatalogAssignmentOpen",
    "AMUX_WORKER_DERIVED_CATALOG_SHADOW_LATCH",
    "amuxWorkerDerivedCatalogShadowOpen",
    "compareAmuxDerivedCatalogWithEnv",
  ]) {
    assert.equal(name in derivedCatalogCore, false, name);
  }
  const reader = code(read("lib/amux/workerAssignmentCatalog.ts"));
  assert.match(reader, /export async function readAmuxAssignmentCatalogs\(client: CatalogReader\): Promise<AmuxAssignmentCatalogs> \{/);
  assert.match(reader, /export async function amuxWorkerCatalogRefusal\(\s*client: CatalogReader,\s*workerName: string,\s*\): Promise/);
  // The one variable it reads turns on non-Claude v22 profiles (owner decision
  // 2026-10-26); none sends assignment back to a catalog variable.
  assert.doesNotMatch(reader.replace(
    "process.env[AMUX_V22_MULTI_PROVIDER_ENV]", ""), /process\.env|source:/);
  const client = fakeClient(statement());
  const catalogs = await readAmuxAssignmentCatalogs(client);
  assert.equal(client.sent.length, 1);
  assert.deepEqual(Object.keys(catalogs).sort(), ["ceilings", "v22", "workers"]);
  await amuxWorkerCatalogRefusal(client, "claude-impl");
  assert.equal(client.sent.length, 2);
});

/** Every TypeScript source file the product builds from. */
const sourceFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs)$/.test(entry)) found.push(full);
  }
  return found;
};

test("R2e: no product source reads either catalog variable or names the removed parsers", () => {
  const files = ["lib", "app", "components"].flatMap((dir) => sourceFiles(dir));
  assert.ok(files.length > 500, `only ${files.length} source files found`);
  const readers = files.filter((path) => /TOMVERSE_AMUX_(V22_)?WORKER_CATALOG_JSON|AMUX_V22_WORKER_CATALOG_ENV|workerCatalogVariables|v22WorkerCatalogCore|getConfiguredAmux(V22)?WorkerCatalog/
    .test(code(readFileSync(path, "utf8"))));
  assert.deepEqual(readers, []);
});

test("one statement gives exactly what production's catalog variables gave", async () => {
  const client = fakeClient(statement());
  const catalogs = await readAmuxAssignmentCatalogs(client);
  assert.equal(client.sent.length, 1);
  assert.deepEqual(catalogs.workers, PRODUCTION_WORKERS);
  assert.deepEqual(catalogs.v22, PRODUCTION_V22);
  // The one statement composes the stores' three subqueries.
  const text = client.sent[0].sql;
  for (const table of ["AmuxWorkerRegistryEvent", "AmuxWorkerLatchEvent", "AmuxWorkerCapabilityEvent"]) {
    assert.equal(text.split(`FROM "${table}"`).length, 2, table);
  }
  assert.equal(client.sent[0].values.length, 0);
});

test("anything the stores would not accept makes the catalog absent, never shorter", async () => {
  const absent = async (row) => {
    const catalogs = await readAmuxAssignmentCatalogs(fakeClient(row));
    assert.deepEqual([catalogs.workers, catalogs.v22, catalogs.ceilings], [null, null, null]);
  };
  await absent(undefined);
  await absent(statement(REGISTRY_ROWS.map((row, index) => (index === 0 ? { ...row, providerClass: "devin" } : row))));
  await absent(statement(REGISTRY_ROWS, [{ workerName: "claude-impl", eventKind: "unknown" }]));
  await absent(statement(REGISTRY_ROWS, [], [{ ...CAPABILITY_ROWS[0], routingTags: [] }]));
  await absent(statement(REGISTRY_ROWS, [], [{ ...CAPABILITY_ROWS[3], v22Roles: null }]));
  await absent({ registry: null, latches: [], capabilities: [] });
  await absent({ registry: [], latches: [], capabilities: "[]" });
  assert.equal(await readAmuxDerivedWorkerCatalog(fakeClient(undefined)), null);
});

test("an open stop latch takes the worker and its v22 profile out of both lists", async () => {
  const catalogs = await readAmuxAssignmentCatalogs(
    fakeClient(statement(REGISTRY_ROWS, [{ workerName: "claude-impl", eventKind: "opened" }])),
  );
  assert.equal(catalogs.workers.some((worker) => worker.worker_name === "claude-impl"), false);
  assert.equal(catalogs.v22.some((worker) => worker.worker_name === "claude-impl"), false);
  assert.equal(catalogs.workers.length, 7);
});

test("the configured shape keeps the conservative runtime defaults", () => {
  const { workers } = amuxDerivedCatalogAsConfigured({
    legacy: [{ worker_name: "claude-impl", provider: "claude", model: null, routing_roles: ["implementation"], tool_capabilities: [], archived: false, paused: false, isolated: false, blocked: false }],
    v22: [],
  });
  assert.deepEqual([workers[0].running, workers[0].status, workers[0].dispatch_ready], [false, "stopped", false]);
});

test("the reader names no table: the text stays in the stores", () => {
  assert.doesNotMatch(code(read("lib/amux/workerAssignmentCatalog.ts")), /Amux(WorkerRegistryEvent|WorkerLatchEvent|WorkerCapabilityEvent|WorkerObservation)/);
});

test("the register refusal names an absent catalog apart from an unlisted name", async () => {
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(statement()), "claude-impl"), null);
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(statement()), "engineering-runner"), null);
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(statement()), "cursor-impl"), "worker_not_configured");
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(undefined), "claude-impl"), "worker_catalog_unavailable");
});

test("the lifecycle routes check the derived catalog in their own transactions, and nothing before them", () => {
  const route = (name) => read(`app/api/internal/amux/workers/${name}/route.ts`);
  const has = (source, text) => assert.ok(source.includes(text), text);
  const register = route("register");
  has(register, "(tx) => amuxWorkerCatalogRefusal(tx, body.worker_name),");
  has(register, "error instanceof AmuxWorkerRegistrationRefusedError");
  assert.doesNotMatch(code(register), /worker_catalog_unavailable|worker_not_configured|\bderived\b/);
  const heartbeat = route("heartbeat");
  has(heartbeat, "listed: async (tx) => (await amuxWorkerCatalogRefusal(tx, body.worker_name)) === null,");
  assert.doesNotMatch(code(heartbeat), /worker_catalog_unavailable|worker_not_configured|\bderived\b/);
});

test("quota and the engineering adapter read the derived catalog in their own transactions", () => {
  const has = (source, text) => assert.ok(source.includes(text), text);
  const quota = read("app/api/internal/amux/quota/route.ts");
  has(quota, "const configured = listedFor((await readAmuxAssignmentCatalogs(tx)).v22);");
  // The check comes before the audit chain lock: a refusal locks and writes nothing.
  assert.ok(quota.indexOf("listedFor((await readAmuxAssignmentCatalogs(tx)).v22)") < quota.indexOf("await takeAuditChainLock(tx);"));
  assert.equal(code(quota).split("listedFor(").length - 1, 1, "one catalog check, inside the write's transaction");
  const adapter = read("lib/engineeringAgentAmuxAdapter.ts");
  assert.doesNotMatch(code(adapter), /workerCatalogRefusal\(\)|\bderived\b/);
  has(adapter, "}, (tx) => amuxWorkerCatalogRefusal(tx, ENGINEERING_AGENT_AMUX_WORKER));");
  has(adapter, "error instanceof AmuxWorkerRegistrationRefusedError");
  has(adapter, "    listed: async (tx) => (await amuxWorkerCatalogRefusal(tx, ENGINEERING_AGENT_AMUX_WORKER)) === null,");
});

test("the FIRST Task recovery path reads the assignment catalog in its transaction, never the v22 variable directly", () => {
  // Orchestration policy version 53, section 4: R2e deletes the catalog
  // variables, so this path must read what the claim path reads first.
  const recovery = read("lib/amux/v22TaskRecoveryService.ts");
  assert.equal(recovery.includes("getConfiguredAmuxV22WorkerCatalog"), false);
  assert.equal(recovery.split("readAmuxAssignmentCatalogs(tx)").length - 1, 3);
});

test("a capability the store would not accept leaves no catalog but keeps the registry read beside it", async () => {
  const badCapability = await readAmuxRegistryAndDerivedCatalog(
    fakeClient(statement(REGISTRY_ROWS, [], [{ ...CAPABILITY_ROWS[0], routingTags: [] }])),
  );
  assert.equal(badCapability.derived, null);
  assert.equal(badCapability.registrations?.length, REGISTRY_ROWS.length);
  const badLatch = await readAmuxRegistryAndDerivedCatalog(
    fakeClient(statement(REGISTRY_ROWS, [{ workerName: "claude-impl", eventKind: "unknown" }])),
  );
  assert.deepEqual(badLatch, { registrations: null, derived: null });
  const whole = await readAmuxRegistryAndDerivedCatalog(fakeClient(statement()));
  assert.equal(whole.registrations?.length, REGISTRY_ROWS.length);
  assert.equal(whole.derived?.legacy.length, 8);
});

test("the derived catalog carries each registered worker's ceiling, and none when it is absent", async () => {
  const derived = await readAmuxAssignmentCatalogs(fakeClient(statement()));
  assert.equal(derived.ceilings?.get("claude-chore"), "chore");
  assert.equal(derived.ceilings?.get("claude-review"), "contract");
  assert.equal(derived.ceilings?.get("cursor-impl"), "implementation");
  assert.equal(derived.ceilings?.has("engineering-runner"), false);
  const absent = await readAmuxAssignmentCatalogs(fakeClient(undefined));
  assert.equal(absent.ceilings, null);
});
