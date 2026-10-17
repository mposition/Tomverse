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
import { createHash } from "node:crypto";
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
  DM_LEDGER_EVENT_KINDS,
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
  DM_VALIDATION_LATCH_THRESHOLD,
  DM_VALIDATION_LATCH_WINDOW,
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
  dmCleanupLatchDecision,
  dmOwedLatchReason,
  dmSwitchInputWithOwedLatch,
  dmTransmitSwitchRefusal,
  dmValidationLatchDecision,
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
  readDecisionMakerInstanceLatchInputs,
  readDecisionMakerInstanceLoad,
  readDecisionMakerInstanceNewestCleanupUnknown,
  readDecisionMakerInstanceResultKinds,
  readDecisionMakerRequestState,
  recordDecisionMakerCleanupLatch,
  recordDecisionMakerCleanupUnknown,
  recordDecisionMakerRequest,
  recordDecisionMakerResultUnknown,
  recordDecisionMakerTransmitIntent,
  recordDecisionMakerTransmitOutcome,
  recordDecisionMakerValidationLatch,
  staleCloseDecisionMakerRequest,
  submitDecisionMakerResult,
} from "../lib/amux/decisionMakerRequestStore.ts";
import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
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
    // Stage S2-2a3, §5.
    "cleanup_unknown",
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
  // S1c's nine; stage S2-2a3 adds cleanup_unknown in a CHECK of its own (below).
  assert.deepEqual(
    inList("AmuxDecisionMakerRequestEvent_kind_check"),
    DM_REQUEST_EVENT_KINDS.filter((kind) => kind !== "cleanup_unknown"),
  );
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

const CLEANUP_MIGRATION_NAME = "20261017160000_amux_decision_maker_cleanup_unknown";
const CLEANUP_MIGRATION = `prisma/migrations/${CLEANUP_MIGRATION_NAME}/migration.sql`;
const JUDGMENT_MIGRATION_NAME = "20261008130100_amux_decision_maker_judgment_delivery";
const JUDGMENT_MIGRATION = `prisma/migrations/${JUDGMENT_MIGRATION_NAME}/migration.sql`;
const bodyOf = (fn) => {
  const open = fn.indexOf("AS $$") + 5;
  return fn.slice(open, fn.indexOf("$$", open));
};
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `${label}: exactly one occurrence`);
  return parts.join(to);
};

test("stage S2-2a3's migration adds cleanup_unknown to the kinds, once per request, and its transition alone to the event guard", () => {
  const raw = read(CLEANUP_MIGRATION);
  const sql = withoutSqlComments(raw);
  const before = functionBody(read(JUDGMENT_MIGRATION), "amux_decision_maker_request_event_guard");
  const after = functionBody(raw, "amux_decision_maker_request_event_guard");

  // The header pins the previous body, as the baseline guard compares a replacement.
  assert.equal(
    raw.split("\n")[0],
    `-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_request_event_guard" "${sha256(bodyOf(before))}"`,
  );

  // The replaced body is its previous body with these lines added and nothing else.
  let expected = before;
  expected = replaceOnce(expected, "    has_result_unknown BOOLEAN;\n", "    has_result_unknown BOOLEAN;\n    has_cleanup_unknown BOOLEAN;\n", "declare");
  expected = replaceOnce(
    expected,
    `                coalesce(bool_or("kind" = ''result_unknown''), false),\n`,
    `                coalesce(bool_or("kind" = ''result_unknown''), false),\n                coalesce(bool_or("kind" = ''cleanup_unknown''), false),\n`,
    "aggregate",
  );
  expected = replaceOnce(
    expected,
    "terminal_digest, terminal_kind, has_result_unknown, closed\n",
    "terminal_digest, terminal_kind, has_result_unknown, has_cleanup_unknown, closed\n",
    "into",
  );
  expected = replaceOnce(
    expected,
    "        WHEN 'result_unknown' THEN\n            assigned AND NOT closed AND NOT has_result AND NOT has_result_unknown\n",
    "        WHEN 'result_unknown' THEN\n            assigned AND NOT closed AND NOT has_result AND NOT has_result_unknown\n" +
      "        -- Stage S2-2a3, section 5: the broker could not confirm that the\n" +
      "        -- request's directories were deleted. Once per request, after the\n" +
      "        -- assignment that gave the broker the request; a fact whatever\n" +
      "        -- happened since, so also once the request is closed. It closes\n" +
      "        -- nothing.\n" +
      "        WHEN 'cleanup_unknown' THEN\n            assigned AND NOT has_cleanup_unknown\n",
    "graph",
  );
  assert.equal(after, expected);
  // Its audit is the instance's, through the guard's existing rule for every kind but the router's and a judgment's;
  // it takes no switch gate, holds no deadline and is not a closing kind.
  assert.ok(after.includes(`WHEN NEW."kind" IN ('assign', 'assign_discarded', 'stale_close') THEN 'amux-decision-router'`));
  assert.ok(after.includes(`IF NEW."kind" IN ('transmit_intent', 'result', 'result_rejected') THEN`));
  assert.ok(after.includes(`''assign_discarded'', ''stale_close'', ''confirm'', ''edit_confirm'', ''reject''`));
  assert.doesNotMatch(after, /IN \([^)]*cleanup_unknown/);

  // The kind CHECK holds the core's list, and is the only constraint dropped.
  const kindCheck = sql.slice(
    sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"'),
    sql.indexOf("));", sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"')),
  );
  assert.deepEqual(quoted(kindCheck), [...DM_LEDGER_EVENT_KINDS]);
  assert.match(sql, /DROP CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check",\n\s+ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"/);
  assert.deepEqual([...sql.matchAll(/\bDROP (CONSTRAINT|INDEX|TRIGGER) "([A-Za-z_]+)"/g)].map((match) => match[2]), [
    "AmuxDecisionMakerRequestEvent_kind_check",
  ]);
  // One report per request, and an instance's newest report on an index.
  assert.ok(
    sql.includes(
      `CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_cleanup_unknown_key"\n  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" = 'cleanup_unknown';`,
    ),
  );
  assert.ok(
    sql.includes(
      `CREATE INDEX "AmuxDecisionMakerRequestEvent_cleanup_unknown_instance_idx"\n  ON "AmuxDecisionMakerRequestEvent"("instance", "createdAt") WHERE "kind" = 'cleanup_unknown';`,
    ),
  );
  // Nothing else: one function, no table, trigger, row or closing change.
  assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 1);
  assert.equal((sql.match(/^ALTER TABLE /gm) ?? []).length, 1);
  assert.equal((sql.match(/^CREATE (UNIQUE )?INDEX /gm) ?? []).length, 2);
  assert.doesNotMatch(sql, /^CREATE TABLE |^CREATE TRIGGER |^CREATE CONSTRAINT TRIGGER |\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b|one_closing|closing_retention/im);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.ok(!DM_CLOSING_EVENT_KINDS.includes("cleanup_unknown"));

  // No migration between the two redefines the guard, and none after this one: it is the body the database runs.
  const redefining = readdirSync(join(root, "prisma/migrations"))
    .filter((name) => name > JUDGMENT_MIGRATION_NAME && name !== CLEANUP_MIGRATION_NAME)
    .filter((name) => {
      try {
        return /FUNCTION "amux_decision_maker_request_event_guard"\(/.test(read(`prisma/migrations/${name}/migration.sql`));
      } catch {
        return false;
      }
    });
  assert.deepEqual(redefining, []);
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
const CLEANUP_EVENT_ID = "88888888-2222-4333-8444-555555555555";
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
  cleanupUnknownEventId: null,
  cleanupUnknownAtEpochMs: null,
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
  // §5 (stage S2-2a3): the broker reported a cleanup it could not confirm; the request stays open.
  cleanupReported: stateRow({ ...TRANSMITTED, cleanupUnknownEventId: CLEANUP_EVENT_ID, cleanupUnknownAtEpochMs: BigInt(NOW - 1_000) }),
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
  cleanup_unknown: { kind: "cleanup_unknown", instance: OPENAI },
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
    cleanup_unknown: "not_assigned",
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
    cleanup_unknown: "not_assigned",
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
    cleanup_unknown: null,
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
    cleanup_unknown: null,
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
    cleanup_unknown: null,
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
    cleanup_unknown: null,
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
    cleanup_unknown: null,
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
    cleanup_unknown: null,
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
    cleanup_unknown: null,
  },
  assignmentLate: {
    assign: "deadline_passed",
  },
  assignedLate: {
    transmit_intent: "deadline_passed",
    unavailable_before_intent: null,
    assign_discarded: null,
    // No deadline holds a report.
    cleanup_unknown: null,
  },
  transmittedLate: {
    proposal: "deadline_passed",
    timeout: null,
    result_unknown: null,
  },
  stale: {
    stale_close: null,
    assign: "deadline_passed",
    cleanup_unknown: "not_assigned",
  },
  // A report is not a closing: the request takes its result and its receipt, and no second report.
  cleanupReported: {
    cleanup_unknown: "cleanup_unknown_recorded",
    transmit_receipt: null,
    proposal: null,
    result_unknown: null,
    stale_close: "not_stale",
    assign_discarded: "already_transmitted",
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
  for (const name of ["transmit_intent", "transmit_receipt", "proposal", "result_unknown", "cleanup_unknown"]) {
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
  // §5's report, with its database clock; it does not close the request.
  assert.equal(state("transmitted").cleanupUnknown, null);
  assert.deepEqual(state("cleanupReported").cleanupUnknown, { eventId: CLEANUP_EVENT_ID, createdAtMs: NOW - 1_000 });
  assert.equal(state("cleanupReported").closing, null);
  for (const overrides of [
    // A report is its id and its clock, both or neither, from the state read's own columns.
    { cleanupUnknownEventId: CLEANUP_EVENT_ID, cleanupUnknownAtEpochMs: null },
    { cleanupUnknownEventId: null, cleanupUnknownAtEpochMs: BigInt(NOW) },
    { cleanupUnknownEventId: "not-a-uuid", cleanupUnknownAtEpochMs: BigInt(NOW) },
    { cleanupUnknownEventId: CLEANUP_EVENT_ID, cleanupUnknownAtEpochMs: "soon" },
    { cleanupUnknownEventId: undefined },
    { cleanupUnknownAtEpochMs: undefined },
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
  // §8's and §5's latches turn an instance off only through the switch store's
  // latch: each check under its own reason, and the intent that finds a latch
  // owed under the reason it owes. The ledger store never names the switch
  // table (the switch test fails on any other reader or writer of it).
  assert.equal((store.match(/latchDecisionMakerInstanceOff\(tx, \{ instance, reason: "validation_latch" \}\)/g) ?? []).length, 1);
  assert.equal((store.match(/latchDecisionMakerInstanceOff\(tx, \{ instance, reason: "cleanup_latch" \}\)/g) ?? []).length, 1);
  assert.equal((store.match(/latchDecisionMakerInstanceOff\(tx, \{ instance, reason: owed \}\)/g) ?? []).length, 1);
  assert.equal((store.match(/latchDecisionMakerInstanceOff\(/g) ?? []).length, 3);
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

const MISSING_COLUMN = Symbol("missing column");

const recordingTx = ({
  state: row = stateRow(),
  existing = [],
  failRead = false,
  switches = PERMISSIVE_SWITCHES,
  failSwitchRead = false,
  throughput = { lastHour: 3n, lastDay: 7n },
  createdAtMs = NOW,
  // §8's latch: the instance's terminal results since its newest switch event
  // (each switch row's actor and clock below).
  resultKinds = [],
  // §5's latch (stage S2-2a3): the database clock of the instance's newest cleanup report, or none;
  // MISSING_COLUMN leaves the column out of the row.
  cleanupAt = null,
} = {}) => {
  const reportColumn = cleanupAt === MISSING_COLUMN ? {} : { newestCleanupUnknownAtEpochMs: cleanupAt };
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
      if (sql.includes('INSERT INTO "AmuxDecisionMakerSwitchEvent"')) {
        return Promise.resolve([{ sequence: 77n, createdAtEpochMs: BigInt(NOW + 9) }]);
      }
      // The routing's throughput statement, which carries the result kinds and the newest cleanup report too.
      if (sql.includes("count(*) FILTER")) {
        return Promise.resolve([{ ...throughput, resultKinds, ...reportColumn }]);
      }
      // The intent's latch inputs: the result kinds and the newest cleanup report, in one statement.
      if (sql.includes('AS "resultKinds"')) return Promise.resolve([{ resultKinds, ...reportColumn }]);
      if (sql.includes('SELECT ev."resultKind"')) return Promise.resolve(resultKinds.map((resultKind) => ({ resultKind })));
      // §5's latch check: the newest cleanup report alone.
      if (sql.includes('AS "newestCleanupUnknownAtEpochMs"')) return Promise.resolve([{ ...reportColumn }]);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"')) {
        return Promise.resolve([{ sequence: 41n, createdAtEpochMs: BigInt(NOW + 5), resultDeadlineAtEpochMs: null }]);
      }
      if (sql.includes('INSERT INTO "AmuxDecisionMakerRequest"')) {
        return Promise.resolve([{ createdAtEpochMs: BigInt(createdAtMs), assignmentDeadlineAtEpochMs: BigInt(createdAtMs + DM_ASSIGNMENT_WINDOW_MS) }]);
      }
      if (sql.includes("CROSS JOIN LATERAL")) return Promise.resolve(row === null ? [] : [row]);
      if (sql.includes('SELECT DISTINCT ON ("scope")')) {
        // Each scope's newest event carries its actor and clock: a person's, a minute ago, unless a row says otherwise.
        return failSwitchRead
          ? Promise.reject(new Error("switch read failed"))
          : Promise.resolve(switches.map((row) => ({ actorKind: "human", createdAtEpochMs: BigInt(NOW - 60_000), newestCleanupLatchAtEpochMs: null, ...row })));
      }
      if (sql.includes('LEFT JOIN "AmuxDecisionMakerRequest" r')) {
        return Promise.resolve([existing[0] ? { dbNowEpochMs: BigInt(NOW), ...existing[0] } : { ...NO_REQUEST, dbNowEpochMs: BigInt(NOW) }]);
      }
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

/**
 * The boundary each event write below runs in when a caller other than a
 * test makes it: the retention sweep's stale close, and stage S2's internal
 * routes (app/api/internal/amux/decision-maker/**). The assignment and the
 * result run through the body store's keyed compositions, whose boundaries
 * tests/amuxDecisionMakerBody.test.mjs pins.
 */
const EVENT_WRITE_BOUNDARIES = {
  assign_discarded: "decisionMakerAssignmentDiscard",
  transmit_intent: "decisionMakerTransmitIntent",
  transmit_receipt: "decisionMakerTransmitOutcome",
  transmit_unknown: "decisionMakerTransmitOutcome",
  result_unknown: "decisionMakerResultUnknown",
  stale_close: "decisionMakerStaleClose",
  cleanup_unknown: "decisionMakerCleanupUnknown",
};

test("stage S2's internal routes run each ledger operation in a boundary of its own name and isolation", async () => {
  assert.deepEqual(
    Object.fromEntries(
      [
        "decisionMakerAssignmentDiscard",
        "decisionMakerTransmitIntent",
        "decisionMakerTransmitOutcome",
        "decisionMakerResultUnknown",
        "decisionMakerCleanupUnknown",
      ].map((name) => [name, { operation: AMUX_DB_BOUNDARIES[name].operation, isolation: AMUX_DB_BOUNDARIES[name].isolation }]),
    ),
    {
      decisionMakerAssignmentDiscard: { operation: "decision_maker_assignment_discard", isolation: "mutation" },
      decisionMakerTransmitIntent: { operation: "decision_maker_transmit_intent", isolation: "mutation" },
      decisionMakerTransmitOutcome: { operation: "decision_maker_transmit_outcome", isolation: "mutation" },
      decisionMakerResultUnknown: { operation: "decision_maker_result_unknown", isolation: "mutation" },
      decisionMakerCleanupUnknown: { operation: "decision_maker_cleanup_unknown", isolation: "mutation" },
    },
  );
  // §9's lookup writes nothing: its one state read, plus setup and fence, in a read boundary.
  // A ceiling below it refuses every lookup; one above it lets a statement the tests here never
  // counted run inside the budget.
  const { tx, sent } = recordingTx({ state: STATES.terminal });
  await lookupDecisionMakerResult(tx, { requestId: REQUEST_ID, resultDigest: DIGEST_C });
  assert.equal(sent.length, 1);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerResultLookupRead, {
    operation: "decision_maker_result_lookup_read",
    prismaCallCeiling: sent.length + BOUNDARY_STATEMENTS,
    isolation: "read",
  });
});

const kindsOf = (sent) => sent.map((statement) => statement.kind);
const auditOf = (sent) => sent.find((statement) => statement.kind === "create").data;
const LOCK = /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/;
// The routing's throughput statement carries the instance's result kinds since its boundary (2026-10-17).
const RESULT_KINDS_IN_LOAD = /ARRAY\(\s+SELECT ev\."resultKind"\s+FROM "AmuxDecisionMakerRequestEvent" ev\s+WHERE ev\."kind" = 'result'\s+AND ev\."instance" = \$\s+AND ev\."createdAt" >= 'epoch'::timestamptz \+ \$ \* INTERVAL '1 millisecond'\s+ORDER BY ev\."sequence" DESC\s+LIMIT \$\s+\) AS "resultKinds"/;
// Since stage S2-2a3 the routing's throughput statement and the intent's latch read also carry the
// database clock of the instance's newest cleanup report, whatever its age.
const NEWEST_REPORT_IN_READ = /\(\s+SELECT floor\(extract\(epoch FROM max\(c\."createdAt"\)\) \* 1000\)::bigint\s+FROM "AmuxDecisionMakerRequestEvent" c\s+WHERE c\."kind" = 'cleanup_unknown'\s+AND c\."instance" = \$\s+\) AS "newestCleanupUnknownAtEpochMs"/;
// §5's latch check reads that clock alone.
const CLEANUP_REPORT_READ = /^\s+SELECT floor\(extract\(epoch FROM max\(c\."createdAt"\)\) \* 1000\)::bigint AS "newestCleanupUnknownAtEpochMs"\s+FROM "AmuxDecisionMakerRequestEvent" c\s+WHERE c\."kind" = 'cleanup_unknown'\s+AND c\."instance" = \$\s+$/;
// The ledger's switch read (since 2026-10-17 with each scope's newest actor and clock).
// Since stage S2-2a3 it also carries each scope's newest system cleanup latch, the one event that settles
// a cleanup report (review r-20261017-115136-888d76).
const SWITCH_READ = /SELECT DISTINCT ON \("scope"\)\s+"scope", "value", "actorKind",\s+floor\(extract\(epoch FROM "createdAt"\) \* 1000\)::bigint AS "createdAtEpochMs",\s+floor\(extract\(epoch FROM max\("createdAt"\) FILTER \(\s+WHERE "reasonCode" = 'cleanup_latch' AND "actorKind" = 'system'\s+\) OVER \(PARTITION BY "scope"\)\) \* 1000\)::bigint AS "newestCleanupLatchAtEpochMs"\s+FROM "AmuxDecisionMakerSwitchEvent"/;

test("the reads are one statement each", async () => {
  {
    const { tx, sent } = recordingTx({ cleanupAt: BigInt(NOW - 3) });
    assert.deepEqual(await readDecisionMakerInstanceLoad(tx, { instance: OPENAI, sinceMs: NOW - 5 }), {
      lastHour: 3,
      lastDay: 7,
      resultKindsNewestFirst: [],
      newestCleanupUnknownAtMs: NOW - 3,
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, /WHERE r\."route" = 'dm_proposal'\s+AND r\."instance" = \$/);
    // The throughput and, in the same statement, the instance's newest result kinds since the boundary
    // and its newest cleanup report.
    assert.match(sent[0].sql, RESULT_KINDS_IN_LOAD);
    assert.match(sent[0].sql, NEWEST_REPORT_IN_READ);
    assert.deepEqual(sent[0].values, [OPENAI, OPENAI, NOW - 5, DM_VALIDATION_LATCH_WINDOW, OPENAI]);
  }
  {
    // The intent's latch inputs: the same two, in one statement without the throughput.
    const { tx, sent } = recordingTx({ resultKinds: ["validation_failure"], cleanupAt: null });
    assert.deepEqual(await readDecisionMakerInstanceLatchInputs(tx, { instance: OPENAI, sinceMs: NOW - 5 }), {
      resultKindsNewestFirst: ["validation_failure"],
      newestCleanupUnknownAtMs: null,
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, RESULT_KINDS_IN_LOAD);
    assert.match(sent[0].sql, NEWEST_REPORT_IN_READ);
    assert.doesNotMatch(sent[0].sql, /count\(\*\)/);
    assert.deepEqual(sent[0].values, [OPENAI, NOW - 5, DM_VALIDATION_LATCH_WINDOW, OPENAI]);
  }
  {
    // §5's latch check: the newest report alone.
    const { tx, sent } = recordingTx({ cleanupAt: 7n });
    assert.equal(await readDecisionMakerInstanceNewestCleanupUnknown(tx, { instance: OPENAI }), 7);
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, CLEANUP_REPORT_READ);
    assert.deepEqual(sent[0].values, [OPENAI]);
  }
  // A report clock the read could not have produced -- a missing column included -- is unreadable.
  for (const cleanupAt of [-1n, "soon", MISSING_COLUMN, 1.5]) {
    for (const read of [
      (tx) => readDecisionMakerInstanceNewestCleanupUnknown(tx, { instance: OPENAI }),
      (tx) => readDecisionMakerInstanceLatchInputs(tx, { instance: OPENAI, sinceMs: null }),
      (tx) => readDecisionMakerInstanceLoad(tx, { instance: OPENAI, sinceMs: null }),
    ]) {
      const { tx } = recordingTx({ cleanupAt });
      await assert.rejects(read(tx), (error) => error instanceof DecisionMakerRequestWriteError && error.code === "state_unreadable", String(cleanupAt));
    }
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
      // The throughput statement carries the instance's result kinds since its newest switch event (§8)
      // and its newest cleanup report (§5, stage S2-2a3).
      assert.deepEqual(sent[3].values, [OPENAI, OPENAI, NOW - 60_000, DM_VALIDATION_LATCH_WINDOW, OPENAI]);
      assert.match(sent[3].sql, NEWEST_REPORT_IN_READ);
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
          // §8 (2026-10-17): the instance's results since its newest switch event, for an owed latch.
          resultRead: true,
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
        {
          // §5 (stage S2-2a3), on a request already closed: a report is a fact whatever happened since.
          name: "cleanup_unknown",
          row: STATES.staleClosed,
          run: (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI }),
          action: "amux.decision.cleanup_unknown",
          actor: "amux-decision-maker-openai",
          values: [OPENAI, null, null, null, null, null, null, null, null],
        },
      ];
      for (const entry of cases) {
        const { tx, sent } = recordingTx({ state: entry.row, switches: entry.switches });
        const lease = leases();
        const result = await entry.run(tx, lease.requireLeaseAt);
        // 6 (7) without a switch read, 7 (8) with one, 8 (9) with the intent's result read too;
        // 11 at most with the boundary.
        const expected = (entry.switchRead ? 7 : 6) + (entry.resultRead ? 1 : 0) + extra;
        assert.equal(sent.length, expected, entry.name);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12, entry.name);
        // The retention sweep closes stale requests, and stage S2's internal
        // routes write the bridge's and the broker's events, each in its own
        // boundary: this write at its largest, with an integrity key, plus
        // setup and fence.
        const routeBoundary = EVENT_WRITE_BOUNDARIES[entry.name];
        if (routeBoundary) {
          const ceiling = AMUX_DB_BOUNDARIES[routeBoundary].prismaCallCeiling;
          assert.ok(sent.length + BOUNDARY_STATEMENTS <= ceiling, entry.name);
          if (extra > 0) assert.equal(sent.length + BOUNDARY_STATEMENTS, ceiling, entry.name);
        }
        assert.deepEqual(
          kindsOf(sent),
          ["execute", "query", ...(entry.switchRead ? ["query"] : []), ...(entry.resultRead ? ["query"] : []), ...auditKinds, "query"],
          entry.name,
        );
        assert.match(sent[0].sql, LOCK, entry.name);
        assert.match(sent[1].sql, /CROSS JOIN LATERAL/, entry.name);
        // The switches are read after the lock, by the switch store's reader.
        if (entry.switchRead) assert.match(sent[2].sql, SWITCH_READ, entry.name);
        else assert.ok(!sent.some((statement) => SWITCH_READ.test(statement.sql)), entry.name);
        if (entry.resultRead) {
          // The results since the newest switch event and, since stage S2-2a3, the newest cleanup report.
          assert.match(sent[3].sql, RESULT_KINDS, entry.name);
          assert.match(sent[3].sql, NEWEST_REPORT_IN_READ, entry.name);
          assert.deepEqual(sent[3].values, [OPENAI, NOW - 60_000, DM_VALIDATION_LATCH_WINDOW, OPENAI], entry.name);
        }
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
    // §5 (stage S2-2a3): a report sent again returns the one recorded and writes nothing; another
    // instance is refused before the recorded one is looked at.
    [
      "cleanup reported again",
      STATES.cleanupReported,
      2,
      (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI }),
      { status: "existing", eventId: CLEANUP_EVENT_ID, createdAt: new Date(NOW - 1_000).toISOString() },
    ],
    [
      "cleanup from the other instance",
      STATES.cleanupReported,
      2,
      (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: "decision-maker-anthropic" }),
      { status: "refused", reason: "instance_mismatch" },
    ],
    [
      "cleanup before the assignment",
      STATES.fresh,
      2,
      (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI }),
      { status: "refused", reason: "not_assigned" },
    ],
    [
      "cleanup of an operator's request",
      STATES.operator,
      2,
      (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI }),
      { status: "refused", reason: "not_assigned" },
    ],
    ["cleanup unknown request", null, 2, (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI }), { status: "refused", reason: "unknown_request" }],
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
  // The routing, the intent, the result, §8's latch check and §5's.
  assert.equal((store.match(/await readSwitchesForWrite\(tx\)/g) ?? []).length, 5);
  assert.equal((store.match(/await readDecisionMakerSwitchesWithBoundariesOrThrow\(tx\)/g) ?? []).length, 1);
  assert.doesNotMatch(store, /readDecisionMakerSwitchesOrThrow/);
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
    (tx) => readDecisionMakerInstanceLoad(tx, { instance: "decision-maker-gemini", sinceMs: null }),
    (tx) => readDecisionMakerInstanceLoad(tx, { instance: OPENAI, sinceMs: -1 }),
    (tx) => readDecisionMakerRequestState(tx, REQUEST_ID, "x"),
    (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: "not-a-uuid", instance: OPENAI }),
    (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: "decision-maker-gemini" }),
    (tx) => recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID }),
    (tx) => recordDecisionMakerCleanupLatch(tx, { instance: "kill_switch" }),
    (tx) => readDecisionMakerInstanceLatchInputs(tx, { instance: OPENAI, sinceMs: -1 }),
    (tx) => readDecisionMakerInstanceLatchInputs(tx, { instance: "decision-maker-gemini", sinceMs: null }),
    (tx) => readDecisionMakerInstanceNewestCleanupUnknown(tx, { instance: "kill_switch" }),
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

// ---------------------------------------------------------------------------
// The two latches (§5, §8), added 2026-10-17
// ---------------------------------------------------------------------------

const FAILURE = "validation_failure";
const HUMAN_EVENT = { actorKind: "human" };
const SYSTEM_EVENT = { actorKind: "system" };
const latchFor = (kinds, newestEvent = HUMAN_EVENT) =>
  dmValidationLatchDecision({ newestEvent, resultKindsNewestFirst: kinds });

test("§8: three validation failures in a row latch, and any other terminal result breaks the run", () => {
  assert.equal(DM_VALIDATION_LATCH_THRESHOLD, 3);
  assert.equal(DM_VALIDATION_LATCH_WINDOW, 100);
  assert.deepEqual(latchFor([FAILURE, FAILURE, FAILURE]), { latch: true });
  assert.deepEqual(latchFor([FAILURE, FAILURE, FAILURE, FAILURE]), { latch: true });
  // With no switch event at all every result counts.
  assert.deepEqual(latchFor([FAILURE, FAILURE, FAILURE], null), { latch: true });
  assert.deepEqual(latchFor([FAILURE, FAILURE]), { latch: false, reason: "no_streak" });
  assert.deepEqual(latchFor([]), { latch: false, reason: "no_streak" });
  for (const other of DM_RESULT_KINDS.filter((kind) => kind !== FAILURE)) {
    assert.deepEqual(latchFor([FAILURE, FAILURE, other, FAILURE]), { latch: false, reason: "no_streak" }, other);
    assert.deepEqual(latchFor([FAILURE, other, FAILURE, FAILURE]), { latch: false, reason: "no_streak" }, other);
    assert.deepEqual(latchFor([other, other, other]), { latch: false, reason: "no_streak" }, other);
  }
});

test("§8: a run anywhere since the instance's newest switch event is owed, but never latched twice", () => {
  // A later result does not cancel a latch whose write failed after the third failure.
  assert.deepEqual(latchFor(["proposal", "escalate", FAILURE, FAILURE, FAILURE, "proposal"]), { latch: true });
  // The instance's newest event is a latch that nobody has released: nothing is due, however long the run.
  assert.deepEqual(latchFor([FAILURE, FAILURE, FAILURE, FAILURE, FAILURE, FAILURE], SYSTEM_EVENT), {
    latch: false,
    reason: "already_latched",
  });
  assert.deepEqual(latchFor([], SYSTEM_EVENT), { latch: false, reason: "already_latched" });
});

test("§8: a result kind the ledger cannot hold is unreadable, latched or not", () => {
  for (const bad of ["autonomous", "Validation_failure", "", null, undefined, 3, {}]) {
    assert.equal(latchFor([FAILURE, FAILURE, bad]), null, String(bad));
    assert.equal(latchFor([bad], SYSTEM_EVENT), null, String(bad));
  }
});

test("§8: an owed latch is the instance off for a routing and an intent; nothing else changes", () => {
  const proposing = { killSwitch: false, instanceMode: "proposal" };
  assert.deepEqual(dmSwitchInputWithOwedLatch(proposing, true), { killSwitch: false, instanceMode: "off" });
  assert.equal(dmSwitchInputWithOwedLatch(proposing, false), proposing);
  // The kill switch is the kill switch's; an unreadable mode stays unreadable (the router refuses it as such).
  assert.deepEqual(dmSwitchInputWithOwedLatch({ killSwitch: true, instanceMode: "proposal" }, true), { killSwitch: true, instanceMode: "off" });
  assert.deepEqual(dmSwitchInputWithOwedLatch({ killSwitch: null, instanceMode: null }, true), { killSwitch: null, instanceMode: null });
  assert.deepEqual(dmTransmitSwitchRefusal(dmSwitchInputWithOwedLatch(proposing, true)), "instance_off");
});
const RESULT_KINDS = /SELECT ev\."resultKind"\s+FROM "AmuxDecisionMakerRequestEvent" ev\s+WHERE ev\."kind" = 'result'\s+AND ev\."instance" = \$\s+AND ev\."createdAt" >= 'epoch'::timestamptz \+ \$ \* INTERVAL '1 millisecond'\s+ORDER BY ev\."sequence" DESC\s+LIMIT \$/;

test("an instance's results since a boundary are one bounded statement, newest first", async () => {
  {
    const { tx, sent } = recordingTx({ resultKinds: [FAILURE, "proposal"] });
    assert.deepEqual(await readDecisionMakerInstanceResultKinds(tx, { instance: OPENAI, sinceMs: NOW - 5 }), [FAILURE, "proposal"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, RESULT_KINDS);
    assert.deepEqual(sent[0].values, [OPENAI, NOW - 5, DM_VALIDATION_LATCH_WINDOW]);
  }
  {
    // No boundary is the epoch: every result counts.
    const { tx, sent } = recordingTx();
    await readDecisionMakerInstanceResultKinds(tx, { instance: OPENAI, sinceMs: null });
    assert.deepEqual(sent[0].values, [OPENAI, 0, DM_VALIDATION_LATCH_WINDOW]);
  }
  for (const input of [
    { instance: "kill_switch", sinceMs: 0 },
    { instance: OPENAI, sinceMs: -1 },
    { instance: OPENAI, sinceMs: 1.5 },
    { instance: OPENAI, sinceMs: "0" },
  ]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      readDecisionMakerInstanceResultKinds(tx, input),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "invalid_input",
      JSON.stringify(input),
    );
    assert.equal(sent.length, 0);
  }
});

for (const [label, key] of [
  ["without", null],
  ["with", "unit-test-integrity-key"],
]) {
  const extra = key === null ? 0 : WITH_KEY;
  const auditKinds = key === null ? ["execute", "query", "create"] : ["execute", "query", "findFirst", "create"];

  test(`§8's latch check sends 3 statements when nothing is due and ${7 + extra} when it latches, ${label} an integrity key`, async () => {
    await withIntegrityKey(key, async () => {
      // Due: the lock, the switches with each instance's newest event, the results since it, then the latch under the instance's actor.
      const due = recordingTx({ resultKinds: ["proposal", FAILURE, FAILURE, FAILURE] });
      const latched = await recordDecisionMakerValidationLatch(due.tx, { instance: "decision-maker-anthropic" });
      assert.equal(due.sent.length, 7 + extra);
      assert.ok(due.sent.length + BOUNDARY_STATEMENTS <= 12);
      assert.deepEqual(kindsOf(due.sent), ["execute", "query", "query", ...auditKinds, "query"]);
      assert.match(due.sent[0].sql, LOCK);
      assert.match(due.sent[1].sql, SWITCH_READ);
      assert.match(due.sent[2].sql, RESULT_KINDS);
      // The results are counted from the newest switch event's database clock.
      assert.deepEqual(due.sent[2].values, ["decision-maker-anthropic", NOW - 60_000, DM_VALIDATION_LATCH_WINDOW]);
      const audit = auditOf(due.sent);
      assert.equal(audit.action, "amux.decision.latch");
      assert.equal(audit.targetType, "AmuxDecisionMakerSwitchEvent");
      assert.equal(audit.actorUserId, null);
      assert.deepEqual(audit.metadata, {
        event_id: latched.event.eventId,
        scope: "decision-maker-anthropic",
        value: "off",
        reason_code: "validation_latch",
        systemActor: "amux-decision-maker-anthropic",
      });
      assert.match(due.sent.at(-1).sql, /INSERT INTO "AmuxDecisionMakerSwitchEvent"/);
      assert.deepEqual(due.sent.at(-1).values, [latched.event.eventId, "decision-maker-anthropic", "validation_latch", "audit-row-1"]);
      assert.equal(latched.latched, true);

      // Not due, or already latched: the three reads and nothing else.
      for (const [options, reason] of [
        [{ resultKinds: [FAILURE, FAILURE, "timeout", FAILURE] }, "no_streak"],
        [
          {
            switches: [
              { scope: "kill_switch", value: "off" },
              { scope: OPENAI, value: "off", actorKind: "system", createdAtEpochMs: BigInt(NOW) },
            ],
            resultKinds: [FAILURE, FAILURE, FAILURE],
          },
          "already_latched",
        ],
      ]) {
        const { tx, sent } = recordingTx(options);
        assert.deepEqual(await recordDecisionMakerValidationLatch(tx, { instance: OPENAI }), { latched: false, reason });
        assert.deepEqual(kindsOf(sent), ["execute", "query", "query"]);
        assert.ok(!sent.some((statement) => statement.kind === "create"));
      }
      // With no switch event the count starts at the epoch.
      const unset = recordingTx({ switches: [{ scope: "kill_switch", value: "off" }], resultKinds: [FAILURE, FAILURE, FAILURE] });
      assert.equal((await recordDecisionMakerValidationLatch(unset.tx, { instance: OPENAI })).latched, true);
      assert.deepEqual(unset.sent[2].values, [OPENAI, 0, DM_VALIDATION_LATCH_WINDOW]);
    });
  });
}

test("§8: while a latch is owed, a routing goes to the operator as instance_off, in the routing's own statements", async () => {
  const owed = [FAILURE, FAILURE, FAILURE];
  const routing = recordingTx({ resultKinds: owed });
  const routed = await recordDecisionMakerRequest(routing.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING });
  assert.deepEqual([routed.route, routed.instance, routed.refusalCodes], ["operator", OPENAI, ["instance_off"]]);
  // Nothing more than any routing: the result kinds ride in the throughput statement.
  assert.deepEqual(kindsOf(routing.sent).slice(0, 4), ["execute", "query", "query", "query"]);
  assert.match(routing.sent[3].sql, RESULT_KINDS_IN_LOAD);
  // A run broken later is still owed; a run that is not three is not.
  for (const [resultKinds, switches, route] of [
    [["proposal", FAILURE, FAILURE, FAILURE], undefined, "operator"],
    [[FAILURE, FAILURE, "proposal", FAILURE], undefined, "dm_proposal"],
  ]) {
    const { tx } = recordingTx({ resultKinds, switches });
    assert.equal((await recordDecisionMakerRequest(tx, { binding: routingBinding(), card: routedCard(), keyRing: RING })).route, route);
  }
  // A result kind the ledger could not hold writes nothing.
  const unreadable = recordingTx({ resultKinds: [FAILURE, "autonomous"] });
  await assert.rejects(
    recordDecisionMakerRequest(unreadable.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING }),
    (error) => error instanceof DecisionMakerRequestWriteError && error.code === "state_unreadable",
  );
  assert.ok(!unreadable.sent.some((statement) => statement.kind === "create"));
});

for (const [label, key] of [
  ["without", null],
  ["with", "unit-test-integrity-key"],
]) {
  const extra = key === null ? 0 : WITH_KEY;
  const auditKinds = key === null ? ["execute", "query", "create"] : ["execute", "query", "findFirst", "create"];
  test(`§8: while a latch is owed, an intent is refused as instance_off and writes the latch, in ${8 + extra} statements ${label} an integrity key`, async () => {
    await withIntegrityKey(key, async () => {
      const lease = leases();
      const { tx, sent } = recordingTx({ state: STATES.assigned, resultKinds: [FAILURE, FAILURE, FAILURE] });
      const refused = await recordDecisionMakerTransmitIntent(tx, {
        requestId: REQUEST_ID,
        instance: OPENAI,
        transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
        requireLeaseAt: lease.requireLeaseAt,
      });
      assert.equal(sent.length, 8 + extra);
      assert.ok(sent.length + BOUNDARY_STATEMENTS <= AMUX_DB_BOUNDARIES.decisionMakerTransmitIntent.prismaCallCeiling);
      assert.deepEqual(kindsOf(sent), ["execute", "query", "query", "query", ...auditKinds, "query"]);
      assert.match(sent[2].sql, SWITCH_READ);
      assert.match(sent[3].sql, RESULT_KINDS);
      // No intent: the one write is the owed latch, under the instance's own actor.
      assert.ok(!sent.some((statement) => statement.sql?.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"')));
      assert.match(sent.at(-1).sql, /INSERT INTO "AmuxDecisionMakerSwitchEvent"/);
      const audit = auditOf(sent);
      assert.equal(audit.action, "amux.decision.latch");
      assert.equal(audit.metadata.reason_code, "validation_latch");
      assert.equal(audit.metadata.systemActor, "amux-decision-maker-openai");
      assert.equal(refused.recorded, false);
      assert.equal(refused.reason, "instance_off");
      assert.equal(refused.latch?.eventId, audit.metadata.event_id);
      assert.deepEqual(lease.seen, []);
    });
  });
}

test("§8's latch check stops at a switch event or a result it cannot read, writing nothing", async () => {
  {
    const { tx, sent } = recordingTx({ failSwitchRead: true });
    await assert.rejects(
      recordDecisionMakerValidationLatch(tx, { instance: OPENAI }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "settings_unreadable",
    );
    assert.deepEqual(kindsOf(sent), ["execute", "query"]);
  }
  {
    const { tx, sent } = recordingTx({ switches: [{ scope: OPENAI, value: "proposal", actorKind: "operator" }] });
    await assert.rejects(
      recordDecisionMakerValidationLatch(tx, { instance: OPENAI }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "settings_unreadable",
    );
    assert.deepEqual(kindsOf(sent), ["execute", "query"]);
  }
  {
    const { tx, sent } = recordingTx({ resultKinds: [FAILURE, FAILURE, "autonomous"] });
    await assert.rejects(
      recordDecisionMakerValidationLatch(tx, { instance: OPENAI }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "state_unreadable",
    );
    assert.deepEqual(kindsOf(sent), ["execute", "query", "query"]);
  }
  {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      recordDecisionMakerValidationLatch(tx, { instance: "kill_switch" }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "invalid_input",
    );
    assert.equal(sent.length, 0);
  }
});

test("the latch check runs in a boundary of its own: the check at its largest, with an integrity key, plus setup and fence", async () => {
  // A ceiling below the count refuses every call; one above it lets a statement the tests here never counted run.
  const largest = await withIntegrityKey("unit-test-integrity-key", async () => {
    const due = recordingTx({ resultKinds: [FAILURE, FAILURE, FAILURE] });
    await recordDecisionMakerValidationLatch(due.tx, { instance: OPENAI });
    return due.sent.length;
  });
  assert.equal(largest, 8);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerValidationLatch, {
    operation: "decision_maker_validation_latch",
    prismaCallCeiling: largest + BOUNDARY_STATEMENTS,
    isolation: "mutation",
  });
  // Within docs/policy/amux-decision-maker.md §9's 12.
  assert.ok(AMUX_DB_BOUNDARIES.decisionMakerValidationLatch.prismaCallCeiling <= 12);
});

// ---------------------------------------------------------------------------
// §5's cleanup report and latch (stage S2-2a3)
// ---------------------------------------------------------------------------

test("§5: a report is owed until a cleanup latch at or after it; nothing else settles it", () => {
  const decide = (cleanupLatchedAtMs, newestCleanupUnknownAtMs) => dmCleanupLatchDecision({ cleanupLatchedAtMs, newestCleanupUnknownAtMs });
  assert.deepEqual(decide(null, null), { latch: false, reason: "no_cleanup_unknown" });
  assert.deepEqual(decide(NOW, null), { latch: false, reason: "no_cleanup_unknown" });
  // With no cleanup latch at all any report is owed -- whatever a person changed since
  // (review r-20261017-115136-888d76): the person's changes are not an input.
  assert.deepEqual(decide(null, NOW), { latch: true });
  // A cleanup latch from before the report is an earlier report's.
  assert.deepEqual(decide(NOW - 1, NOW), { latch: true });
  // Its own latch settles it, including one in the report's own millisecond, so the same report sent
  // again -- or after the operator released that latch -- never latches twice.
  assert.deepEqual(decide(NOW + 1, NOW), { latch: false, reason: "latched" });
  assert.deepEqual(decide(NOW, NOW), { latch: false, reason: "latched" });
  for (const bad of [-1, 1.5, "1", 1n, undefined, {}]) {
    assert.equal(decide(null, bad), null, `report ${String(bad)}`);
    assert.equal(decide(bad, NOW), null, `latch ${String(bad)}`);
  }
});

test("§5 before §8: the latch an owed report holds the instance off for comes first", () => {
  const person = { actorKind: "human", createdAtMs: NOW - 10 };
  const latched = { actorKind: "system", createdAtMs: NOW - 10 };
  const owed = (resultKindsNewestFirst, newestCleanupUnknownAtMs, newestEvent = person, cleanupLatchedAtMs = null) =>
    dmOwedLatchReason({ newestEvent, cleanupLatchedAtMs, resultKindsNewestFirst, newestCleanupUnknownAtMs });
  assert.deepEqual(owed([], null), { reason: null });
  assert.deepEqual(owed([FAILURE, FAILURE, FAILURE], null), { reason: "validation_latch" });
  assert.deepEqual(owed([], NOW), { reason: "cleanup_latch" });
  assert.deepEqual(owed([FAILURE, FAILURE, FAILURE], NOW), { reason: "cleanup_latch" });
  // A report from before a person's newest change is still owed (review r-20261017-115136-888d76).
  assert.deepEqual(owed([], NOW - 20), { reason: "cleanup_latch" });
  // One its own cleanup latch followed owes nothing.
  assert.deepEqual(owed([], NOW - 20, latched, NOW - 10), { reason: null });
  // Latched already for §8: the run is not owed again, a report the latch did not follow is.
  assert.deepEqual(owed([FAILURE, FAILURE, FAILURE], null, latched), { reason: null });
  assert.deepEqual(owed([FAILURE, FAILURE, FAILURE], NOW, latched), { reason: "cleanup_latch" });
  // Either input unreadable is unreadable.
  assert.equal(owed([FAILURE, "autonomous"], null), null);
  assert.equal(owed([], "soon"), null);
  assert.equal(owed([], NOW, person, "soon"), null);
});

for (const [label, key] of [
  ["without", null],
  ["with", "unit-test-integrity-key"],
]) {
  const extra = key === null ? 0 : WITH_KEY;
  const auditKinds = key === null ? ["execute", "query", "create"] : ["execute", "query", "findFirst", "create"];

  test(`§5's latch check sends 3 statements when nothing is due and ${7 + extra} when it latches, ${label} an integrity key`, async () => {
    await withIntegrityKey(key, async () => {
      // Due: the lock, the switches with each instance's newest event, the newest report, then the latch.
      const due = recordingTx({ cleanupAt: BigInt(NOW - 1) });
      const latched = await recordDecisionMakerCleanupLatch(due.tx, { instance: "decision-maker-anthropic" });
      assert.equal(due.sent.length, 7 + extra);
      assert.ok(due.sent.length + BOUNDARY_STATEMENTS <= AMUX_DB_BOUNDARIES.decisionMakerCleanupLatch.prismaCallCeiling);
      assert.deepEqual(kindsOf(due.sent), ["execute", "query", "query", ...auditKinds, "query"]);
      assert.match(due.sent[0].sql, LOCK);
      assert.match(due.sent[1].sql, SWITCH_READ);
      assert.match(due.sent[2].sql, CLEANUP_REPORT_READ);
      assert.deepEqual(due.sent[2].values, ["decision-maker-anthropic"]);
      const audit = auditOf(due.sent);
      assert.equal(audit.action, "amux.decision.latch");
      assert.equal(audit.targetType, "AmuxDecisionMakerSwitchEvent");
      assert.equal(audit.actorUserId, null);
      assert.deepEqual(audit.metadata, {
        event_id: latched.event.eventId,
        scope: "decision-maker-anthropic",
        value: "off",
        reason_code: "cleanup_latch",
        systemActor: "amux-decision-maker-anthropic",
      });
      assert.match(due.sent.at(-1).sql, /INSERT INTO "AmuxDecisionMakerSwitchEvent"/);
      assert.deepEqual(due.sent.at(-1).values, [latched.event.eventId, "decision-maker-anthropic", "cleanup_latch", "audit-row-1"]);
      assert.equal(latched.latched, true);

      // Not due: no report, or one its own cleanup latch followed -- that latch standing, in the report's
      // own millisecond, or released by a person since.
      for (const [options, reason] of [
        [{}, "no_cleanup_unknown"],
        [
          {
            switches: [
              { scope: "kill_switch", value: "off" },
              { scope: OPENAI, value: "off", actorKind: "system", createdAtEpochMs: BigInt(NOW), newestCleanupLatchAtEpochMs: BigInt(NOW) },
            ],
            cleanupAt: BigInt(NOW),
          },
          "latched",
        ],
        [
          {
            switches: [
              { scope: "kill_switch", value: "off" },
              { scope: OPENAI, value: "proposal", actorKind: "human", createdAtEpochMs: BigInt(NOW), newestCleanupLatchAtEpochMs: BigInt(NOW - 10) },
            ],
            cleanupAt: BigInt(NOW - 20),
          },
          "latched",
        ],
      ]) {
        const { tx, sent } = recordingTx(options);
        assert.deepEqual(await recordDecisionMakerCleanupLatch(tx, { instance: OPENAI }), { latched: false, reason }, reason);
        assert.deepEqual(kindsOf(sent), ["execute", "query", "query"]);
        assert.ok(!sent.some((statement) => statement.kind === "create"));
      }
      // A latch of another cause does not settle a later report; the kill switch decides nothing.
      const over = recordingTx({
        switches: [
          { scope: "kill_switch", value: "on" },
          { scope: OPENAI, value: "off", actorKind: "system", createdAtEpochMs: BigInt(NOW - 5) },
        ],
        cleanupAt: BigInt(NOW),
      });
      assert.equal((await recordDecisionMakerCleanupLatch(over.tx, { instance: OPENAI })).latched, true);
    });
  });

  test(`§5: a report is recorded in ${6 + extra} statements ${label} an integrity key, and the boundary is that at its largest plus setup and fence`, async () => {
    await withIntegrityKey(key, async () => {
      const { tx, sent } = recordingTx({ state: STATES.assigned });
      const written = await recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI });
      assert.equal(written.status, "recorded");
      assert.equal(sent.length, 6 + extra);
      if (extra > 0) assert.equal(sent.length + BOUNDARY_STATEMENTS, AMUX_DB_BOUNDARIES.decisionMakerCleanupUnknown.prismaCallCeiling);
      // No switch read: a report is accepted under the kill switch.
      assert.ok(!sent.some((statement) => SWITCH_READ.test(statement.sql)));
      assert.equal(auditOf(sent).metadata.kind, "cleanup_unknown");
    });
  });

  test(`§5: while a report's latch is owed, an intent is refused as instance_off and writes it, in ${8 + extra} statements ${label} an integrity key`, async () => {
    await withIntegrityKey(key, async () => {
      // Owed alone, and owed beside a validation run: the report's latch either way.
      for (const resultKinds of [[], [FAILURE, FAILURE, FAILURE]]) {
        const lease = leases();
        const { tx, sent } = recordingTx({ state: STATES.assigned, cleanupAt: BigInt(NOW - 1), resultKinds });
        const refused = await recordDecisionMakerTransmitIntent(tx, {
          requestId: REQUEST_ID,
          instance: OPENAI,
          transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
          requireLeaseAt: lease.requireLeaseAt,
        });
        assert.equal(sent.length, 8 + extra);
        assert.deepEqual(kindsOf(sent), ["execute", "query", "query", "query", ...auditKinds, "query"]);
        assert.match(sent[3].sql, NEWEST_REPORT_IN_READ);
        assert.ok(!sent.some((statement) => statement.sql?.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"')));
        const audit = auditOf(sent);
        assert.equal(audit.metadata.reason_code, "cleanup_latch");
        assert.equal(audit.metadata.systemActor, "amux-decision-maker-openai");
        assert.deepEqual([refused.recorded, refused.reason, refused.latch?.eventId], [false, "instance_off", audit.metadata.event_id]);
        assert.deepEqual(lease.seen, []);
      }
    });
  });
}

test("§5: while a report's latch is owed, a routing goes to the operator as instance_off; a settled report holds nothing", async () => {
  const owed = recordingTx({ cleanupAt: BigInt(NOW - 1) });
  const routed = await recordDecisionMakerRequest(owed.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING });
  assert.deepEqual([routed.route, routed.instance, routed.refusalCodes], ["operator", OPENAI, ["instance_off"]]);
  // Nothing more than any routing: the report rides in the throughput statement.
  assert.deepEqual(kindsOf(owed.sent).slice(0, 4), ["execute", "query", "query", "query"]);
  // Its own cleanup latch followed it, and a person released that latch: nothing is held.
  const settled = recordingTx({
    switches: [
      { scope: "kill_switch", value: "off" },
      { scope: OPENAI, value: "proposal", actorKind: "human", createdAtEpochMs: BigInt(NOW), newestCleanupLatchAtEpochMs: BigInt(NOW - 1) },
    ],
    cleanupAt: BigInt(NOW - 1),
  });
  assert.equal((await recordDecisionMakerRequest(settled.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING })).route, "dm_proposal");
  // Another instance is not held by it.
  const other = recordingTx({ cleanupAt: BigInt(NOW - 1) });
  const codex = await recordDecisionMakerRequest(other.tx, { binding: routingBinding({ askingProvider: "codex" }), card: routedCard(), keyRing: RING });
  assert.deepEqual(other.sent[3].values.at(-1), "decision-maker-anthropic");
  assert.equal(codex.instance, "decision-maker-anthropic");
});

test("§5's latch check stops at a switch event or a report clock it cannot read, writing nothing", async () => {
  {
    const { tx, sent } = recordingTx({ failSwitchRead: true });
    await assert.rejects(
      recordDecisionMakerCleanupLatch(tx, { instance: OPENAI }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "settings_unreadable",
    );
    assert.deepEqual(kindsOf(sent), ["execute", "query"]);
  }
  {
    const { tx, sent } = recordingTx({ switches: [{ scope: OPENAI, value: "proposal", actorKind: "operator" }] });
    await assert.rejects(
      recordDecisionMakerCleanupLatch(tx, { instance: OPENAI }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "settings_unreadable",
    );
    assert.deepEqual(kindsOf(sent), ["execute", "query"]);
  }
  {
    const { tx, sent } = recordingTx({ cleanupAt: "soon" });
    await assert.rejects(
      recordDecisionMakerCleanupLatch(tx, { instance: OPENAI }),
      (error) => error instanceof DecisionMakerRequestWriteError && error.code === "state_unreadable",
    );
    assert.deepEqual(kindsOf(sent), ["execute", "query", "query"]);
  }
});

test("the cleanup latch check runs in a boundary of its own: the check at its largest, with an integrity key, plus setup and fence", async () => {
  const largest = await withIntegrityKey("unit-test-integrity-key", async () => {
    const due = recordingTx({ cleanupAt: BigInt(NOW) });
    await recordDecisionMakerCleanupLatch(due.tx, { instance: OPENAI });
    return due.sent.length;
  });
  assert.equal(largest, 8);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerCleanupLatch, {
    operation: "decision_maker_cleanup_latch",
    prismaCallCeiling: largest + BOUNDARY_STATEMENTS,
    isolation: "mutation",
  });
  const report = await withIntegrityKey("unit-test-integrity-key", async () => {
    const { tx, sent } = recordingTx({ state: STATES.assigned });
    await recordDecisionMakerCleanupUnknown(tx, { requestId: REQUEST_ID, instance: OPENAI });
    return sent.length;
  });
  assert.equal(report, 7);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerCleanupUnknown, {
    operation: "decision_maker_cleanup_unknown",
    prismaCallCeiling: report + BOUNDARY_STATEMENTS,
    isolation: "mutation",
  });
  // In one transaction the report's 7, a switch read and the latch's 5 would be 15 with setup and
  // fence, over docs/policy/amux-decision-maker.md §9's 12: the latch is its own transaction, and
  // the owed latch covers the time between.
  const LATCH_WRITE_WITH_KEY = 5;
  assert.equal(report + 1 + LATCH_WRITE_WITH_KEY + BOUNDARY_STATEMENTS, 15);
  for (const name of ["decisionMakerCleanupLatch", "decisionMakerCleanupUnknown"]) {
    assert.ok(AMUX_DB_BOUNDARIES[name].prismaCallCeiling <= 12, name);
  }
});

// Review r-20261017-115136-888d76 (major): only the report's own cleanup latch settles it. A person's
// ordinary mode change after the report -- the same mode saved again, off and back to proposal -- is not
// that latch, and leaves it owed.
const AFTER_REPORT = NOW;
const REPORT_AT = NOW - 1;
/** The report at REPORT_AT; the operator saved the instance's mode at AFTER_REPORT; `latchedAt` is its newest cleanup latch. */
const savedAfterReport = (latchedAt = null, extra = {}) => ({
  switches: [
    { scope: "kill_switch", value: "off" },
    { scope: OPENAI, value: "proposal", actorKind: "human", createdAtEpochMs: BigInt(AFTER_REPORT), newestCleanupLatchAtEpochMs: latchedAt },
    { scope: "decision-maker-anthropic", value: "proposal" },
  ],
  cleanupAt: BigInt(REPORT_AT),
  ...extra,
});

test("§5 review r-20261017-115136-888d76: a mode saved after a report leaves its latch owed -- a routing and an intent refuse, the check latches", async () => {
  // A routing goes to the operator as instance_off.
  const routing = recordingTx(savedAfterReport());
  const routed = await recordDecisionMakerRequest(routing.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING });
  assert.deepEqual([routed.route, routed.instance, routed.refusalCodes], ["operator", OPENAI, ["instance_off"]]);

  // An intent sends nothing and writes the report's latch.
  const intent = recordingTx(savedAfterReport(null, { state: STATES.assigned }));
  const refused = await recordDecisionMakerTransmitIntent(intent.tx, {
    requestId: REQUEST_ID,
    instance: OPENAI,
    transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
    requireLeaseAt: () => assert.fail("no lease for a refused intent"),
  });
  assert.deepEqual([refused.recorded, refused.reason], [false, "instance_off"]);
  assert.ok(!intent.sent.some((statement) => statement.sql?.includes('INSERT INTO "AmuxDecisionMakerRequestEvent"')));
  assert.equal(auditOf(intent.sent).metadata.reason_code, "cleanup_latch");

  // The check -- the route's or the sweep's -- writes it.
  const check = recordingTx(savedAfterReport());
  const latched = await recordDecisionMakerCleanupLatch(check.tx, { instance: OPENAI });
  assert.equal(latched.latched, true);
  assert.equal(auditOf(check.sent).metadata.reason_code, "cleanup_latch");

  // A latch of another cause after the report is not the report's own either.
  const validation = recordingTx(
    savedAfterReport(null, {
      switches: [
        { scope: "kill_switch", value: "off" },
        { scope: OPENAI, value: "off", actorKind: "system", createdAtEpochMs: BigInt(AFTER_REPORT), newestCleanupLatchAtEpochMs: null },
      ],
    }),
  );
  assert.equal((await recordDecisionMakerCleanupLatch(validation.tx, { instance: OPENAI })).latched, true);
});

test("§5 review r-20261017-115136-888d76: the report's own latch settles it, and a release after that latch reopens nothing", async () => {
  // The report's latch at the report's millisecond or after it, then a person's release: nothing is owed,
  // so a routing reaches the DM and a resend's check latches nothing.
  for (const latchedAt of [BigInt(REPORT_AT), BigInt(REPORT_AT + 1)]) {
    const routing = recordingTx(savedAfterReport(latchedAt));
    assert.equal((await recordDecisionMakerRequest(routing.tx, { binding: routingBinding(), card: routedCard(), keyRing: RING })).route, "dm_proposal");
    const check = recordingTx(savedAfterReport(latchedAt));
    assert.deepEqual(await recordDecisionMakerCleanupLatch(check.tx, { instance: OPENAI }), { latched: false, reason: "latched" });
    assert.deepEqual(kindsOf(check.sent), ["execute", "query", "query"]);
  }
  // A cleanup latch from before the report is an earlier report's: this one is owed.
  const earlier = recordingTx(savedAfterReport(BigInt(REPORT_AT - 1)));
  assert.equal((await recordDecisionMakerCleanupLatch(earlier.tx, { instance: OPENAI })).latched, true);
});
