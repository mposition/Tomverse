// AMUX Decision Maker, stage S2: the Admin request list
// (docs/policy/amux-decision-maker.md §2, §6, §12; lib/amux/decisionMakerAdminCore.ts,
// lib/amux/decisionMakerAdminRead.ts).
//
// The questions: the list is one statement inside a boundary sized to it; it
// carries no body; a row the ledger could not have produced refuses the whole
// list; each status and delivery code follows from the ledger's events in one
// fixed order; and every code has words in both locales.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { adminAmuxDecisionMakerRequestsMessages } from "../lib/adminMessages/amuxDecisionMaker.ts";
import {
  DM_ADMIN_DELIVERY_STATUSES,
  DM_ADMIN_REQUEST_LIST_LIMIT,
  DM_ADMIN_REQUEST_STATUSES,
  dmAdminDeliveryStatus,
  dmAdminRequestRowFromRow,
  dmAdminRequestStatus,
} from "../lib/amux/decisionMakerAdminCore.ts";
import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import { DM_CLOSING_EVENT_KINDS } from "../lib/amux/decisionMakerRequestCore.ts";
import {
  DecisionMakerAdminReadError,
  listDecisionMakerRequestsForAdmin,
} from "../lib/amux/decisionMakerAdminRead.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);
const REQUEST_ID = "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b";

/** One row as the list statement returns it: a request routed to a DM and assigned, nothing more. */
const listRow = (overrides = {}) => ({
  id: REQUEST_ID,
  cardId: "card-41",
  questionRevision: 2,
  askingWorkerId: "worker.claude-1",
  askingProvider: "claude",
  route: "dm_proposal",
  instance: "decision-maker-openai",
  refusalCodes: [],
  createdAtEpochMs: BigInt(NOW - 60_000),
  assignmentDeadlineAtEpochMs: BigInt(NOW + 60_000),
  dbNowEpochMs: BigInt(NOW),
  assigned: true,
  snapshotState: null,
  transmitOutcome: null,
  resultKind: null,
  resultUnknown: false,
  closingKind: null,
  outputKind: null,
  irreversible: null,
  declarationAccuracy: null,
  delivered: false,
  deliveryOutcomeKind: null,
  deliveryResolution: null,
  ...overrides,
});

/** JSON for a failure message; the rows carry BigInt epochs. */
const show = (value) => JSON.stringify(value, (_key, x) => (typeof x === "bigint" ? `${x}n` : x));

const parsed = (overrides = {}) => {
  const row = dmAdminRequestRowFromRow(listRow(overrides));
  assert.ok(row, `row should parse: ${show(overrides)}`);
  return row;
};

const DETAIL_KEYS = ["outputKind", "irreversible"];
const JUDGMENT_KEYS = ["declarationAccuracy", "delivered", "deliveryOutcomeKind", "deliveryResolution"];

/**
 * A transaction that answers each store's statement from the combined rows:
 * the request store's ledger half, the body store's result details and the
 * judgment store's records.
 */
const recordingTx = (combined) => {
  const sent = [];
  const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));
  const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
  return {
    sent,
    tx: {
      $queryRaw: (strings, ...values) => {
        const sql = strings.join("$");
        sent.push({ sql, values });
        if (sql.includes("recent AS MATERIALIZED")) {
          return Promise.resolve(combined.map((row) => omit(row, [...DETAIL_KEYS, ...JUDGMENT_KEYS])));
        }
        if (sql.includes('FROM "AmuxDecisionMakerResultDetail"')) {
          return Promise.resolve(
            combined
              .filter((row) => row.resultKind !== null && row.id !== null)
              .map((row) => ({
                requestId: row.id,
                resultKind: row.resultKind,
                outputKind: row.outputKind,
                optionId: row.outputKind === "select" ? "a" : null,
                irreversible: row.irreversible,
              })),
          );
        }
        if (sql.includes("unnest(")) {
          return Promise.resolve(combined.filter((row) => row.id !== null).map((row) => ({ requestId: row.id, ...pick(row, JUDGMENT_KEYS) })));
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
    },
  };
};

test("the list is three statements, each store reading its own tables, and its boundary is those plus setup and fence", async () => {
  const proposal = listRow({ snapshotState: "none", resultKind: "proposal", outputKind: "select", irreversible: true });
  const { tx, sent } = recordingTx([proposal]);
  const list = await listDecisionMakerRequestsForAdmin(tx);
  assert.equal(sent.length, 3);
  assert.equal(list.dbNowMs, NOW);
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].irreversible, true);
  assert.equal(list.rows[0].outputKind, "select");
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerRequestListRead, {
    operation: "decision_maker_request_list_read",
    prismaCallCeiling: sent.length + 2,
    isolation: "read",
  });
  // The request store chooses the newest requests before aggregating, at the panel's limit,
  // and the other two read exactly those ids.
  assert.match(sent[0].sql, /recent AS MATERIALIZED \(\s*SELECT \* FROM "AmuxDecisionMakerRequest"\s*ORDER BY "createdAt" DESC, "id" DESC\s*LIMIT \$/);
  assert.deepEqual(sent[0].values, [DM_ADMIN_REQUEST_LIST_LIMIT]);
  assert.deepEqual(sent[1].values, [[REQUEST_ID]]);
  assert.deepEqual(sent[2].values, [[REQUEST_ID]]);
  // Each statement names only its own store's tables.
  const tables = (sql) => [...new Set([...sql.matchAll(/"(AmuxDecisionMaker[A-Za-z]+)"/g)].map((match) => match[1]))].sort();
  assert.deepEqual(tables(sent[0].sql), ["AmuxDecisionMakerRequest", "AmuxDecisionMakerRequestEvent"]);
  assert.deepEqual(tables(sent[1].sql), ["AmuxDecisionMakerResultDetail"]);
  assert.deepEqual(tables(sent[2].sql), ["AmuxDecisionMakerDeliveryEvent", "AmuxDecisionMakerJudgment"]);
});

test("the list reads no body and no free text, and the composer holds no SQL", async () => {
  const { tx, sent } = recordingTx([listRow()]);
  await listDecisionMakerRequestsForAdmin(tx);
  for (const { sql } of sent) {
    assert.doesNotMatch(sql, /"AmuxDecisionMakerBody"/);
    assert.doesNotMatch(sql, /"(text|digest|keyCheck|resultDigest|inputPayloadDigest|snapshotManifestDigest|snapshotTargetSha|actorUserId|rejectionReason)"/);
  }
  // The closing kinds are the core's list: a fourth read of the request store uses it.
  const closing = DM_CLOSING_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ");
  assert.ok(sent[0].sql.includes(`"kind" IN (${closing})`));
  const composer = read("lib/amux/decisionMakerAdminRead.ts");
  // Its client type names $queryRaw; it never calls it, and names no table.
  assert.doesNotMatch(composer, /\$queryRaw`|\$queryRaw\(|\$executeRaw|"AmuxDecisionMaker/);
});

test("an empty ledger is the clock's row alone: one statement, no request, the database clock", async () => {
  const empty = Object.fromEntries(Object.keys(listRow()).map((key) => [key, null]));
  const { tx, sent } = recordingTx([{ ...empty, dbNowEpochMs: BigInt(NOW), assigned: false, resultUnknown: false }]);
  assert.deepEqual(await listDecisionMakerRequestsForAdmin(tx), { dbNowMs: NOW, rows: [] });
  assert.equal(sent.length, 1);
});

test("a row the ledger could not have produced refuses the whole list", async () => {
  const bad = [
    { route: "elsewhere" },
    { instance: "decision-maker-other" },
    { route: "operator" },
    { instance: null },
    { instance: "decision-maker-anthropic" },
    { route: "operator", assigned: false, instance: null },
    { route: "operator", assigned: false, refusalCodes: ["provider_unverified"] },
    { route: "operator", assigned: false, askingProvider: "gemini" },
    { refusalCodes: ["no_such_code"] },
    { questionRevision: -1 },
    { assigned: "yes" },
    { snapshotState: "worker_head", assigned: false },
    { transmitOutcome: "transmit_receipt" },
    { transmitOutcome: "transmit_later", snapshotState: "none" },
    { outputKind: "free_text" },
    { resultKind: "proposal", irreversible: "no" },
    { declarationAccuracy: "matched" },
    { closingKind: "confirm", resultKind: "proposal", outputKind: "free_text", irreversible: false },
    { delivered: true },
    { deliveryOutcomeKind: "delivery_receipt" },
    { deliveryResolution: "delivered" },
    { closingKind: "approve" },
  ];
  for (const overrides of bad) {
    assert.equal(dmAdminRequestRowFromRow(listRow(overrides)), null, show(overrides));
  }
  const { tx } = recordingTx([listRow(), listRow({ id: "1b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b", closingKind: "approve" })]);
  await assert.rejects(
    listDecisionMakerRequestsForAdmin(tx),
    (error) => error instanceof DecisionMakerAdminReadError && error.code === "state_unreadable",
  );
  // So does a judgment record for a request the list did not ask about.
  const stray = recordingTx([listRow()]);
  const query = stray.tx.$queryRaw;
  stray.tx.$queryRaw = (strings, ...values) =>
    strings.join("$").includes("unnest(")
      ? Promise.resolve([{ requestId: "1b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b", declarationAccuracy: null, delivered: false, deliveryOutcomeKind: null, deliveryResolution: null }])
      : query(strings, ...values);
  await assert.rejects(listDecisionMakerRequestsForAdmin(stray.tx), /state_unreadable/);
});

test("an operator route has no DM path, and its refusals are kept for Admin", () => {
  const row = parsed({
    route: "operator",
    assigned: false,
    refusalCodes: ["ask_type_not_allowed", "irreversible_term"],
  });
  // It still names the instance it would have gone to; only an unverified provider has none.
  assert.equal(row.instance, "decision-maker-openai");
  const unverified = parsed({
    route: "operator",
    instance: null,
    askingProvider: "gemini",
    assigned: false,
    refusalCodes: ["provider_unverified"],
  });
  assert.equal(dmAdminRequestStatus(unverified, NOW), "routed_to_operator");
  assert.equal(dmAdminRequestStatus(row, NOW), "routed_to_operator");
  assert.deepEqual(row.refusalCodes, ["ask_type_not_allowed", "irreversible_term"]);
  assert.equal(dmAdminDeliveryStatus(row), "not_applicable");
});

test("the status follows the events in one order: closing, unknown result, result, then the DM path", () => {
  const cases = [
    [{ assigned: false }, "awaiting_assignment"],
    [{ assigned: false, assignmentDeadlineAtEpochMs: BigInt(NOW) }, "assignment_expired"],
    [{}, "assigned"],
    [{ snapshotState: "none" }, "running"],
    [{ snapshotState: "worker_head", transmitOutcome: "transmit_receipt" }, "running"],
    [{ snapshotState: "develop", transmitOutcome: "transmit_unknown" }, "transmit_unknown"],
    [{ snapshotState: "none", resultUnknown: true }, "result_unknown"],
    [{ snapshotState: "none", resultKind: "proposal", outputKind: "free_text", irreversible: false }, "proposal"],
    [{ snapshotState: "none", resultKind: "escalate", outputKind: "escalate" }, "escalate"],
    [{ snapshotState: "none", resultKind: "validation_failure" }, "validation_failure"],
    [{ resultKind: "timeout" }, "timeout"],
    [{ resultKind: "unavailable" }, "unavailable"],
    // A result outranks an unknown transmission; a closing outranks everything.
    [{ snapshotState: "none", transmitOutcome: "transmit_unknown", resultKind: "timeout" }, "timeout"],
    [{ snapshotState: "none", resultUnknown: true, resultKind: "proposal", outputKind: "select", irreversible: true }, "result_unknown"],
    [{ snapshotState: "none", resultKind: "proposal", outputKind: "select", irreversible: true, closingKind: "confirm", declarationAccuracy: "not_judged" }, "confirm"],
    [{ snapshotState: "none", resultKind: "proposal", outputKind: "free_text", irreversible: false, closingKind: "edit_confirm", declarationAccuracy: "matched" }, "edit_confirm"],
    [{ snapshotState: "none", resultKind: "proposal", outputKind: "free_text", irreversible: false, closingKind: "reject", declarationAccuracy: "not_judged" }, "reject"],
    [{ assigned: false, closingKind: "assign_discarded" }, "assign_discarded"],
    [{ resultKind: "timeout", closingKind: "stale_close" }, "stale_close"],
  ];
  const seen = new Set(["routed_to_operator"]);
  for (const [overrides, expected] of cases) {
    assert.equal(dmAdminRequestStatus(parsed(overrides), NOW), expected, show(overrides));
    seen.add(expected);
  }
  // Every status is reachable, and none is left over.
  assert.deepEqual([...seen].sort(), [...DM_ADMIN_REQUEST_STATUSES].sort());
});

test("only a confirmed answer is ever delivered, and the delivery status follows its events", () => {
  const confirmed = {
    snapshotState: "none",
    resultKind: "proposal",
    outputKind: "free_text",
    irreversible: false,
    closingKind: "confirm",
    declarationAccuracy: "not_judged",
  };
  const cases = [
    [{}, "not_applicable"],
    [{ ...confirmed, closingKind: "reject" }, "not_applicable"],
    [confirmed, "pending"],
    [{ ...confirmed, closingKind: "edit_confirm", delivered: true }, "in_flight"],
    [{ ...confirmed, delivered: true, deliveryOutcomeKind: "delivery_receipt" }, "delivered"],
    [{ ...confirmed, delivered: true, deliveryOutcomeKind: "delivery_unknown" }, "unknown"],
    [{ ...confirmed, delivered: true, deliveryOutcomeKind: "delivery_unknown", deliveryResolution: "delivered" }, "resolved_delivered"],
    [{ ...confirmed, delivered: true, deliveryOutcomeKind: "delivery_unknown", deliveryResolution: "not_delivered" }, "resolved_not_delivered"],
  ];
  const seen = new Set();
  for (const [overrides, expected] of cases) {
    assert.equal(dmAdminDeliveryStatus(parsed(overrides)), expected, show(overrides));
    seen.add(expected);
  }
  assert.deepEqual([...seen].sort(), [...DM_ADMIN_DELIVERY_STATUSES].sort());
  // A delivery beside a rejection, or a resolution beside a receipt, is not a row the ledger holds.
  assert.equal(dmAdminRequestRowFromRow(listRow({ ...confirmed, closingKind: "reject", delivered: true })), null);
  assert.equal(
    dmAdminRequestRowFromRow(listRow({ ...confirmed, delivered: true, deliveryOutcomeKind: "delivery_receipt", deliveryResolution: "delivered" })),
    null,
  );
});

test("every status and delivery code has words in both locales, and no other key", () => {
  for (const locale of ["en", "ko"]) {
    const m = adminAmuxDecisionMakerRequestsMessages[locale];
    assert.deepEqual(Object.keys(m.statuses).sort(), [...DM_ADMIN_REQUEST_STATUSES].sort(), locale);
    assert.deepEqual(Object.keys(m.deliveries).sort(), [...DM_ADMIN_DELIVERY_STATUSES].sort(), locale);
    for (const text of [...Object.values(m.statuses), ...Object.values(m.deliveries)]) {
      assert.ok(typeof text === "string" && text.length > 0, locale);
    }
  }
});
