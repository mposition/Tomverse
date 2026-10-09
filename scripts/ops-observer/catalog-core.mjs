// T3a of the ops-observer trust check (docs/policy/sre-ops.md §3-7, §6): the
// database rules the migrations made are still in the catalogue, exactly.
//
// The store reads pg_trigger, pg_constraint and pg_indexes for the agent's own
// tables and the shared tables its transactions write, and passes the rows
// here. Own tables must match the expected sets exactly -- a missing guard is
// an unenforced table, and an extra one is a change nobody reviewed. Only the
// deadline checks listed below may be deferred: anything else deferred would
// run after them at COMMIT, so a late run could still do work that the
// deadline check was meant to refuse. Shared tables have no expected set of
// their own here, but none of their triggers or constraints may be deferrable.

/**
 * The deferred triggers that check the run deadline at COMMIT: one per own
 * table for its rows, and the reservations' retention deadline on delete.
 */
export const OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS = Object.freeze([
  "ops_observer_delivery_deadline_check",
  "ops_observer_delivery_retention_deadline_check",
  "ops_observer_deferred_item_deadline_check",
  "ops_observer_deferred_item_retention_deadline_check",
  "ops_observer_run_guard_deadline_check",
  "ops_observer_genesis_deadline_check",
  "ops_observer_state_deadline_check",
  "ops_observer_transition_deadline_check",
]);

/** Tables the ops-observer transactions write that other features own. */
export const OPS_OBSERVER_SHARED_TABLES = Object.freeze(["AdminAuditLog", "AgentDigestItem"]);

const deferred = (name) => OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS.includes(name);

/** Non-internal triggers of the own tables. */
export const EXPECTED_TRIGGERS = Object.freeze({
  OpsObserverGenesis: ["OpsObserverGenesis_guard", "ops_observer_genesis_deadline_check"],
  OpsObserverState: ["OpsObserverState_guard", "ops_observer_state_deadline_check"],
  OpsObserverDelivery: [
    "OpsObserverDelivery_guard",
    "ops_observer_delivery_deadline_check",
    "ops_observer_delivery_retention_deadline_check",
  ],
  OpsObserverDeliveryItem: ["OpsObserverDeliveryItem_guard"],
  OpsObserverDeferredItem: [
    "OpsObserverDeferredItem_guard",
    "OpsObserverDeferredItem_no_truncate",
    "ops_observer_deferred_item_deadline_check",
    "ops_observer_deferred_item_retention_deadline_check",
  ],
  OpsObserverRunGuard: [
    "OpsObserverRunGuard_guard",
    "OpsObserverRunGuard_no_truncate",
    "ops_observer_run_guard_deadline_check",
  ],
  OpsObserverTransition: [
    "OpsObserverTransition_guard",
    "OpsObserverTransition_no_truncate",
    "ops_observer_transition_deadline_check",
  ],
});

/**
 * The function each own trigger runs. A trigger whose name survives but that
 * now calls something else is as unenforced as a missing one.
 */
export const EXPECTED_TRIGGER_FUNCTIONS = Object.freeze({
  OpsObserverGenesis_guard: "ops_observer_genesis_guard",
  OpsObserverState_guard: "ops_observer_state_guard",
  OpsObserverDelivery_guard: "ops_observer_delivery_guard",
  OpsObserverDeliveryItem_guard: "ops_observer_delivery_item_guard",
  OpsObserverDeferredItem_guard: "ops_observer_deferred_item_guard",
  OpsObserverDeferredItem_no_truncate: "ops_observer_deferred_item_no_truncate",
  ops_observer_deferred_item_deadline_check: "ops_observer_deadline_check",
  ops_observer_deferred_item_retention_deadline_check: "ops_observer_retention_deadline_check",
  OpsObserverRunGuard_guard: "ops_observer_run_guard_guard",
  OpsObserverRunGuard_no_truncate: "ops_observer_run_guard_no_truncate",
  ops_observer_run_guard_deadline_check: "ops_observer_deadline_check",
  OpsObserverTransition_guard: "ops_observer_transition_guard",
  OpsObserverTransition_no_truncate: "ops_observer_transition_no_truncate",
  ops_observer_genesis_deadline_check: "ops_observer_deadline_check",
  ops_observer_state_deadline_check: "ops_observer_deadline_check",
  ops_observer_delivery_deadline_check: "ops_observer_deadline_check",
  ops_observer_delivery_retention_deadline_check: "ops_observer_retention_deadline_check",
  ops_observer_transition_deadline_check: "ops_observer_deadline_check",
});

/** pg_trigger.tgenabled for a trigger that fires in an ordinary session. */
export const TRIGGER_ENABLED = "O";

/** Every pg_constraint row of the own tables, as name: contype. */
export const EXPECTED_CONSTRAINTS = Object.freeze({
  OpsObserverGenesis: {
    OpsObserverGenesis_pkey: "p",
    OpsObserverGenesis_supersedesGenesisId_key: "u",
    OpsObserverGenesis_rootMarker_key: "u",
    OpsObserverGenesis_reason_check: "c",
    OpsObserverGenesis_mode_check: "c",
    OpsObserverGenesis_root_check: "c",
    OpsObserverGenesis_requestDigest_check: "c",
    ops_observer_genesis_deadline_check: "t",
  },
  OpsObserverState: {
    OpsObserverState_pkey: "p",
    OpsObserverState_genesisId_fkey: "f",
    OpsObserverState_generation_check: "c",
    OpsObserverState_keys_check: "c",
    OpsObserverState_checkpoint_check: "c",
    ops_observer_state_deadline_check: "t",
  },
  OpsObserverDelivery: {
    OpsObserverDelivery_pkey: "p",
    OpsObserverDelivery_genesisId_fkey: "f",
    OpsObserverDelivery_runId_key: "u",
    OpsObserverDelivery_reservedMarker_key: "u",
    OpsObserverDelivery_channelCheckDate_key: "u",
    OpsObserverDelivery_status_check: "c",
    OpsObserverDelivery_mode_check: "c",
    OpsObserverDelivery_runId_check: "c",
    OpsObserverDelivery_lifecycle_check: "c",
    OpsObserverDelivery_stampStatus_check: "c",
    ops_observer_delivery_deadline_check: "t",
    ops_observer_delivery_retention_deadline_check: "t",
  },
  OpsObserverDeliveryItem: {
    OpsObserverDeliveryItem_pkey: "p",
    OpsObserverDeliveryItem_deliveryId_fkey: "f",
    OpsObserverDeliveryItem_incident_kind_key: "u",
    OpsObserverDeliveryItem_kind_check: "c",
    OpsObserverDeliveryItem_mode_check: "c",
    OpsObserverDeliveryItem_origin_check: "c",
    OpsObserverDeliveryItem_scope_check: "c",
    OpsObserverDeliveryItem_signal_check: "c",
  },
  OpsObserverDeferredItem: {
    OpsObserverDeferredItem_pkey: "p",
    OpsObserverDeferredItem_genesisId_fkey: "f",
    OpsObserverDeferredItem_incident_kind_key: "u",
    OpsObserverDeferredItem_kind_check: "c",
    OpsObserverDeferredItem_mode_check: "c",
    OpsObserverDeferredItem_origin_check: "c",
    OpsObserverDeferredItem_scope_check: "c",
    OpsObserverDeferredItem_signal_check: "c",
    ops_observer_deferred_item_deadline_check: "t",
    ops_observer_deferred_item_retention_deadline_check: "t",
  },
  OpsObserverRunGuard: {
    OpsObserverRunGuard_pkey: "p",
    OpsObserverRunGuard_kind_check: "c",
    OpsObserverRunGuard_runId_check: "c",
    ops_observer_run_guard_deadline_check: "t",
  },
  OpsObserverTransition: {
    OpsObserverTransition_pkey: "p",
    OpsObserverTransition_genesisId_fkey: "f",
    OpsObserverTransition_auditLogId_key: "u",
    OpsObserverTransition_generation_check: "c",
    OpsObserverTransition_keysSha256_check: "c",
    ops_observer_transition_deadline_check: "t",
  },
});

/** Every index of the own tables. */
export const EXPECTED_INDEXES = Object.freeze({
  OpsObserverGenesis: ["OpsObserverGenesis_pkey", "OpsObserverGenesis_rootMarker_key", "OpsObserverGenesis_supersedesGenesisId_key"],
  OpsObserverState: ["OpsObserverState_pkey"],
  OpsObserverDelivery: [
    "OpsObserverDelivery_pkey",
    "OpsObserverDelivery_runId_key",
    "OpsObserverDelivery_reservedMarker_key",
    "OpsObserverDelivery_channelCheckDate_key",
    "OpsObserverDelivery_genesisId_ownerDate_idx",
  ],
  OpsObserverDeliveryItem: [
    "OpsObserverDeliveryItem_pkey",
    "OpsObserverDeliveryItem_incident_kind_key",
    "OpsObserverDeliveryItem_deliveryId_idx",
  ],
  OpsObserverDeferredItem: [
    "OpsObserverDeferredItem_pkey",
    "OpsObserverDeferredItem_incident_kind_key",
    "OpsObserverDeferredItem_ownerDate_mode_idx",
  ],
  OpsObserverRunGuard: ["OpsObserverRunGuard_pkey"],
  OpsObserverTransition: ["OpsObserverTransition_pkey", "OpsObserverTransition_auditLogId_key"],
});

export const OPS_OBSERVER_OWN_TABLES = Object.freeze(Object.keys(EXPECTED_TRIGGERS));

const key = (...parts) => parts.join(" :: ");

function exactSet(problems, label, expected, observed) {
  const want = new Set(expected);
  const have = new Set(observed);
  for (const name of want) if (!have.has(name)) problems.push(`${label} missing ${name}`);
  for (const name of have) if (!want.has(name)) problems.push(`${label} unexpected ${name}`);
}

/**
 * Compares catalogue rows against the expected sets. Rows:
 *   triggers:    { table, tableSchema, name, enabled, functionName, functionSchema,
 *                  deferrable, initiallyDeferred }
 *                (tgisinternal = false; enabled is tgenabled; functionName and
 *                functionSchema are tgfoid's proname and its namespace)
 *   constraints: { table, name, type, deferrable, initiallyDeferred }
 *   indexes:     { table, name }
 * Returns a list of problems; empty means T3a passes.
 */
export function catalogProblems({ triggers, constraints, indexes }) {
  if (![triggers, constraints, indexes].every(Array.isArray)) return ["catalogue rows missing"];
  const problems = [];
  const own = new Set(OPS_OBSERVER_OWN_TABLES);
  const shared = new Set(OPS_OBSERVER_SHARED_TABLES);
  const byTable = (rows, table) => rows.filter((row) => row?.table === table);

  for (const row of [...triggers, ...constraints, ...indexes]) {
    if (!row || typeof row.table !== "string" || typeof row.name !== "string") {
      problems.push("malformed catalogue row");
    } else if (!own.has(row.table) && !shared.has(row.table)) {
      problems.push(`${key(row.table, row.name)} is outside the checked tables`);
    }
  }

  for (const table of own) {
    const tableTriggers = byTable(triggers, table);
    const tableConstraints = byTable(constraints, table);
    exactSet(problems, `${table} trigger`, EXPECTED_TRIGGERS[table], tableTriggers.map((r) => r.name));
    exactSet(problems, `${table} constraint`, Object.keys(EXPECTED_CONSTRAINTS[table]), tableConstraints.map((r) => r.name));
    exactSet(problems, `${table} index`, EXPECTED_INDEXES[table], byTable(indexes, table).map((r) => r.name));
    for (const row of tableConstraints) {
      const type = EXPECTED_CONSTRAINTS[table][row.name];
      if (type !== undefined && row.type !== type) problems.push(`${key(table, row.name)} has type ${row.type}`);
    }
    for (const row of tableTriggers) {
      if (row.enabled !== TRIGGER_ENABLED) problems.push(`${key(table, row.name)} is not enabled`);
      const fn = EXPECTED_TRIGGER_FUNCTIONS[row.name];
      if (fn !== undefined && row.functionName !== fn) problems.push(`${key(table, row.name)} runs ${row.functionName}`);
      // The migrations create each function beside its table. A same-named
      // function in another schema is a different function.
      if (typeof row.tableSchema !== "string" || row.functionSchema !== row.tableSchema) {
        problems.push(`${key(table, row.name)} runs a function outside its table's schema`);
      }
    }
    for (const row of [...tableTriggers, ...tableConstraints]) {
      const want = deferred(row.name);
      if (row.deferrable !== want || row.initiallyDeferred !== want) {
        problems.push(`${key(table, row.name)} deferral is not ${want ? "deferred" : "immediate"}`);
      }
    }
  }

  for (const table of shared) {
    // Every shared table has a primary key, so no constraint rows at all means
    // the table was not read -- which must not read as "nothing deferrable".
    if (!byTable(constraints, table).some((row) => row.type === "p")) problems.push(`${table} was not read`);
    for (const row of [...byTable(triggers, table), ...byTable(constraints, table)]) {
      if (row.deferrable !== false || row.initiallyDeferred !== false) {
        problems.push(`${key(table, row.name)} is deferrable on a shared table`);
      }
    }
  }
  return problems;
}
