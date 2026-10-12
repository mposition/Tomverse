// Orchestration policy version 31, stage R1: the worker registry's pure core
// (docs/policy/development-agent-orchestration.md, "버전 31").
//
// Runs without a database: the class table, the name grammar, the change rule,
// the effective assignment rule and the registry-vs-catalog comparison.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_WORKER_DESIRED_STATES,
  AMUX_WORKER_LATCH_CONSECUTIVE_FAILURES,
  AMUX_WORKER_PROVIDER_CLASSES,
  AMUX_WORKER_PROVIDER_CLASS_TABLE,
  AMUX_WORKER_REGISTRY_AUDIT_ACTIONS,
  AMUX_WORKER_REGISTRY_BOOTSTRAP_ACTIVE,
  AMUX_WORKER_REGISTRY_V31_SEED,
  AMUX_WORKER_ROLE_CEILINGS,
  AMUX_WORKER_TRIAL_CARD_COUNT,
  AMUX_WORKER_TRIAL_COST_CAP_MICRO_USD,
  amuxCatalogProviderClass,
  amuxWorkerEffectiveState,
  amuxWorkerLatchOpen,
  amuxWorkerProviderClassOf,
  amuxWorkerRegistrationFromRow,
  amuxWorkerRegistryAuditAction,
  amuxWorkerRegistryAuditMetadata,
  amuxWorkerRegistryChangeRefusal,
  compareAmuxWorkerRegistryWithCatalog,
  isAmuxWorkerName,
  parseAmuxWorkerRegistryChange,
} from "../lib/amux/workerRegistryCore.ts";
import { AGENT_OFFICE_AMUX_ROSTER } from "../lib/agentOffice/amuxRoster.ts";

const registration = (workerName, desiredState, roleCeiling, revision = 1) => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName),
  roleCeiling,
  desiredState,
  revision,
});

const change = (workerName, desiredState, roleCeiling, expectedRevision) => {
  const parsed = parseAmuxWorkerRegistryChange({ workerName, desiredState, roleCeiling, expectedRevision });
  assert.ok(parsed, `${workerName} ${desiredState} ${roleCeiling} parses`);
  return parsed;
};

test("the class table is section 2's: two verified classes, two unverified at implementation", () => {
  assert.deepEqual([...AMUX_WORKER_PROVIDER_CLASSES], ["claude", "codex", "cursor", "copilot"]);
  assert.deepEqual([...AMUX_WORKER_ROLE_CEILINGS], ["chore", "implementation", "contract"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(AMUX_WORKER_PROVIDER_CLASS_TABLE).map(([name, row]) => [name, [row.verified, row.maxRole]])),
    {
      claude: [true, "contract"],
      codex: [true, "contract"],
      cursor: [false, "implementation"],
      copilot: [false, "implementation"],
    },
  );
  assert.ok(Object.isFrozen(AMUX_WORKER_PROVIDER_CLASS_TABLE));
  assert.ok(Object.isFrozen(AMUX_WORKER_PROVIDER_CLASS_TABLE.cursor));
});

test("activation gate 2's values are the ones the operator approved", () => {
  assert.equal(AMUX_WORKER_TRIAL_CARD_COUNT, 3);
  assert.equal(AMUX_WORKER_TRIAL_COST_CAP_MICRO_USD, 5_000_000);
  assert.equal(AMUX_WORKER_LATCH_CONSECUTIVE_FAILURES, 3);
});

test("the name grammar is the class prefix and 1-24 of [a-z0-9]", () => {
  for (const name of ["claude-impl", "codex-x", "cursor-worker", "copilot-" + "a".repeat(24), "codex-0"]) {
    assert.ok(isAmuxWorkerName(name), name);
  }
  for (const name of [
    "claude-", "devin-worker", "Claude-impl", "claude-impl-2", "claude_impl", "copilot-" + "a".repeat(25),
    " claude-impl", "claude-impl\n", "claude-IMPL", "codex", "", null, 7,
  ]) {
    assert.equal(isAmuxWorkerName(name), false, String(name));
    assert.equal(amuxWorkerProviderClassOf(name), null, String(name));
  }
  assert.equal(amuxWorkerProviderClassOf("copilot-chore"), "copilot");
});

test("the seed is version 27's thirteen: the catalog's seven active, the six new requested", () => {
  assert.equal(AMUX_WORKER_REGISTRY_V31_SEED.length, 13);
  assert.deepEqual(
    AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => entry.workerName).sort(),
    AGENT_OFFICE_AMUX_ROSTER.map((seat) => seat.name).sort(),
  );
  assert.deepEqual(
    AMUX_WORKER_REGISTRY_V31_SEED.filter((entry) => entry.desiredState === "active").map((entry) => entry.workerName).sort(),
    [...AMUX_WORKER_REGISTRY_BOOTSTRAP_ACTIVE].sort(),
  );
  for (const entry of AMUX_WORKER_REGISTRY_V31_SEED) {
    const providerClass = amuxWorkerProviderClassOf(entry.workerName);
    assert.ok(providerClass, entry.workerName);
    if (entry.desiredState === "requested") assert.ok(["cursor", "copilot"].includes(providerClass));
    // Every seed entry is a valid first event.
    assert.equal(
      amuxWorkerRegistryChangeRefusal(null, change(entry.workerName, entry.desiredState, entry.roleCeiling, 0)),
      null,
      entry.workerName,
    );
    const suffix = entry.workerName.split("-")[1];
    const expected = suffix === "chore" ? "chore" : suffix === "impl" || suffix === "worker" ? "implementation" : "contract";
    assert.equal(entry.roleCeiling, expected, entry.workerName);
  }
  assert.ok(Object.isFrozen(AMUX_WORKER_REGISTRY_V31_SEED));
  assert.ok(Object.isFrozen(AMUX_WORKER_REGISTRY_V31_SEED[0]));
});

test("parsing refuses anything outside the vocabularies and derives the class from the name", () => {
  const good = { workerName: "cursor-impl", roleCeiling: "chore", desiredState: "requested", expectedRevision: 0 };
  assert.deepEqual(parseAmuxWorkerRegistryChange(good), { ...good, providerClass: "cursor" });
  for (const bad of [
    { ...good, workerName: "devin-worker" },
    { ...good, roleCeiling: "review" },
    { ...good, roleCeiling: "Chore" },
    { ...good, desiredState: "autonomous" },
    { ...good, expectedRevision: -1 },
    { ...good, expectedRevision: 1.5 },
    { ...good, expectedRevision: "0" },
    { ...good, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(parseAmuxWorkerRegistryChange(bad), null, JSON.stringify(bad));
  }
});

test("a role ceiling never exceeds the class's", () => {
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("cursor-x", "requested", "contract", 0)), "role_above_class");
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("copilot-x", "requested", "implementation", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("codex-x", "requested", "contract", 0)), null);
});

test("a new worker starts requested, or active only if it is one of the catalog's seven", () => {
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "requested", "chore", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "active", "chore", 0)), "activation_requires_trial");
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("cursor-impl", "active", "implementation", 0)), "activation_requires_trial");
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-impl", "active", "implementation", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "paused", "chore", 0)), "first_state_invalid");
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "retired", "chore", 0)), "first_state_invalid");
});

test("every change names the revision the person saw", () => {
  const previous = registration("claude-impl", "active", "implementation", 4);
  assert.equal(amuxWorkerRegistryChangeRefusal(previous, change("claude-impl", "paused", "implementation", 3)), "stale_revision");
  assert.equal(amuxWorkerRegistryChangeRefusal(previous, change("claude-impl", "paused", "implementation", 5)), "stale_revision");
  assert.equal(amuxWorkerRegistryChangeRefusal(previous, change("claude-impl", "paused", "implementation", 4)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "requested", "chore", 1)), "stale_revision");
});

test("the transition rule: stop and narrow freely, activate only through R5, retire for good", () => {
  const active = registration("claude-impl", "active", "implementation");
  const requested = registration("cursor-impl", "requested", "chore");
  const paused = registration("codex-impl", "paused", "implementation");
  const retired = registration("codex-chore", "retired", "chore");

  // Stopping and retiring are never refused.
  for (const from of [active, requested, paused]) {
    for (const to of ["paused", "retired"]) {
      if (from.desiredState === to) continue;
      assert.equal(amuxWorkerRegistryChangeRefusal(from, change(from.workerName, to, from.roleCeiling, 1)), null, `${from.desiredState}->${to}`);
    }
  }
  // Activation is section 5's, which R1 does not have.
  for (const from of [requested, paused]) {
    assert.equal(
      amuxWorkerRegistryChangeRefusal(from, change(from.workerName, "active", from.roleCeiling, 1)),
      "activation_requires_trial",
    );
  }
  // A paused worker may go back to trial.
  assert.equal(amuxWorkerRegistryChangeRefusal(paused, change("codex-impl", "requested", "implementation", 1)), null);
  // Retired is final, whatever the change.
  for (const to of AMUX_WORKER_DESIRED_STATES) {
    assert.equal(amuxWorkerRegistryChangeRefusal(retired, change("codex-chore", to, "chore", 1)), "retired");
  }
  // Narrowing an active worker's role is allowed; widening it is a new trial.
  assert.equal(amuxWorkerRegistryChangeRefusal(active, change("claude-impl", "active", "chore", 1)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(active, change("claude-impl", "active", "contract", 1)), "role_widening_requires_trial");
  assert.equal(amuxWorkerRegistryChangeRefusal(paused, change("codex-impl", "paused", "contract", 1)), "role_widening_requires_trial");
  assert.equal(amuxWorkerRegistryChangeRefusal(requested, change("cursor-impl", "requested", "implementation", 1)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(paused, change("codex-impl", "requested", "contract", 1)), null);
  // Recording the state a worker already has is no change.
  assert.equal(amuxWorkerRegistryChangeRefusal(active, change("claude-impl", "active", "implementation", 1)), "no_change");
});

test("the first event registers and every later one changes, with no free text in the audit", () => {
  assert.equal(amuxWorkerRegistryAuditAction(null), AMUX_WORKER_REGISTRY_AUDIT_ACTIONS.register);
  assert.equal(amuxWorkerRegistryAuditAction(registration("claude-impl", "active", "chore")), "amux.worker.change");
  assert.ok(Object.values(AMUX_WORKER_REGISTRY_AUDIT_ACTIONS).every((action) => action.startsWith("amux.worker.")));
  const previous = registration("claude-impl", "active", "implementation", 2);
  const metadata = amuxWorkerRegistryAuditMetadata(previous, change("claude-impl", "paused", "chore", 2), "event-1");
  assert.deepEqual(metadata, {
    event_id: "event-1",
    worker_name: "claude-impl",
    provider_class: "claude",
    role_ceiling: "chore",
    desired_state: "paused",
    revision: 3,
    previous_role_ceiling: "implementation",
    previous_desired_state: "active",
  });
});

test("a stored row maps back only when it is one the guard would have accepted", () => {
  const row = { workerName: "copilot-impl", providerClass: "copilot", roleCeiling: "implementation", desiredState: "requested", revision: 2n };
  assert.deepEqual(amuxWorkerRegistrationFromRow(row), { ...row, revision: 2 });
  for (const [label, bad] of Object.entries({
    class: { ...row, providerClass: "codex" },
    ceiling: { ...row, roleCeiling: "contract" },
    state: { ...row, desiredState: "on" },
    zero: { ...row, revision: 0 },
    string: { ...row, revision: "2" },
    name: { ...row, workerName: "devin-worker" },
  })) {
    assert.equal(amuxWorkerRegistrationFromRow(bad), null, label);
  }
});

test("a latch is open when its newest event is an opening", () => {
  assert.equal(amuxWorkerLatchOpen("opened"), true);
  assert.equal(amuxWorkerLatchOpen("released"), false);
  assert.equal(amuxWorkerLatchOpen(null), false);
});

test("a worker is assigned only when active, unlatched and last observed ok -- every failure is named", () => {
  const active = registration("claude-impl", "active", "implementation");
  assert.deepEqual(
    amuxWorkerEffectiveState({ registration: active, latchNewestKind: "released", latestObservationStatus: "ok" }),
    { assignable: true, reasons: [] },
  );
  assert.deepEqual(
    amuxWorkerEffectiveState({ registration: active, latchNewestKind: null, latestObservationStatus: "ok" }),
    { assignable: true, reasons: [] },
  );
  assert.deepEqual(
    amuxWorkerEffectiveState({ registration: null, latchNewestKind: undefined, latestObservationStatus: null }).reasons,
    ["not_registered", "latch_unreadable", "no_observation"],
  );
  assert.deepEqual(
    amuxWorkerEffectiveState({
      registration: registration("cursor-impl", "requested", "chore"),
      latchNewestKind: "opened",
      latestObservationStatus: "halted",
    }).reasons,
    ["not_active", "latch_open", "observation_not_ok"],
  );
  // Before R4 nothing records an observation, so nothing is assignable by the registry yet.
  assert.equal(
    amuxWorkerEffectiveState({ registration: active, latchNewestKind: null, latestObservationStatus: null }).assignable,
    false,
  );
});

test("catalog providers map to classes only by their known spellings", () => {
  assert.equal(amuxCatalogProviderClass("anthropic"), "claude");
  assert.equal(amuxCatalogProviderClass("openai"), "codex");
  assert.equal(amuxCatalogProviderClass("github-copilot"), "copilot");
  assert.equal(amuxCatalogProviderClass("devin"), null);
  assert.equal(amuxCatalogProviderClass("constructor"), null);
  assert.equal(amuxCatalogProviderClass("__proto__"), null);
});

const catalogEntry = (worker_name, provider, flags = {}) => ({
  worker_name,
  provider,
  archived: false,
  paused: false,
  isolated: false,
  blocked: false,
  ...flags,
});

test("the registry and the catalog agree when they assign the same workers", () => {
  const registry = [
    registration("claude-impl", "active", "implementation"),
    registration("codex-impl", "active", "implementation"),
    registration("cursor-impl", "requested", "implementation"),
  ];
  const catalog = [catalogEntry("claude-impl", "claude"), catalogEntry("codex-impl", "openai")];
  const result = compareAmuxWorkerRegistryWithCatalog(registry, catalog);
  assert.equal(result.status, "match");
  assert.deepEqual(result.rows.map((row) => [row.workerName, row.registryState, row.catalog, row.verdict]), [
    ["claude-impl", "active", "assignable", "match"],
    ["codex-impl", "active", "assignable", "match"],
    ["cursor-impl", "requested", "absent", "match"],
  ]);
});

test("every way they can disagree is named", () => {
  const registry = [
    registration("claude-impl", "active", "implementation"),
    registration("claude-chore", "active", "chore"),
    registration("codex-impl", "paused", "implementation"),
    registration("codex-chore", "active", "chore"),
    registration("cursor-impl", "requested", "implementation"),
  ];
  const catalog = [
    catalogEntry("claude-impl", "claude", { paused: true }),
    catalogEntry("codex-impl", "codex"),
    catalogEntry("codex-chore", "claude"),
    catalogEntry("claude-review", "claude", { archived: true }),
    catalogEntry("cursor-impl", "cursor", { blocked: true }),
  ];
  const result = compareAmuxWorkerRegistryWithCatalog(registry, catalog);
  assert.equal(result.status, "mismatch");
  assert.deepEqual(Object.fromEntries(result.rows.map((row) => [row.workerName, row.verdict])), {
    "claude-chore": "registry_only",
    "claude-impl": "registry_only",
    "claude-review": "unregistered",
    "codex-chore": "provider_mismatch",
    "codex-impl": "catalog_only",
    "cursor-impl": "match",
  });
});

test("an unreadable side is reported as unreadable, never as empty", () => {
  assert.deepEqual(compareAmuxWorkerRegistryWithCatalog(null, []), { status: "registry_unreadable", rows: [] });
  assert.deepEqual(compareAmuxWorkerRegistryWithCatalog([], null), { status: "catalog_unreadable", rows: [] });
  assert.deepEqual(compareAmuxWorkerRegistryWithCatalog([], []), { status: "match", rows: [] });
});
