// AMUX Decision Maker policy version 1, stage S1c: the request ledger
// (docs/policy/amux-decision-maker.md §2, §6, §9, §10).
//
// Runs without a database: the vocabularies and their parity with the
// migration's CHECKs and triggers and with routeDmQuestion(), the input
// checks, the transition graph the event trigger enforces (mirrored by
// dmEventRefusal()), result submission, the one-writer rule, and the exact
// statements each store operation sends (§9's statement budget), counted on a
// recording transaction. What the database itself refuses is exercised
// against PostgreSQL in tests/integration/amux-decision-maker-request.db.test.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS } from "../lib/adminAuditSystemActors.ts";
import { DM_INSTANCE_FOR_PROVIDER, DM_POLICY_VERSION, routeDmQuestion } from "../lib/amux/decisionMakerCore.ts";
import {
  DM_ASSIGNMENT_WINDOW_MS,
  DM_CLOSING_EVENT_KINDS,
  DM_COMMIT_RESERVE_MS,
  DM_DEADLINE_RESULT_KINDS,
  DM_EVENT_AUDIT_METADATA_KEYS,
  DM_REQUEST_AUDIT_ACTION,
  DM_REQUEST_AUDIT_METADATA_KEYS,
  DM_REQUEST_AUDIT_TARGET_TYPE,
  DM_REQUEST_BINDING_KEYS,
  DM_REQUEST_EVENT_AUDIT_TARGET_TYPE,
  DM_REQUEST_EVENT_KINDS,
  DM_REQUEST_ROUTES,
  DM_RESULT_KINDS,
  DM_RESULT_REJECTION_REASONS,
  DM_RESULT_WINDOW_MS,
  DM_ROUTER_EVENT_KINDS,
  DM_ROUTER_SYSTEM_ACTOR,
  DM_ROUTING_REFUSAL_CODES,
  DM_SNAPSHOT_STATES,
  DM_STALE_CLOSE_AFTER_MS,
  DM_VENDORS,
  DM_VENDOR_FOR_INSTANCE,
  dmEventAuditAction,
  dmEventAuditActor,
  dmEventAuditMetadata,
  dmEventRefusal,
  dmEventSwitchRefusal,
  dmRequestAuditMetadata,
  dmRequestStateFromRow,
  dmResultLookup,
  dmResultSubmissionOutcome,
  dmTransmitSwitchRefusal,
  parseDmRequestBinding,
  parseDmRequestRecord,
  parseDmResultSubmission,
  parseDmTransmission,
} from "../lib/amux/decisionMakerRequestCore.ts";
import {
  DecisionMakerRequestWriteError,
  assignDecisionMakerRequest,
  countOpenDecisionMakerRequestsCreatedBetween,
  discardDecisionMakerAssignment,
  lookupDecisionMakerResult,
  readDecisionMakerRequestState,
  readDecisionMakerThroughput,
  recordDecisionMakerRequest,
  recordDecisionMakerResultUnknown,
  recordDecisionMakerTransmitIntent,
  recordDecisionMakerTransmitOutcome,
  staleCloseDecisionMakerRequest,
  submitDecisionMakerResult,
} from "../lib/amux/decisionMakerRequestStore.ts";
import { DM_INSTANCE_SCOPES, DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE } from "../lib/amux/decisionMakerSwitchCore.ts";
import { dmKeyPeriodOf, dmOptionSetDigest, dmRequestDigestKey } from "../lib/amux/decisionMakerBodyCore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const STORE = "lib/amux/decisionMakerRequestStore.ts";
const AUDIT_MODULE = "lib/amux/decisionMakerRequestSystemAudit.ts";
const LEDGER_MIGRATION = "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql";
const SERIALIZATION_MIGRATION = "prisma/migrations/20261008090000_amux_decision_maker_switch_serialization/migration.sql";
const SWITCH_MIGRATION = "prisma/migrations/20261008030000_amux_decision_maker_switch/migration.sql";
// The one key the switch guard takes exclusive and the ledger guards take shared.
const SWITCH_GATE = "tomverse-amux-decision-maker-switch-gate";

const withoutSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((item) => item[1]);

const checkBody = (sql, name) => {
  const start = sql.indexOf(`CONSTRAINT "${name}"`);
  assert.ok(start >= 0, `CHECK ${name} was found`);
  const open = sql.indexOf("CHECK", start);
  let depth = 0;
  for (let index = sql.indexOf("(", open); index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1;
    if (sql[index] === ")") depth -= 1;
    if (depth === 0) return sql.slice(open, index + 1);
  }
  throw new Error(`unbalanced CHECK ${name}`);
};

const functionBody = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION "${name}"`);
  assert.ok(start >= 0, `function ${name} was found`);
  const bodyStart = sql.indexOf("AS $$", start);
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  return sql.slice(start, bodyEnd + 3);
};

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

test("the ledger's vocabularies are the policy's, and no list holds an autonomous value", () => {
  assert.deepEqual([...DM_REQUEST_ROUTES], ["operator", "dm_proposal"]);
  assert.deepEqual([...DM_REQUEST_EVENT_KINDS], [
    "assign",
    "assign_discarded",
    "transmit_intent",
    "transmit_receipt",
    "transmit_unknown",
    "result",
    "result_rejected",
    "result_unknown",
    "stale_close",
  ]);
  assert.deepEqual([...DM_ROUTER_EVENT_KINDS], ["assign", "assign_discarded", "stale_close"]);
  // Stage S1e adds a person's judgment to the closing kinds (tests/amuxDecisionMakerJudgment.test.mjs).
  assert.deepEqual([...DM_CLOSING_EVENT_KINDS], ["assign_discarded", "stale_close", "confirm", "edit_confirm", "reject"]);
  assert.deepEqual([...DM_RESULT_KINDS], ["proposal", "escalate", "validation_failure", "timeout", "unavailable"]);
  assert.deepEqual([...DM_DEADLINE_RESULT_KINDS], ["proposal", "escalate", "validation_failure"]);
  assert.deepEqual([...DM_SNAPSHOT_STATES], ["none", "worker_head", "develop"]);
  assert.deepEqual([...DM_VENDORS], ["openai", "anthropic"]);
  assert.deepEqual(DM_VENDOR_FOR_INSTANCE, {
    "decision-maker-openai": "openai",
    "decision-maker-anthropic": "anthropic",
  });
  for (const list of [DM_REQUEST_ROUTES, DM_REQUEST_EVENT_KINDS, DM_RESULT_KINDS]) {
    assert.equal(list.some((value) => /autonom/i.test(value)), false);
  }
  // §2-1, §9, §10 windows, and the commit reserve of lib/amux/dbBoundary.ts.
  assert.equal(DM_ASSIGNMENT_WINDOW_MS, 2 * 60 * 1000);
  assert.equal(DM_RESULT_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(DM_STALE_CLOSE_AFTER_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(DM_COMMIT_RESERVE_MS, 200);
  assert.match(read("lib/amux/dbBoundary.ts"), /export const AMUX_DB_COMMIT_RESERVE_MS = 200;/);
});

test("every event kind is a §10 audit action, by the router or by the request's own instance", () => {
  const section10 = read("docs/policy/amux-decision-maker.md");
  const systemLine = section10.slice(section10.indexOf("**감사 action**"), section10.indexOf("사람: `.confirm`"));
  for (const kind of DM_REQUEST_EVENT_KINDS) {
    assert.equal(dmEventAuditAction(kind), `amux.decision.${kind}`);
    assert.ok(
      systemLine.includes(`\`.${kind}\``) || systemLine.includes(`\`amux.decision.${kind}\``),
      `${kind} is a §10 system action`,
    );
  }
  assert.ok(systemLine.includes(`\`${DM_REQUEST_AUDIT_ACTION}\``));
  assert.equal(DM_REQUEST_AUDIT_TARGET_TYPE, "AmuxDecisionMakerRequest");
  assert.equal(DM_REQUEST_EVENT_AUDIT_TARGET_TYPE, "AmuxDecisionMakerRequestEvent");
  assert.equal(DM_ROUTER_SYSTEM_ACTOR, "amux-decision-router");
  for (const kind of DM_REQUEST_EVENT_KINDS) {
    for (const instance of DM_INSTANCE_SCOPES) {
      const actor = dmEventAuditActor(kind, instance);
      assert.ok(AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS.includes(actor), actor);
      assert.equal(
        actor,
        DM_ROUTER_EVENT_KINDS.includes(kind) ? "amux-decision-router" : DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE[instance],
        `${kind}/${instance}`,
      );
    }
  }
  assert.throws(() => dmEventAuditActor("result", null), /needs an instance/);
});

test("the refusal codes are exactly the ones routeDmQuestion() records", () => {
  const card = {
    askType: "decision",
    resolution: null,
    type: "task",
    tags: [],
    title: "Pick a cache key layout",
    question: "Should the cache key include the locale or only the model id?",
    options: [
      { id: "a", label: "Model id only" },
      { id: "b", label: "Model id and locale" },
    ],
    unblocks: "The cache module can be finished.",
    context: "Both layouts pass the current tests.",
    contextPaths: ["lib/cache.ts"],
  };
  const route = (overrides = {}, cardOverrides = {}) =>
    routeDmQuestion({
      killSwitch: false,
      instanceMode: "proposal",
      askingProvider: "claude",
      throughput: { lastHour: 0, lastDay: 0 },
      ...overrides,
      card: { ...card, ...cardOverrides },
    });
  const produced = new Set();
  for (const decision of [
    route({ killSwitch: null }),
    route({ killSwitch: true }),
    route({ instanceMode: "off" }),
    route({}, { askType: "customer_outbound" }),
    route({}, { title: "Deploy the cache to production" }),
    route({}, { askType: "credential", resolution: "needs_secret" }),
    route({ askingProvider: "gemini" }),
    route({ throughput: { lastHour: 20, lastDay: 20 } }),
    route({}, { contextPaths: ["../outside"] }),
    route({}, { context: `ghp_${"a".repeat(36)}` }),
  ]) {
    for (const refusal of decision.refusals) produced.add(refusal);
  }
  assert.deepEqual([...produced].sort(), [...DM_ROUTING_REFUSAL_CODES].sort());
});

// ---------------------------------------------------------------------------
// The migrations
// ---------------------------------------------------------------------------

test("the ledger migration's CHECKs hold exactly the core's lists", () => {
  const sql = withoutSqlComments(read(LEDGER_MIGRATION));
  const inList = (name) => quoted(checkBody(sql, name).replace(/^CHECK \(\s*"\w+" IS NULL OR /, "CHECK ("));
  assert.deepEqual(inList("AmuxDecisionMakerRequest_route_check"), [...DM_REQUEST_ROUTES]);
  assert.deepEqual(inList("AmuxDecisionMakerRequest_instance_check"), [...DM_INSTANCE_SCOPES]);
  assert.deepEqual(inList("AmuxDecisionMakerRequestEvent_kind_check"), [...DM_REQUEST_EVENT_KINDS]);
  assert.deepEqual(inList("AmuxDecisionMakerRequestEvent_instance_check"), [...DM_INSTANCE_SCOPES]);
  assert.deepEqual(inList("AmuxDecisionMakerRequestEvent_vendor_check"), [...DM_VENDORS]);
  assert.deepEqual(inList("AmuxDecisionMakerRequestEvent_snapshot_state_check"), [...DM_SNAPSHOT_STATES]);
  assert.deepEqual(inList("AmuxDecisionMakerRequestEvent_result_kind_check"), [...DM_RESULT_KINDS]);
  assert.deepEqual(inList("AmuxDecisionMakerRequestEvent_rejection_reason_check"), [...DM_RESULT_REJECTION_REASONS]);
  // The array CHECK is the router's list; check:enum-constraints does not read arrays.
  const refusals = checkBody(sql, "AmuxDecisionMakerRequest_refusal_codes_check");
  assert.deepEqual(quoted(refusals.slice(refusals.indexOf("ARRAY["), refusals.indexOf("]::TEXT[]"))), [
    ...DM_ROUTING_REFUSAL_CODES,
  ]);
  assert.match(refusals, /"refusalCodes" IS NOT NULL/);
  assert.match(refusals, /array_position\("refusalCodes", NULL\) IS NULL/);
  // §7's pairing, the route/refusal agreement and the unverified-provider rule.
  const pairing = checkBody(sql, "AmuxDecisionMakerRequest_provider_instance_check");
  for (const [provider, instance] of Object.entries(DM_INSTANCE_FOR_PROVIDER)) {
    assert.ok(pairing.includes(`("askingProvider" = '${provider}' AND "instance" IS NOT DISTINCT FROM '${instance}')`));
  }
  assert.ok(pairing.includes(`("askingProvider" NOT IN ('claude', 'codex') AND "instance" IS NULL)`));
  assert.match(checkBody(sql, "AmuxDecisionMakerRequest_route_refusals_check"), /\("route" = 'dm_proposal'\) = \(cardinality\("refusalCodes"\) = 0\)/);
  assert.match(
    checkBody(sql, "AmuxDecisionMakerRequest_unverified_provider_check"),
    /\('provider_unverified' = ANY \("refusalCodes"\)\) = \("instance" IS NULL\)/,
  );
  // Vendor pairing is the core's.
  const vendor = checkBody(sql, "AmuxDecisionMakerRequestEvent_vendor_instance_check");
  for (const [instance, vendorName] of Object.entries(DM_VENDOR_FOR_INSTANCE)) {
    assert.ok(vendor.includes(`("vendor" = '${vendorName}' AND "instance" IS NOT DISTINCT FROM '${instance}')`));
  }
  // The router's kinds name no instance.
  assert.deepEqual(quoted(checkBody(sql, "AmuxDecisionMakerRequestEvent_instance_kind_check")), [...DM_ROUTER_EVENT_KINDS]);
});

test("the ledger migration is additive, and its triggers hold the core's rules", () => {
  const raw = read(LEDGER_MIGRATION);
  const sql = withoutSqlComments(raw);
  assert.equal((sql.match(/^CREATE TABLE /gm) ?? []).length, 2);
  assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 3);
  assert.equal((sql.match(/^CREATE TRIGGER /gm) ?? []).length, 2);
  assert.equal((sql.match(/^CREATE CONSTRAINT TRIGGER /gm) ?? []).length, 1);
  assert.equal((sql.match(/^ALTER TABLE /gm) ?? []).length, 3);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b|SET CONSTRAINTS/im);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  // Every foreign key restricts: an audit row or a request can never be removed under a row naming it.
  assert.equal((sql.match(/ON DELETE RESTRICT ON UPDATE RESTRICT;/g) ?? []).length, 3);
  for (const table of ["AmuxDecisionMakerRequest", "AmuxDecisionMakerRequestEvent"]) {
    assert.ok(sql.includes(`CREATE UNIQUE INDEX "${table}_auditLogId_key"`), table);
    assert.ok(sql.includes(`BEFORE INSERT OR UPDATE OR DELETE ON "${table}"`), table);
  }
  assert.match(sql, /CREATE UNIQUE INDEX "AmuxDecisionMakerRequest_cardId_questionRevision_key"\s+ON "AmuxDecisionMakerRequest"\("cardId", "questionRevision"\);/);
  // One of each per request, the terminal result among them (§6, §9).
  for (const [name, where] of [
    ["one_assign", `"kind" = 'assign'`],
    ["one_transmit_intent", `"kind" = 'transmit_intent'`],
    ["one_transmit_outcome", `"kind" IN ('transmit_receipt', 'transmit_unknown')`],
    ["one_result", `"kind" = 'result'`],
    ["one_result_unknown", `"kind" = 'result_unknown'`],
    ["one_closing", `"kind" IN ('assign_discarded', 'stale_close')`],
  ]) {
    assert.ok(
      sql.includes(`CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_${name}_key"\n  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE ${where};`),
      name,
    );
  }

  const requestGuard = functionBody(sql, "amux_decision_maker_request_guard");
  assert.match(requestGuard, /SET search_path = pg_catalog, pg_temp/);
  assert.match(requestGuard, /IF TG_OP <> 'INSERT' THEN\s*RAISE EXCEPTION 'AMUX_DM_REQUEST_IMMUTABLE';/);
  assert.ok(requestGuard.includes(`'${DM_REQUEST_AUDIT_ACTION}', '${DM_REQUEST_AUDIT_TARGET_TYPE}', NEW."id", '${DM_ROUTER_SYSTEM_ACTOR}'`));
  assert.match(requestGuard, /NEW\."createdAt" := pg_catalog\.clock_timestamp\(\);/);
  assert.match(requestGuard, /NEW\."assignmentDeadlineAt" := NEW\."createdAt" \+ INTERVAL '2 minutes';/);
  assert.equal((requestGuard.match(/xmin = pg_catalog\.pg_current_xact_id\(\)::xid/g) ?? []).length, 1);
  // A routing to a DM reads the switches under the gate, READ COMMITTED only.
  const requestOrder = [
    "RAISE EXCEPTION 'AMUX_DM_REQUEST_IMMUTABLE'",
    "current_setting('transaction_isolation') <> 'read committed'",
    `IF NEW."route" = 'dm_proposal' THEN`,
    `pg_advisory_xact_lock_shared(\n            pg_catalog.hashtext('${SWITCH_GATE}')`,
    "'AmuxDecisionMakerSwitchEvent'",
    "RAISE EXCEPTION 'AMUX_DM_REQUEST_SWITCH'",
  ].map((needle) => requestGuard.indexOf(needle));
  assert.ok(requestOrder.every((position) => position >= 0), JSON.stringify(requestOrder));
  assert.deepEqual([...requestOrder].sort((a, b) => a - b), requestOrder);
  assert.ok(
    requestGuard.includes(
      `IF coalesce(kill_switch_value, 'off') <> 'off' OR coalesce(instance_mode, 'off') <> 'proposal' THEN`,
    ),
  );

  const eventGuard = functionBody(sql, "amux_decision_maker_request_event_guard");
  assert.match(eventGuard, /SET search_path = pg_catalog, pg_temp/);
  // Immutability first, then the isolation check, then the switch gate
  // (shared), then the per-request lock, then the reads, then the switches,
  // and the switch refusal only after the graph and the deadlines.
  const order = [
    "RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_IMMUTABLE'",
    "current_setting('transaction_isolation') <> 'read committed'",
    `pg_advisory_xact_lock_shared(\n            pg_catalog.hashtext('${SWITCH_GATE}')`,
    "pg_advisory_xact_lock(",
    "'AmuxDecisionMakerRequest'",
    "FROM %I.%I WHERE \"requestId\" = $1',",
    "'AmuxDecisionMakerSwitchEvent'",
    "RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_TRANSITION'",
    "RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_DEADLINE'",
    "RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_SWITCH'",
  ].map((needle) => eventGuard.indexOf(needle));
  assert.ok(order.every((position) => position >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(eventGuard, /'amux\.decision\.' \|\| NEW\."kind", 'AmuxDecisionMakerRequestEvent', NEW\."id", expected_actor/);
  assert.equal((eventGuard.match(/xmin = pg_catalog\.pg_current_xact_id\(\)::xid/g) ?? []).length, 1);
  assert.ok(eventGuard.includes(`WHEN NEW."kind" IN ('assign', 'assign_discarded', 'stale_close') THEN 'amux-decision-router'`));
  for (const [instance, actor] of Object.entries(DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE)) {
    assert.ok(eventGuard.includes(`WHEN request_instance = '${instance}' THEN '${actor}'`), instance);
  }
  assert.match(eventGuard, /NOT closed AND now_at >= request_created_at \+ INTERVAL '30 days'/);
  assert.match(eventGuard, /NEW\."resultDeadlineAt" := NEW\."createdAt" \+ INTERVAL '30 minutes';/);
  assert.equal((eventGuard.match(/INTERVAL '200 milliseconds'/g) ?? []).length, 3);
  assert.ok(eventGuard.includes(`NEW."resultKind" IN ('${DM_DEADLINE_RESULT_KINDS.join("', '")}')`));
  for (const reason of DM_RESULT_REJECTION_REASONS.filter((reason) => reason !== "binding_mismatch")) {
    assert.ok(eventGuard.includes(`WHEN '${reason}' THEN`), reason);
  }
  // §6's table and §8, on the switch store's newest events.
  assert.ok(eventGuard.includes(`IF NEW."kind" IN ('transmit_intent', 'result', 'result_rejected') THEN`));
  assert.ok(eventGuard.includes(`OR (NEW."kind" = 'result' AND NEW."resultKind" = 'proposal')`));
  assert.ok(
    eventGuard.includes(
      `(NEW."kind" = 'transmit_intent' AND (kill_on OR coalesce(instance_mode, 'off') <> 'proposal'))\n            OR (NEW."kind" = 'result' AND kill_on);`,
    ),
  );
  assert.ok(eventGuard.includes(`WHEN 'kill_switch' THEN kill_on`));

  // The deferred commit check: the AmuxCommitDeadline device's SQLSTATE, the
  // same reserve, and only the assignment, the transmission intent and a DM
  // output.
  const commitCheck = functionBody(sql, "amux_decision_maker_request_event_commit_check");
  assert.match(commitCheck, /pg_catalog\.clock_timestamp\(\) >= deadline - INTERVAL '200 milliseconds'/);
  assert.match(commitCheck, /RAISE EXCEPTION 'AMUX_DM_LATE_COMMIT' USING ERRCODE = 'AX001';/);
  assert.match(
    sql,
    new RegExp(
      `CREATE CONSTRAINT TRIGGER "amux_decision_maker_request_event_commit_check"\\s+AFTER INSERT ON "AmuxDecisionMakerRequestEvent"\\s+DEFERRABLE INITIALLY DEFERRED\\s+FOR EACH ROW\\s+WHEN \\(\\s+NEW\\."kind" IN \\('assign', 'transmit_intent'\\)\\s+OR \\(NEW\\."kind" = 'result' AND NEW\\."resultKind" IN \\('${DM_DEADLINE_RESULT_KINDS.join("', '")}'\\)\\)\\s+\\)`,
    ),
  );
});

test("the serialization migration is the S1b switch guard plus a READ COMMITTED check and the exclusive gate, and nothing else", () => {
  const before = functionBody(read(SWITCH_MIGRATION), "amux_decision_maker_switch_event_guard");
  const after = functionBody(read(SERIALIZATION_MIGRATION), "amux_decision_maker_switch_event_guard");
  const immutable = "        RAISE EXCEPTION 'AMUX_DM_SWITCH_IMMUTABLE';\n    END IF;\n";
  const check =
    "    -- The newest event below is read after a lock. Only READ COMMITTED gives\n" +
    "    -- that read a snapshot taken after the lock was granted.\n" +
    "    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN\n" +
    "        RAISE EXCEPTION 'AMUX_DM_SWITCH_ISOLATION';\n" +
    "    END IF;\n" +
    "    -- The switch gate, exclusive: no request ledger write that reads the\n" +
    "    -- switches is in flight while a switch changes.\n" +
    "    PERFORM pg_catalog.pg_advisory_xact_lock(\n" +
    `        pg_catalog.hashtext('${SWITCH_GATE}')\n` +
    "    );\n";
  assert.ok(before.includes(immutable));
  assert.equal(after, before.replace(immutable, `${immutable}${check}`));
  // One gate key: exclusive in the switch guard only, shared in both ledger guards.
  const gate = (sql, mode) =>
    (sql.match(new RegExp(`pg_advisory_xact_lock${mode}\\(\\s*pg_catalog\\.hashtext\\('${SWITCH_GATE}'\\)`, "g")) ?? []).length;
  const ledger = withoutSqlComments(read(LEDGER_MIGRATION));
  assert.equal(gate(after, ""), 1);
  assert.equal(gate(after, "_shared"), 0);
  assert.equal(gate(ledger, "_shared"), 2);
  assert.equal(gate(ledger, ""), 0);
  const statements = withoutSqlComments(read(SERIALIZATION_MIGRATION));
  assert.equal((statements.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 1);
  assert.doesNotMatch(statements, /^CREATE TABLE |^CREATE TRIGGER |^ALTER TABLE |\bDROP\b|\bTRUNCATE\b/m);
  // Both migrations apply after the switch store's, in this order.
  assert.ok("20261008090000_amux_decision_maker_switch_serialization" > "20261008030000_amux_decision_maker_switch");
  assert.ok("20261008090100_amux_decision_maker_request_ledger" > "20261008090000_amux_decision_maker_switch_serialization");
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const SHA = "0123456789abcdef0123456789abcdef01234567";

const binding = (overrides = {}) => ({
  cardId: "card-41",
  questionRevision: 3,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:9",
  amuxSessionAttempt: 1,
  askingProvider: "claude",
  optionSetDigest: DIGEST_A,
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
  ...overrides,
});

test("a binding carries exactly §9's routing-time values, each in its format", () => {
  assert.deepEqual([...DM_REQUEST_BINDING_KEYS], Object.keys(binding()));
  assert.deepEqual(parseDmRequestBinding(binding()), binding());
  assert.equal(parseDmRequestBinding({ ...binding(), extra: 1 }), null);
  const missing = binding();
  delete missing.cardId;
  assert.equal(parseDmRequestBinding(missing), null);
  for (const overrides of [
    { cardId: "" },
    { cardId: "card 41" },
    { cardId: "card/41" },
    { cardId: "x".repeat(129) },
    { questionRevision: -1 },
    { questionRevision: 1.5 },
    { questionRevision: 2 ** 31 },
    { questionRevision: "3" },
    { askingWorkerId: "-worker" },
    { amuxSessionId: "session\n9" },
    { amuxSessionAttempt: -1 },
    { askingProvider: "Claude" },
    { optionSetDigest: DIGEST_A.toUpperCase() },
    { optionSetDigest: "a".repeat(63) },
    { termListVersion: "V1" },
    { classificationVersion: "" },
    { scannerVersion: "v 1" },
  ]) {
    assert.equal(parseDmRequestBinding(binding(overrides)), null, JSON.stringify(overrides));
  }
});

test("a decision is recorded only when it agrees with the binding the way the CHECKs require", () => {
  assert.deepEqual(
    parseDmRequestRecord(binding(), { route: "dm_proposal", instance: "decision-maker-openai", refusals: [] }),
    { ...binding(), policyVersion: DM_POLICY_VERSION, route: "dm_proposal", instance: "decision-maker-openai", refusalCodes: [] },
  );
  assert.equal(
    parseDmRequestRecord(binding({ askingProvider: "codex" }), {
      route: "operator",
      instance: "decision-maker-anthropic",
      refusals: ["instance_off", "irreversible_term"],
    }).route,
    "operator",
  );
  assert.equal(
    parseDmRequestRecord(binding({ askingProvider: "gemini" }), {
      route: "operator",
      instance: null,
      refusals: ["provider_unverified"],
    }).instance,
    null,
  );
  for (const [overrides, decision] of [
    // The other vendor's instance, or none for a verified provider.
    [{}, { route: "dm_proposal", instance: "decision-maker-anthropic", refusals: [] }],
    [{}, { route: "operator", instance: null, refusals: ["provider_unverified"] }],
    // An unverified provider with an instance.
    [{ askingProvider: "gemini" }, { route: "operator", instance: "decision-maker-openai", refusals: ["provider_unverified"] }],
    // A verified provider recorded as unverified.
    [{}, { route: "operator", instance: "decision-maker-openai", refusals: ["provider_unverified"] }],
    // A proposal with a refusal, an operator route with none.
    [{}, { route: "dm_proposal", instance: "decision-maker-openai", refusals: ["instance_off"] }],
    [{}, { route: "operator", instance: "decision-maker-openai", refusals: [] }],
    // A code the router does not record, a repeated code.
    [{}, { route: "operator", instance: "decision-maker-openai", refusals: ["autonomous"] }],
    [{}, { route: "operator", instance: "decision-maker-openai", refusals: ["instance_off", "instance_off"] }],
    // A route outside the list.
    [{}, { route: "autonomous", instance: "decision-maker-openai", refusals: [] }],
    [{}, null],
  ]) {
    assert.equal(parseDmRequestRecord(binding(overrides), decision), null, JSON.stringify(decision));
  }
});

test("a transmission names a target SHA and a manifest exactly when it has a snapshot", () => {
  const none = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  const head = { snapshotState: "worker_head", snapshotTargetSha: SHA, snapshotManifestDigest: DIGEST_C, inputPayloadDigest: DIGEST_B };
  assert.deepEqual(parseDmTransmission(none), none);
  assert.deepEqual(parseDmTransmission(head), head);
  assert.deepEqual(parseDmTransmission({ ...head, snapshotState: "develop" }), { ...head, snapshotState: "develop" });
  for (const value of [
    { ...none, snapshotTargetSha: SHA },
    { ...none, snapshotManifestDigest: DIGEST_C },
    { ...head, snapshotTargetSha: null },
    { ...head, snapshotManifestDigest: null },
    { ...head, snapshotTargetSha: SHA.toUpperCase() },
    { ...head, snapshotTargetSha: SHA.slice(1) },
    { ...head, snapshotState: "local" },
    { ...none, inputPayloadDigest: null },
    { ...none, extra: true },
    null,
  ]) {
    assert.equal(parseDmTransmission(value), null, JSON.stringify(value));
  }
});

// ---------------------------------------------------------------------------
// State and the transition graph
// ---------------------------------------------------------------------------

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const TERMINAL_EVENT_ID = "99999999-2222-4333-8444-555555555555";
const NOW = 1_790_000_000_000;

const stateRow = (overrides = {}) => ({
  id: REQUEST_ID,
  ...binding(),
  policyVersion: 1,
  route: "dm_proposal",
  instance: "decision-maker-openai",
  createdAtEpochMs: BigInt(NOW - 10_000),
  assignmentDeadlineAtEpochMs: BigInt(NOW - 10_000 + DM_ASSIGNMENT_WINDOW_MS),
  dbNowEpochMs: BigInt(NOW),
  assigned: false,
  resultDeadlineAtEpochMs: null,
  transmitted: false,
  snapshotState: null,
  snapshotTargetSha: null,
  snapshotManifestDigest: null,
  inputPayloadDigest: null,
  transmitOutcome: null,
  terminalEventId: null,
  terminalResultKind: null,
  terminalResultDigest: null,
  resultUnknown: false,
  closingKind: null,
  probedRejection: null,
  ...overrides,
});

const ASSIGNED = { assigned: true, resultDeadlineAtEpochMs: BigInt(NOW + 20 * 60_000) };
const TRANSMITTED = { ...ASSIGNED, transmitted: true, snapshotState: "none", inputPayloadDigest: DIGEST_B };
const TERMINAL = { terminalEventId: TERMINAL_EVENT_ID, terminalResultKind: "proposal", terminalResultDigest: DIGEST_C };

const STATES = {
  fresh: stateRow(),
  operator: stateRow({ route: "operator" }),
  assigned: stateRow(ASSIGNED),
  transmitted: stateRow(TRANSMITTED),
  receipted: stateRow({ ...TRANSMITTED, transmitOutcome: "transmit_receipt" }),
  terminal: stateRow({ ...TRANSMITTED, ...TERMINAL }),
  resultUnknown: stateRow({ ...TRANSMITTED, resultUnknown: true }),
  discarded: stateRow({ ...ASSIGNED, closingKind: "assign_discarded" }),
  staleClosed: stateRow({ ...TRANSMITTED, closingKind: "stale_close" }),
  assignmentLate: stateRow({ dbNowEpochMs: BigInt(NOW - 10_000 + DM_ASSIGNMENT_WINDOW_MS - DM_COMMIT_RESERVE_MS) }),
  assignedLate: stateRow({ ...ASSIGNED, dbNowEpochMs: BigInt(NOW + 20 * 60_000 - DM_COMMIT_RESERVE_MS) }),
  transmittedLate: stateRow({ ...TRANSMITTED, dbNowEpochMs: BigInt(NOW + 20 * 60_000 - DM_COMMIT_RESERVE_MS) }),
  stale: stateRow({ dbNowEpochMs: BigInt(NOW - 10_000 + DM_STALE_CLOSE_AFTER_MS) }),
};

const state = (name) => {
  const parsed = dmRequestStateFromRow(STATES[name]);
  assert.ok(parsed, name);
  return parsed;
};

const OPENAI = "decision-maker-openai";
const ATTEMPTS = {
  assign: { kind: "assign" },
  assign_discarded: { kind: "assign_discarded" },
  transmit_intent: { kind: "transmit_intent", instance: OPENAI },
  transmit_receipt: { kind: "transmit_receipt", instance: OPENAI },
  transmit_unknown: { kind: "transmit_unknown", instance: OPENAI },
  proposal: { kind: "result", instance: OPENAI, resultKind: "proposal", resultDigest: DIGEST_D, inputPayloadDigest: DIGEST_B },
  proposal_without_payload: { kind: "result", instance: OPENAI, resultKind: "proposal", resultDigest: DIGEST_D, inputPayloadDigest: null },
  timeout: { kind: "result", instance: OPENAI, resultKind: "timeout", resultDigest: DIGEST_D, inputPayloadDigest: DIGEST_B },
  unavailable_before_intent: { kind: "result", instance: OPENAI, resultKind: "unavailable", resultDigest: DIGEST_D, inputPayloadDigest: null },
  result_unknown: { kind: "result_unknown", instance: OPENAI, resultDigest: DIGEST_D },
  stale_close: { kind: "stale_close" },
};

// Every state against every attempt: null is accepted, anything else is the
// first clause of the trigger it fails. The DB suite runs the same graph
// against the trigger itself.
const GRAPH = {
  fresh: {
    assign: null,
    assign_discarded: "not_assigned",
    transmit_intent: "not_assigned",
    transmit_receipt: "not_transmitted",
    transmit_unknown: "not_transmitted",
    proposal: "not_assigned",
    proposal_without_payload: "not_assigned",
    timeout: "not_assigned",
    unavailable_before_intent: "not_assigned",
    result_unknown: "not_assigned",
    stale_close: "not_stale",
  },
  operator: {
    assign: "not_routed_to_dm",
    assign_discarded: "not_assigned",
    transmit_intent: "not_assigned",
    transmit_receipt: "not_transmitted",
    transmit_unknown: "not_transmitted",
    proposal: "not_assigned",
    proposal_without_payload: "not_assigned",
    timeout: "not_assigned",
    unavailable_before_intent: "not_assigned",
    result_unknown: "not_assigned",
    stale_close: "closed",
  },
  assigned: {
    assign: "already_assigned",
    assign_discarded: null,
    transmit_intent: null,
    transmit_receipt: "not_transmitted",
    transmit_unknown: "not_transmitted",
    proposal: "not_transmitted",
    proposal_without_payload: "not_transmitted",
    timeout: "not_transmitted",
    unavailable_before_intent: null,
    result_unknown: null,
    stale_close: "not_stale",
  },
  transmitted: {
    assign: "already_assigned",
    assign_discarded: "already_transmitted",
    transmit_intent: "already_transmitted",
    transmit_receipt: null,
    transmit_unknown: null,
    proposal: null,
    proposal_without_payload: "payload_mismatch",
    timeout: null,
    unavailable_before_intent: "payload_mismatch",
    result_unknown: null,
    stale_close: "not_stale",
  },
  receipted: {
    assign: "already_assigned",
    assign_discarded: "already_transmitted",
    transmit_intent: "already_transmitted",
    transmit_receipt: "transmit_outcome_recorded",
    transmit_unknown: "transmit_outcome_recorded",
    proposal: null,
    proposal_without_payload: "payload_mismatch",
    timeout: null,
    unavailable_before_intent: "payload_mismatch",
    result_unknown: null,
    stale_close: "not_stale",
  },
  terminal: {
    assign: "already_assigned",
    assign_discarded: "already_transmitted",
    transmit_intent: "already_transmitted",
    transmit_receipt: null,
    transmit_unknown: null,
    proposal: "result_recorded",
    proposal_without_payload: "result_recorded",
    timeout: "result_recorded",
    unavailable_before_intent: "result_recorded",
    result_unknown: "result_recorded",
    stale_close: "not_stale",
  },
  resultUnknown: {
    assign: "already_assigned",
    assign_discarded: "already_transmitted",
    transmit_intent: "already_transmitted",
    transmit_receipt: null,
    transmit_unknown: null,
    proposal: "result_unknown_recorded",
    proposal_without_payload: "result_unknown_recorded",
    timeout: "result_unknown_recorded",
    unavailable_before_intent: "result_unknown_recorded",
    result_unknown: "result_unknown_recorded",
    stale_close: "not_stale",
  },
  discarded: {
    assign: "closed",
    assign_discarded: "closed",
    transmit_intent: "closed",
    transmit_receipt: "not_transmitted",
    transmit_unknown: "not_transmitted",
    proposal: "closed",
    proposal_without_payload: "closed",
    timeout: "closed",
    unavailable_before_intent: "closed",
    result_unknown: "closed",
    stale_close: "closed",
  },
  staleClosed: {
    assign: "closed",
    assign_discarded: "closed",
    transmit_intent: "closed",
    transmit_receipt: null,
    transmit_unknown: null,
    proposal: "closed",
    proposal_without_payload: "closed",
    timeout: "closed",
    unavailable_before_intent: "closed",
    result_unknown: "closed",
    stale_close: "closed",
  },
  assignmentLate: {
    assign: "deadline_passed",
  },
  assignedLate: {
    transmit_intent: "deadline_passed",
    unavailable_before_intent: null,
    assign_discarded: null,
  },
  transmittedLate: {
    proposal: "deadline_passed",
    timeout: null,
    result_unknown: null,
  },
  stale: {
    stale_close: null,
    assign: "deadline_passed",
  },
};

test("the transition graph: every state against every event", () => {
  for (const [stateName, expectations] of Object.entries(GRAPH)) {
    for (const [attemptName, expected] of Object.entries(expectations)) {
      assert.equal(
        dmEventRefusal(state(stateName), ATTEMPTS[attemptName]),
        expected,
        `${stateName} + ${attemptName}`,
      );
    }
  }
  // Each of the five results that are DM output is held to the deadline; the others are not.
  for (const resultKind of ["proposal", "escalate", "validation_failure"]) {
    assert.equal(dmEventRefusal(state("transmittedLate"), { ...ATTEMPTS.proposal, resultKind }), "deadline_passed", resultKind);
    assert.equal(dmEventRefusal(state("transmitted"), { ...ATTEMPTS.proposal, resultKind }), null, resultKind);
  }
  for (const resultKind of ["timeout", "unavailable"]) {
    assert.equal(dmEventRefusal(state("transmittedLate"), { ...ATTEMPTS.proposal, resultKind }), null, resultKind);
  }
  // An event from the other instance is never the request's.
  for (const name of ["transmit_intent", "transmit_receipt", "proposal", "result_unknown"]) {
    assert.equal(
      dmEventRefusal(state("transmitted"), { ...ATTEMPTS[name], instance: "decision-maker-anthropic" }),
      "instance_mismatch",
      name,
    );
  }
  // One millisecond before the reserve is still on time.
  assert.equal(
    dmEventRefusal(
      dmRequestStateFromRow(stateRow({ dbNowEpochMs: BigInt(NOW - 10_000 + DM_ASSIGNMENT_WINDOW_MS - DM_COMMIT_RESERVE_MS - 1) })),
      ATTEMPTS.assign,
    ),
    null,
  );
});

test("a rejection is recorded whenever it can be, with a reason the ledger's state bears out", () => {
  const rejected = (stateName, rejectionReason, resultDigest = DIGEST_D) =>
    dmEventRefusal(state(stateName), { kind: "result_rejected", instance: OPENAI, resultDigest, rejectionReason });
  for (const [stateName, reason, expected] of [
    ["operator", "request_closed", null],
    ["discarded", "request_closed", null],
    ["staleClosed", "request_closed", null],
    ["transmitted", "request_closed", "reason_inconsistent"],
    ["terminal", "terminal_exists", null],
    ["transmitted", "terminal_exists", "reason_inconsistent"],
    ["resultUnknown", "result_unknown", null],
    ["transmitted", "result_unknown", "reason_inconsistent"],
    ["fresh", "not_transmitted", null],
    ["assigned", "not_transmitted", null],
    ["operator", "not_transmitted", null],
    ["transmitted", "not_transmitted", "reason_inconsistent"],
    ["transmittedLate", "deadline_passed", null],
    ["transmitted", "deadline_passed", "reason_inconsistent"],
    ["fresh", "deadline_passed", "reason_inconsistent"],
    ["transmitted", "binding_mismatch", null],
    ["terminal", "kill_switch", null],
  ]) {
    assert.equal(rejected(stateName, reason), expected, `${stateName} + ${reason}`);
  }
  // The result's own digest is not "another" result.
  assert.equal(rejected("terminal", "terminal_exists", DIGEST_C), "reason_inconsistent");
  assert.equal(
    dmEventRefusal(state("transmitted"), { kind: "result_rejected", instance: "decision-maker-anthropic", resultDigest: DIGEST_D, rejectionReason: "kill_switch" }),
    "instance_mismatch",
  );
});

test("a state row the ledger could not have produced is unreadable", () => {
  assert.equal(state("operator").closing, "routed_to_operator");
  assert.equal(state("discarded").closing, "assign_discarded");
  assert.equal(state("fresh").closing, null);
  assert.deepEqual(state("terminal").terminal, { eventId: TERMINAL_EVENT_ID, resultKind: "proposal", resultDigest: DIGEST_C });
  assert.deepEqual(state("transmitted").transmission, {
    snapshotState: "none",
    snapshotTargetSha: null,
    snapshotManifestDigest: null,
    inputPayloadDigest: DIGEST_B,
  });
  for (const overrides of [
    { id: "not-a-uuid" },
    { route: "autonomous" },
    { instance: "decision-maker-gemini" },
    { policyVersion: 0 },
    { cardId: "card 41" },
    { dbNowEpochMs: "soon" },
    { assigned: "yes" },
    // An assignment always carries its result deadline, and only an assignment does.
    { assigned: true },
    { resultDeadlineAtEpochMs: BigInt(NOW) },
    { ...ASSIGNED, transmitted: true },
    { ...TRANSMITTED, transmitOutcome: "transmit_intent" },
    { ...TRANSMITTED, ...TERMINAL, terminalResultKind: "approve" },
    { closingKind: "assign" },
    { probedRejection: "maybe" },
  ]) {
    assert.equal(dmRequestStateFromRow(stateRow(overrides)), null, JSON.stringify(overrides, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  assert.equal(dmRequestStateFromRow(null), null);
});

// ---------------------------------------------------------------------------
// Result submission
// ---------------------------------------------------------------------------

const resultBinding = (overrides = {}) => {
  const rest = binding();
  delete rest.askingProvider;
  return {
    ...rest,
    policyVersion: 1,
    transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
    ...overrides,
  };
};

const submission = (overrides = {}) => ({
  instance: OPENAI,
  resultKind: "proposal",
  resultDigest: DIGEST_D,
  binding: resultBinding(),
  ...overrides,
});

test("a submission carries the instance, the result and §9's binding values, nothing else", () => {
  assert.deepEqual(parseDmResultSubmission(submission()), submission());
  assert.deepEqual(parseDmResultSubmission(submission({ binding: resultBinding({ transmission: null }) })).binding.transmission, null);
  for (const value of [
    submission({ instance: "decision-maker-gemini" }),
    submission({ resultKind: "approve" }),
    submission({ resultDigest: "x" }),
    submission({ extra: true }),
    submission({ binding: { ...resultBinding(), askingProvider: "claude" } }),
    submission({ binding: resultBinding({ policyVersion: 0 }) }),
    submission({ binding: resultBinding({ cardId: "" }) }),
    submission({ binding: resultBinding({ transmission: { snapshotState: "none" } }) }),
    null,
  ]) {
    assert.equal(parseDmResultSubmission(value), null, JSON.stringify(value));
  }
});

test("a submission is idempotent on its pair, and otherwise becomes the one result or a rejection", () => {
  const outcome = (stateName, overrides = {}, killSwitch = false, row = {}) =>
    dmResultSubmissionOutcome(
      dmRequestStateFromRow({ ...STATES[stateName], ...row }),
      parseDmResultSubmission(submission(overrides)),
      killSwitch,
    );
  assert.deepEqual(outcome("transmitted"), { outcome: "accept" });
  // The same pair returns what was recorded and writes nothing.
  assert.deepEqual(outcome("terminal", { resultDigest: DIGEST_C }), {
    outcome: "existing_result",
    eventId: TERMINAL_EVENT_ID,
    resultKind: "proposal",
  });
  assert.deepEqual(outcome("transmitted", {}, false, { probedRejection: "binding_mismatch" }), {
    outcome: "existing_rejection",
    reason: "binding_mismatch",
  });
  // A different digest for the same request is refused (§9).
  assert.deepEqual(outcome("terminal"), { outcome: "reject", reason: "terminal_exists" });
  assert.deepEqual(outcome("discarded"), { outcome: "reject", reason: "request_closed" });
  assert.deepEqual(outcome("operator"), { outcome: "reject", reason: "request_closed" });
  assert.deepEqual(outcome("resultUnknown"), { outcome: "reject", reason: "result_unknown" });
  assert.deepEqual(outcome("assigned"), { outcome: "reject", reason: "not_transmitted" });
  assert.deepEqual(outcome("fresh"), { outcome: "reject", reason: "not_transmitted" });
  assert.deepEqual(outcome("transmittedLate"), { outcome: "reject", reason: "deadline_passed" });
  assert.deepEqual(outcome("transmittedLate", { resultKind: "timeout" }), { outcome: "accept" });
  // DM unavailable before anything was sent.
  assert.deepEqual(outcome("assigned", { resultKind: "unavailable", binding: resultBinding({ transmission: null }) }), {
    outcome: "accept",
  });
  // §9: any binding value that changed.
  for (const changed of [
    { cardId: "card-42" },
    { questionRevision: 4 },
    { askingWorkerId: "worker.claude-2" },
    { amuxSessionId: "session:10" },
    { amuxSessionAttempt: 2 },
    { optionSetDigest: DIGEST_C },
    { policyVersion: 2 },
    { termListVersion: "v2" },
    { classificationVersion: "authority-manifest-2" },
    { scannerVersion: "v2" },
    { transmission: null },
    { transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_C } },
    { transmission: { snapshotState: "develop", snapshotTargetSha: SHA, snapshotManifestDigest: DIGEST_C, inputPayloadDigest: DIGEST_B } },
  ]) {
    assert.deepEqual(outcome("transmitted", { binding: resultBinding(changed) }), { outcome: "reject", reason: "binding_mismatch" }, JSON.stringify(changed));
  }
  // §6's table: a proposal is not stored while the kill switch is on or unreadable; other results are.
  assert.deepEqual(outcome("transmitted", {}, true), { outcome: "reject", reason: "kill_switch" });
  assert.deepEqual(outcome("transmitted", {}, null), { outcome: "reject", reason: "kill_switch" });
  for (const resultKind of ["escalate", "validation_failure", "timeout"]) {
    assert.deepEqual(outcome("transmitted", { resultKind }, true), { outcome: "accept" }, resultKind);
  }
});

test("a lost response is settled by the pair alone", () => {
  assert.deepEqual(dmResultLookup(state("terminal"), DIGEST_C), { status: "accepted", eventId: TERMINAL_EVENT_ID, resultKind: "proposal" });
  assert.deepEqual(dmResultLookup(state("terminal"), DIGEST_D), { status: "not_recorded" });
  assert.deepEqual(dmResultLookup(dmRequestStateFromRow(stateRow({ ...TRANSMITTED, probedRejection: "deadline_passed" })), DIGEST_D), {
    status: "rejected",
    reason: "deadline_passed",
  });
});

test("ledger audit metadata carries closed keys and short tokens only", () => {
  assert.deepEqual([...DM_REQUEST_AUDIT_METADATA_KEYS], ["request_id", "route", "instance", "asking_provider", "refusal_codes"]);
  assert.deepEqual(
    dmRequestAuditMetadata({
      requestId: REQUEST_ID,
      route: "operator",
      instance: null,
      askingProvider: "gemini",
      refusalCodes: ["provider_unverified"],
    }),
    { request_id: REQUEST_ID, route: "operator", asking_provider: "gemini", refusal_codes: ["provider_unverified"] },
  );
  assert.throws(
    () => dmRequestAuditMetadata({ requestId: REQUEST_ID, route: "operator", instance: null, askingProvider: "gemini", refusalCodes: ["Free text"] }),
    /value refused/,
  );
  assert.deepEqual([...DM_EVENT_AUDIT_METADATA_KEYS], [
    "event_id",
    "request_id",
    "kind",
    "instance",
    "vendor",
    "snapshot_state",
    "result_kind",
    "rejection_reason",
  ]);
  assert.deepEqual(dmEventAuditMetadata({ event_id: "e", kind: "assign", instance: null }), { event_id: "e", kind: "assign" });
  assert.throws(() => dmEventAuditMetadata({ systemActor: "amux-decision-router" }), /key refused/);
  assert.throws(() => dmEventAuditMetadata({ result_digest: DIGEST_A }), /key refused/);
  assert.throws(() => dmEventAuditMetadata({ kind: "x".repeat(65) }), /value refused/);
});

// ---------------------------------------------------------------------------
// One writer
// ---------------------------------------------------------------------------

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mts|cts|mjs|js|cjs)$/.test(name) ? [path] : [];
  });

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one store module reads and writes both tables; nothing else in the application reaches them", () => {
  // §10: "단일 writer 모듈이 위 표들에 쓴다."
  const reaches =
    /\.\s*amuxDecisionMakerRequest(Event)?\b|\[\s*["'`]amuxDecisionMakerRequest(Event)?["'`]\s*\]|\b(from|into|update|join|table)\s+"?AmuxDecisionMakerRequest(Event)?"?\b/i;
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200, "the scan must reach the application");
  const offenders = files.filter(
    (path) => path !== STORE && reaches.test(withoutComments(readFileSync(join(root, path), "utf8"))),
  );
  assert.deepEqual(offenders, []);
  const store = read(STORE);
  assert.match(store, /INSERT INTO "AmuxDecisionMakerRequest"\n/);
  assert.match(store, /INSERT INTO "AmuxDecisionMakerRequestEvent"\n/);
  // The store names no system actor; its audit entries come from their own module.
  assert.doesNotMatch(store, /systemActor|writeSystemAuditLog|writeAdminAuditLog/);
  const audit = read(AUDIT_MODULE);
  assert.equal((audit.match(/writeSystemAuditLog\(\{/g) ?? []).length, 2);
  assert.doesNotMatch(audit, /writeAdminAuditLog/);
  // Nothing updates or deletes a row.
  assert.doesNotMatch(withoutComments(store), /UPDATE "AmuxDecisionMakerRequest|DELETE FROM "AmuxDecisionMakerRequest/);
});


// ---------------------------------------------------------------------------
// Statements per operation (§9: 12 at most including setup and fence, pinned exactly)
// ---------------------------------------------------------------------------

const PERMISSIVE_SWITCHES = [
  { scope: "kill_switch", value: "off" },
  { scope: "decision-maker-openai", value: "proposal" },
  { scope: "decision-maker-anthropic", value: "proposal" },
];

/** The routing read's request columns when the card revision has no request. */
const NO_REQUEST = Object.fromEntries(
  [
    "id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt", "askingProvider",
    "optionSetDigest", "termListVersion", "classificationVersion", "scannerVersion", "route", "instance", "refusalCodes",
    "createdAtEpochMs", "assignmentDeadlineAtEpochMs",
  ].map((key) => [key, null]),
);

// The routing store keys the option set digest itself (stage S1d): a key for
// the period of the clock it reads, and one more on each side.
const ROUTING_KEY = Buffer.alloc(32, 5);
const RING = new Map([
  [dmKeyPeriodOf(NOW) - 1, Buffer.alloc(32, 4)],
  [dmKeyPeriodOf(NOW), ROUTING_KEY],
  [dmKeyPeriodOf(NOW) + 1, Buffer.alloc(32, 6)],
]);
/** A routing caller's binding: every value but the option set digest, which the store computes. */
const routingBinding = (overrides = {}) => {
  const value = binding(overrides);
  delete value.optionSetDigest;
  return value;
};

const recordingTx = ({
  state: row = stateRow(),
  existing = [],
  failRead = false,
  switches = PERMISSIVE_SWITCHES,
  failSwitchRead = false,
  throughput = { lastHour: 3n, lastDay: 7n },
  createdAtMs = NOW,
} = {}) => {
  const sent = [];
  const tx = {
    $executeRaw: (strings, ...values) => {
      sent.push({ kind: "execute", sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ kind: "query", sql, values });
      if (failRead) return Promise.reject(new Error("relation does not exist"));
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-08T00:00:00.000Z") }]);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"')) {
        return Promise.resolve([{ sequence: 41n, createdAtEpochMs: BigInt(NOW + 5), resultDeadlineAtEpochMs: null }]);
      }
      if (sql.includes('INSERT INTO "AmuxDecisionMakerRequest"')) {
        return Promise.resolve([{ createdAtEpochMs: BigInt(createdAtMs), assignmentDeadlineAtEpochMs: BigInt(createdAtMs + DM_ASSIGNMENT_WINDOW_MS) }]);
      }
      if (sql.includes("CROSS JOIN LATERAL")) return Promise.resolve(row === null ? [] : [row]);
      if (sql.includes('SELECT DISTINCT ON ("scope")')) {
        return failSwitchRead ? Promise.reject(new Error("switch read failed")) : Promise.resolve(switches);
      }
      if (sql.includes('LEFT JOIN "AmuxDecisionMakerRequest" r')) {
        return Promise.resolve([existing[0] ? { dbNowEpochMs: BigInt(NOW), ...existing[0] } : { ...NO_REQUEST, dbNowEpochMs: BigInt(NOW) }]);
      }
      if (sql.includes("count(*) FILTER")) return Promise.resolve([throughput]);
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
    adminAuditLog: {
      findFirst: (query) => {
        sent.push({ kind: "findFirst", query });
        return Promise.resolve(null);
      },
      create: (query) => {
        sent.push({ kind: "create", data: query.data });
        return Promise.resolve({ id: "audit-row-1" });
      },
    },
  };
  return { tx, sent };
};

const withIntegrityKey = async (key, work) => {
  const names = ["ADMIN_AUDIT_INTEGRITY_KEY", "ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS", "NEXTAUTH_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  if (key !== null) process.env.ADMIN_AUDIT_INTEGRITY_KEY = key;
  try {
    return await work();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
};

const leases = () => {
  const seen = [];
  return { seen, requireLeaseAt: (deadline) => seen.push(deadline.toISOString()) };
};

const routedCard = (overrides = {}) => ({
  askType: "decision",
  resolution: null,
  type: "task",
  tags: [],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  options: [
    { id: "a", label: "Model id only" },
    { id: "b", label: "Model id and locale" },
  ],
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.",
  contextPaths: ["lib/cache.ts"],
  ...overrides,
});

// The route transaction around each operation adds the boundary's setup and
// commit fence (lib/amux/dbBoundary.ts): two more statements.
const BOUNDARY_STATEMENTS = 2;
const WITH_KEY = 1;

const kindsOf = (sent) => sent.map((statement) => statement.kind);
const auditOf = (sent) => sent.find((statement) => statement.kind === "create").data;
const LOCK = /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/;
const SWITCH_READ = /SELECT DISTINCT ON \("scope"\) "scope", "value"\s+FROM "AmuxDecisionMakerSwitchEvent"/;

test("the reads are one statement each", async () => {
  {
    const { tx, sent } = recordingTx();
    assert.deepEqual(await readDecisionMakerThroughput(tx, OPENAI), { lastHour: 3, lastDay: 7 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, /WHERE r\."route" = 'dm_proposal'\s+AND r\."instance" = \$/);
    assert.deepEqual(sent[0].values, [OPENAI]);
  }
  {
    const { tx, sent } = recordingTx({ state: STATES.terminal });
    assert.equal((await readDecisionMakerRequestState(tx, REQUEST_ID, DIGEST_D)).terminal.resultDigest, DIGEST_C);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].values, [DIGEST_D, REQUEST_ID]);
  }
  {
    const { tx, sent } = recordingTx({ state: STATES.terminal });
    assert.deepEqual(await lookupDecisionMakerResult(tx, { requestId: REQUEST_ID, resultDigest: DIGEST_C }), {
      status: "accepted",
      eventId: TERMINAL_EVENT_ID,
      resultKind: "proposal",
    });
    assert.equal(sent.length, 1);
  }
  {
    const { tx } = recordingTx({ state: null });
    assert.equal(await readDecisionMakerRequestState(tx, REQUEST_ID), null);
  }
  {
    const { tx } = recordingTx({ state: stateRow({ route: "autonomous" }) });
    await assert.rejects(readDecisionMakerRequestState(tx, REQUEST_ID), (error) => error.code === "state_unreadable");
  }
});

for (const [label, key] of [
  ["without", null],
  ["with", "unit-test-integrity-key"],
]) {
  const extra = key === null ? 0 : WITH_KEY;
  const auditKinds = key === null ? ["execute", "query", "create"] : ["execute", "query", "findFirst", "create"];

  test(`routing a question sends ${8 + extra} statements ${label} an integrity key (${7 + extra} without an instance), and an existing one 2`, async () => {
    await withIntegrityKey(key, async () => {
      const { tx, sent } = recordingTx();
      const result = await recordDecisionMakerRequest(tx, { binding: routingBinding(), card: routedCard(), keyRing: RING });
      assert.equal(sent.length, 8 + extra);
      // The whole routing transaction, with the boundary's setup and fence, within §9's 12.
      assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12);
      assert.deepEqual(kindsOf(sent), ["execute", "query", "query", "query", ...auditKinds, "query"]);
      // The lock first, then the existing request, then the switches and the
      // throughput -- both read after the lock every switch change takes.
      assert.match(sent[0].sql, LOCK);
      // The routing read carries the database clock, whose period keys the option set digest.
      assert.match(sent[1].sql, /floor\(extract\(epoch FROM clock_timestamp\(\)\) \* 1000\)::bigint AS "dbNowEpochMs"/);
      assert.match(sent[1].sql, /ON r\."cardId" = \$ AND r\."questionRevision" = \$/);
      assert.deepEqual(sent[1].values, ["card-41", 3]);
      assert.match(sent[2].sql, SWITCH_READ);
      assert.match(sent[3].sql, /count\(\*\) FILTER/);
      assert.deepEqual(sent[3].values, [OPENAI]);
      const audit = auditOf(sent);
      assert.equal(audit.action, "amux.decision.route");
      assert.equal(audit.targetType, "AmuxDecisionMakerRequest");
      assert.equal(audit.targetId, result.requestId);
      assert.equal(audit.actorUserId, null);
      assert.deepEqual(audit.metadata, {
        request_id: result.requestId,
        route: "dm_proposal",
        asking_provider: "claude",
        refusal_codes: [],
        instance: OPENAI,
        systemActor: "amux-decision-router",
      });
      const insert = sent.at(-1);
      assert.match(insert.sql, /INSERT INTO "AmuxDecisionMakerRequest"/);
      assert.deepEqual(insert.values, [
        result.requestId,
        "card-41",
        3,
        "worker.claude-1",
        "session:9",
        1,
        "claude",
        // The store's own keyed digest of the card's options, never the caller's.
        dmOptionSetDigest(dmRequestDigestKey(ROUTING_KEY, result.requestId), routedCard().options),
        DM_POLICY_VERSION,
        "v1",
        "authority-manifest-1",
        "v1",
        "dm_proposal",
        OPENAI,
        [],
        "audit-row-1",
      ]);
      assert.deepEqual(result, {
        requestId: result.requestId,
        created: true,
        route: "dm_proposal",
        instance: OPENAI,
        refusalCodes: [],
        sameBinding: true,
        createdAt: new Date(NOW).toISOString(),
        assignmentDeadlineAt: new Date(NOW + DM_ASSIGNMENT_WINDOW_MS).toISOString(),
        // The route audit of this transaction, which the body store binds the card text to (2026-10-09).
        routeAuditLogId: "audit-row-1",
      });

      // A provider with no instance has no throughput to read.
      const unverified = recordingTx();
      const gemini = await recordDecisionMakerRequest(unverified.tx, {
        binding: routingBinding({ askingProvider: "gemini" }),
        card: routedCard(),
        keyRing: RING,
      });
      assert.equal(unverified.sent.length, 7 + extra);
      assert.deepEqual(kindsOf(unverified.sent), ["execute", "query", "query", ...auditKinds, "query"]);
      assert.deepEqual([gemini.route, gemini.instance, gemini.refusalCodes], ["operator", null, ["provider_unverified"]]);

      const again = recordingTx({
        existing: [
          {
            id: REQUEST_ID,
            ...binding({ askingWorkerId: "worker.claude-2" }),
            route: "operator",
            instance: OPENAI,
            refusalCodes: ["kill_switch_on"],
            createdAtEpochMs: BigInt(NOW - 1),
            assignmentDeadlineAtEpochMs: BigInt(NOW - 1 + DM_ASSIGNMENT_WINDOW_MS),
          },
        ],
      });
      const existing = await recordDecisionMakerRequest(again.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING });
      assert.equal(again.sent.length, 2);
      // The first request of a question revision stands (§9).
      assert.deepEqual(existing, {
        requestId: REQUEST_ID,
        created: false,
        route: "operator",
        instance: OPENAI,
        refusalCodes: ["kill_switch_on"],
        sameBinding: false,
        createdAt: new Date(NOW - 1).toISOString(),
        assignmentDeadlineAt: new Date(NOW - 1 + DM_ASSIGNMENT_WINDOW_MS).toISOString(),
        // No audit was written for it in this transaction.
        routeAuditLogId: null,
      });
      // The same binding and the same options, recomputed under that request's own key.
      const storedRow = {
        id: REQUEST_ID,
        ...binding({ optionSetDigest: dmOptionSetDigest(dmRequestDigestKey(ROUTING_KEY, REQUEST_ID), routedCard().options) }),
        route: "dm_proposal",
        instance: OPENAI,
        refusalCodes: [],
        createdAtEpochMs: BigInt(NOW - 1),
        assignmentDeadlineAtEpochMs: BigInt(NOW - 1 + DM_ASSIGNMENT_WINDOW_MS),
      };
      const same = recordingTx({ existing: [storedRow] });
      assert.equal((await recordDecisionMakerRequest(same.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING })).sameBinding, true);
      // Another label is another option set; without that period's key the set cannot be confirmed.
      const otherOptions = routedCard({ options: [{ id: "a", label: "Model id only" }, { id: "b", label: "Locale only" }] });
      const relabelled = recordingTx({ existing: [storedRow] });
      assert.equal((await recordDecisionMakerRequest(relabelled.tx, { binding: routingBinding(), card: otherOptions, keyRing: RING })).sameBinding, false);
      const keyless = recordingTx({ existing: [storedRow] });
      assert.equal((await recordDecisionMakerRequest(keyless.tx, { binding: routingBinding(), card: routedCard(), keyRing: new Map() })).sameBinding, false);
    });
  });

  test(`each event write sends its pinned statements ${label} an integrity key, in order`, async () => {
    await withIntegrityKey(key, async () => {
      const cases = [
        {
          name: "assign",
          row: STATES.fresh,
          run: (tx, lease) => assignDecisionMakerRequest(tx, { requestId: REQUEST_ID, requireLeaseAt: lease }),
          action: "amux.decision.assign",
          actor: "amux-decision-router",
          values: [null, null, null, null, null, null, null, null, null],
          lease: [new Date(NOW - 10_000 + DM_ASSIGNMENT_WINDOW_MS).toISOString()],
        },
        {
          name: "assign_discarded",
          row: STATES.assigned,
          run: (tx) => discardDecisionMakerAssignment(tx, { requestId: REQUEST_ID }),
          action: "amux.decision.assign_discarded",
          actor: "amux-decision-router",
          values: [null, null, null, null, null, null, null, null, null],
        },
        {
          name: "transmit_intent",
          row: STATES.assigned,
          switchRead: true,
          run: (tx, lease) =>
            recordDecisionMakerTransmitIntent(tx, {
              requestId: REQUEST_ID,
              instance: OPENAI,
              transmission: { snapshotState: "worker_head", snapshotTargetSha: SHA, snapshotManifestDigest: DIGEST_C, inputPayloadDigest: DIGEST_B },
              requireLeaseAt: lease,
            }),
          action: "amux.decision.transmit_intent",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, "openai", DIGEST_B, "worker_head", SHA, DIGEST_C, null, null, null],
          // The intent is held to the result deadline, at the fence and at COMMIT.
          lease: [new Date(NOW + 20 * 60_000).toISOString()],
        },
        {
          name: "transmit_receipt",
          row: STATES.transmitted,
          run: (tx) => recordDecisionMakerTransmitOutcome(tx, { requestId: REQUEST_ID, instance: OPENAI, outcome: "receipt" }),
          action: "amux.decision.transmit_receipt",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, null, null, null, null, null, null, null],
        },
        {
          name: "transmit_unknown",
          row: STATES.staleClosed,
          run: (tx) => recordDecisionMakerTransmitOutcome(tx, { requestId: REQUEST_ID, instance: OPENAI, outcome: "unknown" }),
          action: "amux.decision.transmit_unknown",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, null, null, null, null, null, null, null],
        },
        {
          name: "result",
          row: STATES.transmitted,
          switchRead: true,
          run: (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: lease }),
          action: "amux.decision.result",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, DIGEST_B, null, null, null, "proposal", DIGEST_D, null],
          lease: [new Date(NOW + 20 * 60_000).toISOString()],
        },
        {
          name: "result (timeout under the kill switch, no lease)",
          row: STATES.transmittedLate,
          switches: [{ scope: "kill_switch", value: "on" }],
          switchRead: true,
          run: (tx, lease) =>
            submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission({ resultKind: "timeout" }), requireLeaseAt: lease }),
          action: "amux.decision.result",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, DIGEST_B, null, null, null, "timeout", DIGEST_D, null],
          lease: [],
        },
        {
          name: "result_rejected (another digest)",
          row: STATES.terminal,
          switchRead: true,
          run: (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: lease }),
          action: "amux.decision.result_rejected",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, null, null, null, null, null, DIGEST_D, "terminal_exists"],
          lease: [],
        },
        {
          name: "result_rejected (a proposal under the kill switch)",
          row: STATES.transmitted,
          switches: [
            { scope: "kill_switch", value: "on" },
            { scope: "decision-maker-openai", value: "proposal" },
          ],
          switchRead: true,
          run: (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: lease }),
          action: "amux.decision.result_rejected",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, null, null, null, null, null, DIGEST_D, "kill_switch"],
          lease: [],
        },
        {
          name: "result_unknown",
          row: STATES.transmitted,
          run: (tx) => recordDecisionMakerResultUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI, resultDigest: DIGEST_D }),
          action: "amux.decision.result_unknown",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, null, null, null, null, null, DIGEST_D, null],
        },
        {
          name: "stale_close",
          row: STATES.stale,
          run: (tx) => staleCloseDecisionMakerRequest(tx, { requestId: REQUEST_ID }),
          action: "amux.decision.stale_close",
          actor: "amux-decision-router",
          values: [null, null, null, null, null, null, null, null, null],
        },
      ];
      for (const entry of cases) {
        const { tx, sent } = recordingTx({ state: entry.row, switches: entry.switches });
        const lease = leases();
        const result = await entry.run(tx, lease.requireLeaseAt);
        // 6 (7) without a switch read, 7 (8) with one; 9 (10) at most with the boundary.
        const expected = (entry.switchRead ? 7 : 6) + extra;
        assert.equal(sent.length, expected, entry.name);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12, entry.name);
        assert.deepEqual(
          kindsOf(sent),
          ["execute", "query", ...(entry.switchRead ? ["query"] : []), ...auditKinds, "query"],
          entry.name,
        );
        assert.match(sent[0].sql, LOCK, entry.name);
        assert.match(sent[1].sql, /CROSS JOIN LATERAL/, entry.name);
        // The switches are read after the lock, by the switch store's reader.
        if (entry.switchRead) assert.match(sent[2].sql, SWITCH_READ, entry.name);
        else assert.ok(!sent.some((statement) => SWITCH_READ.test(statement.sql)), entry.name);
        const audit = auditOf(sent);
        const eventId = result.event?.eventId;
        assert.ok(eventId, entry.name);
        assert.equal(audit.action, entry.action, entry.name);
        assert.equal(audit.targetType, "AmuxDecisionMakerRequestEvent", entry.name);
        assert.equal(audit.targetId, eventId, entry.name);
        assert.equal(audit.actorUserId, null, entry.name);
        assert.equal(audit.metadata.systemActor, entry.actor, entry.name);
        assert.equal(audit.metadata.event_id, eventId, entry.name);
        assert.equal(audit.metadata.request_id, REQUEST_ID, entry.name);
        assert.ok(Object.keys(audit.metadata).every((name) => name === "systemActor" || DM_EVENT_AUDIT_METADATA_KEYS.includes(name)), entry.name);
        const insert = sent.at(-1);
        assert.match(insert.sql, /INSERT INTO "AmuxDecisionMakerRequestEvent"/, entry.name);
        assert.deepEqual(insert.values.slice(0, 3), [eventId, REQUEST_ID, entry.action.slice("amux.decision.".length)], entry.name);
        assert.deepEqual(insert.values.slice(3, 12), entry.values, entry.name);
        assert.equal(insert.values[12], "audit-row-1", entry.name);
        assert.deepEqual(lease.seen, entry.lease ?? [], entry.name);
      }
    });
  });
}

test("routing without the key of its period writes nothing, and a routing that crosses a period is refused", async () => {
  const missing = recordingTx();
  await assert.rejects(
    recordDecisionMakerRequest(missing.tx, { binding: routingBinding(), card: routedCard(), keyRing: new Map() }),
    (error) => error instanceof DecisionMakerRequestWriteError && error.code === "digest_key_unavailable",
  );
  // The lock and the routing read, and nothing after them.
  assert.deepEqual(kindsOf(missing.sent), ["execute", "query"]);

  // The row's createdAt lands in the next period: its key would differ from the digest's.
  const crossing = recordingTx({ createdAtMs: (dmKeyPeriodOf(NOW) + 1) * 30 * 24 * 60 * 60 * 1000 });
  await assert.rejects(
    recordDecisionMakerRequest(crossing.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING }),
    (error) => error instanceof DecisionMakerRequestWriteError && error.code === "key_period_changed",
  );
});

test("the router decides on the switches and the throughput it reads after the lock", async () => {
  const routed = async (options, bindingOverrides = {}) => {
    const { tx } = recordingTx(options);
    return recordDecisionMakerRequest(tx, { binding: routingBinding(bindingOverrides), card: routedCard(), keyRing: RING });
  };
  assert.deepEqual((await routed({ switches: [{ scope: "kill_switch", value: "on" }, ...PERMISSIVE_SWITCHES.slice(1)] })).refusalCodes, [
    "kill_switch_on",
  ]);
  // No event for the instance reads as off.
  assert.deepEqual((await routed({ switches: [{ scope: "kill_switch", value: "off" }] })).refusalCodes, ["instance_off"]);
  // A row the switch store could not have written reads as unreadable and is
  // recorded as such: the transaction is intact.
  assert.deepEqual((await routed({ switches: [{ scope: "decision-maker-openai", value: "autonomous" }] })).refusalCodes, [
    "settings_unreadable",
  ]);
  assert.deepEqual((await routed({ throughput: { lastHour: 20n, lastDay: 20n } })).refusalCodes, ["throughput_exceeded"]);
  assert.deepEqual((await routed({}, { askingProvider: "codex" })).instance, "decision-maker-anthropic");
});

// The S1c review minor (2026-10-08): a switch read that fails has aborted the
// PostgreSQL transaction, so nothing after it can run. Each writer stops at
// the failed read with a typed settings_unreadable and sends nothing more; the
// caller's transaction rolls back with nothing written.
test("a switch read that fails stops every writer at that read, with settings_unreadable", async () => {
  const transmission = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  const cases = [
    ["routing", stateRow(), (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding(), card: routedCard(), keyRing: RING })],
    [
      "intent",
      STATES.assigned,
      (tx, lease) => recordDecisionMakerTransmitIntent(tx, { requestId: REQUEST_ID, instance: OPENAI, transmission, requireLeaseAt: lease }),
    ],
    ["result", STATES.transmitted, (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: lease })],
  ];
  for (const [name, row, run] of cases) {
    const { tx, sent } = recordingTx({ state: row, failSwitchRead: true });
    const lease = leases();
    await assert.rejects(
      run(tx, lease.requireLeaseAt),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "settings_unreadable",
      name,
    );
    // Lock, the request (or the routed card's existing request), the failed switch read -- and nothing after it.
    assert.equal(sent.length, 3, name);
    assert.deepEqual(kindsOf(sent), ["execute", "query", "query"], name);
    assert.match(sent[2].sql, SWITCH_READ, name);
    assert.ok(!sent.some((statement) => statement.kind === "create"), name);
    assert.deepEqual(lease.seen, [], name);
  }
});

test("a refusal, an existing pair or an unknown request writes nothing, in 2 statements -- 3 after a switch read", async () => {
  const cases = [
    ["assign twice", STATES.assigned, 2, (tx, lease) => assignDecisionMakerRequest(tx, { requestId: REQUEST_ID, requireLeaseAt: lease }), { recorded: false, reason: "already_assigned" }],
    ["assign late", STATES.assignmentLate, 2, (tx, lease) => assignDecisionMakerRequest(tx, { requestId: REQUEST_ID, requireLeaseAt: lease }), { recorded: false, reason: "deadline_passed" }],
    ["assign an operator request", STATES.operator, 2, (tx, lease) => assignDecisionMakerRequest(tx, { requestId: REQUEST_ID, requireLeaseAt: lease }), { recorded: false, reason: "not_routed_to_dm" }],
    ["assign unknown", null, 2, (tx, lease) => assignDecisionMakerRequest(tx, { requestId: REQUEST_ID, requireLeaseAt: lease }), { recorded: false, reason: "unknown_request" }],
    ["discard after intent", STATES.transmitted, 2, (tx) => discardDecisionMakerAssignment(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "already_transmitted" }],
    [
      "second intent",
      STATES.transmitted,
      2,
      (tx, lease) =>
        recordDecisionMakerTransmitIntent(tx, {
          requestId: REQUEST_ID,
          instance: OPENAI,
          transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
          requireLeaseAt: lease,
        }),
      { recorded: false, reason: "already_transmitted" },
    ],
    ["second receipt", STATES.receipted, 2, (tx) => recordDecisionMakerTransmitOutcome(tx, { requestId: REQUEST_ID, instance: OPENAI, outcome: "unknown" }), { recorded: false, reason: "transmit_outcome_recorded" }],
    ["same pair", STATES.terminal, 2, (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission({ resultDigest: DIGEST_C }), requireLeaseAt: lease }), { status: "existing", eventId: TERMINAL_EVENT_ID, resultKind: "proposal" }],
    ["same pair rejected", { ...STATES.transmitted, probedRejection: "kill_switch" }, 2, (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: lease }), { status: "already_rejected", reason: "kill_switch" }],
    ["other instance", STATES.transmitted, 2, (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission({ instance: "decision-maker-anthropic" }), requireLeaseAt: lease }), { status: "instance_mismatch" }],
    ["result unknown request", null, 2, (tx, lease) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: lease }), { status: "unknown_request" }],
    ["unknown after accept", STATES.terminal, 2, (tx) => recordDecisionMakerResultUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI, resultDigest: DIGEST_C }), { recorded: false, reason: "already_accepted" }],
    ["unknown after another result", STATES.terminal, 2, (tx) => recordDecisionMakerResultUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI, resultDigest: DIGEST_D }), { recorded: false, reason: "result_recorded" }],
    ["unknown after rejection", { ...STATES.transmitted, probedRejection: "binding_mismatch" }, 2, (tx) => recordDecisionMakerResultUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI, resultDigest: DIGEST_D }), { recorded: false, reason: "already_rejected" }],
    ["stale too early", STATES.fresh, 2, (tx) => staleCloseDecisionMakerRequest(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "not_stale" }],
  ];
  for (const [name, row, statements, run, expected] of cases) {
    const { tx, sent } = recordingTx({ state: row });
    const lease = leases();
    assert.deepEqual(await run(tx, lease.requireLeaseAt), expected, name);
    assert.equal(sent.length, statements, name);
    assert.deepEqual(kindsOf(sent), ["execute", "query"], name);
    assert.deepEqual(lease.seen, [], name);
  }
});

test("no transmission intent is recorded while the kill switch is on, the instance is off, or the switch store is unreadable", async () => {
  const transmission = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  for (const [options, reason] of [
    [{ switches: [{ scope: "kill_switch", value: "on" }, ...PERMISSIVE_SWITCHES.slice(1)] }, "kill_switch_on"],
    [{ switches: [{ scope: "decision-maker-openai", value: "off" }, { scope: "decision-maker-anthropic", value: "proposal" }] }, "instance_off"],
    // No event for the instance is its default, off.
    [{ switches: [{ scope: "decision-maker-anthropic", value: "proposal" }] }, "instance_off"],
    [{ switches: [{ scope: "decision-maker-openai", value: "autonomous" }] }, "settings_unreadable"],
  ]) {
    const { tx, sent } = recordingTx({ state: STATES.assigned, ...options });
    const lease = leases();
    assert.deepEqual(
      await recordDecisionMakerTransmitIntent(tx, { requestId: REQUEST_ID, instance: OPENAI, transmission, requireLeaseAt: lease.requireLeaseAt }),
      { recorded: false, reason },
      JSON.stringify(options),
    );
    // Lock, state, switches -- and nothing written.
    assert.equal(sent.length, 3, JSON.stringify(options));
    assert.match(sent[2].sql, SWITCH_READ);
    assert.deepEqual(lease.seen, []);
  }
  assert.equal(dmTransmitSwitchRefusal({ killSwitch: false, instanceMode: "proposal" }), null);
  assert.equal(dmTransmitSwitchRefusal({ killSwitch: null, instanceMode: "proposal" }), "settings_unreadable");
  assert.equal(dmTransmitSwitchRefusal({ killSwitch: false, instanceMode: null }), "settings_unreadable");
});

test("a result writes nothing when the switch store is unreadable", async () => {
  for (const options of [{ failSwitchRead: true }, { switches: [{ scope: "kill_switch", value: "maybe" }] }]) {
    const { tx, sent } = recordingTx({ state: STATES.transmitted, ...options });
    await assert.rejects(
      submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission(), requireLeaseAt: () => assert.fail("no lease") }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "settings_unreadable",
    );
    assert.equal(sent.length, 3);
    assert.ok(!sent.some((statement) => statement.kind === "create"));
  }
});

test("the switches cannot be handed to the writers", () => {
  const store = read(STORE);
  // The writers take no switch value, and read the switch store themselves --
  // through the reader that lets a failed read through, never the fail-closed
  // one, whose unreadable state would let a writer go on in an aborted
  // transaction.
  assert.doesNotMatch(store, /killSwitch:\s*(boolean|unknown)|switches:\s*\{/);
  assert.equal((store.match(/await readSwitchesForWrite\(tx\)/g) ?? []).length, 3);
  assert.equal((store.match(/await readDecisionMakerSwitchesOrThrow\(tx\)/g) ?? []).length, 1);
  assert.doesNotMatch(store, /readDecisionMakerSwitches\(/);
});

test("the open requests of a key period are counted in one statement, from [from, to) by the database clock", async () => {
  const sent = [];
  const tx = {
    $queryRaw: (strings, ...values) => {
      sent.push({ sql: strings.join("$"), values });
      return Promise.resolve([{ open: 2n }]);
    },
  };
  assert.equal(await countOpenDecisionMakerRequestsCreatedBetween(tx, { fromMs: 1_000, toMs: 2_000 }), 2);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].values, [1_000, 2_000]);
  assert.match(sent[0].sql, /r\."route" = 'dm_proposal'/);
  assert.match(sent[0].sql, /"createdAt" >= 'epoch'::timestamptz \+ \$ \* INTERVAL '1 millisecond'/);
  assert.match(sent[0].sql, /"createdAt" < 'epoch'::timestamptz \+ \$ \* INTERVAL '1 millisecond'/);
  // A judgment closes a request too (stage S1e).
  assert.match(sent[0].sql, /ev\."kind" IN \('assign_discarded', 'stale_close', 'confirm', 'edit_confirm', 'reject'\)/);
  for (const input of [{ fromMs: -1, toMs: 5 }, { fromMs: 5, toMs: 5 }, { fromMs: 1.5, toMs: 5 }, { fromMs: 0, toMs: Number.MAX_VALUE }]) {
    await assert.rejects(
      countOpenDecisionMakerRequestsCreatedBetween(tx, input),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "invalid_input",
    );
  }
  assert.equal(sent.length, 1);
});

test("a malformed input sends nothing at all", async () => {
  const noLease = () => assert.fail("no lease for a refused input");
  const cases = [
    (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding({ cardId: "" }), card: routedCard(), keyRing: RING }),
    // The decision is the store's own; a caller's is not an input.
    (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding(), decision: { route: "dm_proposal", instance: OPENAI, refusals: [] }, keyRing: RING }),
    // So is the option set digest (stage S1d).
    (tx) => recordDecisionMakerRequest(tx, { binding: binding(), card: routedCard(), keyRing: RING }),
    (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding(), card: routedCard() }),
    (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding(), card: routedCard({ options: [{ id: "a" }] }), keyRing: RING }),
    (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding(), card: { ...routedCard(), extra: true }, keyRing: RING }),
    (tx) => recordDecisionMakerRequest(tx, { binding: routingBinding(), card: routedCard({ tags: "needs:you" }), keyRing: RING }),
    (tx) => assignDecisionMakerRequest(tx, { requestId: "not-a-uuid", requireLeaseAt: noLease }),
    (tx) => assignDecisionMakerRequest(tx, { requestId: REQUEST_ID }),
    (tx) => recordDecisionMakerTransmitIntent(tx, { requestId: REQUEST_ID, instance: "decision-maker-gemini", transmission: null, requireLeaseAt: noLease }),
    (tx) =>
      recordDecisionMakerTransmitIntent(tx, {
        requestId: REQUEST_ID,
        instance: OPENAI,
        transmission: { snapshotState: "none", snapshotTargetSha: SHA, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
        requireLeaseAt: noLease,
      }),
    (tx) =>
      recordDecisionMakerTransmitIntent(tx, {
        requestId: REQUEST_ID,
        instance: OPENAI,
        transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
      }),
    (tx) => recordDecisionMakerTransmitOutcome(tx, { requestId: REQUEST_ID, instance: OPENAI, outcome: "maybe" }),
    (tx) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission({ resultKind: "approve" }), requireLeaseAt: noLease }),
    (tx) => submitDecisionMakerResult(tx, { requestId: REQUEST_ID, submission: submission() }),
    (tx) => recordDecisionMakerResultUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI, resultDigest: "x" }),
    (tx) => staleCloseDecisionMakerRequest(tx, { requestId: null }),
    (tx) => readDecisionMakerThroughput(tx, "decision-maker-gemini"),
    (tx) => readDecisionMakerRequestState(tx, REQUEST_ID, "x"),
  ];
  for (const [index, run] of cases.entries()) {
    const { tx, sent } = recordingTx();
    await assert.rejects(run(tx), (error) => error instanceof DecisionMakerRequestWriteError && error.code === "invalid_input", String(index));
    assert.equal(sent.length, 0, String(index));
  }
});

test("the switch clause of the event trigger: an intent needs both on, a proposal the kill switch off", () => {
  const on = { killSwitch: false, instanceMode: "proposal" };
  const killed = { killSwitch: true, instanceMode: "proposal" };
  const instanceOff = { killSwitch: false, instanceMode: "off" };
  const unreadable = { killSwitch: null, instanceMode: null };
  const rejected = (rejectionReason) => ({ kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_D, rejectionReason });
  for (const [attempt, expected] of [
    [ATTEMPTS.transmit_intent, [null, "kill_switch_on", "instance_off", "kill_switch_on"]],
    [ATTEMPTS.proposal, [null, "kill_switch_on", null, "kill_switch_on"]],
    [{ ...ATTEMPTS.proposal, resultKind: "escalate" }, [null, null, null, null]],
    [ATTEMPTS.timeout, [null, null, null, null]],
    [rejected("kill_switch"), ["reason_inconsistent", null, "reason_inconsistent", "reason_inconsistent"]],
    [rejected("binding_mismatch"), [null, null, null, null]],
    [ATTEMPTS.assign, [null, null, null, null]],
    [ATTEMPTS.transmit_receipt, [null, null, null, null]],
    [ATTEMPTS.result_unknown, [null, null, null, null]],
  ]) {
    assert.deepEqual(
      [on, killed, instanceOff, unreadable].map((switches) => dmEventSwitchRefusal(attempt, switches)),
      expected,
      JSON.stringify(attempt),
    );
  }
});
