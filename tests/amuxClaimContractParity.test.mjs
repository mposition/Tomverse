import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AMUX_CLAIM_CLOSED_REFUSAL_REASONS } from "../lib/amux/auditContract.ts";

const refusalReasons = [...AMUX_CLAIM_CLOSED_REFUSAL_REASONS];

test("TypeScript and Rust keep one closed AMUX claim refusal vocabulary", async () => {
  const [contract, rust, route, store, routing] = await Promise.all([
    readFile("lib/amux/auditContract.ts", "utf8"),
    readFile("apps/tomverse-orchestrator/src/tomverse_api.rs", "utf8"),
    readFile("app/api/internal/amux/claim/route.ts", "utf8"),
    readFile("lib/amux/store.ts", "utf8"),
    readFile("lib/amux/routing.ts", "utf8"),
  ]);

  for (const reason of refusalReasons) {
    assert.match(contract, new RegExp(`"${reason}"`), reason);
    assert.match(rust, new RegExp(`"${reason}"`), reason);
  }

  assert.match(rust, /reason: Option<ClaimRefusalReason>/);
  assert.match(route, /claim\.reason === "cas_lost"/);
  assert.match(route, /recordAmuxClaimRefusal\("invalid_request"\)/);
  assert.match(store, /reason: "incident_admission_blocked" as const/);
  assert.match(store, /reason: "wip_limit_reached" as const/);
  // One open card per worker; the refusal reuses the closed vocabulary so the
  // Rust wire enum needs no new variant.
  assert.match(store, /reason: "execution_lifecycle_unavailable" as const/);
  assert.ok(store.includes('status: { in: ["todo", "doing"] }'));
  // The router agrees, so a tick does not re-select a worker the claim refuses:
  // both the readiness summary and each candidate exclude busy owners.
  assert.equal(routing.split("!busyOwners.has(worker.worker_name)").length - 1, 2);
  assert.match(store, /AMUX_DB_BOUNDARIES\.claim/);
  assert.match(store, /AMUX_DB_BOUNDARIES\.claimRefusal/);
  assert.match(store, /action: "amux\.claim\.refused"/);
  assert.match(store, /measured: true/);
  assert.match(store, /verdict: "refused"/);
});
