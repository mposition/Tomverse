import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { amuxV22SafeStopFencedWorkers,
  isAmuxV22SafeStopFenceConstraintError } from "../../lib/amux/v22LegacySafeStopFence.ts";

test("permanent fence reads request membership without evidence or runtime epoch exemptions", async () => {
  let sql = "";
  const tx = { $queryRaw: async (strings: TemplateStringsArray) => {
    sql = strings.join(""); return [{ workerName: "worker-fenced" }];
  } };
  const fenced = await amuxV22SafeStopFencedWorkers(tx as never,
    ["worker-fenced", "worker-eligible"]);
  assert.deepEqual([...fenced], ["worker-fenced"]);
  assert.match(sql, /request\."requestKind" = 'safe_stop'/);
  assert.match(sql, /unnest\(request\."profileWorkerNames"\)/);
  assert.doesNotMatch(sql, /Evidence|generation|verified/);
  assert.equal(isAmuxV22SafeStopFenceConstraintError(new Error(
    'constraint "AmuxV22LegacySafeStop_worker_fenced_check"')), true);
});

test("every authoritative routing, claim, and execution-start path consults the same fence", () => {
  const root = resolve(import.meta.dirname, "../..");
  const source = (path: string) => readFileSync(resolve(root, path), "utf8");
  const routing = source("lib/amux/routing.ts");
  assert.match(routing, /amuxV22SafeStopFencedWorkers/);
  assert.match(routing, /!safeStopFenced\.has\(worker\.worker_name\)/);
  assert.match(routing, /blocked: worker\.blocked \|\| specialistMismatch \|\|\s*safeStopFenced\.has/);

  const store = source("lib/amux/store.ts");
  assert.ok(store.indexOf("lockAmuxAdmissionAndReadIncident") <
    store.indexOf("amuxV22WorkerSafeStopFenced(tx, worker)"));
  // The claim audit names the fence; the wire answer stays in the closed
  // vocabulary main's Rust claim client parses.
  assert.match(store,
    /writeAmuxClaimRefusalAudit\(tx, "worker_safe_stop_fenced",[\s\S]{0,400}reason: "no_authoritative_worker" as const/);

  const claim = source("lib/amux/v22WorkerClaimService.ts");
  assert.match(claim, /amuxV22SafeStopFencedWorkers/);
  assert.match(claim, /!safeStopFenced\.has\(route\.workerName\)/);
  assert.match(claim, /BoardImportError\("worker_safe_stop_fenced", 409\)/);

  const execution = source("lib/amux/execution.ts");
  assert.equal(execution.match(/amuxV22WorkerSafeStopFenced\(tx, input\.worker\)/g)?.length, 2);
  assert.equal(execution.match(/reason: "worker_safe_stop_fenced"/g)?.length, 2);

  const delivery = source("lib/amux/delivery.ts");
  const deliveryLock = delivery.indexOf("lockAmuxAdmissionAndReadIncident(tx, now)");
  const deliveryFence = delivery.indexOf("amuxV22WorkerSafeStopFenced(tx, input.worker)");
  const deliveryLease = delivery.indexOf("const leased = await tx.amuxWorkDelivery.updateMany");
  assert.ok(deliveryLock >= 0 && deliveryLock < deliveryFence && deliveryFence < deliveryLease);
  assert.match(delivery, /reason: "worker_safe_stop_fenced"/);
});
