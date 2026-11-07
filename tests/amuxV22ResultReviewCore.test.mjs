import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { irreversibleTermCategories } from "../lib/amux/decisionMakerCore.ts";
import {
  AMUX_V22_RESULT_REVIEW_KINDS,
  AMUX_V22_RESULT_REVIEW_KIND_TEXT,
  amuxDmApproverEnabled,
  amuxDmProposalAutoApplicable,
  amuxV22ResultReviewDecisionFromAnswer,
  amuxV22ResultReviewDmEnabled,
  amuxV22ResultReviewKind,
  amuxV22ResultReviewRelayCard,
  amuxV22ResultReviewTarget,
} from "../lib/amux/v22ResultReviewCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("both switches are off unless set to enabled", () => {
  assert.equal(amuxV22ResultReviewDmEnabled({}), false);
  assert.equal(amuxV22ResultReviewDmEnabled({ TOMVERSE_AMUX_V22_RESULT_REVIEW_DM: "true" }), false);
  assert.equal(amuxV22ResultReviewDmEnabled({ TOMVERSE_AMUX_V22_RESULT_REVIEW_DM: "enabled" }), true);
  assert.equal(amuxDmApproverEnabled({}), false);
  assert.equal(amuxDmApproverEnabled({ TOMVERSE_AMUX_DM_APPROVER: "enabled" }), true);
});

test("only a result with no patch is put to review, and its kind says why", () => {
  const base = { executionRole: "investigate", writesPatch: false, patchPresent: false };
  assert.equal(amuxV22ResultReviewKind({ ...base, conclusionVerdict: "needs_owner" }), "needs_owner");
  assert.equal(amuxV22ResultReviewKind({ ...base, conclusionVerdict: null }), "conclusion_invalid",
    "a wrong or missing conclusion keeps the review path");
  assert.equal(amuxV22ResultReviewKind({ ...base, conclusionVerdict: "proceed" }), "result_review",
    "while the switch is prompt, a verdict still waits for review");
  assert.equal(amuxV22ResultReviewKind({ executionRole: "design", writesPatch: false, patchPresent: false,
    conclusionVerdict: null }), "result_review");
  assert.equal(amuxV22ResultReviewKind({ executionRole: "implement", writesPatch: true, patchPresent: false,
    conclusionVerdict: null }), "prless_implement");
  assert.equal(amuxV22ResultReviewKind({ executionRole: "implement", writesPatch: true, patchPresent: true,
    conclusionVerdict: null }), null, "a patch keeps its pull request evidence");
});

test("the card's fixed words hit no routing term, so it reaches a DM", () => {
  for (const kind of AMUX_V22_RESULT_REVIEW_KINDS) {
    const card = amuxV22ResultReviewRelayCard({ reviewId: "00000000-0000-4000-8000-00000000000a",
      taskLabel: "AMUX-AUTOFILE-004", role: "investigate", kind,
      criteria: ["The cause is named"], findings: "Found it." });
    const text = [card.title, card.question, card.unblocks, ...card.options.map((option) => option.label)].join("\n");
    assert.deepEqual(irreversibleTermCategories(text), [], kind);
    assert.ok(card.question.includes(AMUX_V22_RESULT_REVIEW_KIND_TEXT[kind]));
    assert.ok(!card.question.includes(kind), `${kind} is not written as a code`);
    assert.deepEqual(card.options.map((option) => option.id), ["approve", "retry", "block"]);
    assert.equal(card.worker, "amux-result-review");
    assert.equal(card.provider, "claude");
  }
  const whole = amuxV22ResultReviewRelayCard({ reviewId: "00000000-0000-4000-8000-00000000000a",
    taskLabel: "T", role: null, kind: "needs_owner", criteria: ["A", "B"], findings: "done" });
  assert.match(whole.question, /Its completion criteria:\n- A\n- B\nIts findings: done/);
  for (const [criteria, findings] of [[["A"], "x".repeat(2_000)], [[], "done"], [["A"], " "]])
    assert.equal(amuxV22ResultReviewRelayCard({ reviewId: "00000000-0000-4000-8000-00000000000a",
      taskLabel: "T", role: null, kind: "needs_owner", criteria, findings }), null,
      "evidence that does not fit whole, or is missing, is left to the person");
});

test("an answer decides only by its fixed words, with the delivery's precedence", () => {
  assert.equal(amuxV22ResultReviewDecisionFromAnswer({ judgmentKind: "confirm", outputKind: "select",
    optionId: "approve" }), "approve");
  assert.equal(amuxV22ResultReviewDecisionFromAnswer({ judgmentKind: "confirm", outputKind: "free_text",
    optionId: null, dmAnswer: " Retry " }), "retry");
  assert.equal(amuxV22ResultReviewDecisionFromAnswer({ judgmentKind: "edit_confirm", outputKind: "select",
    optionId: "approve", operatorAnswer: "차단" }), "block", "the person's edit wins");
  assert.equal(amuxV22ResultReviewDecisionFromAnswer({ judgmentKind: "confirm", outputKind: "free_text",
    optionId: null, dmAnswer: "approve it, I think" }), null, "anything else goes to a person");
  assert.equal(amuxV22ResultReviewTarget("approve"), "done");
  assert.equal(amuxV22ResultReviewTarget("retry"), "todo");
  assert.equal(amuxV22ResultReviewTarget("block"), "blocked");
});

test("the DM may apply alone only a select or free-text proposal it did not mark irreversible", () => {
  assert.equal(amuxDmProposalAutoApplicable({ resultKind: "proposal", outputKind: "select", irreversible: false }), true);
  assert.equal(amuxDmProposalAutoApplicable({ resultKind: "proposal", outputKind: "free_text", irreversible: false }), true);
  assert.equal(amuxDmProposalAutoApplicable({ resultKind: "proposal", outputKind: "select", irreversible: true }), false);
  assert.equal(amuxDmProposalAutoApplicable({ resultKind: "proposal", outputKind: "select", irreversible: null }), false);
  assert.equal(amuxDmProposalAutoApplicable({ resultKind: "escalate", outputKind: null, irreversible: null }), false);
  assert.equal(amuxDmProposalAutoApplicable(null), false);
});

test("applying a review: system resolution in one transaction through the chain writer, block keeps the person", () => {
  const source = read("lib/amux/v22ResultReviewService.ts");
  assert.match(source, /await takeAuditChainLock\(tx\);\s+let killSwitch/, "the chain lock, then the kill switch");
  assert.match(source, /if \(killSwitch !== false\) return \{ applied: false as const, outcome: null \};/);
  assert.match(source, /\.\.\.\(target === "done" \? \{ v4TerminalAt: input\.now \} : \{\}\)/);
  assert.match(source, /if \(target !== "blocked"\)\s+await tx\.amuxHumanEscalation\.updateMany/,
    "a block leaves the person's escalation open");
  assert.match(source, /resolvedById: AMUX_V22_RESULT_REVIEW_RESOLVER/, "the system resolves, never a borrowed person");
  assert.match(source, /AMUX_V22_RESULT_REVIEW_RESOLVER = "system:amux-v22-result-review"/);
  assert.match(source, /settlementDestinationForBudget\(\{ requested_status: "todo"/, "a retry stays inside the attempt budget");
  assert.match(source, /row\.newestAttemptId !== row\.attemptId/, "a Task that ran again cancels the review");
  assert.match(source, /writeSystemAuditLog\(\{ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,\s+action: AMUX_V22_RESULT_REVIEW_APPLIED_ACTION/);
  assert.doesNotMatch(source, /adminAuditLog\./);
});

test("settlement files a review only behind its switch, beside the person's escalation", () => {
  const source = read("lib/amux/execution.ts");
  assert.match(source, /const resultReviewKind = resultReviewDm && humanReview && !questionPlan &&/);
  assert.match(source, /if \(\(humanReview \|\| next === "blocked"\) &&\s+\(!questionPlan \|\| questionPlan\.openEscalation\)\)\s+await openAmuxHumanEscalation/,
    "the human escalation still opens first");
});

test("the DM approver: behind its switch, irreversible stays human, answers are applied as dm and the request closed after", () => {
  const source = read("lib/amux/dmAutoApplyService.ts");
  assert.match(source, /if \(!amuxDmApproverEnabled\(env\)\) return null;/);
  assert.match(source, /amuxDmProposalAutoApplicable\(\{ resultKind: "proposal",\s+outputKind: detail\.outputKind, irreversible: detail\.irreversible \}\)/);
  assert.match(source, /state\.closing !== null/, "a judged or closed request is never applied again");
  assert.equal((source.match(/source: "dm"/g) ?? []).length, 4, "each of the four question types records dm");
  const close = source.indexOf("closeDecisionMakerRequestOnDirectAnswer(tx");
  assert.ok(close > 0 && close < source.indexOf("applyAmuxV22DmAnswer(tx"),
    "the request is closed first, under the chain lock, so a judgment that came first wins");
  assert.match(source, /withAmuxDbBoundary\(AMUX_DB_BOUNDARIES\.decisionMakerAutoApply,\s+async \(tx, context\) => \{\s+const claimed = await closeDecisionMakerRequestOnDirectAnswer\(tx,/,
    "claim and answer in one transaction: a failed answer rolls the claim back");
  assert.match(source, /if \(!effect\) throw new AmuxDmAutoApplyHeld\(\);/);
  const store = read("lib/amux/decisionMakerRequestStore.ts");
  const open = store.slice(store.indexOf("export async function readNextDecisionMakerOpenProposal"));
  assert.match(open.slice(0, 2_000), /ORDER BY random\(\)/, "one it may not apply never holds back the others");
  assert.match(open.slice(0, 2_000), /'confirm', 'edit_confirm', 'reject'/, "a judged request is not open");
  const migration = read("prisma/migrations/20261107140000_amux_v22_result_conclusion_dm_review/migration.sql");
  for (const table of ["AmuxV22TaskQuestion", "AmuxIdeaCardCloseQuestion"])
    assert.match(migration, new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?'operator', 'dm_confirmed', 'dm'`), table);
  assert.match(migration, /"decisionSource" IN \('dm_confirmed', 'dm'\) AND "decidedByUserId" IS NULL/);
});

test("the policy says which approvals stay with a person", () => {
  const contract = read("docs/policy/amux-agent-approval-contract.md");
  for (const phrase of ["실제 돈이 나가는", "외부 게시와", "사용자 데이터 삭제", "자격증명과 보안 경계", "production 병합과 배포"])
    assert.ok(contract.includes(phrase), phrase);
  assert.ok(!contract.includes("요청 Agent나\n시스템 actor는 승인자가 될 수 없고"), "the system-actor ban is lifted");
  const dm = read("docs/policy/amux-decision-maker.md");
  assert.match(dm, /## 0a\. 운영자 결정 \(2026-11-07\)/);
});
