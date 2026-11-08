// A v22 worker question's Decision Maker state on its card (owner decision
// 2026-10-30: the Decision Maker proposes, the operator only confirms;
// 2026-11-08: the card showed an empty answer box with no proposal).
//
// The questions: each fact names one state in one order; a proposal is
// confirmable only with every value a confirmation must name; the read writes
// nothing and applies nothing; and the result route reads it only for an open
// question and shows its bodies only to a person who may judge them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminAmuxCardsMessages } from "../lib/adminMessages/amuxCards.ts";
import { DM_ROUTING_REFUSAL_CODES } from "../lib/amux/decisionMakerRequestCore.ts";
import {
  AMUX_V22_QUESTION_DM_NOT_SENT_REASONS,
  amuxV22QuestionDmNotSentReason,
  amuxV22QuestionDmOfDetail,
  amuxV22QuestionDmPending,
} from "../lib/amux/v22OwnerQuestionDmCore.ts";

const NOW = Date.UTC(2026, 10, 8, 8, 0, 0);
const REQUEST_ID = "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b";
const SHOWN = {
  answerDigest: null, rationaleDigest: "3".repeat(64), optionId: "b", irreversible: false,
  snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null,
};

/** A parsed ledger row (decisionMakerAdminCore DmAdminRequestRow): routed to a DM, assigned. */
const row = (overrides = {}) => ({
  requestId: REQUEST_ID, cardId: "CC-301", questionRevision: 1, askingWorkerId: "codex-impl",
  askingProvider: "codex", route: "dm_proposal", instance: "decision-maker-openai", refusalCodes: [],
  createdAtMs: NOW - 60_000, assignmentDeadlineAtMs: NOW + 60_000, assigned: true, snapshotState: null,
  transmitOutcome: null, resultKind: null, resultUnknown: false, closingKind: null, outputKind: null,
  irreversible: null, declarationAccuracy: null, delivered: false, deliveryOutcome: null,
  deliveryNotSentReason: null, deliveryResolution: null, cleanupUnknownAtMs: null, ...overrides,
});
const detail = (overrides = {}, extra = {}) => ({
  dbNowMs: NOW, row: row(overrides), answer: null, optionId: null, rationale: null,
  escalationReason: null, shown: null,
  card: { contextPaths: ["lib/amux/fileRetry.ts"], options: [{ paths: [] }, { paths: ["lib/amux/fileRetry.ts", "lib/amux/retryModel.ts"] }] },
  ...extra,
});

test("a question with no local card says the first thing that holds it", () => {
  const all = { routingEnabled: true, killSwitch: false, hasProvider: true };
  assert.equal(amuxV22QuestionDmNotSentReason(all), "waiting_relay");
  assert.equal(amuxV22QuestionDmNotSentReason({ ...all, hasProvider: false }), "no_provider");
  assert.equal(amuxV22QuestionDmNotSentReason({ ...all, killSwitch: true, hasProvider: false }), "kill_switch");
  assert.equal(amuxV22QuestionDmNotSentReason({ ...all, killSwitch: null }), "switches_unreadable");
  assert.equal(amuxV22QuestionDmNotSentReason({ ...all, routingEnabled: false, killSwitch: true }), "routing_off");
});

test("a filed question's state follows its card's newest request", () => {
  assert.deepEqual(amuxV22QuestionDmOfDetail(null), { state: "filed" });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ route: "operator", assigned: false, refusalCodes: ["irreversible_term"] })),
    { state: "with_operator", requestId: REQUEST_ID, reasons: ["irreversible_term"] });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ snapshotState: "none" })), { state: "working", requestId: REQUEST_ID });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ resultKind: "escalate" }, { escalationReason: "Needs the product owner." })),
    { state: "cannot_answer", requestId: REQUEST_ID, reason: "Needs the product owner." });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ resultKind: "timeout" })), { state: "failed", requestId: REQUEST_ID, status: "timeout" });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ assigned: false, assignmentDeadlineAtMs: NOW - 1 })),
    { state: "failed", requestId: REQUEST_ID, status: "assignment_expired" });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ resultKind: "proposal", closingKind: "confirm" })), { state: "confirmed", requestId: REQUEST_ID });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ resultKind: "proposal", closingKind: "edit_confirm" })), { state: "confirmed", requestId: REQUEST_ID });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ resultKind: "proposal", closingKind: "reject" })), { state: "rejected", requestId: REQUEST_ID });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail({ resultKind: "proposal", closingKind: "stale_close" })),
    { state: "closed", requestId: REQUEST_ID, status: "stale_close" });
});

test("a proposal is confirmable only with its rationale and the values a confirmation names", () => {
  const proposal = { resultKind: "proposal", outputKind: "select", irreversible: false };
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail(proposal, { optionId: "b", rationale: "Keeps the trailer small.", shown: SHOWN })), {
    state: "proposal", requestId: REQUEST_ID, answer: null, optionId: "b", rationale: "Keeps the trailer small.",
    irreversible: false, snapshot: { state: "none", targetSha: null, paths: ["lib/amux/fileRetry.ts", "lib/amux/retryModel.ts"] },
    shown: SHOWN,
  });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail(proposal, { optionId: "b", rationale: "Why.", shown: null })),
    { state: "failed", requestId: REQUEST_ID, status: "proposal_unreadable" });
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail(proposal, { optionId: "b", rationale: null, shown: SHOWN })),
    { state: "failed", requestId: REQUEST_ID, status: "proposal_unreadable" });
  // The snapshot shown is the one the confirmation names; its paths are the card's, once each.
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const atHead = amuxV22QuestionDmOfDetail(detail(proposal, { rationale: "Why.",
    shown: { ...SHOWN, snapshotState: "worker_head", snapshotTargetSha: sha, snapshotManifestDigest: "b".repeat(64) } }));
  assert.deepEqual(atHead.snapshot, { state: "worker_head", targetSha: sha,
    paths: ["lib/amux/fileRetry.ts", "lib/amux/retryModel.ts"] });
  // A snapshot whose paths cannot be listed (the card text is gone) is not confirmable here; card only still is.
  assert.deepEqual(amuxV22QuestionDmOfDetail(detail(proposal, { rationale: "Why.", card: null,
    shown: { ...SHOWN, snapshotState: "develop", snapshotTargetSha: sha } })),
  { state: "failed", requestId: REQUEST_ID, status: "proposal_unreadable" });
  assert.equal(amuxV22QuestionDmOfDetail(detail(proposal, { rationale: "Why.", card: null, shown: SHOWN })).state, "proposal");
  // The irreversible mark the card warns about is the one the confirmation names.
  const marked = amuxV22QuestionDmOfDetail(detail(proposal, { rationale: "Why.", shown: { ...SHOWN, irreversible: true } }));
  assert.equal(marked.irreversible, true);
});

test("only a state still on the Decision Maker's path counts as pending", () => {
  assert.equal(amuxV22QuestionDmPending({ state: "proposal" }), true);
  assert.equal(amuxV22QuestionDmPending({ state: "not_sent", reason: "waiting_relay" }), true);
  assert.equal(amuxV22QuestionDmPending({ state: "not_sent", reason: "routing_off" }), false);
  assert.equal(amuxV22QuestionDmPending({ state: "cannot_answer", reason: null }), false);
  assert.equal(amuxV22QuestionDmPending({ state: "rejected" }), false);
});

test("every state, reason and routing refusal has words in both locales", () => {
  const states = [
    ...AMUX_V22_QUESTION_DM_NOT_SENT_REASONS.map((reason) => ({ state: "not_sent", reason })),
    { state: "filed" }, { state: "with_operator", reasons: ["instance_off"] }, { state: "working" },
    { state: "proposal" }, { state: "cannot_answer", reason: null }, { state: "cannot_answer", reason: "Ask the owner." },
    { state: "failed", status: "timeout" }, { state: "confirmed" }, { state: "rejected" },
    { state: "closed", status: "stale_close" }, { state: "restricted" }, { state: "unavailable" },
  ];
  for (const locale of ["en", "ko"]) {
    const m = adminAmuxCardsMessages[locale];
    for (const dm of states) {
      const line = m.dmState(dm, (code) => m.dmReasons[code] ?? code);
      assert.equal(typeof line, "string", `${locale} ${JSON.stringify(dm)}`);
      assert.ok(line.length > 0);
    }
    for (const code of DM_ROUTING_REFUSAL_CODES) assert.ok(m.dmReasons[code], `${locale} ${code}`);
  }
  assert.equal(adminAmuxCardsMessages.ko.dmConfirm, "이대로 확인");
  assert.match(adminAmuxCardsMessages.ko.dmState({ state: "not_sent", reason: "waiting_relay" }, String), /DM에 아직 전달되지 않았어요/);
  assert.match(adminAmuxCardsMessages.ko.dmState({ state: "cannot_answer", reason: null }, String), /DM이 답할 수 없다고 했어요/);
});

test("the read writes nothing, applies nothing, and reads the Decision Maker only through its own stores", () => {
  const read = readFileSync("lib/amux/v22OwnerQuestionDmRead.ts", "utf8");
  assert.doesNotMatch(read, /\$executeRaw|\$queryRaw|\.update\(|\.updateMany\(|\.create\(|\.upsert\(|\.delete/);
  assert.doesNotMatch(read, /"AmuxDecisionMaker/);
  assert.doesNotMatch(read, /applyAmuxV22DmAnswer|answerAmuxV22OwnerQuestion|recordDecisionMakerJudgment|runAmuxV22ResolveStep/);
  assert.match(read, /AMUX_DB_BOUNDARIES\.decisionMakerRequestDetailRead/);
  assert.match(read, /readDecisionMakerCardDetailForAdmin/);
  const core = readFileSync("lib/amux/v22OwnerQuestionDmCore.ts", "utf8");
  assert.doesNotMatch(core, /^import (?!type )[^;]*(prisma|server-only|fetch)/m);
});

test("the result route reads the state only for an open question, and its bodies only for ops:write", () => {
  const route = readFileSync("app/api/admin/amux/v22-task-result/route.ts", "utf8");
  // The route itself stays owner-only, read-only and step-up guarded.
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(route, /question\?\.state !== "open" \? null :/);
  assert.match(route, /hasAdminPermission\(session, "ops:write"\) \?\s*await readAmuxV22QuestionDm\(question\.id\) : \{ state: "restricted" as const \}/);
});

test("the card confirms through the existing judgment route and applies nothing itself", () => {
  const card = readFileSync("components/admin/AmuxWorkerQuestion.tsx", "utf8");
  assert.match(card, /const JUDGMENT_PATH = "\/api\/admin\/amux\/decision-maker\/judgments";/);
  assert.match(card, /dmJudgmentBody\(dm\.requestId, "confirm", dm\.shown,/);
  assert.match(card, /runDmJudgment\(amuxWorkerQuestionDmConfirmBody\(dm\), send,/);
  assert.doesNotMatch(card, /decision-maker\/v22-questions|applyAmuxV22DmAnswer/);
});
