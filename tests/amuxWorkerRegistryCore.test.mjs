// Orchestration policy version 31, stage R1: the worker registry's pure core
// (docs/policy/development-agent-orchestration.md, "버전 31").
//
// Runs without a database: the class table, the name grammar, the change rule
// and the effective assignment rule. R1's registry-vs-catalog comparison went
// with the catalog variable at R2e (version 35, section 5).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_CATALOG_WORKER_NAME_PATTERN,
  AMUX_WORKER_CATALOG_EXEMPT,
  AMUX_WORKER_DESIRED_STATES,
  AMUX_WORKER_LATCH_CONSECUTIVE_FAILURES,
  AMUX_WORKER_PROVIDER_CLASSES,
  AMUX_WORKER_PROVIDER_CLASS_TABLE,
  AMUX_WORKER_REGISTRY_AUDIT_ACTIONS,
  AMUX_WORKER_REGISTRY_REFUSALS,
  AMUX_WORKER_REGISTRY_V31_SEED,
  AMUX_WORKER_ROLE_CEILINGS,
  AMUX_WORKER_TRIAL_CARD_COUNT,
  AMUX_WORKER_TRIAL_COST_CAP_MICRO_USD,
  AMUX_WORKER_REGISTRY_WRITES_LATCH,
  amuxWorkerRegistryWritesOpen,
  amuxWorkerSeedEntriesToRegister,
  buildAmuxWorkerRegistryAdminView,
  amuxWorkerEffectiveState,
  amuxWorkerLatchOpen,
  amuxWorkerRegistrationFromRow,
  amuxWorkerRegistryAuditAction,
  amuxWorkerRegistryAuditMetadata,
  amuxWorkerRegistryChangeRefusal,
  isAmuxWorkerName,
  parseAmuxWorkerRegistryChange,
} from "../lib/amux/workerRegistryCore.ts";
import { AGENT_OFFICE_AMUX_ROSTER } from "../lib/agentOffice/amuxRoster.ts";
import { AMUX_MACHINE_ID_PATTERN } from "../lib/amux/claimContract.ts";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name) => name.slice(0, name.indexOf("-"));


const registration = (workerName, desiredState, roleCeiling, revision = 1) => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName),
  roleCeiling,
  desiredState,
  revision,
});

const change = (workerName, desiredState, roleCeiling, expectedRevision, providerClass = amuxWorkerProviderClassOf(workerName)) => {
  const parsed = parseAmuxWorkerRegistryChange({ workerName, providerClass, desiredState, roleCeiling, expectedRevision });
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

test("the name grammar is 1-40 lower-case letters, digits and hyphens, and says nothing of the CLI", () => {
  // Owner decision 2026-10-27: every name the old prefix grammar allowed still is.
  for (const name of ["claude-impl", "codex-x", "cursor-worker", "copilot-" + "a".repeat(24), "codex-0",
    "kimi-impl", "review-2", "a", "x".repeat(40), "claude-impl-2"]) {
    assert.ok(isAmuxWorkerName(name), name);
  }
  for (const name of [
    "claude-", "-impl", "Claude-impl", "claude_impl", "x".repeat(41),
    " claude-impl", "claude-impl\n", "claude-IMPL", "", null, 7,
  ]) {
    assert.equal(isAmuxWorkerName(name), false, String(name));
  }
});

test("the seed is version 27's thirteen: the catalog's seven active, the six new requested", () => {
  assert.equal(AMUX_WORKER_REGISTRY_V31_SEED.length, 13);
  assert.deepEqual(
    AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => entry.workerName).sort(),
    AGENT_OFFICE_AMUX_ROSTER.map((seat) => seat.name).sort(),
  );
  assert.deepEqual(
    AMUX_WORKER_REGISTRY_V31_SEED.filter((entry) => entry.desiredState === "active").map((entry) => entry.workerName).sort(),
    ["claude-chore", "claude-contract", "claude-impl", "claude-review", "codex-chore", "codex-contract", "codex-impl"],
  );
  for (const entry of AMUX_WORKER_REGISTRY_V31_SEED) {
    const providerClass = entry.providerClass;
    // The seed's names still start with their CLI, so the first run registers what it always did.
    assert.equal(providerClass, amuxWorkerProviderClassOf(entry.workerName), entry.workerName);
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

test("parsing refuses anything outside the vocabularies and keeps the chosen class, whatever the name", () => {
  const good = { workerName: "cursor-impl", providerClass: "cursor", roleCeiling: "chore", desiredState: "requested", expectedRevision: 0 };
  assert.deepEqual(parseAmuxWorkerRegistryChange(good), good);
  // A name that does not start with its CLI is fine; the chosen class is kept.
  const renamed = { ...good, workerName: "kimi-impl", providerClass: "copilot" };
  assert.deepEqual(parseAmuxWorkerRegistryChange(renamed), renamed);
  for (const bad of [
    { ...good, workerName: "Devin_worker" },
    { ...good, providerClass: "devin" },
    { ...good, providerClass: undefined },
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

test("a new worker starts requested or active, whatever its name (operator decision 2026-10-20)", () => {
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "requested", "chore", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "active", "chore", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("cursor-impl", "active", "implementation", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-impl", "active", "implementation", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("codex-x", "active", "contract", 0)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "paused", "chore", 0)), "first_state_invalid");
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "retired", "chore", 0)), "first_state_invalid");
  // An unverified class still never holds contract, active or not.
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("cursor-impl", "active", "contract", 0)), "role_above_class");
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("copilot-x", "active", "contract", 0)), "role_above_class");
  // The trial refusal is gone from the vocabulary the route and Admin answer with.
  assert.equal(AMUX_WORKER_REGISTRY_REFUSALS.includes("activation_requires_trial"), false);
});

test("every change names the revision the person saw", () => {
  const previous = registration("claude-impl", "active", "implementation", 4);
  assert.equal(amuxWorkerRegistryChangeRefusal(previous, change("claude-impl", "paused", "implementation", 3)), "stale_revision");
  assert.equal(amuxWorkerRegistryChangeRefusal(previous, change("claude-impl", "paused", "implementation", 5)), "stale_revision");
  assert.equal(amuxWorkerRegistryChangeRefusal(previous, change("claude-impl", "paused", "implementation", 4)), null);
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("claude-new", "requested", "chore", 1)), "stale_revision");
});

test("the transition rule: stop and narrow freely, activate directly, retire for good", () => {
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
  // The owner activates a requested or paused worker directly, with no trial
  // period (operator decision 2026-10-20), at its role or a narrower one.
  for (const from of [requested, paused]) {
    assert.equal(amuxWorkerRegistryChangeRefusal(from, change(from.workerName, "active", from.roleCeiling, 1)), null);
    assert.equal(amuxWorkerRegistryChangeRefusal(from, change(from.workerName, "active", "chore", 1)), null);
  }
  // Activation does not widen a role: that still happens only while requested.
  assert.equal(amuxWorkerRegistryChangeRefusal(requested, change("cursor-impl", "active", "implementation", 1)), "role_widening_requires_trial");
  assert.equal(amuxWorkerRegistryChangeRefusal(paused, change("codex-impl", "active", "contract", 1)), "role_widening_requires_trial");
  // A class's ceiling binds an activation too.
  assert.equal(amuxWorkerRegistryChangeRefusal(requested, change("cursor-impl", "active", "contract", 1)), "role_above_class");
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
    class: { ...row, providerClass: "devin" },
    ceiling: { ...row, roleCeiling: "contract" },
    state: { ...row, desiredState: "on" },
    zero: { ...row, revision: 0 },
    string: { ...row, revision: "2" },
    name: { ...row, workerName: "Devin_worker" },
    reserved: { ...row, workerName: "engineering-runner" },
  })) {
    assert.equal(amuxWorkerRegistrationFromRow(bad), null, label);
  }
  // The class is the row's own, whatever the name says (owner decision 2026-10-27).
  assert.deepEqual(amuxWorkerRegistrationFromRow({ ...row, providerClass: "codex" }), { ...row, providerClass: "codex", revision: 2 });
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

test("version 32 turns R1's registry writes on, and the policy records it", () => {
  // Version 31 section 8: R1 shipped latched off; version 32 is the operator's
  // activation record. The latch and its record move together.
  assert.equal(AMUX_WORKER_REGISTRY_WRITES_LATCH, true);
  assert.equal(amuxWorkerRegistryWritesOpen(), true);
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8");
  const normalized = policy.split(String.fromCharCode(13)).join("");
  const heading = "## 버전 32 — worker 등록부 R1 코드 래치";
  const record = "승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-12`";
  assert.ok(normalized.includes([heading, "", record].join(String.fromCharCode(10))));
  assert.ok(normalized.includes("`AMUX_WORKER_REGISTRY_WRITES_LATCH`(`lib/amux/workerRegistryCore.ts`)를 false로 둔 채 출고됐고, 이 버전이 그 래치를 true로 바꾼다"));
});

test("the Admin view shows desired and effective state apart, and offers only unregistered seed entries", () => {
  const view = buildAmuxWorkerRegistryAdminView({
    registrations: [
      { ...registration("cursor-impl", "requested", "implementation"), changedAt: "2026-10-12T05:00:00.000Z" },
      { ...registration("claude-impl", "active", "implementation", 2), changedAt: "2026-10-12T06:00:00.000Z" },
    ],
    latches: new Map([["claude-impl", "opened"]]),
    observations: new Map([["claude-impl", "ok"]]),
  });
  // Defaults to the code latch (true since version 32).
  assert.equal(view.writesLatch, AMUX_WORKER_REGISTRY_WRITES_LATCH);
  assert.equal(view.registryReadable, true);
  assert.deepEqual(view.rows.map((row) => row.workerName), ["claude-impl", "cursor-impl"]);
  const claude = view.rows[0];
  assert.equal(claude.verified, true);
  assert.equal(claude.classMaxRole, "contract");
  assert.equal(claude.latch, "opened");
  assert.equal(claude.observation, "ok");
  assert.deepEqual(claude.reasons, ["latch_open"]);
  assert.equal(view.rows[1].verified, false);
  assert.deepEqual(view.rows[1].reasons, ["not_active", "no_observation"]);
  assert.equal("comparison" in view, false, "R1's comparison went with the catalog variable at R2e");
  assert.equal(amuxWorkerSeedEntriesToRegister(view).length, 11);
  assert.equal(view.seed.filter((entry) => entry.registered).length, 2);
});

test("an unreadable registry offers nothing to register", () => {
  const view = buildAmuxWorkerRegistryAdminView({
    registrations: null,
    latches: new Map(),
    observations: new Map(),
    writesLatch: true,
  });
  assert.deepEqual(view, {
    writesLatch: true,
    registryReadable: false,
    rows: [],
    seed: null,
  });
  assert.deepEqual(amuxWorkerSeedEntriesToRegister(view), []);
});

test("the catalog name rule is the AMUX machine-id rule, and wider than the registry's", () => {
  assert.equal(AMUX_CATALOG_WORKER_NAME_PATTERN.source, AMUX_MACHINE_ID_PATTERN.source);
  assert.equal(AMUX_CATALOG_WORKER_NAME_PATTERN.flags, AMUX_MACHINE_ID_PATTERN.flags);
  for (const name of ["claude-impl", "devin-worker", "Codex.Impl:2"]) {
    assert.ok(AMUX_CATALOG_WORKER_NAME_PATTERN.test(name), name);
  }
});

test("version 34: the engineering adapter's runner is a code constant by name and can never be a registry entry", () => {
  assert.deepEqual([...AMUX_WORKER_CATALOG_EXEMPT], ["engineering-runner"]);
  assert.ok(Object.isFrozen(AMUX_WORKER_CATALOG_EXEMPT));
  // An exempt name can never also be a registry entry: the grammar refuses it
  // by name (and the CHECK of migration 20261027120000 likewise), so the
  // derived catalog's constant entry and the ceiling check's exception cannot
  // collide with a registered worker.
  for (const name of AMUX_WORKER_CATALOG_EXEMPT) {
    assert.equal(isAmuxWorkerName(name), false, name);
    for (const providerClass of AMUX_WORKER_PROVIDER_CLASSES) {
      assert.equal(parseAmuxWorkerRegistryChange({ workerName: name, providerClass, roleCeiling: "chore", desiredState: "requested", expectedRevision: 0 }), null, name);
    }
  }
  const sql = readFileSync(new URL("../prisma/migrations/20261027120000_amux_cli_models_and_worker_cli/migration.sql", import.meta.url), "utf8");
  for (const name of AMUX_WORKER_CATALOG_EXEMPT) assert.equal(sql.split(`"workerName" <> '${name}'`).length - 1, 5, name);
  // No other name is: devin-worker, removed in version 27, is not a constant;
  // since names are free it is registrable, but only with one of the four CLIs.
  assert.equal(AMUX_WORKER_CATALOG_EXEMPT.includes("devin-worker"), false);
  assert.equal(parseAmuxWorkerRegistryChange({ workerName: "devin-worker", providerClass: "devin", roleCeiling: "chore", desiredState: "requested", expectedRevision: 0 }), null);
});

test("version 34 is recorded in the policy with the exempt name", () => {
  const policy = readFileSync(new URL("../docs/policy/development-agent-orchestration.md", import.meta.url), "utf8")
    .split(String.fromCharCode(13)).join("");
  assert.ok(policy.includes(["## 버전 34 — engineering adapter runner의 등록부 비교 제외", "", "승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-13`"].join(String.fromCharCode(10))));
  assert.ok(policy.includes("`AMUX_WORKER_CATALOG_EXEMPT`"));
  assert.ok(policy.includes("`engineering-runner`"));
});

test("a worker keeps the CLI it was registered with (owner decision 2026-10-27)", () => {
  const active = registration("kimi-impl", "active", "implementation");
  const copilot = { ...active, providerClass: "copilot" };
  assert.equal(amuxWorkerRegistryChangeRefusal(copilot, change("kimi-impl", "paused", "implementation", 1, "copilot")), null);
  assert.equal(
    amuxWorkerRegistryChangeRefusal(copilot, change("kimi-impl", "paused", "implementation", 1, "codex")),
    "class_changed",
  );
  // A new name with any CLI is a first event like any other.
  assert.equal(amuxWorkerRegistryChangeRefusal(null, change("kimi-impl", "requested", "implementation", 0, "copilot")), null);
});
