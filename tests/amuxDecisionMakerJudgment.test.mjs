// AMUX Decision Maker policy version 1, stage S1e: a person's judgment of a
// proposal with its declaration accuracy, the delivery records of a confirmed
// answer, section 4's report, and the S1d review's stale-close follow-up
// (docs/policy/amux-decision-maker.md §2 steps 6-7, §4, §6, §9, §10).
//
// Runs without a database: the vocabularies and their parity with the
// migrations' CHECKs, indexes and triggers, the pinned previous function
// bodies and the exact lines each replacement changes, the CHECKs held to
// IS TRUE, the pure preconditions, the delivery graph, the report's arithmetic,
// the one-writer rule, and the exact statements each store operation sends
// (§9's statement budget), counted on a recording transaction. What the
// database itself refuses is exercised against PostgreSQL in
// tests/integration/amux-decision-maker-judgment.db.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { DM_OPTION_ID_PATTERN } from "../lib/amux/decisionMakerCore.ts";
import {
  dmBodyDigest,
  dmDigestKeyCheck,
  dmKeyPeriodOf,
  dmProposalForJudgmentFromRow,
  dmRequestDigestKey,
} from "../lib/amux/decisionMakerBodyCore.ts";
import {
  DM_CONFIRMING_JUDGMENT_KINDS,
  DM_DECLARATION_ACCURACIES,
  DM_DECLARATION_ITEMS,
  DM_DEFAULT_DECLARATION_ACCURACY,
  DM_DELIVERY_ACTOR_KINDS,
  DM_DELIVERY_AUDIT_ACTIONS,
  DM_DELIVERY_AUDIT_METADATA_KEYS,
  DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE,
  DM_DELIVERY_EVENT_KINDS,
  DM_DELIVERY_RESOLVE_OUTCOMES,
  DM_DELIVERY_SYSTEM_EVENT_KINDS,
  DM_JUDGMENT_AUDIT_METADATA_KEYS,
  DM_JUDGMENT_AUDIT_TARGET_TYPE,
  DM_JUDGMENT_KINDS,
  DM_REPORT_DAY_MS,
  dmDeclarationAccuracyReport,
  dmDeliveryAuditMetadata,
  dmDeliveryRefusal,
  dmDeliveryStateFromRow,
  dmDeliverySwitchRefusal,
  dmJudgmentAuditAction,
  dmJudgmentAuditMetadata,
  dmJudgmentProposalRefusal,
  dmJudgmentStateRefusal,
  dmJudgmentSwitchRefusal,
  dmJudgmentTalliesFromRows,
  dmReportMetric,
  dmShownProposalMatches,
  parseDmDeclarationAccuracy,
  parseDmJudgmentInput,
  parseDmShownProposal,
} from "../lib/amux/decisionMakerJudgmentCore.ts";
import {
  DecisionMakerJudgmentWriteError,
  readDecisionMakerDeclarationAccuracyReport,
  readDecisionMakerDeliveryState,
  readDecisionMakerJudgment,
  recordDecisionMakerDelivery,
  recordDecisionMakerDeliveryOutcome,
  recordDecisionMakerJudgment,
  resolveDecisionMakerDeliveryUnknown,
} from "../lib/amux/decisionMakerJudgmentStore.ts";
import {
  DM_ASSIGNMENT_WINDOW_MS,
  DM_CLOSING_EVENT_KINDS,
  DM_JUDGMENT_EVENT_KINDS,
  DM_LEDGER_EVENT_KINDS,
  DM_REQUEST_EVENT_KINDS,
  DM_ROUTER_CLOSING_EVENT_KINDS,
  DM_ROUTER_EVENT_KINDS,
  DM_SNAPSHOT_STATES,
  DM_STALE_CLOSE_AFTER_MS,
  dmEventRefusal,
  dmRequestStateFromRow,
} from "../lib/amux/decisionMakerRequestCore.ts";
import { DM_INSTANCE_SCOPES } from "../lib/amux/decisionMakerSwitchCore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const MIGRATIONS = "prisma/migrations";
const STALE_MIGRATION = `${MIGRATIONS}/20261008130000_amux_decision_maker_stale_close_hours/migration.sql`;
const MIGRATION = `${MIGRATIONS}/20261008130100_amux_decision_maker_judgment_delivery/migration.sql`;
const LEDGER_MIGRATION = `${MIGRATIONS}/20261008090100_amux_decision_maker_request_ledger/migration.sql`;
const BODY_MIGRATION = `${MIGRATIONS}/20261008120000_amux_decision_maker_body_store/migration.sql`;
const STORE = "lib/amux/decisionMakerJudgmentStore.ts";
const CORE = "lib/amux/decisionMakerJudgmentCore.ts";
const AUDIT_MODULE = "lib/amux/decisionMakerJudgmentSystemAudit.ts";

const withoutSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((item) => item[1]);

const checkBody = (sql, name) => {
  const start = sql.indexOf(`CONSTRAINT "${name}"\n`);
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

const functionOf = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION "${name}"()`);
  assert.ok(start >= 0, `function ${name} was found`);
  const end = sql.indexOf("$$;", sql.indexOf("AS $$", start) + 5) + 3;
  return sql.slice(start, end);
};
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
const sqlList = (values) => values.map((value) => `'${value}'`).join(", ");
const doubledList = (values) => values.map((value) => `''${value}''`).join(", ");

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

test("the judgment, accuracy and delivery vocabularies are the policy's, and none holds an autonomous value", () => {
  assert.deepEqual([...DM_JUDGMENT_KINDS], ["confirm", "edit_confirm", "reject"]);
  assert.deepEqual([...DM_JUDGMENT_EVENT_KINDS], [...DM_JUDGMENT_KINDS]);
  assert.deepEqual([...DM_CONFIRMING_JUDGMENT_KINDS], ["confirm", "edit_confirm"]);
  assert.deepEqual([...DM_DECLARATION_ACCURACIES], ["matched", "mismatched", "not_judged"]);
  assert.equal(DM_DEFAULT_DECLARATION_ACCURACY, "not_judged");
  assert.deepEqual([...DM_DECLARATION_ITEMS], ["effect_class", "resolution", "paths"]);
  assert.deepEqual([...DM_DELIVERY_EVENT_KINDS], ["deliver", "delivery_receipt", "delivery_unknown", "delivery_unknown_resolve"]);
  assert.deepEqual([...DM_DELIVERY_SYSTEM_EVENT_KINDS], ["deliver", "delivery_receipt", "delivery_unknown"]);
  assert.deepEqual([...DM_DELIVERY_RESOLVE_OUTCOMES], ["delivered", "not_delivered"]);
  assert.deepEqual([...DM_DELIVERY_ACTOR_KINDS], ["human", "system"]);
  for (const list of [DM_JUDGMENT_KINDS, DM_DECLARATION_ACCURACIES, DM_DELIVERY_EVENT_KINDS, DM_DELIVERY_RESOLVE_OUTCOMES]) {
    assert.equal(list.some((value) => /autonom|graduat|eligib/i.test(value)), false);
  }
  // The ledger: the S1c nine, a judgment's three, and every closing kind once.
  assert.deepEqual([...DM_LEDGER_EVENT_KINDS], [...DM_REQUEST_EVENT_KINDS, ...DM_JUDGMENT_EVENT_KINDS]);
  assert.deepEqual([...DM_ROUTER_CLOSING_EVENT_KINDS], ["assign_discarded", "stale_close"]);
  assert.deepEqual([...DM_CLOSING_EVENT_KINDS], ["assign_discarded", "stale_close", "confirm", "edit_confirm", "reject"]);
  assert.equal(DM_STALE_CLOSE_AFTER_MS, 720 * 60 * 60 * 1000);
});

test("every judgment and delivery audit action is section 10's, by the right kind of actor", () => {
  const policy = read("docs/policy/amux-decision-maker.md");
  const start = policy.indexOf("**감사 action**");
  const human = policy.indexOf("사람: `.confirm`", start);
  const end = policy.indexOf("\n- **actor:**", human);
  const systemLine = policy.slice(start, human);
  const humanLine = policy.slice(human, end);
  for (const kind of DM_JUDGMENT_KINDS) {
    assert.equal(dmJudgmentAuditAction(kind), `amux.decision.${kind}`);
    assert.ok(humanLine.includes(`\`.${kind}\``), `${kind} is a person's action`);
    assert.ok(!systemLine.includes(`\`.${kind}\``), `${kind} is not a system action`);
  }
  assert.deepEqual(DM_DELIVERY_AUDIT_ACTIONS, {
    deliver: "amux.decision.deliver",
    delivery_receipt: "amux.decision.deliver",
    delivery_unknown: "amux.decision.delivery_unknown",
    delivery_unknown_resolve: "amux.decision.delivery_unknown_resolve",
  });
  for (const kind of DM_DELIVERY_SYSTEM_EVENT_KINDS) {
    assert.ok(systemLine.includes(`\`${DM_DELIVERY_AUDIT_ACTIONS[kind].replace("amux.decision", "")}\``), kind);
  }
  assert.ok(humanLine.includes("`.delivery_unknown_resolve`"));
  // Section 10 closes the list: no action of its own for a receipt.
  assert.ok(!policy.includes(".delivery_receipt"));
  assert.equal(DM_JUDGMENT_AUDIT_TARGET_TYPE, "AmuxDecisionMakerRequest");
  assert.equal(DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE, "AmuxDecisionMakerDeliveryEvent");
});

// ---------------------------------------------------------------------------
// The migrations
// ---------------------------------------------------------------------------

test("the stale close counts 720 hours, a fixed length, and nothing else in the event guard changed", () => {
  const before = functionOf(read(LEDGER_MIGRATION), "amux_decision_maker_request_event_guard");
  const sql = read(STALE_MIGRATION);
  const after = functionOf(sql, "amux_decision_maker_request_event_guard");
  assert.equal(
    after,
    replaceOnce(
      before,
      "NOT closed AND now_at >= request_created_at + INTERVAL '30 days'",
      "NOT closed AND now_at >= request_created_at + INTERVAL '720 hours'",
      "stale interval",
    ),
  );
  assert.equal(720 * 3_600_000, DM_STALE_CLOSE_AFTER_MS);
  // The header pins the S1c body, and the migration replaces that one function and nothing else.
  assert.match(sql.split("\n")[0], new RegExp(`^-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_request_event_guard" "${sha256(bodyOf(before))}"$`));
  const statements = withoutSqlComments(sql);
  assert.equal((statements.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 1);
  assert.doesNotMatch(statements, /^CREATE TABLE |^CREATE TRIGGER |^ALTER TABLE |\bDROP\b|\bTRUNCATE\b/m);
  // No interval in either migration's code is counted in days, months or years.
  for (const path of [STALE_MIGRATION, MIGRATION]) {
    assert.doesNotMatch(withoutSqlComments(read(path)), /INTERVAL '{1,2}[^']*\b(day|days|month|months|year|years|mon|mons)\b/i, path);
  }
});

test("the judgment migration pins each replaced function to its previous body", () => {
  const sql = read(MIGRATION);
  const pins = Object.fromEntries([...sql.matchAll(/^ {12}\('([0-9a-f]{64})', '(amux_decision_maker_[a-z_]+)'\),?$/gm)].map((match) => [match[2], match[1]]));
  assert.deepEqual(pins, {
    amux_decision_maker_request_event_guard: sha256(bodyOf(functionOf(read(STALE_MIGRATION), "amux_decision_maker_request_event_guard"))),
    amux_decision_maker_body_guard: sha256(bodyOf(functionOf(read(BODY_MIGRATION), "amux_decision_maker_body_guard"))),
    amux_decision_maker_retention_event_guard: sha256(bodyOf(functionOf(read(BODY_MIGRATION), "amux_decision_maker_retention_event_guard"))),
    amux_decision_maker_digest_key_event_guard: sha256(bodyOf(functionOf(read(BODY_MIGRATION), "amux_decision_maker_digest_key_event_guard"))),
  });
  // The pins run first, before anything changes, and compare what the baseline guard compares.
  const statements = withoutSqlComments(sql);
  assert.ok(statements.indexOf("DO $pin$") < statements.indexOf("CREATE TABLE"));
  assert.match(statements, /pg_catalog\.encode\(pg_catalog\.sha256\(pg_catalog\.convert_to\(p\.prosrc, 'UTF8'\)\), 'hex'\)/);
  assert.match(statements, /n\.nspname = pg_catalog\.current_schema\(\)/);
  assert.match(statements, /RAISE EXCEPTION 'AMUX_DM_UNEXPECTED_FUNCTION_BODY %', pinned\."name";/);
  // Only these four existing functions are replaced; the others are new.
  const replaced = [...statements.matchAll(/^CREATE OR REPLACE FUNCTION "([a-z_]+)"/gm)].map((match) => match[1]);
  assert.deepEqual(replaced, [
    "amux_decision_maker_request_event_guard",
    "amux_decision_maker_body_guard",
    "amux_decision_maker_retention_event_guard",
    "amux_decision_maker_digest_key_event_guard",
    "amux_decision_maker_judgment_guard",
    "amux_decision_maker_judgment_close",
    "amux_decision_maker_delivery_event_guard",
  ]);
  // No migration between the previous ones and this one redefines them.
  const between = readdirSync(join(root, MIGRATIONS))
    .filter((name) => name > "20261008120000_amux_decision_maker_body_store" && name < "20261008130100_amux_decision_maker_judgment_delivery")
    .filter((name) => name !== "20261008130000_amux_decision_maker_stale_close_hours")
    .filter((name) => {
      try {
        return /FUNCTION "amux_decision_maker_(request_event|body|retention_event|digest_key_event)_guard"\(/.test(read(`${MIGRATIONS}/${name}/migration.sql`));
      } catch {
        return false;
      }
    });
  assert.deepEqual(between, []);
});

test("each replaced function is its previous body with only the listed lines changed", () => {
  const after = (name) => functionOf(read(MIGRATION), name);
  const closing = `''assign_discarded'', ''stale_close'', ''confirm'', ''edit_confirm'', ''reject''`;

  // The request event guard: the terminal result's kind read, the judgment kinds closing, allowed
  // only on an open request with a proposal, and audited beside the judgment row.
  let event = functionOf(read(STALE_MIGRATION), "amux_decision_maker_request_event_guard");
  event = replaceOnce(event, "    terminal_digest TEXT;\n", "    terminal_digest TEXT;\n    terminal_kind TEXT;\n", "declare");
  event = replaceOnce(
    event,
    `                coalesce(bool_or("kind" = ''result_unknown''), false),\n                coalesce(bool_or("kind" IN (''assign_discarded'', ''stale_close'')), false)\n`,
    `                max("resultKind") FILTER (WHERE "kind" = ''result''),\n                coalesce(bool_or("kind" = ''result_unknown''), false),\n                coalesce(bool_or("kind" IN (${closing})), false)\n`,
    "aggregate",
  );
  event = replaceOnce(event, "terminal_digest, has_result_unknown, closed\n", "terminal_digest, terminal_kind, has_result_unknown, closed\n", "into");
  const judgmentCases = DM_JUDGMENT_KINDS.map(
    (kind) => `        WHEN '${kind}' THEN\n            request_route = 'dm_proposal' AND NOT closed AND terminal_kind = 'proposal'\n`,
  ).join("");
  event = replaceOnce(
    event,
    "        WHEN 'stale_close' THEN\n",
    `        -- Stage S1e: a person's judgment of the request's proposal closes it,\n        -- once. The judgment table's own trigger writes these, in the\n        -- judgment's statement.\n${judgmentCases}        WHEN 'stale_close' THEN\n`,
    "graph",
  );
  const systemAudit = event.slice(event.indexOf("    expected_actor := CASE"), event.indexOf("    IF audited IS DISTINCT FROM TRUE THEN"));
  const judgmentAudit = after("amux_decision_maker_request_event_guard").slice(
    after("amux_decision_maker_request_event_guard").indexOf(`    IF NEW."kind" IN ('confirm', 'edit_confirm', 'reject') THEN\n        -- A person's judgment`),
    after("amux_decision_maker_request_event_guard").indexOf("    ELSE\n        expected_actor := CASE"),
  );
  assert.match(
    judgmentAudit,
    /'SELECT EXISTS \(SELECT 1 FROM %1\$I\.%2\$I j JOIN %1\$I\.%3\$I a ON a\."id" = j\."auditLogId" WHERE j\."requestId" = \$1 AND j\."kind" = \$2 AND j\."auditLogId" = \$3 AND j\.xmin = pg_catalog\.pg_current_xact_id\(\)::xid AND a\."action" = ''amux\.decision\.'' \|\| j\."kind" AND a\."targetType" = ''AmuxDecisionMakerRequest'' AND a\."targetId" = j\."requestId" AND a\."actorUserId" = j\."actorUserId" AND pg_catalog\.jsonb_typeof\(a\."metadata"\) = ''object'' AND NOT \(a\."metadata" \? ''systemActor''\) AND a\."metadata" ->> ''request_id'' = j\."requestId" AND a\.xmin = pg_catalog\.pg_current_xact_id\(\)::xid\)',\n\s+TG_TABLE_SCHEMA,\n\s+'AmuxDecisionMakerJudgment',\n\s+'AdminAuditLog'\n\s+\) INTO audited USING NEW\."requestId", NEW\."kind", NEW\."auditLogId";\n$/,
  );
  const reindented = systemAudit
    .split("\n")
    .map((line) => (line === "" ? line : `    ${line}`))
    .join("\n");
  event = replaceOnce(event, systemAudit, `${judgmentAudit}    ELSE\n${reindented}    END IF;\n`, "audit");
  assert.equal(after("amux_decision_maker_request_event_guard"), event);

  // The body guard: the switch gate before the request lock for an operator's answer, and a
  // judgment closing the request.
  let bodyGuard = functionOf(read(BODY_MIGRATION), "amux_decision_maker_body_guard");
  bodyGuard = replaceOnce(
    bodyGuard,
    "    PERFORM pg_catalog.pg_advisory_xact_lock(\n        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW.\"requestId\")",
    "    -- Stage S1e: an operator's answer is written for an edited confirmation,\n" +
      "    -- whose judgment reads the kill switch under the Decision Maker switch\n" +
      "    -- gate. Every Decision Maker write takes that gate before the request\n" +
      "    -- lock, so the answer takes it first, shared. It reads no switch here.\n" +
      "    IF NEW.\"field\" = 'operator_answer' THEN\n" +
      "        PERFORM pg_catalog.pg_advisory_xact_lock_shared(\n" +
      "            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')\n" +
      "        );\n" +
      "    END IF;\n" +
      "    PERFORM pg_catalog.pg_advisory_xact_lock(\n        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW.\"requestId\")",
    "body gate",
  );
  bodyGuard = replaceOnce(
    bodyGuard,
    "    -- its creation, and a closed one gains no body.\n",
    "    -- its creation, and a closed one gains no body. Since stage S1e a person's\n" +
      "    -- judgment closes it too, so an edited answer is stored before its\n" +
      "    -- judgment, in the same transaction, and nothing after it.\n",
    "body comment",
  );
  bodyGuard = replaceOnce(bodyGuard, `"kind" IN (''assign_discarded'', ''stale_close''))',`, `"kind" IN (${closing}))',`, "body closed");
  assert.equal(after("amux_decision_maker_body_guard"), bodyGuard);

  // The retention guard: a retention_set named by a judgment's closing event and its person's audit.
  let retention = functionOf(read(BODY_MIGRATION), "amux_decision_maker_retention_event_guard");
  const oldClosing = retention.slice(retention.indexOf("        -- The request's closing event of this transaction"), retention.indexOf("            TG_TABLE_SCHEMA,\n            'AmuxDecisionMakerRequestEvent',"));
  const newClosing = after("amux_decision_maker_retention_event_guard").slice(
    after("amux_decision_maker_retention_event_guard").indexOf("        -- The request's closing event of this transaction"),
    after("amux_decision_maker_retention_event_guard").indexOf("            TG_TABLE_SCHEMA,\n            'AmuxDecisionMakerRequestEvent',"),
  );
  retention = replaceOnce(retention, oldClosing, newClosing, "retention closing");
  assert.equal(after("amux_decision_maker_retention_event_guard"), retention);
  // ... and the new reading accepts exactly the router's closings and a person's judgments.
  assert.ok(newClosing.includes(`(e."kind" IN (''assign_discarded'', ''stale_close'') AND a."targetType" = ''AmuxDecisionMakerRequestEvent'' AND a."targetId" = e."id" AND a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND a."userAgent" IS NULL AND a."metadata" ->> ''systemActor'' = ''amux-decision-router'')`));
  assert.ok(newClosing.includes(`OR (e."kind" IN (''confirm'', ''edit_confirm'', ''reject'') AND a."targetType" = ''AmuxDecisionMakerRequest'' AND a."targetId" = e."requestId" AND a."actorUserId" IS NOT NULL AND NOT (a."metadata" ? ''systemActor''))`));
  assert.ok(newClosing.includes(`e.xmin = pg_catalog.pg_current_xact_id()::xid AND a."action" = ''amux.decision.'' || e."kind"`));
  assert.ok(newClosing.includes(`a.xmin = pg_catalog.pg_current_xact_id()::xid AND (`));
  assert.equal(oldClosing.split("\n").filter((line) => !line.trimStart().startsWith("--")).length, 3);

  // The key guard: a request closed by a judgment is not open.
  let keyGuard = functionOf(read(BODY_MIGRATION), "amux_decision_maker_digest_key_event_guard");
  keyGuard = replaceOnce(
    keyGuard,
    "        -- period's requests routed to a DM may be open.\n",
    "        -- period's requests routed to a DM may be open. Since stage S1e a\n        -- person's judgment closes a request as well.\n",
    "key comment",
  );
  keyGuard = replaceOnce(keyGuard, `e."kind" IN (''assign_discarded'', ''stale_close''))',`, `e."kind" IN (${closing}))',`, "key open");
  assert.equal(after("amux_decision_maker_digest_key_event_guard"), keyGuard);
});

test("the request event table's kinds, instance rule and one closing take a judgment's three kinds", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  const kindCheck = sql.slice(sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"'), sql.indexOf("));", sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"')));
  assert.deepEqual(quoted(kindCheck), [...DM_LEDGER_EVENT_KINDS]);
  assert.match(sql, /DROP CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check",\n\s+ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"/);
  const instanceKind = sql.slice(sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_kind_check"'), sql.indexOf(") IS TRUE);", sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_kind_check"')) + 11);
  assert.deepEqual(quoted(instanceKind), [...DM_ROUTER_EVENT_KINDS, ...DM_JUDGMENT_EVENT_KINDS]);
  assert.match(instanceKind.replace(/\s+/g, " "), /CHECK \(\(\( "kind" IN \([^)]*\) \) = \("instance" IS NULL\)\) IS TRUE\);$/);
  assert.ok(
    sql.includes(
      `DROP INDEX "AmuxDecisionMakerRequestEvent_one_closing_key";\nCREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_closing_key"\n  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" IN (${sqlList(DM_CLOSING_EVENT_KINDS)});`,
    ),
  );
  // The S1d closing trigger, recreated: the same function on every closing kind.
  assert.ok(
    sql.includes(
      `DROP TRIGGER "amux_decision_maker_request_closing_retention" ON "AmuxDecisionMakerRequestEvent";\nCREATE TRIGGER "amux_decision_maker_request_closing_retention"\n    AFTER INSERT ON "AmuxDecisionMakerRequestEvent"\n    FOR EACH ROW\n    WHEN (NEW."kind" IN (${sqlList(DM_CLOSING_EVENT_KINDS)}))\n    EXECUTE FUNCTION "amux_decision_maker_request_closing_retention"();`,
    ),
  );
  assert.doesNotMatch(sql, /FUNCTION "amux_decision_maker_request_closing_retention"\(\)\nRETURNS/);
  // The closing kinds the state read, the open count and the guards use are the core's.
  const requestStore = read("lib/amux/decisionMakerRequestStore.ts");
  assert.equal((requestStore.match(new RegExp(`"kind" IN \\(${sqlList(DM_CLOSING_EVENT_KINDS)}\\)`, "g")) ?? []).length, 2);
  for (const name of ["amux_decision_maker_request_event_guard", "amux_decision_maker_body_guard", "amux_decision_maker_judgment_guard", "amux_decision_maker_digest_key_event_guard"]) {
    assert.ok(functionOf(sql, name).includes(`"kind" IN (${doubledList(DM_CLOSING_EVENT_KINDS)})`), name);
  }
  // The only DROPs are the ones replaced in place.
  assert.deepEqual(
    [...sql.matchAll(/\bDROP (CONSTRAINT|INDEX|TRIGGER) "([A-Za-z_]+)"/g)].map((match) => match[2]),
    [
      "AmuxDecisionMakerRequestEvent_kind_check",
      "AmuxDecisionMakerRequestEvent_instance_kind_check",
      "AmuxDecisionMakerRequestEvent_one_closing_key",
      "amux_decision_maker_request_closing_retention",
    ],
  );
  assert.doesNotMatch(sql, /\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b|SET CONSTRAINTS|DROP TABLE|DROP FUNCTION|DROP COLUMN/im);
});

test("the new tables' CHECKs and indexes hold the core's lists", () => {
  const sql = read(MIGRATION);
  const inList = (name) => quoted(checkBody(sql, name).replace(/^CHECK \(\s*"\w+" IS NULL OR /, "CHECK ("));
  assert.deepEqual(inList("AmuxDecisionMakerJudgment_kind_check"), [...DM_JUDGMENT_KINDS]);
  assert.deepEqual(inList("AmuxDecisionMakerJudgment_instance_check"), [...DM_INSTANCE_SCOPES]);
  assert.deepEqual(inList("AmuxDecisionMakerJudgment_declaration_accuracy_check"), [...DM_DECLARATION_ACCURACIES]);
  assert.deepEqual(inList("AmuxDecisionMakerJudgment_shown_snapshot_state_check"), [...DM_SNAPSHOT_STATES]);
  assert.deepEqual(quoted(checkBody(sql, "AmuxDecisionMakerJudgment_shown_option_id_format_check")), [DM_OPTION_ID_PATTERN.source]);
  assert.deepEqual(inList("AmuxDecisionMakerDeliveryEvent_kind_check"), [...DM_DELIVERY_EVENT_KINDS]);
  assert.deepEqual(inList("AmuxDecisionMakerDeliveryEvent_outcome_check"), [...DM_DELIVERY_RESOLVE_OUTCOMES]);
  assert.deepEqual(inList("AmuxDecisionMakerDeliveryEvent_actor_kind_check"), [...DM_DELIVERY_ACTOR_KINDS]);
  // The array CHECK of the mismatched items; check:enum-constraints does not read arrays.
  const items = checkBody(sql, "AmuxDecisionMakerJudgment_mismatched_items_check");
  assert.deepEqual(quoted(items.slice(items.indexOf("ARRAY["), items.indexOf("]::TEXT[]"))), [...DM_DECLARATION_ITEMS]);
  assert.match(items, /"mismatchedItems" IS NOT NULL/);
  assert.match(items, /array_position\("mismatchedItems", NULL\) IS NULL/);
  assert.match(items, /\("declarationAccuracy" = 'mismatched'\) = \(cardinality\("mismatchedItems"\) > 0\)/);
  // One judgment per request and per result; one decision, one outcome and one resolution per request.
  for (const [table, column] of [
    ["AmuxDecisionMakerJudgment", "requestId"],
    ["AmuxDecisionMakerJudgment", "resultEventId"],
    ["AmuxDecisionMakerJudgment", "auditLogId"],
    ["AmuxDecisionMakerDeliveryEvent", "sequence"],
    ["AmuxDecisionMakerDeliveryEvent", "auditLogId"],
  ]) {
    assert.ok(sql.includes(`CREATE UNIQUE INDEX "${table}_${column}_key"\n  ON "${table}"("${column}");`), `${table}.${column}`);
  }
  for (const [name, where] of [
    ["one_deliver", `"kind" = 'deliver'`],
    ["one_outcome", `"kind" IN ('delivery_receipt', 'delivery_unknown')`],
    ["one_resolve", `"kind" = 'delivery_unknown_resolve'`],
  ]) {
    assert.ok(sql.includes(`CREATE UNIQUE INDEX "AmuxDecisionMakerDeliveryEvent_${name}_key"\n  ON "AmuxDecisionMakerDeliveryEvent"("requestId") WHERE ${where};`), name);
  }
  // Every foreign key restricts.
  const statements = withoutSqlComments(sql);
  assert.equal((statements.match(/FOREIGN KEY \("(requestId|resultEventId|auditLogId)"\) REFERENCES "(AmuxDecisionMakerRequest|AmuxDecisionMakerRequestEvent|AdminAuditLog)"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT;/g) ?? []).length, 5);
  assert.equal((statements.match(/^CREATE TABLE /gm) ?? []).length, 2);
});

test("no CHECK of the judgment migration passes on NULL", () => {
  const sql = read(MIGRATION);
  const composite = [
    "AmuxDecisionMakerJudgment_digest_format_check",
    "AmuxDecisionMakerJudgment_mismatched_items_check",
    "AmuxDecisionMakerJudgment_shape_check",
    "AmuxDecisionMakerDeliveryEvent_shape_check",
  ];
  for (const name of composite) {
    assert.match(checkBody(sql, name).replace(/\s+/g, " "), /^CHECK \(\(.*\) IS TRUE\)$/, name);
  }
  // The replaced instance/kind CHECK of the request event table is held to IS TRUE as well.
  const instanceKind = sql.slice(sql.indexOf('ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_kind_check"'));
  assert.match(instanceKind.slice(0, instanceKind.indexOf(";")).replace(/\s+/g, " "), /CHECK \(\(\( .* \) = \("instance" IS NULL\)\) IS TRUE\)$/);
  // Every other CHECK names one NOT NULL column, or says IS NULL OR for a nullable one.
  const all = [...sql.matchAll(/CONSTRAINT "(AmuxDecisionMaker(?:Judgment|DeliveryEvent)_[a-z_]+_check)"\n/g)].map((match) => match[1]);
  assert.equal(all.length, 14);
  const nullable = {
    AmuxDecisionMakerJudgment_shown_snapshot_state_check: "shownSnapshotState",
    AmuxDecisionMakerJudgment_shown_option_id_format_check: "shownOptionId",
    AmuxDecisionMakerDeliveryEvent_outcome_check: "outcome",
  };
  for (const name of all.filter((item) => !composite.includes(item))) {
    const body = checkBody(sql, name);
    if (nullable[name]) assert.match(body, new RegExp(`^CHECK \\("${nullable[name]}" IS NULL OR `), name);
    else assert.match(body, /^CHECK \("(id|kind|instance|declarationAccuracy|actorKind)" (~|IN) /, name);
  }
  // The shapes compare a nullable column only by IS [NOT] NULL or IS [NOT] DISTINCT FROM.
  const nullableColumns = /"(shownAnswerDigest|shownRationaleDigest|shownOptionId|shownIrreversible|shownSnapshotState|shownSnapshotTargetSha|shownSnapshotManifestDigest|operatorAnswerDigest|outcome|actorUserId)" (=|<>|IN)\b/;
  for (const name of ["AmuxDecisionMakerJudgment_shape_check", "AmuxDecisionMakerDeliveryEvent_shape_check", "AmuxDecisionMakerJudgment_mismatched_items_check"]) {
    assert.doesNotMatch(checkBody(sql, name), nullableColumns, name);
  }
});

test("every new guard refuses an update, reads only under READ COMMITTED, pins search_path and sets its clock", () => {
  const sql = read(MIGRATION);
  for (const [name, table, prefix] of [
    ["amux_decision_maker_judgment_guard", "AmuxDecisionMakerJudgment", "AMUX_DM_JUDGMENT"],
    ["amux_decision_maker_delivery_event_guard", "AmuxDecisionMakerDeliveryEvent", "AMUX_DM_DELIVERY"],
  ]) {
    const body = functionOf(sql, name);
    assert.match(body, new RegExp(`IF TG_OP <> 'INSERT' THEN\\s*RAISE EXCEPTION '${prefix}_IMMUTABLE';`), name);
    assert.ok(body.includes(`RAISE EXCEPTION '${prefix}_ISOLATION'`), name);
    assert.ok(body.includes("SET search_path = pg_catalog, pg_temp"), name);
    assert.ok(body.includes('NEW."createdAt" := pg_catalog.clock_timestamp();'), name);
    assert.match(sql, new RegExp(`CREATE TRIGGER "${name}"\\s+BEFORE INSERT OR UPDATE OR DELETE ON "${table}"`), name);
    // Immutability, isolation, the gate (when the switch is read), the request lock, in that order.
    const order = [
      `RAISE EXCEPTION '${prefix}_IMMUTABLE'`,
      "current_setting('transaction_isolation') <> 'read committed'",
      "pg_advisory_xact_lock_shared(\n            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')",
      "pg_advisory_xact_lock(\n        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW.\"requestId\")",
      "'AmuxDecisionMakerSwitchEvent'",
      `RAISE EXCEPTION '${prefix}_UNAUDITED'`,
    ].map((needle) => body.indexOf(needle));
    assert.ok(order.every((position) => position >= 0), `${name} ${JSON.stringify(order)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, name);
  }
  const judgment = functionOf(sql, "amux_decision_maker_judgment_guard");
  // Only a confirmation takes the gate and reads the kill switch; a rejection reads no switch.
  assert.ok(judgment.includes(`IF NEW."kind" IN ('confirm', 'edit_confirm') THEN\n        PERFORM pg_catalog.pg_advisory_xact_lock_shared(`));
  assert.ok(judgment.includes(`IF NEW."kind" IN ('confirm', 'edit_confirm') THEN\n        EXECUTE pg_catalog.format(\n            'SELECT "value" FROM %I.%I WHERE "scope" = ''kill_switch'' ORDER BY "sequence" DESC LIMIT 1'`));
  assert.ok(judgment.includes(`IF coalesce(kill_switch_value, 'off') <> 'off' THEN\n            RAISE EXCEPTION 'AMUX_DM_JUDGMENT_SWITCH';`));
  for (const code of ["NO_REQUEST", "CLOSED", "NO_PROPOSAL", "INSTANCE", "OPERATOR_ANSWER", "SHOWN", "ACCURACY"]) {
    assert.ok(judgment.includes(`RAISE EXCEPTION 'AMUX_DM_JUDGMENT_${code}'`), code);
  }
  // Every shown value is compared NULL-safely, and the whole comparison is held to IS NOT TRUE.
  for (const [column, stored] of [
    ["shownRationaleDigest", "rationale_digest"],
    ["shownAnswerDigest", "answer_digest"],
    ["shownOptionId", "detail_option_id"],
    ["shownIrreversible", "detail_irreversible"],
    ["shownSnapshotState", "intent_state"],
    ["shownSnapshotTargetSha", "intent_sha"],
    ["shownSnapshotManifestDigest", "intent_manifest"],
  ]) {
    assert.ok(judgment.includes(`NEW."${column}" IS NOT DISTINCT FROM ${stored}`), column);
  }
  assert.match(judgment, /\) IS NOT TRUE THEN\n\s+RAISE EXCEPTION 'AMUX_DM_JUDGMENT_SHOWN';/);
  assert.ok(judgment.includes(`'amux.decision.' || NEW."kind", 'AmuxDecisionMakerRequest', NEW."requestId", NEW."actorUserId"`));
  assert.ok(judgment.includes(`AND "metadata" ->> ''request_id'' = $4 AND xmin = pg_catalog.pg_current_xact_id()::xid`));
  // The judgment closes its request in the same statement.
  const close = functionOf(sql, "amux_decision_maker_judgment_close");
  assert.ok(close.includes(`'INSERT INTO %I.%I ("id", "requestId", "kind", "auditLogId") VALUES ($1, $2, $3, $4)'`));
  assert.ok(close.includes(`USING pg_catalog.gen_random_uuid()::text, NEW."requestId", NEW."kind", NEW."auditLogId";`));
  assert.match(sql, /CREATE TRIGGER "amux_decision_maker_judgment_close"\n\s+AFTER INSERT ON "AmuxDecisionMakerJudgment"\n\s+FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_judgment_close"\(\);/);
  // The delivery graph and the switch: only the decision reads it.
  const delivery = functionOf(sql, "amux_decision_maker_delivery_event_guard");
  assert.ok(delivery.includes(`IF NEW."kind" = 'deliver' THEN\n        PERFORM pg_catalog.pg_advisory_xact_lock_shared(`));
  assert.ok(delivery.includes(`WHEN 'deliver' THEN\n            judgment_kind IN ('confirm', 'edit_confirm') AND NOT delivered`));
  assert.ok(delivery.includes(`WHEN 'delivery_unknown_resolve' THEN\n            unknown_outcome AND NOT resolved`));
  assert.ok(delivery.includes(`CASE NEW."kind" WHEN 'delivery_unknown' THEN 'amux.decision.delivery_unknown' ELSE 'amux.decision.deliver' END`));
  assert.ok(delivery.includes(`'amux.decision.delivery_unknown_resolve', 'AmuxDecisionMakerDeliveryEvent', NEW."id", NEW."actorUserId"`));
  for (const code of ["OUT_OF_ORDER", "TRANSITION", "SWITCH"]) {
    assert.ok(delivery.includes(`RAISE EXCEPTION 'AMUX_DM_DELIVERY_${code}'`), code);
  }
  // Every reading is through TG_TABLE_SCHEMA, never a hard-coded schema.
  assert.doesNotMatch(withoutSqlComments(sql), /"public"\.|public\."/);
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const CHECK = dmDigestKeyCheck(KEY);
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const TERMINAL_ID = "99999999-2222-4333-8444-555555555555";
const REQUEST_KEY = dmRequestDigestKey(KEY, REQUEST_ID);
const ANSWER = dmBodyDigest(REQUEST_KEY, "dm_answer", "Use the model id only.");
const RATIONALE = dmBodyDigest(REQUEST_KEY, "dm_rationale", "The locale is in the path.");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST = "e".repeat(64);
const PAYLOAD = "b".repeat(64);

const shownFor = (overrides = {}) => ({
  answerDigest: ANSWER,
  rationaleDigest: RATIONALE,
  optionId: null,
  irreversible: false,
  snapshotState: "worker_head",
  snapshotTargetSha: SHA,
  snapshotManifestDigest: MANIFEST,
  ...overrides,
});

test("what Admin showed is parsed strictly: one of an answer or an option, and a snapshot that agrees with its state", () => {
  assert.deepEqual(parseDmShownProposal(shownFor()), shownFor());
  assert.deepEqual(parseDmShownProposal(shownFor({ answerDigest: null, optionId: "b" })), shownFor({ answerDigest: null, optionId: "b" }));
  assert.deepEqual(
    parseDmShownProposal(shownFor({ snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null })),
    shownFor({ snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null }),
  );
  for (const bad of [
    null,
    [],
    { ...shownFor(), extra: 1 },
    (() => {
      const value = shownFor();
      delete value.irreversible;
      return value;
    })(),
    shownFor({ answerDigest: null }),
    shownFor({ optionId: "b" }),
    shownFor({ rationaleDigest: null }),
    shownFor({ rationaleDigest: "A".repeat(64) }),
    shownFor({ answerDigest: "short" }),
    shownFor({ answerDigest: null, optionId: "Use the model id" }),
    shownFor({ irreversible: "false" }),
    shownFor({ snapshotState: "main" }),
    shownFor({ snapshotState: "none" }),
    shownFor({ snapshotTargetSha: null }),
    shownFor({ snapshotTargetSha: SHA.toUpperCase() }),
    shownFor({ snapshotManifestDigest: null }),
  ]) {
    assert.equal(parseDmShownProposal(bad), null, JSON.stringify(bad));
  }
});

test("declaration accuracy defaults to not_judged, and mismatched names its wrong items once each, in the list's order", () => {
  assert.deepEqual(parseDmDeclarationAccuracy(undefined), { accuracy: "not_judged", mismatchedItems: [] });
  assert.deepEqual(parseDmDeclarationAccuracy({ accuracy: "matched" }), { accuracy: "matched", mismatchedItems: [] });
  assert.deepEqual(parseDmDeclarationAccuracy({ accuracy: "not_judged", mismatchedItems: [] }), { accuracy: "not_judged", mismatchedItems: [] });
  assert.deepEqual(parseDmDeclarationAccuracy({ accuracy: "mismatched", mismatchedItems: ["paths", "effect_class"] }), {
    accuracy: "mismatched",
    mismatchedItems: ["effect_class", "paths"],
  });
  for (const bad of [
    null,
    "matched",
    {},
    { accuracy: "correct" },
    { accuracy: "mismatched" },
    { accuracy: "mismatched", mismatchedItems: [] },
    { accuracy: "mismatched", mismatchedItems: ["paths", "paths"] },
    { accuracy: "mismatched", mismatchedItems: ["model"] },
    { accuracy: "matched", mismatchedItems: ["paths"] },
    { accuracy: "matched", note: "x" },
  ]) {
    assert.equal(parseDmDeclarationAccuracy(bad), null, JSON.stringify(bad));
  }
});

test("a judgment's input: a confirmation names what was shown, an edit its answer, a rejection neither", () => {
  assert.deepEqual(parseDmJudgmentInput({ kind: "confirm", shown: shownFor() }), {
    kind: "confirm",
    shown: shownFor(),
    accuracy: { accuracy: "not_judged", mismatchedItems: [] },
  });
  assert.equal(parseDmJudgmentInput({ kind: "edit_confirm", shown: shownFor(), operatorAnswer: "Use the locale too." }).operatorAnswer, "Use the locale too.");
  assert.deepEqual(parseDmJudgmentInput({ kind: "reject", accuracy: { accuracy: "matched" } }), {
    kind: "reject",
    accuracy: { accuracy: "matched", mismatchedItems: [] },
  });
  assert.equal(parseDmJudgmentInput({ kind: "reject", shown: null }).kind, "reject");
  for (const bad of [
    { kind: "approve", shown: shownFor() },
    { kind: "confirm" },
    { kind: "confirm", shown: shownFor(), operatorAnswer: "x" },
    { kind: "edit_confirm", shown: shownFor() },
    { kind: "edit_confirm", shown: shownFor(), operatorAnswer: 42 },
    { kind: "reject", shown: shownFor() },
    { kind: "reject", operatorAnswer: "x" },
    { kind: "confirm", shown: shownFor(), accuracy: { accuracy: "mismatched" } },
  ]) {
    assert.equal(parseDmJudgmentInput(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

const NOW = 1_790_000_000_000;
const PERIOD = dmKeyPeriodOf(NOW - 10_000);
const RING = new Map([[PERIOD, KEY]]);

/** The S1c state read's row, as tests/amuxDecisionMakerRequest.test.mjs shapes it. */
const requestRow = (overrides = {}) => ({
  id: REQUEST_ID,
  cardId: "card-41",
  questionRevision: 3,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:9",
  amuxSessionAttempt: 1,
  askingProvider: "claude",
  optionSetDigest: "a".repeat(64),
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
  policyVersion: 1,
  route: "dm_proposal",
  instance: "decision-maker-openai",
  createdAtEpochMs: BigInt(NOW - 10_000),
  assignmentDeadlineAtEpochMs: BigInt(NOW - 10_000 + DM_ASSIGNMENT_WINDOW_MS),
  dbNowEpochMs: BigInt(NOW),
  assigned: true,
  resultDeadlineAtEpochMs: BigInt(NOW + 20 * 60_000),
  transmitted: true,
  snapshotState: "worker_head",
  snapshotTargetSha: SHA,
  snapshotManifestDigest: MANIFEST,
  inputPayloadDigest: PAYLOAD,
  transmitOutcome: "transmit_receipt",
  terminalEventId: TERMINAL_ID,
  terminalResultKind: "proposal",
  terminalResultDigest: "c".repeat(64),
  resultUnknown: false,
  closingKind: null,
  probedRejection: null,
  ...overrides,
});
const stateOf = (overrides = {}) => {
  const state = dmRequestStateFromRow(requestRow(overrides));
  assert.ok(state, JSON.stringify(Object.keys(overrides)));
  return state;
};

const proposalRow = (overrides = {}) => ({
  resultEventId: TERMINAL_ID,
  resultKind: "proposal",
  outputKind: "free_text",
  optionId: null,
  irreversible: false,
  answerDigest: ANSWER,
  rationaleDigest: RATIONALE,
  operatorAnswerDigest: null,
  bodyBytes: 120n,
  keyCheck: CHECK,
  keyDestroyed: false,
  ...overrides,
});
const proposalOf = (overrides = {}) => {
  const proposal = dmProposalForJudgmentFromRow(proposalRow(overrides));
  assert.ok(proposal, JSON.stringify(Object.keys(overrides)));
  return proposal;
};

test("a closing judgment is in the request's state, and closes it for every ledger event", () => {
  for (const kind of DM_JUDGMENT_EVENT_KINDS) {
    const state = stateOf({ closingKind: kind });
    assert.equal(state.closing, kind);
    assert.equal(dmEventRefusal(state, { kind: "stale_close" }), "closed");
    assert.equal(dmEventRefusal(state, { kind: "result_unknown", instance: "decision-maker-openai", resultDigest: "d".repeat(64) }), "closed");
    assert.equal(
      dmEventRefusal(state, { kind: "result_rejected", instance: "decision-maker-openai", resultDigest: "d".repeat(64), rejectionReason: "request_closed" }),
      null,
    );
    // A transmission that happened is still recorded after the close.
    assert.equal(dmEventRefusal(stateOf({ closingKind: kind, transmitOutcome: null }), { kind: "transmit_receipt", instance: "decision-maker-openai" }), null);
  }
  assert.equal(dmRequestStateFromRow(requestRow({ closingKind: "approve" })), null);
});

test("a judgment needs an open request routed to a DM whose terminal result is a proposal", () => {
  assert.equal(dmJudgmentStateRefusal(stateOf()), null);
  assert.equal(dmJudgmentStateRefusal(stateOf({ route: "operator", instance: "decision-maker-openai" })), "not_routed_to_dm");
  for (const kind of DM_CLOSING_EVENT_KINDS) {
    assert.equal(dmJudgmentStateRefusal(stateOf({ closingKind: kind })), "closed", kind);
  }
  for (const resultKind of ["escalate", "validation_failure", "timeout", "unavailable"]) {
    assert.equal(dmJudgmentStateRefusal(stateOf({ terminalResultKind: resultKind })), "no_proposal", resultKind);
  }
  assert.equal(dmJudgmentStateRefusal(stateOf({ terminalEventId: null, terminalResultKind: null, terminalResultDigest: null })), "no_proposal");
  // Section 6's table: a confirmation needs the kill switch off; a rejection reads none.
  assert.equal(dmJudgmentSwitchRefusal("confirm", false), null);
  assert.equal(dmJudgmentSwitchRefusal("edit_confirm", false), null);
  assert.equal(dmJudgmentSwitchRefusal("confirm", true), "kill_switch_on");
  assert.equal(dmJudgmentSwitchRefusal("edit_confirm", true), "kill_switch_on");
  assert.equal(dmJudgmentSwitchRefusal("confirm", null), "settings_unreadable");
  assert.equal(dmJudgmentSwitchRefusal("reject", true), null);
  assert.equal(dmJudgmentSwitchRefusal("reject", null), null);
});

test("a confirmation stands only while every shown value equals the stored one", () => {
  const state = stateOf();
  assert.equal(dmShownProposalMatches(state, proposalOf(), shownFor()), true);
  for (const [label, proposal, shown] of [
    ["another rationale", proposalOf(), shownFor({ rationaleDigest: "f".repeat(64) })],
    ["another answer", proposalOf(), shownFor({ answerDigest: "f".repeat(64) })],
    ["the rationale erased", proposalOf({ rationaleDigest: null }), shownFor()],
    ["the answer erased", proposalOf({ answerDigest: null }), shownFor()],
    ["a select shown as free text", proposalOf({ outputKind: "select", optionId: "b", answerDigest: null }), shownFor()],
    ["free text shown as a select", proposalOf(), shownFor({ answerDigest: null, optionId: "b" })],
    ["the irreversible flag hidden", proposalOf({ irreversible: true }), shownFor()],
    ["another snapshot state", proposalOf(), shownFor({ snapshotState: "develop" })],
    ["another target", proposalOf(), shownFor({ snapshotTargetSha: "f".repeat(40) })],
    ["another manifest", proposalOf(), shownFor({ snapshotManifestDigest: "f".repeat(64) })],
    ["card only shown", proposalOf(), shownFor({ snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null })],
  ]) {
    assert.equal(dmShownProposalMatches(state, proposal, shown), false, label);
  }
  // A select: the option, not an answer.
  const select = proposalOf({ outputKind: "select", optionId: "b", answerDigest: null });
  assert.equal(dmShownProposalMatches(state, select, shownFor({ answerDigest: null, optionId: "b" })), true);
  assert.equal(dmShownProposalMatches(state, select, shownFor({ answerDigest: null, optionId: "a" })), false);
});

test("the stored proposal decides the rest: its detail, no operator answer yet, the shown values, and an edit's key", () => {
  const state = stateOf();
  const confirm = { kind: "confirm", shown: shownFor(), accuracy: { accuracy: "not_judged", mismatchedItems: [] } };
  const edit = { ...confirm, kind: "edit_confirm", operatorAnswer: "Use the locale too." };
  const reject = { kind: "reject", accuracy: { accuracy: "matched", mismatchedItems: [] } };
  assert.equal(dmJudgmentProposalRefusal({ state, proposal: proposalOf(), judgment: confirm, keyCheck: null }), null);
  assert.equal(dmJudgmentProposalRefusal({ state, proposal: proposalOf(), judgment: edit, keyCheck: CHECK }), null);
  assert.equal(dmJudgmentProposalRefusal({ state, proposal: proposalOf(), judgment: reject, keyCheck: null }), null);
  const noDetail = proposalOf({ resultEventId: null, resultKind: null, outputKind: null, irreversible: null });
  for (const judgment of [confirm, edit, reject]) {
    assert.equal(dmJudgmentProposalRefusal({ state, proposal: noDetail, judgment, keyCheck: CHECK }), "proposal_detail_missing", judgment.kind);
    assert.equal(
      dmJudgmentProposalRefusal({ state, proposal: proposalOf({ resultEventId: REQUEST_ID }), judgment, keyCheck: CHECK }),
      "proposal_detail_missing",
      judgment.kind,
    );
    assert.equal(
      dmJudgmentProposalRefusal({ state, proposal: proposalOf({ operatorAnswerDigest: "f".repeat(64) }), judgment, keyCheck: CHECK }),
      "operator_answer_present",
      judgment.kind,
    );
  }
  // A rejection stands whatever was shown; a confirmation does not.
  const changed = proposalOf({ irreversible: true });
  assert.equal(dmJudgmentProposalRefusal({ state, proposal: changed, judgment: reject, keyCheck: null }), null);
  assert.equal(dmJudgmentProposalRefusal({ state, proposal: changed, judgment: confirm, keyCheck: null }), "shown_mismatch");
  assert.equal(dmJudgmentProposalRefusal({ state, proposal: changed, judgment: edit, keyCheck: CHECK }), "shown_mismatch");
  // An edit needs the period's registered key, undestroyed.
  for (const [proposal, keyCheck] of [
    [proposalOf(), null],
    [proposalOf(), dmDigestKeyCheck(OTHER_KEY)],
    [proposalOf({ keyCheck: null }), CHECK],
    [proposalOf({ keyDestroyed: true }), CHECK],
  ]) {
    assert.equal(dmJudgmentProposalRefusal({ state, proposal, judgment: edit, keyCheck }), "digest_key_unavailable");
  }
  // A proposal read the stores could not have produced is unreadable.
  for (const overrides of [
    { bodyBytes: -1n },
    { answerDigest: "A".repeat(64) },
    { keyDestroyed: "no" },
    { resultEventId: "not-a-uuid" },
    { outputKind: "approve" },
    { outputKind: "select", optionId: null },
    { resultEventId: null },
  ]) {
    assert.equal(dmProposalForJudgmentFromRow(proposalRow(overrides)), null, JSON.stringify(Object.keys(overrides)));
  }
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const deliveryRow = (overrides = {}) => ({ judgmentKind: "confirm", delivered: false, outcomeKind: null, resolution: null, ...overrides });
const deliveryOf = (overrides = {}) => {
  const state = dmDeliveryStateFromRow(REQUEST_ID, deliveryRow(overrides));
  assert.ok(state, JSON.stringify(overrides));
  return state;
};

test("the delivery graph: one decision after a confirmation, one outcome after it, one resolution after an unknown outcome", () => {
  const states = {
    none: deliveryOf({ judgmentKind: null }),
    rejected: deliveryOf({ judgmentKind: "reject" }),
    confirmed: deliveryOf(),
    edited: deliveryOf({ judgmentKind: "edit_confirm" }),
    delivered: deliveryOf({ delivered: true }),
    received: deliveryOf({ delivered: true, outcomeKind: "delivery_receipt" }),
    unknown: deliveryOf({ delivered: true, outcomeKind: "delivery_unknown" }),
    resolved: deliveryOf({ delivered: true, outcomeKind: "delivery_unknown", resolution: "not_delivered" }),
  };
  const attempts = {
    deliver: { kind: "deliver" },
    delivery_receipt: { kind: "delivery_receipt" },
    delivery_unknown: { kind: "delivery_unknown" },
    delivery_unknown_resolve: { kind: "delivery_unknown_resolve", outcome: "delivered" },
  };
  const expected = {
    none: { deliver: "not_confirmed", delivery_receipt: "not_delivered", delivery_unknown: "not_delivered", delivery_unknown_resolve: "not_unknown" },
    rejected: { deliver: "not_confirmed", delivery_receipt: "not_delivered", delivery_unknown: "not_delivered", delivery_unknown_resolve: "not_unknown" },
    confirmed: { deliver: null, delivery_receipt: "not_delivered", delivery_unknown: "not_delivered", delivery_unknown_resolve: "not_unknown" },
    edited: { deliver: null, delivery_receipt: "not_delivered", delivery_unknown: "not_delivered", delivery_unknown_resolve: "not_unknown" },
    delivered: { deliver: "already_delivered", delivery_receipt: null, delivery_unknown: null, delivery_unknown_resolve: "not_unknown" },
    received: { deliver: "already_delivered", delivery_receipt: "outcome_recorded", delivery_unknown: "outcome_recorded", delivery_unknown_resolve: "not_unknown" },
    unknown: { deliver: "already_delivered", delivery_receipt: "outcome_recorded", delivery_unknown: "outcome_recorded", delivery_unknown_resolve: null },
    resolved: { deliver: "already_delivered", delivery_receipt: "outcome_recorded", delivery_unknown: "outcome_recorded", delivery_unknown_resolve: "already_resolved" },
  };
  for (const [stateName, state] of Object.entries(states)) {
    for (const [attemptName, attempt] of Object.entries(attempts)) {
      assert.equal(dmDeliveryRefusal(state, attempt), expected[stateName][attemptName], `${stateName} + ${attemptName}`);
    }
  }
  // Section 6's table: only the decision is refused under the kill switch.
  assert.equal(dmDeliverySwitchRefusal(attempts.deliver, false), null);
  assert.equal(dmDeliverySwitchRefusal(attempts.deliver, true), "kill_switch_on");
  assert.equal(dmDeliverySwitchRefusal(attempts.deliver, null), "settings_unreadable");
  for (const attempt of [attempts.delivery_receipt, attempts.delivery_unknown, attempts.delivery_unknown_resolve]) {
    assert.equal(dmDeliverySwitchRefusal(attempt, true), null, attempt.kind);
    assert.equal(dmDeliverySwitchRefusal(attempt, null), null, attempt.kind);
  }
  // Rows the guard could not have let through are unreadable.
  for (const overrides of [
    { judgmentKind: "approve" },
    { delivered: "yes" },
    { judgmentKind: "reject", delivered: true },
    { judgmentKind: null, delivered: true },
    { outcomeKind: "delivery_receipt" },
    { delivered: true, outcomeKind: "deliver" },
    { delivered: true, outcomeKind: "delivery_receipt", resolution: "delivered" },
    { delivered: true, outcomeKind: "delivery_unknown", resolution: "maybe" },
  ]) {
    assert.equal(dmDeliveryStateFromRow(REQUEST_ID, deliveryRow(overrides)), null, JSON.stringify(overrides));
  }
});

// ---------------------------------------------------------------------------
// Section 4's report
// ---------------------------------------------------------------------------

const tally = (instance, overrides = {}) => ({
  instance,
  confirm: 0,
  editConfirm: 0,
  reject: 0,
  matched: 0,
  mismatched: 0,
  notJudged: 0,
  ...overrides,
});

test("a report metric carries its numerator and denominator, and an empty denominator is insufficient evidence", () => {
  assert.deepEqual(dmReportMetric(3, 4), { status: "measured", numerator: 3, denominator: 4, value: 0.75 });
  assert.deepEqual(dmReportMetric(0, 4), { status: "measured", numerator: 0, denominator: 4, value: 0 });
  assert.deepEqual(dmReportMetric(0, 0), { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null });
  for (const [numerator, denominator] of [[5, 4], [-1, 4], [1.5, 4], [0, -1]]) {
    assert.throws(() => dmReportMetric(numerator, denominator), JSON.stringify([numerator, denominator]));
  }
});

test("section 4's report: per instance, each rate over its own denominator, insufficient evidence where it is empty", () => {
  const firstAt = NOW - 31 * DM_REPORT_DAY_MS - 5;
  const report = dmDeclarationAccuracyReport({
    dbNowMs: NOW,
    tallies: [tally("decision-maker-openai", { confirm: 38, editConfirm: 1, reject: 1, matched: 30, mismatched: 2, notJudged: 8 })],
    timeline: [
      { instance: "decision-maker-openai", proposals: 50, firstProposalAtMs: firstAt },
      { instance: "decision-maker-anthropic", proposals: 0, firstProposalAtMs: null },
    ],
  });
  assert.equal(report.dbNowMs, NOW);
  assert.deepEqual(report.instances.map((entry) => entry.instance), [...DM_INSTANCE_SCOPES]);
  const [openai, anthropic] = report.instances;
  assert.deepEqual(openai.decidedProposals, { status: "measured", numerator: 40, denominator: 50, value: 0.8 });
  assert.deepEqual(openai.daysSinceFirstProposal, { status: "measured", days: 31, firstProposalAtMs: firstAt });
  assert.deepEqual(openai.confirmedWithoutEdit, { status: "measured", numerator: 38, denominator: 40, value: 0.95 });
  assert.deepEqual(openai.matchedOverJudged, { status: "measured", numerator: 30, denominator: 32, value: 30 / 32 });
  assert.deepEqual(openai.notJudged, { status: "measured", numerator: 8, denominator: 40, value: 0.2 });
  // No proposal, no judgment: every figure is insufficient evidence, never zero.
  const insufficient = { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null };
  assert.deepEqual(anthropic, {
    instance: "decision-maker-anthropic",
    decidedProposals: insufficient,
    daysSinceFirstProposal: { status: "insufficient_evidence" },
    confirmedWithoutEdit: insufficient,
    matchedOverJudged: insufficient,
    notJudged: insufficient,
  });
  // Judged proposals with every accuracy not_judged: the matched rate alone has no evidence.
  const unjudged = dmDeclarationAccuracyReport({
    dbNowMs: NOW,
    tallies: [tally("decision-maker-anthropic", { reject: 2, notJudged: 2 })],
    timeline: [{ instance: "decision-maker-anthropic", proposals: 2, firstProposalAtMs: NOW - DM_REPORT_DAY_MS + 1 }],
  }).instances[1];
  assert.deepEqual(unjudged.matchedOverJudged, insufficient);
  assert.deepEqual(unjudged.confirmedWithoutEdit, { status: "measured", numerator: 0, denominator: 2, value: 0 });
  // Whole 24-hour days, rounded down.
  assert.deepEqual(unjudged.daysSinceFirstProposal, { status: "measured", days: 0, firstProposalAtMs: NOW - DM_REPORT_DAY_MS + 1 });
  // A tally that does not add up, or a judgment without its proposal, is refused rather than reported.
  assert.throws(() =>
    dmDeclarationAccuracyReport({ dbNowMs: NOW, tallies: [tally("decision-maker-openai", { confirm: 1 })], timeline: [] }),
  );
  assert.throws(() =>
    dmDeclarationAccuracyReport({
      dbNowMs: NOW,
      tallies: [tally("decision-maker-openai", { confirm: 2, matched: 2 })],
      timeline: [{ instance: "decision-maker-openai", proposals: 1, firstProposalAtMs: NOW }],
    }),
  );
  // The report names no threshold and grants nothing.
  const keys = JSON.stringify(report);
  assert.doesNotMatch(keys, /eligib|graduat|autonom|threshold|switch|mode|approve/i);
});

test("tallies are read one row per instance and refused when they cannot add up", () => {
  assert.deepEqual(
    dmJudgmentTalliesFromRows([{ instance: "decision-maker-openai", confirm: 2n, editConfirm: 1n, reject: 0n, matched: 1n, mismatched: 1n, notJudged: 1n }]),
    [tally("decision-maker-openai", { confirm: 2, editConfirm: 1, matched: 1, mismatched: 1, notJudged: 1 })],
  );
  for (const rows of [
    null,
    [{ instance: "decision-maker-gemini", confirm: 0n, editConfirm: 0n, reject: 0n, matched: 0n, mismatched: 0n, notJudged: 0n }],
    [{ instance: "decision-maker-openai", confirm: 1n, editConfirm: 0n, reject: 0n, matched: 0n, mismatched: 0n, notJudged: 0n }],
    [{ instance: "decision-maker-openai", confirm: -1n, editConfirm: 0n, reject: 0n, matched: 0n, mismatched: 0n, notJudged: -1n }],
    [
      { instance: "decision-maker-openai", confirm: 0n, editConfirm: 0n, reject: 0n, matched: 0n, mismatched: 0n, notJudged: 0n },
      { instance: "decision-maker-openai", confirm: 0n, editConfirm: 0n, reject: 0n, matched: 0n, mismatched: 0n, notJudged: 0n },
    ],
  ]) {
    assert.equal(dmJudgmentTalliesFromRows(rows), null, JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
});

// ---------------------------------------------------------------------------
// Audit metadata
// ---------------------------------------------------------------------------

test("audit metadata is closed keys and closed values: never a digest, an answer or free text", () => {
  assert.deepEqual([...DM_JUDGMENT_AUDIT_METADATA_KEYS], ["request_id", "judgment_id", "kind", "instance", "declaration_accuracy", "mismatched_items"]);
  assert.deepEqual([...DM_DELIVERY_AUDIT_METADATA_KEYS], ["event_id", "request_id", "kind", "judgment_kind", "outcome"]);
  const judgment = dmJudgmentAuditMetadata({
    requestId: REQUEST_ID,
    judgmentId: TERMINAL_ID,
    kind: "edit_confirm",
    instance: "decision-maker-openai",
    accuracy: { accuracy: "mismatched", mismatchedItems: ["resolution"] },
  });
  assert.deepEqual(judgment, {
    request_id: REQUEST_ID,
    judgment_id: TERMINAL_ID,
    kind: "edit_confirm",
    instance: "decision-maker-openai",
    declaration_accuracy: "mismatched",
    mismatched_items: ["resolution"],
  });
  assert.deepEqual(Object.keys(judgment), [...DM_JUDGMENT_AUDIT_METADATA_KEYS]);
  for (const fields of [
    { requestId: "card-41" },
    { judgmentId: ANSWER },
    { kind: "approve" },
    { instance: "decision-maker-gemini" },
    { accuracy: { accuracy: "Use the locale", mismatchedItems: [] } },
    { accuracy: { accuracy: "mismatched", mismatchedItems: ["Use the locale"] } },
  ]) {
    assert.throws(
      () =>
        dmJudgmentAuditMetadata({
          requestId: REQUEST_ID,
          judgmentId: TERMINAL_ID,
          kind: "confirm",
          instance: "decision-maker-openai",
          accuracy: { accuracy: "not_judged", mismatchedItems: [] },
          ...fields,
        }),
      JSON.stringify(fields),
    );
  }
  assert.deepEqual(
    dmDeliveryAuditMetadata({ eventId: TERMINAL_ID, requestId: REQUEST_ID, kind: "delivery_unknown_resolve", judgmentKind: "confirm", outcome: "not_delivered" }),
    { event_id: TERMINAL_ID, request_id: REQUEST_ID, kind: "delivery_unknown_resolve", judgment_kind: "confirm", outcome: "not_delivered" },
  );
  assert.deepEqual(
    dmDeliveryAuditMetadata({ eventId: TERMINAL_ID, requestId: REQUEST_ID, kind: "deliver", judgmentKind: "edit_confirm", outcome: null }),
    { event_id: TERMINAL_ID, request_id: REQUEST_ID, kind: "deliver", judgment_kind: "edit_confirm" },
  );
  assert.throws(() => dmDeliveryAuditMetadata({ eventId: TERMINAL_ID, requestId: REQUEST_ID, kind: "deliver", judgmentKind: null, outcome: "maybe" }));
});

// ---------------------------------------------------------------------------
// One writer
// ---------------------------------------------------------------------------

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mjs|js|cjs)$/.test(name) ? [path] : [];
  });

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one module reads and writes the two tables, never changes a row, and keeps the writers apart", () => {
  const reaches =
    /\.\s*amuxDecisionMaker(Judgment|DeliveryEvent)\b|\[\s*["'`]amuxDecisionMaker(Judgment|DeliveryEvent)["'`]\s*\]|\b(from|into|update|join|table)\s+"?AmuxDecisionMaker(Judgment|DeliveryEvent)"?\b/i;
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200, "the scan must reach the application");
  const offenders = files.filter((path) => path !== STORE && reaches.test(withoutComments(readFileSync(join(root, path), "utf8"))));
  assert.deepEqual(offenders, []);
  const store = withoutComments(read(STORE));
  assert.equal((store.match(/INSERT INTO "AmuxDecisionMakerJudgment"\n/g) ?? []).length, 1);
  assert.equal((store.match(/INSERT INTO "AmuxDecisionMakerDeliveryEvent"\n/g) ?? []).length, 2);
  assert.doesNotMatch(store, /UPDATE "AmuxDecisionMaker|DELETE FROM "AmuxDecisionMaker|TRUNCATE/);
  // The ledger and the bodies only through their own stores: this module names none of their tables.
  assert.doesNotMatch(store, /"AmuxDecisionMaker(Request|RequestEvent|Body|RetentionEvent|DigestKeyEvent|ResultDetail|SwitchEvent)"/);
  // A person's audit through the administrator writer; the system's from its own module.
  assert.doesNotMatch(read(STORE), /systemActor|writeSystemAuditLog/);
  assert.equal((store.match(/writeAdminAuditLog\(\{/g) ?? []).length, 2);
  const audit = read(AUDIT_MODULE);
  assert.equal((audit.match(/writeSystemAuditLog\(\{/g) ?? []).length, 1);
  assert.doesNotMatch(audit, /writeAdminAuditLog/);
  for (const path of [STORE, CORE, AUDIT_MODULE]) {
    assert.doesNotMatch(read(path), /console\./, path);
    assert.doesNotMatch(read(path), /createHash\(|createHmac\(/, path);
  }
  // An edited answer is stored by the body store, never here.
  assert.match(store, /await storeDecisionMakerOperatorAnswer\(tx,/);
  // The report reads and returns: it calls no writer and changes no switch.
  const report = store.slice(store.indexOf("export async function readDecisionMakerDeclarationAccuracyReport"));
  assert.doesNotMatch(report, /INSERT|UPDATE|DELETE|writeAdminAuditLog|writeDecisionMakerDeliveryAudit|recordDecisionMakerSwitchByOperator|latchDecisionMakerInstanceOff/);
});

// ---------------------------------------------------------------------------
// Statements per operation (§9: 12 at most including setup and fence, pinned exactly)
// ---------------------------------------------------------------------------

const PERMISSIVE_SWITCHES = [
  { scope: "kill_switch", value: "off" },
  { scope: "decision-maker-openai", value: "proposal" },
  { scope: "decision-maker-anthropic", value: "proposal" },
];
const KILLED = [{ scope: "kill_switch", value: "on" }, ...PERMISSIVE_SWITCHES.slice(1)];

const recordingTx = ({
  request = requestRow(),
  proposal = proposalRow(),
  switches = PERMISSIVE_SWITCHES,
  failSwitchRead = false,
  delivery = deliveryRow(),
  registryHoldsKey = true,
  tallies = [],
  timeline = [
    { dbNowEpochMs: BigInt(NOW), instance: "decision-maker-anthropic", proposals: 0n, firstProposalAtEpochMs: null },
    { dbNowEpochMs: BigInt(NOW), instance: "decision-maker-openai", proposals: 0n, firstProposalAtEpochMs: null },
  ],
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
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-08T00:00:00.000Z") }]);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerBody"')) return Promise.resolve(registryHoldsKey ? [{ digest: values[5] }] : []);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerJudgment"')) return Promise.resolve([{ createdAtEpochMs: BigInt(NOW + 5) }]);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerDeliveryEvent"')) return Promise.resolve([{ sequence: 12n, createdAtEpochMs: BigInt(NOW + 6) }]);
      if (sql.includes('"operatorAnswerDigest"') && sql.includes('"probe"')) return Promise.resolve([proposal]);
      if (sql.includes("CROSS JOIN LATERAL")) return Promise.resolve(request === null ? [] : [request]);
      if (sql.includes('SELECT DISTINCT ON ("scope")')) {
        return failSwitchRead ? Promise.reject(new Error("switch read failed")) : Promise.resolve(switches);
      }
      if (sql.includes('FROM "AmuxDecisionMakerDeliveryEvent" d')) return Promise.resolve([delivery]);
      if (sql.includes('GROUP BY "instance"')) return Promise.resolve(tallies);
      if (sql.includes("WITH db_clock")) return Promise.resolve(timeline);
      if (sql.includes('FROM "AmuxDecisionMakerJudgment"')) return Promise.resolve([]);
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

// The route transaction around each operation adds the boundary's setup and
// commit fence (lib/amux/dbBoundary.ts): two more statements.
const BOUNDARY_STATEMENTS = 2;
const LOCK = /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/;
const kindsOf = (sent) => sent.map((statement) => statement.kind);
const auditOf = (sent) => sent.find((statement) => statement.kind === "create").data;
const session = { user: { id: "operator-1", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const integrityKey = ["unit", "test", "integrity"].join("-");

/** Where each value sits in the judgment insert. */
const JUDGMENT = {
  id: 0,
  requestId: 1,
  resultEventId: 2,
  instance: 3,
  kind: 4,
  actorUserId: 5,
  shownAnswerDigest: 6,
  shownRationaleDigest: 7,
  shownOptionId: 8,
  shownIrreversible: 9,
  shownSnapshotState: 10,
  shownSnapshotTargetSha: 11,
  shownSnapshotManifestDigest: 12,
  operatorAnswerDigest: 13,
  declarationAccuracy: 14,
  mismatchedItems: 15,
  auditLogId: 16,
};

for (const [label, keyValue] of [
  ["without", null],
  ["with", integrityKey],
]) {
  const auditKinds = keyValue === null ? ["execute", "query", "create"] : ["execute", "query", "findFirst", "create"];

  test(`each judgment sends its pinned statements ${label} an integrity key, in order, within the budget`, async () => {
    await withIntegrityKey(keyValue, async () => {
      const operatorAnswer = "Use the model id and the locale.";
      const cases = [
        {
          name: "confirm",
          input: { kind: "confirm", shown: shownFor(), accuracy: { accuracy: "matched" } },
          kinds: ["execute", "query", "query", "query", ...auditKinds, "query"],
          shown: true,
          operatorAnswerDigest: null,
          accuracy: ["matched", []],
        },
        {
          name: "edit_confirm",
          input: { kind: "edit_confirm", shown: shownFor(), operatorAnswer, accuracy: { accuracy: "mismatched", mismatchedItems: ["paths", "resolution"] } },
          kinds: ["execute", "query", "query", "query", ...auditKinds, "query", "query"],
          shown: true,
          operatorAnswerDigest: dmBodyDigest(REQUEST_KEY, "operator_answer", operatorAnswer),
          accuracy: ["mismatched", ["resolution", "paths"]],
        },
        {
          name: "reject",
          input: { kind: "reject" },
          kinds: ["execute", "query", "query", ...auditKinds, "query"],
          shown: false,
          operatorAnswerDigest: null,
          accuracy: ["not_judged", []],
        },
      ];
      for (const entry of cases) {
        const { tx, sent } = recordingTx();
        const result = await recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, keyRing: RING, ...entry.input });
        assert.equal(result.recorded, true, `${entry.name}: ${JSON.stringify(result)}`);
        assert.deepEqual(kindsOf(sent), entry.kinds, entry.name);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12, entry.name);
        assert.equal(sent.length, entry.kinds.length);
        assert.match(sent[0].sql, LOCK, entry.name);
        // The person's audit names the request, with closed metadata.
        const audit = auditOf(sent);
        assert.equal(audit.action, `amux.decision.${entry.name}`, entry.name);
        assert.equal(audit.targetType, "AmuxDecisionMakerRequest", entry.name);
        assert.equal(audit.targetId, REQUEST_ID, entry.name);
        assert.equal(audit.actorUserId, "operator-1", entry.name);
        assert.deepEqual(audit.metadata, {
          request_id: REQUEST_ID,
          judgment_id: result.judgment.judgmentId,
          kind: entry.name,
          instance: "decision-maker-openai",
          declaration_accuracy: entry.accuracy[0],
          mismatched_items: entry.accuracy[1],
        });
        // The judgment row names everything the guard checks.
        const insert = sent.at(-1);
        assert.match(insert.sql, /INSERT INTO "AmuxDecisionMakerJudgment"/);
        const at = (column) => insert.values[JUDGMENT[column]];
        assert.deepEqual(
          [at("id"), at("requestId"), at("resultEventId"), at("instance"), at("kind"), at("actorUserId"), at("auditLogId")],
          [result.judgment.judgmentId, REQUEST_ID, TERMINAL_ID, "decision-maker-openai", entry.name, "operator-1", "audit-row-1"],
        );
        const shownColumns = ["shownAnswerDigest", "shownRationaleDigest", "shownOptionId", "shownIrreversible", "shownSnapshotState", "shownSnapshotTargetSha", "shownSnapshotManifestDigest"];
        assert.deepEqual(
          shownColumns.map(at),
          entry.shown ? [ANSWER, RATIONALE, null, false, "worker_head", SHA, MANIFEST] : shownColumns.map(() => null),
          entry.name,
        );
        assert.equal(at("operatorAnswerDigest"), entry.operatorAnswerDigest, entry.name);
        assert.equal(result.judgment.operatorAnswerDigest, entry.operatorAnswerDigest, entry.name);
        assert.deepEqual([at("declarationAccuracy"), at("mismatchedItems")], entry.accuracy, entry.name);
        // The kill switch is read for a confirmation only, after the lock.
        assert.equal(sent.some((statement) => statement.sql?.includes("SELECT DISTINCT ON")), entry.name !== "reject", entry.name);
        // The proposal read names the request and its key period.
        const proposal = sent.find((statement) => statement.sql?.includes('"probe"'));
        assert.deepEqual(proposal.values, [REQUEST_ID, REQUEST_ID, PERIOD]);
        if (entry.name === "edit_confirm") {
          const body = sent.at(-2);
          assert.match(body.sql, /INSERT INTO "AmuxDecisionMakerBody"/);
          assert.deepEqual(body.values.slice(1, 7), [REQUEST_ID, operatorAnswer, PERIOD, CHECK, entry.operatorAnswerDigest, "audit-row-1"]);
          assert.match(body.sql, /WHERE EXISTS \(\s+SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k\s+WHERE k\."keyPeriod" = \$::integer AND k\."kind" = 'rotate' AND k\."keyCheck" = \$/);
        }
      }
    });
  });

  test(`each delivery record sends its pinned statements ${label} an integrity key, in order, within the budget`, async () => {
    await withIntegrityKey(keyValue, async () => {
      const cases = [
        {
          name: "decision",
          options: {},
          run: (tx) => recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }),
          kinds: ["execute", "query", "query", ...auditKinds, "query"],
          action: "amux.decision.deliver",
          kind: "deliver",
          actor: null,
          systemActor: "amux-decision-router",
          insert: (event) => [event.eventId, REQUEST_ID, "deliver", "audit-row-1"],
        },
        {
          name: "receipt",
          options: { delivery: deliveryRow({ delivered: true }) },
          run: (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome: "receipt" }),
          kinds: ["execute", "query", ...auditKinds, "query"],
          action: "amux.decision.deliver",
          kind: "delivery_receipt",
          actor: null,
          systemActor: "amux-decision-router",
          insert: (event) => [event.eventId, REQUEST_ID, "delivery_receipt", "audit-row-1"],
        },
        {
          name: "unknown",
          options: { delivery: deliveryRow({ delivered: true }), switches: KILLED },
          run: (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome: "unknown" }),
          kinds: ["execute", "query", ...auditKinds, "query"],
          action: "amux.decision.delivery_unknown",
          kind: "delivery_unknown",
          actor: null,
          systemActor: "amux-decision-router",
          insert: (event) => [event.eventId, REQUEST_ID, "delivery_unknown", "audit-row-1"],
        },
        {
          name: "resolution",
          options: { delivery: deliveryRow({ delivered: true, outcomeKind: "delivery_unknown" }), switches: KILLED },
          run: (tx) => resolveDecisionMakerDeliveryUnknown(tx, { session, requestId: REQUEST_ID, outcome: "not_delivered" }),
          kinds: ["execute", "query", ...auditKinds, "query"],
          action: "amux.decision.delivery_unknown_resolve",
          kind: "delivery_unknown_resolve",
          actor: "operator-1",
          insert: (event) => [event.eventId, REQUEST_ID, "not_delivered", "operator-1", "audit-row-1"],
        },
      ];
      for (const entry of cases) {
        const { tx, sent } = recordingTx(entry.options);
        const result = await entry.run(tx);
        assert.equal(result.recorded, true, `${entry.name}: ${JSON.stringify(result)}`);
        assert.deepEqual(kindsOf(sent), entry.kinds, entry.name);
        assert.ok(sent.length + BOUNDARY_STATEMENTS <= 12, entry.name);
        assert.match(sent[0].sql, LOCK, entry.name);
        const audit = auditOf(sent);
        assert.equal(audit.action, entry.action, entry.name);
        assert.equal(audit.targetType, "AmuxDecisionMakerDeliveryEvent", entry.name);
        assert.equal(audit.targetId, result.event.eventId, entry.name);
        assert.equal(audit.actorUserId, entry.actor, entry.name);
        const { systemActor, ...metadata } = audit.metadata;
        assert.equal(systemActor, entry.systemActor, entry.name);
        assert.equal(metadata.kind, entry.kind, entry.name);
        assert.ok(Object.keys(metadata).every((key) => DM_DELIVERY_AUDIT_METADATA_KEYS.includes(key)), entry.name);
        assert.deepEqual(sent.at(-1).values, entry.insert(result.event), entry.name);
        // Only the decision reads the switches.
        assert.equal(sent.some((statement) => statement.sql?.includes("SELECT DISTINCT ON")), entry.name === "decision", entry.name);
      }
    });
  });
}

test("a refusal writes nothing, in the statements up to the read that refused it", async () => {
  const confirm = { kind: "confirm", shown: shownFor() };
  const edit = { kind: "edit_confirm", shown: shownFor(), operatorAnswer: "Use the locale too." };
  const judge = (input) => (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, keyRing: RING, ...input });
  const secret = ["Use ", "gh", "p_", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("");
  const cases = [
    ["an unknown request", { request: null }, judge(confirm), { recorded: false, reason: "unknown_request" }, 2],
    ["a request routed to the operator", { request: requestRow({ route: "operator" }) }, judge(confirm), { recorded: false, reason: "not_routed_to_dm" }, 2],
    ["a closed request", { request: requestRow({ closingKind: "stale_close" }) }, judge({ kind: "reject" }), { recorded: false, reason: "closed" }, 2],
    ["a second judgment", { request: requestRow({ closingKind: "confirm" }) }, judge(confirm), { recorded: false, reason: "closed" }, 2],
    ["no proposal", { request: requestRow({ terminalResultKind: "escalate" }) }, judge({ kind: "reject" }), { recorded: false, reason: "no_proposal" }, 2],
    ["a confirmation under the kill switch", { switches: KILLED }, judge(confirm), { recorded: false, reason: "kill_switch_on" }, 3],
    ["an edit under the kill switch", { switches: KILLED }, judge(edit), { recorded: false, reason: "kill_switch_on" }, 3],
    ["an unreadable switch row", { switches: [{ scope: "kill_switch", value: "maybe" }] }, judge(confirm), { recorded: false, reason: "settings_unreadable" }, 3],
    ["a shown value that changed", { proposal: proposalRow({ irreversible: true }) }, judge(confirm), { recorded: false, reason: "shown_mismatch" }, 4],
    ["an erased rationale", { proposal: proposalRow({ rationaleDigest: null }) }, judge(edit), { recorded: false, reason: "shown_mismatch" }, 4],
    ["no stored detail", { proposal: proposalRow({ resultEventId: null, resultKind: null, outputKind: null, irreversible: null }) }, judge({ kind: "reject" }), { recorded: false, reason: "proposal_detail_missing" }, 3],
    ["an operator answer already stored", { proposal: proposalRow({ operatorAnswerDigest: "f".repeat(64) }) }, judge({ kind: "reject" }), { recorded: false, reason: "operator_answer_present" }, 3],
    ["an edit whose key the ring lacks", {}, (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, keyRing: new Map(), ...edit }), { recorded: false, reason: "digest_key_unavailable" }, 3],
    ["an edit under a key the registry does not hold", { proposal: proposalRow({ keyCheck: dmDigestKeyCheck(OTHER_KEY) }) }, judge(edit), { recorded: false, reason: "digest_key_unavailable" }, 4],
    ["an edit with a secret", {}, judge({ ...edit, operatorAnswer: secret }), { recorded: false, reason: "operator_answer_refused", bodyRefusal: "secret_detected" }, 0],
    ["an edit with no text", {}, judge({ ...edit, operatorAnswer: "" }), { recorded: false, reason: "operator_answer_refused", bodyRefusal: "empty" }, 0],
    ["an edit over 8 KiB", {}, judge({ ...edit, operatorAnswer: "x".repeat(8 * 1024 + 1) }), { recorded: false, reason: "operator_answer_refused", bodyRefusal: "too_long" }, 0],
    ["a decision before a confirmation", { delivery: deliveryRow({ judgmentKind: null }) }, (tx) => recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "not_confirmed" }, 2],
    ["a decision after a rejection", { delivery: deliveryRow({ judgmentKind: "reject" }) }, (tx) => recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "not_confirmed" }, 2],
    ["a second decision", { delivery: deliveryRow({ delivered: true }) }, (tx) => recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "already_delivered" }, 2],
    ["a decision under the kill switch", { switches: KILLED }, (tx) => recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "kill_switch_on" }, 3],
    ["a receipt before the decision", {}, (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome: "receipt" }), { recorded: false, reason: "not_delivered" }, 2],
    ["a second receipt", { delivery: deliveryRow({ delivered: true, outcomeKind: "delivery_receipt" }) }, (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome: "receipt" }), { recorded: false, reason: "outcome_recorded" }, 2],
    ["unknown after a receipt", { delivery: deliveryRow({ delivered: true, outcomeKind: "delivery_receipt" }) }, (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome: "unknown" }), { recorded: false, reason: "outcome_recorded" }, 2],
    ["a resolution without an unknown outcome", { delivery: deliveryRow({ delivered: true, outcomeKind: "delivery_receipt" }) }, (tx) => resolveDecisionMakerDeliveryUnknown(tx, { session, requestId: REQUEST_ID, outcome: "delivered" }), { recorded: false, reason: "not_unknown" }, 2],
    ["a second resolution", { delivery: deliveryRow({ delivered: true, outcomeKind: "delivery_unknown", resolution: "delivered" }) }, (tx) => resolveDecisionMakerDeliveryUnknown(tx, { session, requestId: REQUEST_ID, outcome: "delivered" }), { recorded: false, reason: "already_resolved" }, 2],
  ];
  for (const [name, options, run, expected, statements] of cases) {
    const { tx, sent } = recordingTx(options);
    assert.deepEqual(await run(tx), expected, name);
    assert.equal(sent.length, statements, name);
    assert.ok(!sent.some((statement) => statement.kind === "create" || /INSERT|DELETE|UPDATE/.test(statement.sql ?? "")), name);
  }
  // A rejection and a person's resolution stay allowed under the kill switch.
  {
    const { tx } = recordingTx({ switches: KILLED });
    assert.equal((await recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "reject" })).recorded, true);
  }
});

test("a failed switch read, a key the registry lost and a row the stores could not produce stop the writer", async () => {
  {
    const { tx, sent } = recordingTx({ failSwitchRead: true });
    await assert.rejects(
      recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "confirm", shown: shownFor() }),
      (error) => error instanceof DecisionMakerJudgmentWriteError && error.code === "settings_unreadable",
    );
    assert.equal(sent.length, 3);
  }
  {
    const { tx, sent } = recordingTx({ failSwitchRead: true });
    await assert.rejects(
      recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }),
      (error) => error instanceof DecisionMakerJudgmentWriteError && error.code === "settings_unreadable",
    );
    assert.equal(sent.length, 3);
  }
  // The registry no longer holds the key when the answer is inserted: the store throws after its
  // audit, so the caller's transaction rolls back.
  {
    const { tx, sent } = recordingTx({ registryHoldsKey: false });
    await assert.rejects(
      recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "edit_confirm", shown: shownFor(), operatorAnswer: "Use the locale too.", keyRing: RING }),
      (error) => error.code === "digest_key_unavailable",
    );
    assert.ok(!sent.some((statement) => statement.sql?.includes('INSERT INTO "AmuxDecisionMakerJudgment"')));
  }
  {
    const { tx } = recordingTx({ proposal: proposalRow({ keyDestroyed: "no" }) });
    await assert.rejects(
      recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "reject" }),
      (error) => error.code === "state_unreadable",
    );
  }
  {
    const { tx } = recordingTx({ delivery: deliveryRow({ judgmentKind: "reject", delivered: true }) });
    await assert.rejects(readDecisionMakerDeliveryState(tx, REQUEST_ID), (error) => error.code === "state_unreadable");
  }
});

test("a malformed input sends nothing at all", async () => {
  const cases = [
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: "not-a-uuid", kind: "reject" }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "approve" }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "confirm" }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "confirm", shown: { ...shownFor(), answerDigest: null } }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "reject", shown: shownFor() }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "reject", accuracy: { accuracy: "mismatched" } }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "edit_confirm", shown: shownFor(), operatorAnswer: "x" }),
    (tx) => recordDecisionMakerJudgment(tx, { session, requestId: REQUEST_ID, kind: "edit_confirm", shown: shownFor(), operatorAnswer: "x", keyRing: { [PERIOD]: KEY } }),
    (tx) => recordDecisionMakerDelivery(tx, { requestId: null }),
    (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome: "delivered" }),
    (tx) => resolveDecisionMakerDeliveryUnknown(tx, { session, requestId: REQUEST_ID, outcome: "receipt" }),
    (tx) => readDecisionMakerDeliveryState(tx, "not-a-uuid"),
    (tx) => readDecisionMakerJudgment(tx, "not-a-uuid"),
  ];
  for (const [index, run] of cases.entries()) {
    const { tx, sent } = recordingTx();
    await assert.rejects(run(tx), (error) => error instanceof DecisionMakerJudgmentWriteError && error.code === "invalid_input", String(index));
    assert.equal(sent.length, 0, String(index));
  }
  // A judgment and a resolution need a person.
  for (const run of [
    (tx) => recordDecisionMakerJudgment(tx, { session: { expires: session.expires }, requestId: REQUEST_ID, kind: "reject" }),
    (tx) => resolveDecisionMakerDeliveryUnknown(tx, { session: { expires: session.expires }, requestId: REQUEST_ID, outcome: "delivered" }),
  ]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(run(tx), (error) => error instanceof DecisionMakerJudgmentWriteError && error.code === "no_operator");
    assert.equal(sent.length, 0);
  }
});

test("the report reads in two statements, judgments first, and writes nothing", async () => {
  const { tx, sent } = recordingTx({
    tallies: [{ instance: "decision-maker-openai", confirm: 3n, editConfirm: 1n, reject: 0n, matched: 2n, mismatched: 0n, notJudged: 2n }],
    timeline: [
      { dbNowEpochMs: BigInt(NOW), instance: "decision-maker-anthropic", proposals: 0n, firstProposalAtEpochMs: null },
      { dbNowEpochMs: BigInt(NOW), instance: "decision-maker-openai", proposals: 5n, firstProposalAtEpochMs: BigInt(NOW - 3 * DM_REPORT_DAY_MS) },
    ],
  });
  const report = await readDecisionMakerDeclarationAccuracyReport(tx);
  assert.deepEqual(kindsOf(sent), ["query", "query"]);
  assert.match(sent[0].sql, /FROM "AmuxDecisionMakerJudgment"\s+GROUP BY "instance"/);
  assert.match(sent[1].sql, /WITH db_clock AS MATERIALIZED/);
  assert.match(sent[1].sql, /ev\."kind" = 'result' AND ev\."resultKind" = 'proposal'/);
  assert.deepEqual(sent[1].values, [[...DM_INSTANCE_SCOPES]]);
  for (const statement of sent) assert.doesNotMatch(statement.sql, /INSERT|UPDATE|DELETE/);
  const openai = report.instances.find((entry) => entry.instance === "decision-maker-openai");
  assert.deepEqual(openai.decidedProposals, { status: "measured", numerator: 4, denominator: 5, value: 0.8 });
  assert.deepEqual(openai.daysSinceFirstProposal, { status: "measured", days: 3, firstProposalAtMs: NOW - 3 * DM_REPORT_DAY_MS });
  assert.deepEqual(openai.confirmedWithoutEdit, { status: "measured", numerator: 3, denominator: 4, value: 0.75 });
  assert.deepEqual(openai.matchedOverJudged, { status: "measured", numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(openai.notJudged, { status: "measured", numerator: 2, denominator: 4, value: 0.5 });
});

test("the reads are one statement each", async () => {
  {
    const { tx, sent } = recordingTx({ delivery: deliveryRow({ delivered: true, outcomeKind: "delivery_unknown" }) });
    const state = await readDecisionMakerDeliveryState(tx, REQUEST_ID);
    assert.deepEqual(state, { requestId: REQUEST_ID, judgmentKind: "confirm", delivered: true, outcome: "unknown", resolution: null });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].values, [REQUEST_ID, REQUEST_ID]);
  }
  {
    const { tx, sent } = recordingTx();
    assert.equal(await readDecisionMakerJudgment(tx, REQUEST_ID), null);
    assert.equal(sent.length, 1);
  }
});
