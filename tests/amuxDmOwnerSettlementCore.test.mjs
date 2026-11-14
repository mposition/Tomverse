import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { irreversibleTermCategories } from "../lib/amux/decisionMakerCore.ts";
import {
  AMUX_DM_OWNER_SETTLEMENT_QUESTION_MAX,
  AMUX_DM_OWNER_SETTLEMENT_REASON_TEXT,
  amuxDmOwnerSettlementAnswerOf,
  amuxDmOwnerSettlementCard,
  amuxDmOwnerSettlementEnabled,
  amuxDmOwnerSettlementId,
  amuxDmOwnerSettlementKind,
  amuxDmOwnerSettlementMoved,
  amuxDmOwnerSettlementReasonText,
  amuxDmOwnerSettlementRemakeRequestId,
  isAmuxDmOwnerSettlementId,
} from "../lib/amux/dmOwnerSettlementCore.ts";
import { isAmuxIdeaRequestId } from "../lib/amux/ideaRequestIdCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const PATCH = [
  "diff --git a/lib/amux/routerFailure.ts b/lib/amux/routerFailure.ts",
  "--- a/lib/amux/routerFailure.ts",
  "+++ b/lib/amux/routerFailure.ts",
  "@@ -1,2 +1,3 @@",
  " export const a = 1;",
  "+export const b = 2;",
  "diff --git a/tests/routerFailure.test.mjs b/tests/routerFailure.test.mjs",
  "--- a/tests/routerFailure.test.mjs",
  "+++ b/tests/routerFailure.test.mjs",
  "@@ -0,0 +1 @@",
  "+// covered",
].join("\n");

const base = {
  settlementId: amuxDmOwnerSettlementId("escalation-1"),
  taskLabel: "AMUX-ROUTERFAIL2-002",
  title: "Name the router failure",
  role: "implement",
  grade: "routine",
  taskStatus: "blocked",
  reason: "review_server_rejected_twice",
  criteria: ["The failure is named", "The caller uses it"],
  findings: "Added the function; the caller is in the next card.",
  rejections: 2,
  siblings: [
    { label: "AMUX-ROUTERFAIL2-003", title: "Use the name", status: "backlog", waitsOnThis: true },
    { label: "AMUX-ROUTERFAIL2-004", title: null, status: "backlog", waitsOnThis: true },
  ],
  siblingTotal: 2,
  pull: null,
};

test("the switch is off unless it says enabled", () => {
  assert.equal(amuxDmOwnerSettlementEnabled({}), false);
  assert.equal(amuxDmOwnerSettlementEnabled({ TOMVERSE_AMUX_DM_OWNER_SETTLEMENT: "true" }), false);
  assert.equal(amuxDmOwnerSettlementEnabled({ TOMVERSE_AMUX_DM_OWNER_SETTLEMENT: "enabled" }), true);
});

test("a settlement id is a version 8 UUID of its escalation; every other question id is version 4", () => {
  const id = amuxDmOwnerSettlementId("cmw-escalation");
  assert.equal(id, amuxDmOwnerSettlementId("cmw-escalation"), "one escalation, one settlement");
  assert.notEqual(id, amuxDmOwnerSettlementId("cmw-escalation-2"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isAmuxDmOwnerSettlementId(id), true);
  assert.equal(isAmuxDmOwnerSettlementId(crypto.randomUUID()), false, "randomUUID is version 4");
  const migration = read("prisma/migrations/20261113200000_amux_dm_owner_settlement/migration.sql");
  assert.match(migration, /"id" ~ '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-8\[0-9a-f\]\{3\}-\[89ab\]/,
    "the table admits only that shape");
  const remake = amuxDmOwnerSettlementRemakeRequestId(id, "One idea");
  assert.equal(isAmuxIdeaRequestId(remake), true, "the idea intake takes the remake's request id");
  assert.equal(remake, amuxDmOwnerSettlementRemakeRequestId(id, "One idea"), "a lost answer reads the same idea back");
  assert.notEqual(remake, amuxDmOwnerSettlementRemakeRequestId(id, "Another idea"));
});

test("only a review draft pull request is t2_pr; an ordinary open pull request or engineering work in flight is not filed", () => {
  assert.equal(amuxDmOwnerSettlementKind({ openBinding: "review_draft", engineeringInFlight: false }), "t2_pr");
  assert.equal(amuxDmOwnerSettlementKind({ openBinding: null, engineeringInFlight: false }), "stopped");
  assert.equal(amuxDmOwnerSettlementKind({ openBinding: "other", engineeringInFlight: false }), null);
  assert.equal(amuxDmOwnerSettlementKind({ openBinding: null, engineeringInFlight: true }), null);
  const scan = read("lib/amux/dmOwnerSettlementRead.ts");
  for (const held of [/"AmuxV22ResultReview" v WHERE v\."taskId" = w\."id"\s+AND \(v\."state" = 'open'/,
    /"AmuxV22TaskQuestion" q\s+WHERE q\."taskId" = w\."id" AND q\."state" IN \('open', 'answered'\)/,
    /"AmuxIdeaSessionPlanRefusal" f ON f\."ideaId" = u\."ideaId"/,
    /"AmuxIdeaCardCloseQuestion" c ON c\."ideaId" = u\."ideaId"/,
    /NOT EXISTS \(SELECT 1 FROM "AmuxDmOwnerSettlement" s WHERE s\."escalationId" = e\."id"\)/,
    /x\."endedAt" IS NULL/,
    /w\."v22ReceiptId" IS NOT NULL AND w\."taskRole" IS NOT NULL AND w\."executionGrade" IS NOT NULL/])
    assert.match(scan, held, String(held));
  const sql = [...scan.matchAll(/\$queryRaw<[\s\S]*?>`([\s\S]*?)`/g)].map((match) => match[1]).join("\n");
  assert.match(sql, /"EngineeringAgentBinding"/);
  assert.doesNotMatch(sql.toLowerCase(), /\b(insert|update|delete|merge|upsert|truncate|alter|drop)\b/,
    "the engineering reads only read (scripts/check-protected-table-writers-core.mjs)");
});

test("a settlement stands only while its Task is where it was filed, with nothing running and its escalation open", () => {
  const facts = { taskStatus: "blocked", attemptId: "a1", status: "blocked", sourceSystem: "admin-idea-v4",
    archivedAt: null, lastAttempt: { id: "a1" }, activeDelivery: false, liveAttempt: false, escalationOpen: true };
  assert.equal(amuxDmOwnerSettlementMoved(facts), null);
  for (const [change, reason] of [[{ status: "todo" }, "task_moved"], [{ archivedAt: new Date() }, "task_moved"],
    [{ lastAttempt: { id: "a2" } }, "task_moved"], [{ lastAttempt: null }, "task_moved"],
    [{ activeDelivery: true }, "task_moved"], [{ liveAttempt: true }, "task_moved"],
    [{ sourceSystem: "tomverse_private_workboard" }, "task_moved"],
    [{ escalationOpen: false, status: "todo" }, "escalation_resolved"]])
    assert.equal(amuxDmOwnerSettlementMoved({ ...facts, ...change }), reason, JSON.stringify(change));
  assert.equal(amuxDmOwnerSettlementMoved({ ...facts, attemptId: null, lastAttempt: null }), null,
    "a Task that never ran stands while it still has not");
});

test("the card's fixed words hit no routing term, so it reaches a DM", () => {
  for (const [reason, sentence] of [...Object.entries(AMUX_DM_OWNER_SETTLEMENT_REASON_TEXT), ["anything_else", null]]) {
    const text = sentence ?? amuxDmOwnerSettlementReasonText(reason);
    assert.deepEqual(irreversibleTermCategories(text), [], reason);
    for (const kind of ["stopped", "t2_pr"]) {
      const card = amuxDmOwnerSettlementCard({ ...base, kind, reason, title: "T", criteria: ["Done"],
        findings: "Found it.", siblings: [{ label: "L-1", title: "S", status: "backlog", waitsOnThis: true }],
        siblingTotal: 1,
        pull: kind === "t2_pr" ? { number: 12, patch: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b" } : null });
      assert.ok(card, `${kind} ${reason}`);
      const words = [card.title, card.question, card.unblocks, ...card.options.map((option) => option.label)]
        .join("\n");
      assert.deepEqual(irreversibleTermCategories(words), [], `${kind} ${reason}`);
      assert.ok(card.question.includes(text));
      assert.ok(!card.question.includes(reason), `${reason} is not written as a code`);
      assert.equal(card.worker, "amux-owner-settlement");
      assert.equal(card.provider, "claude");
      assert.equal(card.question_id, base.settlementId);
    }
  }
});

test("a stopped Task's card carries its evidence, marked, and cuts it to fit (AMUXFLOW/B2)", () => {
  const card = amuxDmOwnerSettlementCard({ ...base, kind: "stopped" });
  assert.deepEqual(card.options.map((option) => option.id), ["retry", "complete", "close"]);
  assert.match(card.question, /Task: AMUX-ROUTERFAIL2-002 "Name the router failure" \(implement Task, grade routine, now blocked\)/);
  assert.match(card.question, /Its completion criteria:\n- The failure is named\n- The caller uses it\n/);
  assert.match(card.question, /Its findings: Added the function; the caller is in the next card\./);
  assert.match(card.question, /rejected its change 2 times; the rejection findings are kept by the review server/);
  assert.match(card.question, /Other cards under the same parent \(2\):\n- AMUX-ROUTERFAIL2-003 \(backlog, waits on this card\): Use the name\n- AMUX-ROUTERFAIL2-004 \(backlog, waits on this card\)\n/);
  assert.match(card.question, /the word remake on the first line, then the new idea/);
  assert.match(amuxDmOwnerSettlementCard({ ...base, kind: "stopped", findings: null }).question,
    /Its run left no result to read\./, "a run that left no result says so");
  assert.equal(amuxDmOwnerSettlementCard({ ...base, kind: "stopped", criteria: [] }), null,
    "no approved criteria: the person decides");
  assert.ok(card.question.includes("[evidence]\nIts findings: Added the function; the caller is in the next card.\n[/evidence]"),
    "the run's words are an evidence block the term check can skip");
  const long = amuxDmOwnerSettlementCard({ ...base, kind: "stopped",
    findings: "x".repeat(AMUX_DM_OWNER_SETTLEMENT_QUESTION_MAX) });
  assert.ok(long, "long findings no longer leave the card unfiled");
  assert.ok(long.question.length <= AMUX_DM_OWNER_SETTLEMENT_QUESTION_MAX);
  assert.ok(long.question.includes("x (cut to fit this card)\n[/evidence]"));
  const many = Array.from({ length: 11 }, (_, index) => ({ label: `L-${index}`, title: "t".repeat(200),
    status: "todo", waitsOnThis: false }));
  const listed = amuxDmOwnerSettlementCard({ ...base, kind: "stopped", siblings: many, siblingTotal: 11 });
  assert.match(listed.question, /\(3 more are not shown\.\)/);
  assert.ok(listed.question.split("\n").every((line) => line.length < 300), "sibling titles are shortened");
});

test("a review pull request's card always lists its files and shows whole diffs while they fit", () => {
  const card = amuxDmOwnerSettlementCard({ ...base, kind: "t2_pr", taskStatus: "review",
    reason: "human_review_required", rejections: 0, pull: { number: 3812, patch: PATCH } });
  assert.deepEqual(card.options.map((option) => option.id), ["approve", "retry", "close"]);
  assert.match(card.question, /Pull request #3812, files \(2\):\n- lib\/amux\/routerFailure\.ts \(\+1 -0\)\n- tests\/routerFailure\.test\.mjs \(\+1 -0\)/);
  assert.ok(card.question.includes("Patch:\n[evidence]\ndiff --git a/lib/amux/routerFailure.ts"));
  assert.ok(card.question.includes("[/evidence]\nShould the pull request be approved"));
  assert.ok(!card.question.includes("more file diffs"));
  assert.ok(!card.question.includes("remake"), "a pull request is not remade");
  const big = `${PATCH}\n${["diff --git a/big.ts b/big.ts", "@@ -0,0 +1 @@", `+${"z".repeat(1_900)}`].join("\n")}`;
  const cut = amuxDmOwnerSettlementCard({ ...base, kind: "t2_pr", pull: { number: 1, patch: big } });
  assert.match(cut.question, /- big\.ts \(\+1 -0\)/, "every file is listed");
  assert.match(cut.question, /\(1 more file diffs are not shown\.\)/);
  assert.ok(cut.question.length <= AMUX_DM_OWNER_SETTLEMENT_QUESTION_MAX);
  const longFindings = amuxDmOwnerSettlementCard({ ...base, kind: "t2_pr", findings: "f".repeat(1_700),
    pull: { number: 1, patch: PATCH } });
  assert.match(longFindings.question, /Its run's report does not fit this card; judge it from the patch\./);
  assert.equal(amuxDmOwnerSettlementCard({ ...base, kind: "t2_pr", pull: { number: 1, patch: null } }), null,
    "a pull request whose patch cannot be read is left to the person");
  assert.equal(amuxDmOwnerSettlementCard({ ...base, kind: "t2_pr", pull: null }), null);
});

test("an answer decides only by its kind's fixed words, with the delivery's precedence", () => {
  const ask = (kind, over) => amuxDmOwnerSettlementAnswerOf({ kind, judgmentKind: "confirm",
    outputKind: "select", optionId: null, ...over });
  assert.deepEqual(ask("stopped", { optionId: "retry" }), { decision: "retry" });
  assert.deepEqual(ask("stopped", { optionId: "complete" }), { decision: "complete" });
  assert.deepEqual(ask("t2_pr", { optionId: "approve" }), { decision: "approve" });
  assert.equal(ask("t2_pr", { optionId: "complete" }), null, "a pull request is never just marked done");
  assert.equal(ask("stopped", { optionId: "approve" }), null);
  assert.deepEqual(ask("stopped", { outputKind: "free_text", dmAnswer: " Close " }), { decision: "close" });
  assert.deepEqual(ask("stopped", { outputKind: "free_text", dmAnswer: "remake:\n Merge the three cards into one change.\n" }),
    { decision: "remake", ideaText: "Merge the three cards into one change." });
  assert.deepEqual(ask("stopped", { outputKind: "free_text", dmAnswer: "Remake\nOne card: add and wire it." }),
    { decision: "remake", ideaText: "One card: add and wire it." });
  assert.equal(ask("stopped", { outputKind: "free_text", dmAnswer: "remake" }), null, "a remake needs its idea");
  assert.equal(ask("stopped", { optionId: "remake" }), null);
  assert.equal(ask("t2_pr", { outputKind: "free_text", dmAnswer: "remake: x" }), null);
  assert.equal(ask("stopped", { outputKind: "free_text", dmAnswer: "retry it, probably" }), null);
  assert.deepEqual(amuxDmOwnerSettlementAnswerOf({ kind: "stopped", judgmentKind: "edit_confirm",
    outputKind: "select", optionId: "retry", operatorAnswer: "닫기" }), { decision: "close" },
    "the person's edit wins");
});

test("the app applies the answer as the system, through the chain writer, and a person who answers first wins", () => {
  const service = read("lib/amux/dmOwnerSettlementService.ts");
  assert.match(service, /await takeAuditChainLock\(tx\);\s+let killSwitch/, "the chain lock, then the kill switch");
  assert.match(service, /if \(killSwitch !== false\) return null;/);
  assert.equal((service.match(/const locked = await lockUnderKillSwitch\(tx, input\.settlementId\);\s+if \(!locked\) return \{ applied: false, outcome: null \};/g) ?? []).length, 2,
    "an answer and a remake's close both stop under the kill switch");
  assert.match(service, /FOR UPDATE OF s, w NOWAIT/);
  // One judgment of "the Task moved", in every step: the sync's sweep, the
  // answer (and a remake's claim), the guard inside the idea's own commit,
  // the cancel of a moved claim, and the close after the idea.
  assert.equal((service.match(/amuxDmOwnerSettlementMoved\(row\)/g) ?? []).length, 5);
  assert.doesNotMatch(service, /IS DISTINCT FROM s\."attemptId"|row\.status !== row\.taskStatus/,
    "no second copy of the judgment");
  assert.equal((service.match(/\$\{SETTLEMENT_FACTS\}/g) ?? []).length, 2, "and one read of its facts");
  const guard = service.slice(service.indexOf("export async function guardAmuxDmOwnerSettlementRemakeIntake"),
    service.indexOf("export async function recordAmuxDmOwnerSettlementRemakeIdea"));
  const order = ["await takeAuditChainLock(tx);", "readDecisionMakerSwitchesOrThrow(tx)",
    "await lockSettlement(tx, input.settlementId)", "row.remakeRequestId !== input.remakeRequestId",
    "amuxDmOwnerSettlementMoved(row) ?? true"].map((step) => guard.indexOf(step));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])),
    "the guard: the chain lock, the kill switch, the locked claim under its request id, the one judgment");
  assert.doesNotMatch(guard, /\bUPDATE\b|\bINSERT\b/, "the guard only reads and locks");
  assert.match(service, /settlementDestinationForBudget\(\{ requested_status: "todo",/, "a retry stays inside the attempt budget");
  assert.match(service, /return handOff\("attempt_budget_spent"\)/);
  assert.match(service, /if \(decision === "approve"\) \{[\s\S]*?await record\(\{ approvedHeadSha: facts\.verifiedHeadSha, approvedDiffDigest: facts\.diffDigest \}\);[\s\S]*?return \{ applied: true, outcome: "approved" \};/,
    "an approval only records");
  assert.doesNotMatch(service.slice(service.indexOf('if (decision === "approve")'), service.indexOf('if (decision === "retry")')),
    /amuxWorkItem|amuxHumanEscalation/, "an approval leaves the Task and the escalation");
  assert.doesNotMatch(service, /writeAdminAuditLog|adminAuditLog\./);
  const system = read("lib/amux/legacyCardSystemService.ts");
  assert.match(system, /writeSystemAuditLog\(\{ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,/);
  assert.match(system, /resolvedById: AMUX_DM_OWNER_SETTLEMENT_RESOLVER, resolvedByEmail: null/);
  assert.match(system, /AMUX_DM_OWNER_SETTLEMENT_RESOLVER = "system:amux-dm-owner-settlement"/);
  assert.doesNotMatch(system, /writeAdminAuditLog|recordAmuxV22UsageAcceptances/,
    "the owner's usage acceptance stays with a person");
  assert.match(system, /amuxLegacyCardCloseRefusal\(card, card\.revision\)/, "the owner's close judgment");
  assert.match(system, /amuxOwnerCompleteRefusal\(card, card\.revision\)/, "the owner's complete judgment");
});

test("the approver and the walk apply it; the card never reaches a session", () => {
  const auto = read("lib/amux/dmAutoApplyService.ts");
  assert.match(auto, /SELECT "localCardId", 'settlement_' \|\| "kind", "id" FROM "AmuxDmOwnerSettlement"\s+WHERE "state" = 'open' AND "handoffAt" IS NULL/);
  assert.match(auto, /applyAmuxDmOwnerSettlementDecision\(tx, \{\s+settlementId: candidate\.settlementId, answer: candidate\.answer, source: "dm",/);
  assert.ok(!auto.includes("fileAmuxDmOwnerSettlementRemakeIdea("), "the approver never files an idea itself");
  assert.ok(auto.indexOf("closeDecisionMakerRequestOnDirectAnswer(tx") < auto.indexOf("continueAmuxDmOwnerSettlementRemake("),
    "a remake's idea comes only after the request is claimed");
  assert.match(auto, /return true;\s+\}\);\s+\/\/ The claim committed with the request closed[\s\S]*?if \(applied && claim && candidate\.kind === "owner_settlement"/,
    "after the claim's transaction committed, and only when it claimed");
  const remake = read("lib/amux/dmOwnerSettlementRemake.ts");
  const cont = remake.slice(remake.indexOf("export async function continueAmuxDmOwnerSettlementRemake"),
    remake.indexOf("export async function settleAmuxDmOwnerSettlementAnswer"));
  assert.doesNotMatch(remake, /RemakeLive|live\.killSwitch/, "no separate check before the commit: the guard is it");
  assert.match(cont, /guard: amuxDmOwnerSettlementRemakeGuard\(input\.settlementId, input\.remakeRequestId\)/);
  assert.match(remake, /check: \(tx\) => guardAmuxDmOwnerSettlementRemakeIntake\(tx, \{ settlementId, remakeRequestId \}\),\s+committed: \(tx, ideaId\) => recordAmuxDmOwnerSettlementRemakeIdea\(tx, \{ settlementId, ideaId \}\),/);
  assert.match(remake, /submitAmuxIdeaFromSession\(\{ inspected, guard: input\.guard \}\)/);
  const intake = read("lib/amux/ideaSessionSubmissionService.ts");
  const body = intake.slice(intake.indexOf("export async function commitAmuxIdeaSessionIntake"));
  assert.ok(body.indexOf("await input.guard.check(tx)") < body.indexOf("commitAmuxIdeaSessionSubmission(tx"),
    "the guard runs in the commit transaction before the idea is written");
  assert.ok(body.indexOf("commitAmuxSessionAnalysisReservation(tx") < body.indexOf("input.guard?.committed?.(tx"),
    "and names it after both are written, in the same transaction");
  assert.match(intake, /if \(error instanceof AmuxIdeaSessionGuardRefused\) throw error;/);
  assert.match(cont, /if \("unknown" in filed\) filed = await readBack\(input\.remakeRequestId\)/,
    "an unknown outcome is read back by its request id, never filed again");
  assert.equal((cont.match(/fileIdea\(/g) ?? []).length, 1, "one filing per claim");
  const settle = remake.slice(remake.indexOf("export async function settleAmuxDmOwnerSettlementAnswer"));
  assert.ok(settle.indexOf("applyAmuxDmOwnerSettlementDecision(tx") < settle.indexOf("continueAmuxDmOwnerSettlementRemake("),
    "the confirmed answer's path claims first too");
  assert.match(read("lib/amux/dmOwnerSettlementService.ts"),
    /UPDATE "AmuxDmOwnerSettlement" SET "state" = 'claimed', "decision" = 'remake',/);
  assert.match(read("prisma/migrations/20261113200000_amux_dm_owner_settlement/migration.sql"),
    /"state" = 'claimed' AND "kind" = 'stopped' AND "decision" = 'remake'/);
  const dm = read("lib/amux/v22OwnerQuestionDmService.ts");
  assert.match(dm, /UNION ALL\s+SELECT 1 AS "found" FROM "AmuxDmOwnerSettlement"\s+WHERE "localCardId" = \$\{cardId\}/);
  assert.match(dm, /if \(isAmuxDmOwnerSettlementId\(input\.questionId\)\) \{\s+const recorded = await recordAmuxDmOwnerSettlementLocalCard\(tx, input\);/);
  assert.match(dm, /source: "dm_confirmed", requestId: step\.requestId/);
  const route = read("app/api/internal/amux/decision-maker/v22-questions/sync/route.ts");
  assert.match(route, /readAmuxDmOwnerSettlementSyncRows\(tx, \{ enabled: settlementOn \}\)/);
  // Off files nothing on its own; the read returns only what the owner asked
  // for from the owner queue (owner decision 2026-11-14), and the open ones still close.
  assert.doesNotMatch(route, /if \(!settlementOn\) return \{ pending: \[\]/);
  assert.match(read("lib/amux/dmOwnerSettlementService.ts"),
    /const requested = input\.enabled \? null :\s+await readAmuxDmOwnerSettlementRequestedIds/);
  const policy = read("docs/policy/amux-decision-maker.md");
  assert.match(policy, /TOMVERSE_AMUX_DM_OWNER_SETTLEMENT=enabled/);
  assert.match(policy, /\*\*운영자 확인 대기의 정리 \(운영자 결정 2026-11-13\)\.\*\*/);
  assert.match(policy, /11\. \*\*운영자 확인 대기의 멈춘 Task \(운영자 결정 2026-11-13, §0a-5\)\.\*\*/);
});
