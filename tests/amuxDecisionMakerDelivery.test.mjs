// AMUX Decision Maker stage S2-2b3: delivering an operator-confirmed answer to
// the asking worker (docs/policy/amux-decision-maker.md §2-7, §6, §7, §9).
//
// Runs without a database: §7's header, sentence and model table held to the
// policy's own text; the candidate a confirmation makes and everything that is
// never one (a rejection, a request with no judgment, a judgment that is not
// the request's closing); the judgment store's read of the next confirmation;
// the delivery read's statements, which stop at the kill switch; and the three
// delivery routes' DB boundaries, each the largest operation's statements plus
// setup and fence (§9's budget). The database's own refusals are exercised in
// tests/integration/amux-decision-maker-delivery.db.test.ts; the routes in
// tests/server-contract/amux-decision-maker-delivery-routes.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import { dmKeyPeriodOf } from "../lib/amux/decisionMakerBodyCore.ts";
import {
  DM_DELIVERY_JUDGMENT_LABELS,
  DM_DELIVERY_MESSAGE_MAX_BYTES,
  DM_DELIVERY_MODEL_LABELS,
  DM_DELIVERY_NOT_AN_APPROVAL,
  dmDeliveryCandidate,
  dmDeliveryHeader,
  dmDeliveryJudgmentFromRow,
  dmDeliveryMessage,
  dmDeliveryMessageId,
  parseDmDeliveryCursor,
} from "../lib/amux/decisionMakerDeliveryCore.ts";
import { readDecisionMakerDeliveryCandidate } from "../lib/amux/decisionMakerDeliveryRead.ts";
import {
  DecisionMakerJudgmentWriteError,
  readNextDecisionMakerDeliveryJudgment,
  recordDecisionMakerDelivery,
  recordDecisionMakerDeliveryOutcome,
} from "../lib/amux/decisionMakerJudgmentStore.ts";
import { DM_ASSIGNMENT_WINDOW_MS, dmRequestStateFromRow } from "../lib/amux/decisionMakerRequestCore.ts";
import { DM_INSTANCE_SCOPES } from "../lib/amux/decisionMakerSwitchCore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const POLICY = "docs/policy/amux-decision-maker.md";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_REQUEST = "22222222-2222-4333-8444-555555555555";
const TERMINAL_ID = "99999999-2222-4333-8444-555555555555";
const NOW = 1_790_000_000_000;

// ---------------------------------------------------------------------------
// §7: what the worker reads
// ---------------------------------------------------------------------------

/** The policy's text with its line breaks and indents folded to single spaces. */
const policySection = (number) => {
  const text = read(POLICY);
  const start = text.indexOf(`\n## ${number}. `);
  assert.ok(start >= 0, `§${number} was found`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end);
};
const folded = (text) => text.replace(/\n\s*/g, " ");

test("§7's header and sentence are the policy's own words, with the policy's model table", () => {
  const section = folded(policySection(7));
  const template = section.match(/확정된 답의 메시지는 `(\[Decision Maker [^`]+\])`로 시작하고 "([^"]+)"는 문장을 붙인다/);
  assert.ok(template, "§7's header template and sentence were found");
  const [, header, sentence] = template;
  assert.equal(DM_DELIVERY_NOT_AN_APPROVAL, `${sentence}.`);
  assert.match(section, /카드 기록도 같은 표시를 쓴다/);
  // Each label is §7's table cell for that instance.
  for (const instance of DM_INSTANCE_SCOPES) {
    const row = section.match(new RegExp(`\\| \`${instance}\` \\| \`(?:codex|claude)\`, ([^|]+?) \\|`));
    assert.ok(row, `§7's table row for ${instance}`);
    assert.equal(DM_DELIVERY_MODEL_LABELS[instance], row[1], instance);
  }
  assert.deepEqual(Object.keys(DM_DELIVERY_MODEL_LABELS).sort(), [...DM_INSTANCE_SCOPES].sort());
  // The header fills the template's placeholders and nothing else.
  assert.equal(header, "[Decision Maker <인스턴스> (<모델>) 제안, <operator-confirmed|operator-edited>, re <카드>]");
  for (const [kind, label] of Object.entries(DM_DELIVERY_JUDGMENT_LABELS)) {
    for (const instance of DM_INSTANCE_SCOPES) {
      const expected = header
        .replace("<인스턴스>", instance)
        .replace("<모델>", DM_DELIVERY_MODEL_LABELS[instance])
        .replace("<operator-confirmed|operator-edited>", label)
        .replace("<카드>", "AMUX-12");
      assert.equal(dmDeliveryHeader({ instance, judgmentKind: kind, cardId: "AMUX-12" }), expected);
    }
  }
  assert.deepEqual(DM_DELIVERY_JUDGMENT_LABELS, { confirm: "operator-confirmed", edit_confirm: "operator-edited" });
});

test("the message starts with the header, carries the answer, and ends with the sentence", () => {
  const select = dmDeliveryMessage({
    instance: "decision-maker-openai",
    judgmentKind: "confirm",
    cardId: "AMUX-12",
    answer: { kind: "option", optionId: "sqlite" },
  });
  assert.equal(
    select,
    "[Decision Maker decision-maker-openai (GPT-6 Astra) 제안, operator-confirmed, re AMUX-12]\n선택지: sqlite\n\n" +
      DM_DELIVERY_NOT_AN_APPROVAL,
  );
  const edited = dmDeliveryMessage({
    instance: "decision-maker-anthropic",
    judgmentKind: "edit_confirm",
    cardId: "AMUX-7",
    answer: { kind: "text", text: "Use the model id.\nKeep the locale out." },
  });
  assert.ok(edited.startsWith("[Decision Maker decision-maker-anthropic (Claude Fable 5.1) 제안, operator-edited, re AMUX-7]\n"));
  assert.ok(edited.includes("\nUse the model id.\nKeep the locale out.\n\n"));
  assert.ok(edited.endsWith(DM_DELIVERY_NOT_AN_APPROVAL));
  // A rejection has no label; an unknown instance, card or option is refused.
  for (const bad of [
    { instance: "decision-maker-openai", judgmentKind: "reject", cardId: "AMUX-1", answer: { kind: "option", optionId: "a" } },
    { instance: "decision-maker-other", judgmentKind: "confirm", cardId: "AMUX-1", answer: { kind: "option", optionId: "a" } },
    { instance: "decision-maker-openai", judgmentKind: "confirm", cardId: "../x", answer: { kind: "option", optionId: "a" } },
    { instance: "decision-maker-openai", judgmentKind: "confirm", cardId: "AMUX-1", answer: { kind: "option", optionId: "not an id" } },
    { instance: "decision-maker-openai", judgmentKind: "confirm", cardId: "AMUX-1", answer: { kind: "text", text: "  " } },
  ]) {
    assert.throws(() => dmDeliveryMessage(bad), JSON.stringify(bad));
  }
  assert.equal(dmDeliveryMessageId(REQUEST_ID), `dm-answer:${REQUEST_ID}`);
  assert.ok(dmDeliveryMessageId(REQUEST_ID).length <= 64, "the local message id is 64 characters at most");
  assert.throws(() => dmDeliveryMessageId("not-a-uuid"));
});

test("the cursor is null or a database clock and a request id, nothing else", () => {
  assert.equal(parseDmDeliveryCursor(null), null);
  assert.equal(parseDmDeliveryCursor(undefined), null);
  assert.deepEqual(parseDmDeliveryCursor({ judged_at_ms: 5, request_id: REQUEST_ID }), { judgedAtMs: 5, requestId: REQUEST_ID });
  for (const bad of [
    [],
    "x",
    { judged_at_ms: 5 },
    { judged_at_ms: -1, request_id: REQUEST_ID },
    { judged_at_ms: 1.5, request_id: REQUEST_ID },
    { judged_at_ms: "5", request_id: REQUEST_ID },
    { judged_at_ms: 5, request_id: "x" },
    { judged_at_ms: 5, request_id: REQUEST_ID, extra: 1 },
  ]) {
    assert.equal(parseDmDeliveryCursor(bad), undefined, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

/** The S1c state read's row, as tests/amuxDecisionMakerJudgment.test.mjs shapes it. */
const requestRow = (overrides = {}) => ({
  id: REQUEST_ID,
  cardId: "AMUX-12",
  questionRevision: 3,
  askingWorkerId: "claude-impl",
  amuxSessionId: "claude-impl",
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
  snapshotState: "none",
  snapshotTargetSha: null,
  snapshotManifestDigest: null,
  inputPayloadDigest: "b".repeat(64),
  transmitOutcome: "transmit_receipt",
  terminalEventId: TERMINAL_ID,
  terminalResultKind: "proposal",
  terminalResultDigest: "c".repeat(64),
  resultUnknown: false,
  cleanupUnknownEventId: null,
  cleanupUnknownAtEpochMs: null,
  closingKind: "confirm",
  probedRejection: null,
  ...overrides,
});
const stateOf = (overrides = {}) => {
  const state = dmRequestStateFromRow(requestRow(overrides));
  assert.ok(state, JSON.stringify(Object.keys(overrides)));
  return state;
};
const judgmentOf = (overrides = {}) => ({
  requestId: REQUEST_ID,
  judgmentKind: "confirm",
  instance: "decision-maker-openai",
  judgedAtMs: NOW - 1_000,
  ...overrides,
});
const FREE = { resultKind: "proposal", outputKind: "free_text", optionId: null };
const SELECT = { resultKind: "proposal", outputKind: "select", optionId: "sqlite" };

test("a confirmation delivers the DM's answer or option, an edited confirmation the person's answer", () => {
  const free = dmDeliveryCandidate({ judgment: judgmentOf(), state: stateOf(), detail: FREE, bodies: { dm_answer: "Use the model id only." } });
  assert.deepEqual(free, {
    status: "ready",
    requestId: REQUEST_ID,
    judgedAtMs: NOW - 1_000,
    judgmentKind: "confirm",
    instance: "decision-maker-openai",
    cardId: "AMUX-12",
    questionRevision: 3,
    session: "claude-impl",
    messageId: `dm-answer:${REQUEST_ID}`,
    message:
      "[Decision Maker decision-maker-openai (GPT-6 Astra) 제안, operator-confirmed, re AMUX-12]\nUse the model id only.\n\n" +
      DM_DELIVERY_NOT_AN_APPROVAL,
  });
  const select = dmDeliveryCandidate({ judgment: judgmentOf(), state: stateOf(), detail: SELECT, bodies: {} });
  assert.equal(select.status, "ready");
  assert.match(select.message, /\n선택지: sqlite\n/);
  const edited = dmDeliveryCandidate({
    judgment: judgmentOf({ judgmentKind: "edit_confirm" }),
    state: stateOf({ closingKind: "edit_confirm" }),
    detail: SELECT,
    bodies: { dm_answer: "the DM's answer", operator_answer: "Use the locale too." },
  });
  assert.equal(edited.status, "ready");
  assert.match(edited.message, /operator-edited, re AMUX-12\]\nUse the locale too\.\n/);
  assert.doesNotMatch(edited.message, /the DM's answer|선택지/);
});

test("a body erased since the confirmation leaves nothing to deliver, and the bridge steps past it", () => {
  for (const [judgment, state, detail] of [
    [judgmentOf(), stateOf(), FREE],
    [judgmentOf({ judgmentKind: "edit_confirm" }), stateOf({ closingKind: "edit_confirm" }), FREE],
  ]) {
    assert.deepEqual(dmDeliveryCandidate({ judgment, state, detail, bodies: {} }), {
      status: "undeliverable",
      requestId: REQUEST_ID,
      judgedAtMs: NOW - 1_000,
      reason: "answer_body_missing",
    });
  }
});

test("no candidate comes from anything but a confirmation that closed its own request", () => {
  // §12's blocking criterion: "운영자 확정 없이는 어떤 DM 출력도 worker에게 전달되지 않는다".
  const bodies = { dm_answer: "Use the model id only.", operator_answer: "Edited." };
  for (const [label, judgment, state, detail] of [
    ["a request with no judgment", judgmentOf(), stateOf({ closingKind: null }), FREE],
    ["a rejected request", judgmentOf(), stateOf({ closingKind: "reject" }), FREE],
    ["a request closed by the router", judgmentOf(), stateOf({ closingKind: "stale_close" }), FREE],
    ["a judgment that is not the closing one", judgmentOf({ judgmentKind: "edit_confirm" }), stateOf({ closingKind: "confirm" }), FREE],
    ["another instance", judgmentOf({ instance: "decision-maker-anthropic" }), stateOf(), FREE],
    ["another request", judgmentOf({ requestId: OTHER_REQUEST }), stateOf(), FREE],
    ["a request routed to the operator", judgmentOf(), stateOf({ route: "operator", instance: null, closingKind: null }), FREE],
    ["an escalation", judgmentOf(), stateOf({ terminalResultKind: "escalate" }), { resultKind: "escalate", outputKind: "escalate", optionId: null }],
    ["no detail", judgmentOf(), stateOf(), null],
    ["a select with no option", judgmentOf(), stateOf(), { ...SELECT, optionId: null }],
    ["no request", judgmentOf(), null, FREE],
  ]) {
    assert.equal(dmDeliveryCandidate({ judgment, state, detail, bodies }), null, label);
  }
  // A rejection never even makes a judgment row the read accepts.
  assert.equal(
    dmDeliveryJudgmentFromRow({ requestId: REQUEST_ID, kind: "reject", instance: "decision-maker-openai", judgedAtEpochMs: 1n }),
    null,
  );
  assert.deepEqual(
    dmDeliveryJudgmentFromRow({ requestId: REQUEST_ID, kind: "edit_confirm", instance: "decision-maker-openai", judgedAtEpochMs: 7n }),
    { requestId: REQUEST_ID, judgmentKind: "edit_confirm", instance: "decision-maker-openai", judgedAtMs: 7 },
  );
});

test("a message over the cap is undeliverable rather than cut", () => {
  const long = "x".repeat(DM_DELIVERY_MESSAGE_MAX_BYTES);
  assert.equal(
    dmDeliveryCandidate({ judgment: judgmentOf(), state: stateOf(), detail: FREE, bodies: { dm_answer: long } }).reason,
    "message_too_long",
  );
});

// ---------------------------------------------------------------------------
// The reads, counted
// ---------------------------------------------------------------------------

const PERMISSIVE = [
  { scope: "kill_switch", value: "off" },
  { scope: "decision-maker-openai", value: "proposal" },
  { scope: "decision-maker-anthropic", value: "proposal" },
];
const KILLED = [{ scope: "kill_switch", value: "on" }, ...PERMISSIVE.slice(1)];

const recordingTx = ({
  switches = PERMISSIVE,
  candidate = { requestId: REQUEST_ID, kind: "confirm", instance: "decision-maker-openai", judgedAtEpochMs: BigInt(NOW - 1_000) },
  request = requestRow(),
  detail = { resultKind: "proposal", outputKind: "free_text", optionId: null, irreversible: false, keyPeriod: dmKeyPeriodOf(NOW), createdAtEpochMs: BigInt(NOW - 2_000) },
  bodies = [{ field: "dm_answer", text: "Use the model id only.", digest: "d".repeat(64), keyPeriod: dmKeyPeriodOf(NOW), createdAtEpochMs: BigInt(NOW - 2_000) }],
  delivery = { judgmentKind: "confirm", delivered: false, outcomeKind: null, resolution: null },
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
      if (sql.includes('SELECT DISTINCT ON ("scope")')) return Promise.resolve(switches);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerDeliveryEvent"')) return Promise.resolve([{ sequence: 12n, createdAtEpochMs: BigInt(NOW + 6) }]);
      // The delivery state read names the judgment table in a subquery too; the candidate read alone has a LIMIT.
      if (sql.includes('FROM "AmuxDecisionMakerJudgment" j') && sql.includes("LIMIT 1")) {
        return Promise.resolve(candidate === null ? [] : [candidate]);
      }
      if (sql.includes('FROM "AmuxDecisionMakerDeliveryEvent" d')) return Promise.resolve([delivery]);
      if (sql.includes("CROSS JOIN LATERAL")) return Promise.resolve(request === null ? [] : [request]);
      if (sql.includes('FROM "AmuxDecisionMakerResultDetail"')) return Promise.resolve(detail === null ? [] : [detail]);
      if (sql.includes('FROM "AmuxDecisionMakerBody"')) return Promise.resolve(bodies);
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

// The route transaction around each operation adds the boundary's setup and
// commit fence (lib/amux/dbBoundary.ts): two more statements.
const BOUNDARY_STATEMENTS = 2;

test("the next confirmation is one statement over the two judgment tables, after the cursor, confirmations only", async () => {
  {
    const { tx, sent } = recordingTx();
    const judgment = await readNextDecisionMakerDeliveryJudgment(tx, { after: null });
    assert.deepEqual(judgment, { requestId: REQUEST_ID, judgmentKind: "confirm", instance: "decision-maker-openai", judgedAtMs: NOW - 1_000 });
    assert.equal(sent.length, 1);
    const [statement] = sent;
    assert.match(statement.sql, /WHERE j\."kind" IN \('confirm', 'edit_confirm'\)/);
    assert.match(statement.sql, /NOT EXISTS \(\s+SELECT 1 FROM "AmuxDecisionMakerDeliveryEvent" d\s+WHERE d\."requestId" = j\."requestId" AND d\."kind" = 'deliver'\s+\)/);
    assert.match(statement.sql, /ORDER BY "judgedAtEpochMs", j\."requestId"\s+LIMIT 1/);
    assert.doesNotMatch(statement.sql, /INSERT|UPDATE|DELETE|'reject'/);
    // The start sorts before every judgment.
    assert.deepEqual(statement.values, [-1, ""]);
  }
  {
    const { tx, sent } = recordingTx();
    await readNextDecisionMakerDeliveryJudgment(tx, { after: { judgedAtMs: 42, requestId: OTHER_REQUEST } });
    assert.deepEqual(sent[0].values, [42, OTHER_REQUEST]);
  }
  {
    const { tx } = recordingTx({ candidate: null });
    assert.equal(await readNextDecisionMakerDeliveryJudgment(tx, { after: null }), null);
  }
  // A row the table could not hold, and a malformed cursor, send nothing further.
  {
    const { tx } = recordingTx({ candidate: { requestId: REQUEST_ID, kind: "reject", instance: "decision-maker-openai", judgedAtEpochMs: 1n } });
    await assert.rejects(readNextDecisionMakerDeliveryJudgment(tx, { after: null }), (error) => error.code === "state_unreadable");
  }
  for (const after of [{ judgedAtMs: -1, requestId: REQUEST_ID }, { judgedAtMs: 1, requestId: "x" }]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      readNextDecisionMakerDeliveryJudgment(tx, { after }),
      (error) => error instanceof DecisionMakerJudgmentWriteError && error.code === "invalid_input",
    );
    assert.equal(sent.length, 0);
  }
});

test("the delivery read reads the kill switch first and nothing else while it is on", async () => {
  {
    const { tx, sent } = recordingTx({ switches: KILLED });
    assert.deepEqual(await readDecisionMakerDeliveryCandidate(tx, { after: null }), { status: "kill_switch_on" });
    assert.equal(sent.length, 1);
    assert.match(sent[0].sql, /SELECT DISTINCT ON \("scope"\)/);
  }
  // An unreadable switch store is not off: nothing is read after it.
  {
    const { tx, sent } = recordingTx({ switches: [{ scope: "kill_switch", value: "maybe" }] });
    await assert.rejects(readDecisionMakerDeliveryCandidate(tx, { after: null }), (error) => error.code === "settings_unreadable");
    assert.equal(sent.length, 1);
  }
  {
    const { tx, sent } = recordingTx({ candidate: null });
    assert.deepEqual(await readDecisionMakerDeliveryCandidate(tx, { after: null }), { status: "none" });
    assert.equal(sent.length, 2);
  }
});

test("a ready candidate is five statements in a read boundary of seven: switches, judgment, request, detail, bodies", async () => {
  const { tx, sent } = recordingTx();
  const candidate = await readDecisionMakerDeliveryCandidate(tx, { after: null });
  assert.equal(candidate.status, "ready");
  assert.equal(candidate.session, "claude-impl");
  assert.equal(sent.length, 5);
  const order = [/SELECT DISTINCT ON \("scope"\)/, /FROM "AmuxDecisionMakerJudgment" j/, /CROSS JOIN LATERAL/, /FROM "AmuxDecisionMakerResultDetail"/, /FROM "AmuxDecisionMakerBody"/];
  order.forEach((pattern, index) => assert.match(sent[index].sql, pattern, String(index)));
  for (const statement of sent) assert.doesNotMatch(statement.sql, /INSERT|UPDATE|DELETE/);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerDeliveryCandidateRead, {
    operation: "decision_maker_delivery_candidate_read",
    prismaCallCeiling: sent.length + BOUNDARY_STATEMENTS,
    isolation: "read",
  });
  // A confirmation the request's state does not close is unreadable, never a candidate.
  {
    const { tx: rejected } = recordingTx({ request: requestRow({ closingKind: "reject" }) });
    await assert.rejects(readDecisionMakerDeliveryCandidate(rejected, { after: null }), (error) => error.code === "state_unreadable");
  }
});

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

test("the decision and the outcome routes' boundaries are their largest operation plus setup and fence", async () => {
  // A ceiling below the count refuses every such write; one above it lets a
  // statement nobody counted run inside the budget.
  const largest = { decision: 0, outcome: 0 };
  for (const key of [null, ["unit", "test", "integrity"].join("-")]) {
    await withIntegrityKey(key, async () => {
      {
        const { tx, sent } = recordingTx();
        assert.equal((await recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID })).recorded, true);
        largest.decision = Math.max(largest.decision, sent.length);
      }
      for (const outcome of ["receipt", "unknown"]) {
        const { tx, sent } = recordingTx({ delivery: { judgmentKind: "confirm", delivered: true, outcomeKind: null, resolution: null } });
        assert.equal((await recordDecisionMakerDeliveryOutcome(tx, { requestId: REQUEST_ID, outcome })).recorded, true, outcome);
        largest.outcome = Math.max(largest.outcome, sent.length);
      }
    });
  }
  assert.deepEqual(largest, { decision: 8, outcome: 7 });
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerDeliveryDecision, {
    operation: "decision_maker_delivery_decision",
    prismaCallCeiling: largest.decision + BOUNDARY_STATEMENTS,
    isolation: "mutation",
  });
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerDeliveryOutcome, {
    operation: "decision_maker_delivery_outcome",
    prismaCallCeiling: largest.outcome + BOUNDARY_STATEMENTS,
    isolation: "mutation",
  });
  for (const ceiling of [largest.decision + BOUNDARY_STATEMENTS, largest.outcome + BOUNDARY_STATEMENTS, 7]) {
    assert.ok(ceiling <= 12, "§9's budget");
  }
  // The decision reads the kill switch under the lock and refuses while it is on.
  const { tx, sent } = recordingTx({ switches: KILLED });
  assert.deepEqual(await recordDecisionMakerDelivery(tx, { requestId: REQUEST_ID }), { recorded: false, reason: "kill_switch_on" });
  assert.ok(!sent.some((statement) => statement.kind === "create" || /INSERT/.test(statement.sql ?? "")));
});

test("the delivery read and route hold no SQL, no table name and no log of the message", () => {
  for (const path of [
    "lib/amux/decisionMakerDeliveryRead.ts",
    "lib/amux/decisionMakerDeliveryCore.ts",
    "lib/amux/decisionMakerDeliveryRoute.ts",
    "app/api/internal/amux/decision-maker/deliveries/next/route.ts",
    "app/api/internal/amux/decision-maker/deliveries/route.ts",
    "app/api/internal/amux/decision-maker/deliveries/outcome/route.ts",
  ]) {
    const source = read(path);
    // A call or a tagged template; the read's client type names `"$queryRaw"` as a key.
    assert.doesNotMatch(source, /\$(queryRaw|executeRaw)(Unsafe)?\s*(<|`|\()|"AmuxDecisionMaker[A-Za-z]+"/, path);
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\([^)]*message/, path);
  }
  // Each route answers the disabled switch before it reads its body.
  for (const path of [
    "app/api/internal/amux/decision-maker/deliveries/next/route.ts",
    "app/api/internal/amux/decision-maker/deliveries/route.ts",
    "app/api/internal/amux/decision-maker/deliveries/outcome/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.indexOf("dmInternalRoutesEnabled()") < source.indexOf("readLimitedJson("), path);
    assert.ok(source.indexOf("isAmuxSyncAuthorized(request)") < source.indexOf("dmInternalRoutesEnabled()"), path);
  }
});
