import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_WORKER_CATALOG_ENV, parseAmuxV22WorkerCatalog } from
  "../lib/amux/v22WorkerCatalogCore.ts";

const admitted = (name = "worker-a", extra = {}) => ({ worker_name: name,
  provider: "claude", model: "opus", routing_roles: ["chore"],
  tool_capabilities: [], archived: false, paused: false, isolated: false,
  blocked: false, running: false, status: "stopped", dispatch_ready: false,
  ...extra });
const profile = (name = "worker-a", extra = {}) => ({ worker_name: name,
  provider: "anthropic", model: "claude-opus-5-5", routing_roles: ["investigate"],
  tool_capabilities: ["repo_read"], ...extra });
const parse = (rows, workers = [admitted()]) =>
  parseAmuxV22WorkerCatalog(JSON.stringify(rows), workers);

test("v22 profiles are explicit and never fall back to legacy roles or aliases", () => {
  assert.equal(AMUX_V22_WORKER_CATALOG_ENV, "TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON");
  for (const raw of [undefined, "", " ", "not-json", "[]", "{}",
    JSON.stringify([admitted()]), " ".repeat(131_073)]) {
    assert.equal(parseAmuxV22WorkerCatalog(raw, [admitted()]), null);
  }
  assert.equal(parse([profile()], null), null);
  assert.equal(parse([profile()], []), null);
});

test("a v22 profile keeps the entire legacy identity and runtime snapshot unchanged", () => {
  const source = [admitted()];
  const before = JSON.stringify(source);
  const result = parse([profile()], source);
  assert.equal(result?.[0].model, "claude-opus-5-5");
  assert.equal(result?.[0].provider, "anthropic");
  assert.deepEqual(result?.[0].routing_roles, ["investigate"]);
  assert.deepEqual(result?.[0].tool_capabilities, ["repo_read"]);
  assert.equal(result?.[0].running, false);
  assert.equal(result?.[0].dispatch_ready, false);
  assert.equal(JSON.stringify(source), before);
});

test("catalog size is not seven and unprofiled admitted residents are preserved", () => {
  const source = Array.from({ length: 13 }, (_, i) => admitted(`worker-${i}`));
  const before = JSON.stringify(source);
  const result = parse([profile("worker-12"), profile("worker-0")], source);
  assert.deepEqual(result?.map((w) => w.worker_name), ["worker-0", "worker-12"]);
  assert.equal(source.length, 13);
  assert.equal(JSON.stringify(source), before);
});

test("metadata cannot enroll a resident absent from the product admission catalog", () => {
  assert.equal(parse([profile("new-resident")]), null);
  assert.equal(parse([profile(), profile()]), null);
  assert.equal(parse([profile()], [admitted(), admitted()]), null);
  for (const provider of ["codex", "cursor", "copilot", "unknown"]) {
    assert.equal(parse([profile()], [admitted("worker-a", { provider })]), null);
  }
  assert.equal(parse([profile()], [admitted("worker-a", { provider: "anthropic" })])?.length, 1);
});

test("legacy lifecycle exclusions cannot be reset by a v22 profile", () => {
  for (const flag of ["archived", "paused", "isolated", "blocked"]) {
    assert.equal(parse([profile()], [admitted("worker-a", { [flag]: true })])?.[0][flag], true);
    assert.equal(parse([profile("worker-a", { [flag]: false })]), null);
  }
});

test("each role must declare its real required sidecar capability", () => {
  for (const role of ["investigate", "design", "review"]) {
    assert.equal(parse([profile("worker-a", { routing_roles: [role] })])?.length, 1);
    assert.equal(parse([profile("worker-a", { routing_roles: [role],
      tool_capabilities: ["repo_write"] })]), null);
  }
  assert.equal(parse([profile("worker-a", { routing_roles: ["implement"],
    tool_capabilities: ["repo_read", "repo_write"] })])?.length, 1);
  assert.equal(parse([profile("worker-a", { routing_roles: ["implement"] })]), null);
  for (const role of ["test", "verify", "operate", "chore", "implementation", "unknown"]) {
    assert.equal(parse([profile("worker-a", { routing_roles: [role] })]), null);
  }
});

test("aliases, unknown fields and duplicate capabilities are not execution evidence", () => {
  for (const extra of [{ model: "opus" }, { model: "gpt-6-astra" },
    { provider: "claude" }, { provider: "openai" }, { provider: "cursor" },
    { tool_capabilities: ["repo_read", "repo_read"] },
    { tool_capabilities: ["shell"] }, { routing_roles: ["review", "review"] },
    { token: "synthetic-token" }, { tool_capabilities: [] }, { model: null }]) {
    assert.equal(parse([profile("worker-a", extra)]), null);
  }
});

test("Task readiness, promotion capacity and claim use the same separated catalog", () => {
  for (const path of ["lib/amux/v4TaskReadyService.ts", "lib/amux/v22AutoPromotionService.ts",
    "lib/amux/v22WorkerClaimService.ts"]) {
    const source = readFileSync(path, "utf8");
    // Version 35, section 3 (R2c): each reads the assignment catalog in its
    // own transaction, which is the v22 variable while R2c is off.
    assert.match(source, /const \{ v22: \w+ \} = await readAmuxAssignmentCatalogs\(tx\);/);
    assert.doesNotMatch(source, /getConfiguredAmuxWorkerCatalog\(\)|getConfiguredAmuxV22WorkerCatalog\(\)/);
  }
  // The variables' parser moved out of routing.ts (orchestration policy
  // version 35, R2c), which re-exports it for these importers.
  const variables = readFileSync("lib/amux/workerCatalogVariables.ts", "utf8");
  assert.match(variables, /parseAmuxV22WorkerCatalog\(process\.env\[AMUX_V22_WORKER_CATALOG_ENV\],[\s\S]*?getConfiguredAmuxWorkerCatalog\(\)\)/);
  assert.match(variables, /const raw = process\.env\.TOMVERSE_AMUX_WORKER_CATALOG_JSON\?\.trim\(\)/);
  assert.match(readFileSync("lib/amux/routing.ts", "utf8"),
    /export \{\s*getConfiguredAmuxV22WorkerCatalog,\s*getConfiguredAmuxWorkerCatalog,\s*\} from "@\/lib\/amux\/workerCatalogVariables";/);
});

test("v48: readiness counts compatible workers whenever the cost is known, not only when it is allowed", () => {
  const source = readFileSync("lib/amux/v4TaskReadyService.ts", "utf8");
  // A cost that needs reconfirmation must not also read as "no worker": the
  // FIRST Task final consent stands in for exactly that one reconfirmation.
  assert.match(source, /if \(cost !== "hold"\) \{[\s\S]{0,400}?readAmuxAssignmentCatalogs\(tx\)/);
  assert.doesNotMatch(source, /if \(cost === "allow"\) \{/);
});
