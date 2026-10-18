// Orchestration policy version 35, section 3 (stage R2c): the one reader the
// assignment paths ask for the worker catalog. With R2c's latch off it is the
// catalog variables and sends nothing; with it on (version 53), one statement
// whose result, for production's values, is exactly what the variables give.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { getConfiguredAmuxV22WorkerCatalog, getConfiguredAmuxWorkerCatalog } from "../lib/amux/routing.ts";
import { AMUX_V22_WORKER_CATALOG_ENV } from "../lib/amux/v22WorkerCatalogCore.ts";
import {
  amuxDerivedCatalogAsConfigured,
  amuxWorkerCatalogRefusal,
  readAmuxAssignmentCatalogs,
  readAmuxRegistryAndDerivedCatalog,
  readAmuxDerivedWorkerCatalog,
} from "../lib/amux/workerAssignmentCatalog.ts";
import {
  AMUX_WORKER_DERIVED_CATALOG_ASSIGNMENT_LATCH,
  AMUX_WORKER_SESSION_LIST_LATCH,
  amuxWorkerDerivedCatalogAssignmentOpen,
  amuxWorkerSessionListOpen,
} from "../lib/amux/workerDerivedCatalogCore.ts";
import { AMUX_WORKER_REGISTRY_V31_SEED, amuxWorkerProviderClassOf } from "../lib/amux/workerRegistryCore.ts";

const LEGACY_ENV = "TOMVERSE_AMUX_WORKER_CATALOG_JSON";
const saved = { legacy: process.env[LEGACY_ENV], v22: process.env[AMUX_V22_WORKER_CATALOG_ENV] };
afterEach(() => {
  for (const [name, value] of [[LEGACY_ENV, saved.legacy], [AMUX_V22_WORKER_CATALOG_ENV, saved.v22]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// The production catalog variables as read on 2026-10-13 (names, providers,
// models, tags and tools only), spelled as the variables spell them.
const PRODUCTION_LEGACY_JSON = JSON.stringify([
  { worker_name: "codex-chore", provider: "codex", routing_roles: ["chore"] },
  { worker_name: "codex-impl", provider: "codex", routing_roles: ["implementation"] },
  { worker_name: "codex-contract", provider: "codex", routing_roles: ["contract"] },
  { worker_name: "claude-chore", provider: "claude", routing_roles: ["chore"] },
  { worker_name: "claude-impl", provider: "claude", routing_roles: ["implementation"] },
  { worker_name: "claude-contract", provider: "claude", routing_roles: ["contract"] },
  { worker_name: "claude-review", provider: "claude", routing_roles: ["review"] },
  { worker_name: "engineering-runner", provider: "claude", model: "claude-opus-5", routing_roles: ["engineering"] },
]);
const PRODUCTION_V22_JSON = JSON.stringify([
  { worker_name: "claude-chore", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["investigate"], tool_capabilities: ["repo_read"] },
  { worker_name: "claude-contract", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["design"], tool_capabilities: ["repo_read"] },
  { worker_name: "claude-impl", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["implement"], tool_capabilities: ["repo_write"] },
  { worker_name: "claude-review", provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["review"], tool_capabilities: ["repo_read"] },
]);
const useProductionVariables = () => {
  process.env[LEGACY_ENV] = PRODUCTION_LEGACY_JSON;
  process.env[AMUX_V22_WORKER_CATALOG_ENV] = PRODUCTION_V22_JSON;
};

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

test("version 53 turns R2c's derived assignment catalog on, and the policy records it", async () => {
  // Version 35 section 5: R2c shipped latched off; version 53 is the
  // operator's activation record. The latch and its record move together.
  assert.equal(AMUX_WORKER_DERIVED_CATALOG_ASSIGNMENT_LATCH, true);
  assert.equal(amuxWorkerDerivedCatalogAssignmentOpen(), true);
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8");
  const normalized = policy.split(String.fromCharCode(13)).join("");
  const lines = normalized.split(String.fromCharCode(10));
  const heading = lines.indexOf("## 버전 53 — R1·R2b 관측 종료와 R2c 배정 카탈로그 전환");
  assert.ok(heading >= 0, "version 53 section");
  // The latch may be true only with the operator's approval recorded, and only
  // once R2b's 72-hour window has closed (2026-10-17 08:21Z). Before then this
  // fails on every run, so no passing check -- and no merge -- can exist; after
  // it, the clock condition holds for good.
  const record = /^승인 기록: `approvedBy: mposition`, `approvedAt: (\d{4}-\d{2}-\d{2})`/.exec(lines[heading + 2] ?? "");
  assert.ok(record, "version 53 approval record");
  assert.ok(record[1] >= "2026-10-17", `approvedAt ${record[1]} is before R2b's window closes`);
  assert.ok(Date.now() >= Date.parse("2026-10-17T08:21:00Z"), "R2b's observation window has not closed");
  // With no argument the reader now asks the registry.
  useProductionVariables();
  const client = fakeClient(statement());
  assert.equal((await readAmuxAssignmentCatalogs(client)).source, "derived");
  assert.equal(client.sent.length, 1);
});

// The catalog variable parser, which the variable path (latch off) uses until
// R2e deletes it. These rules were pinned by the routing snapshot DB tests
// before R2c moved those to the derived catalog.
test("the catalog variable parser: missing or any bad entry means no catalog; providers and roles normalised", () => {
  delete process.env[LEGACY_ENV];
  assert.equal(getConfiguredAmuxWorkerCatalog(), null);
  for (const workerName of ["codex-", " codex-a ", "a".repeat(121)]) {
    process.env[LEGACY_ENV] = JSON.stringify([{ worker_name: workerName, provider: "codex", routing_roles: ["migration"] }]);
    assert.equal(getConfiguredAmuxWorkerCatalog(), null, workerName);
  }
  process.env[LEGACY_ENV] = JSON.stringify([
    { worker_name: "z-migration", provider: "DEVIN", routing_roles: ["migration", "multi_file", "migration"] },
    { worker_name: "a-implementation", provider: "CODEX", model: "explicit-model", routing_roles: ["implementation"] },
  ]);
  const catalog = getConfiguredAmuxWorkerCatalog();
  assert.deepEqual(catalog?.map((worker) => worker.worker_name), ["a-implementation", "z-migration"]);
  assert.equal(catalog?.[0]?.provider, "codex");
  assert.equal(catalog?.[0]?.model, "explicit-model");
  assert.equal(catalog?.[1]?.provider, "devin");
  assert.deepEqual(catalog?.[1]?.routing_roles, ["migration", "multi_file"]);
  for (const worker of catalog ?? []) {
    assert.deepEqual([worker.running, worker.status, worker.dispatch_ready], [false, "stopped", false]);
  }
});

test("latched off, the catalog is the variables and nothing is sent", async () => {
  useProductionVariables();
  const client = fakeClient(statement());
  const catalogs = await readAmuxAssignmentCatalogs(client, false);
  assert.equal(client.sent.length, 0);
  assert.equal(catalogs.source, "variables");
  assert.deepEqual(catalogs.workers, getConfiguredAmuxWorkerCatalog());
  assert.deepEqual(catalogs.v22, getConfiguredAmuxV22WorkerCatalog());
});

test("latched on, one statement gives exactly what production's variables give today", async () => {
  useProductionVariables();
  const client = fakeClient(statement());
  const catalogs = await readAmuxAssignmentCatalogs(client, true);
  assert.equal(client.sent.length, 1);
  assert.equal(catalogs.source, "derived");
  assert.deepEqual(catalogs.workers, getConfiguredAmuxWorkerCatalog());
  assert.deepEqual(catalogs.v22, getConfiguredAmuxV22WorkerCatalog());
  // The one statement composes the stores' three subqueries.
  const text = client.sent[0].sql;
  for (const table of ["AmuxWorkerRegistryEvent", "AmuxWorkerLatchEvent", "AmuxWorkerCapabilityEvent"]) {
    assert.equal(text.split(`FROM "${table}"`).length, 2, table);
  }
  assert.equal(client.sent[0].values.length, 0);
});

test("anything the stores would not accept makes the catalog absent, never shorter", async () => {
  const absent = async (row) => {
    const catalogs = await readAmuxAssignmentCatalogs(fakeClient(row), true);
    assert.deepEqual([catalogs.source, catalogs.workers, catalogs.v22], ["derived", null, null]);
  };
  await absent(undefined);
  await absent(statement(REGISTRY_ROWS.map((row, index) => (index === 0 ? { ...row, providerClass: "cursor" } : row))));
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
    true,
  );
  assert.equal(catalogs.workers.some((worker) => worker.worker_name === "claude-impl"), false);
  assert.equal(catalogs.v22.some((worker) => worker.worker_name === "claude-impl"), false);
  assert.equal(catalogs.workers.length, 7);
});

test("the configured shape keeps the variables' conservative runtime defaults", () => {
  const { workers } = amuxDerivedCatalogAsConfigured({
    legacy: [{ worker_name: "claude-impl", provider: "claude", model: null, routing_roles: ["implementation"], tool_capabilities: [], archived: false, paused: false, isolated: false, blocked: false }],
    v22: [],
  });
  assert.deepEqual([workers[0].running, workers[0].status, workers[0].dispatch_ready], [false, "stopped", false]);
});

test("the reader names no table: the text stays in the stores", () => {
  const source = readFileSync(new URL("../lib/amux/workerAssignmentCatalog.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(source, /Amux(WorkerRegistryEvent|WorkerLatchEvent|WorkerCapabilityEvent|WorkerObservation)/);
});

test("the register refusal names an absent catalog apart from an unlisted name", async () => {
  useProductionVariables();
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(statement()), "claude-impl", true), null);
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(statement()), "cursor-impl", true), "worker_not_configured");
  assert.equal(await amuxWorkerCatalogRefusal(fakeClient(undefined), "claude-impl", true), "worker_catalog_unavailable");
  // Latched off it is the variable's answer, with nothing sent.
  const client = fakeClient(statement());
  assert.equal(await amuxWorkerCatalogRefusal(client, "engineering-runner", false), null);
  assert.equal(await amuxWorkerCatalogRefusal(client, "cursor-impl", false), "worker_not_configured");
  assert.equal(client.sent.length, 0);
});

test("the lifecycle routes keep the variable's check while R2c is off, and pass the derived one only when it is on", () => {
  const route = (name) => readFileSync(new URL(`../app/api/internal/amux/workers/${name}/route.ts`, import.meta.url), "utf8");
  const register = route("register");
  const has = (source, text) => assert.ok(source.includes(text), text);
  has(register, "const catalog = derived ? [] : getConfiguredAmuxWorkerCatalog();");
  has(register, "derived ? (tx) => amuxWorkerCatalogRefusal(tx, body.worker_name, true) : undefined");
  has(register, "error instanceof AmuxWorkerRegistrationRefusedError");
  const heartbeat = route("heartbeat");
  has(heartbeat, "const catalog = derived ? [] : getConfiguredAmuxWorkerCatalog();");
  has(heartbeat, "listed: derived\n          ? async (tx) => (await amuxWorkerCatalogRefusal(tx, body.worker_name, true)) === null\n          : undefined,");
});

test("quota and the engineering adapter keep the variable while R2c is off, and read the derived catalog in their own transactions when it is on", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const has = (source, text) => assert.ok(source.includes(text), text);
  const quota = read("app/api/internal/amux/quota/route.ts");
  has(quota, "const variableListed = derived ? null : listedFor(getConfiguredAmuxV22WorkerCatalog());");
  has(quota, "const configured = variableListed ?? listedFor((await readAmuxAssignmentCatalogs(tx, true)).v22);");
  // The check comes before the audit chain lock: a refusal locks and writes nothing.
  assert.ok(quota.indexOf("listedFor((await readAmuxAssignmentCatalogs(tx, true)).v22)") < quota.indexOf("await takeAuditChainLock(tx);"));
  const adapter = read("lib/engineeringAgentAmuxAdapter.ts");
  assert.equal(adapter.split("const refusal = derived ? null : workerCatalogRefusal();").length, 3);
  has(adapter, "derived ? (tx) => amuxWorkerCatalogRefusal(tx, ENGINEERING_AGENT_AMUX_WORKER, true) : undefined");
  has(adapter, "error instanceof AmuxWorkerRegistrationRefusedError");
  has(adapter, ["listed: derived",
    "      ? async (tx) => (await amuxWorkerCatalogRefusal(tx, ENGINEERING_AGENT_AMUX_WORKER, true)) === null",
    "      : undefined,"].join(String.fromCharCode(10)));
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

test("version 54 turns R2d's bridge session list on, the policy records it, and the route only reads", () => {
  // Orchestration policy version 35, section 4; version 54 is the operator's
  // activation record. The latch may be true only with that approval
  // recorded: a candidate still awaiting it fails here, so it cannot merge.
  assert.equal(AMUX_WORKER_SESSION_LIST_LATCH, true);
  assert.equal(amuxWorkerSessionListOpen(), true);
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8");
  const lines = policy.split(String.fromCharCode(13)).join("").split(String.fromCharCode(10));
  const heading = lines.indexOf("## 버전 54 — R2d bridge 세션 목록 켜기");
  assert.ok(heading >= 0, "version 54 section");
  assert.match(lines[heading + 2] ?? "", /^승인 기록: `approvedBy: mposition`, `approvedAt: \d{4}-\d{2}-\d{2}`/, "version 54 approval record");
  const route = readFileSync(new URL("../app/api/internal/amux/workers/session-list/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.ok(route.indexOf("isAmuxSyncAuthorized(request)") < route.indexOf("readAmuxWorkerSessionList()"));
  const list = readFileSync(new URL("../lib/amux/workerSessionList.ts", import.meta.url), "utf8");
  assert.match(list, /if \(!open\) return \{ listed: false, reason: "session_list_off" \};/);
  assert.match(list, /AMUX_DB_BOUNDARIES\.workerSessionListRead/);
  assert.match(list, /filter\(\(name\) => !amuxDerivedCatalogEntryIsConstant\(name\)\)/);
});

test("the derived catalog carries each registered worker's ceiling; the variables carry none", async () => {
  useProductionVariables();
  const variables = await readAmuxAssignmentCatalogs(fakeClient(statement()), false);
  assert.equal(variables.ceilings, null);
  const derived = await readAmuxAssignmentCatalogs(fakeClient(statement()), true);
  assert.equal(derived.ceilings?.get("claude-chore"), "chore");
  assert.equal(derived.ceilings?.get("claude-review"), "contract");
  assert.equal(derived.ceilings?.get("cursor-impl"), "implementation");
  assert.equal(derived.ceilings?.has("engineering-runner"), false);
  const absent = await readAmuxAssignmentCatalogs(fakeClient(undefined), true);
  assert.equal(absent.ceilings, null);
});
