import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// AMUX process audit bundle 2 (owner decision 2026-11-14, AMUXFLOW/B2):
// stopped cards in one place, the Decision Maker first. Every switch is off
// by default; each test names the switch it turns on.

test("routing: a card the app filed is not read for the terms; a worker's card is, every word (owner decision 2026-11-22)", async () => {
  const core = await import("../lib/amux/decisionMakerCore.ts");
  const card = (question) => ({
    type: "decision", tags: [], title: "Owner queue: AMUX-X-001", question,
    options: [{ id: "retry", label: "Run the Task again", effect: "reversible", paths: [] },
      { id: "close", label: "Close the card", effect: "reversible", paths: [] }],
    unblocks: "A retry runs the Task again.", context: "", contextPaths: [],
    askType: "choice", resolution: "decision_only",
  });
  const evidence = `${core.DM_EVIDENCE_OPEN}\nIts findings: the migration deletes the token\n${core.DM_EVIDENCE_CLOSE}`;
  const input = (question, appFiledCard) => ({ killSwitch: false, instanceMode: "proposal", card: card(question),
    askingProvider: "claude", throughput: { lastHour: 0, lastDay: 0 }, appFiledCard });
  // A worker's question: the evidence markers are plain text, and every word is read.
  const worker = core.routeDmQuestion(input(`A Task stopped.\n${evidence}\nWhat now?`, undefined));
  assert.ok(worker.route === "operator" && worker.refusals.includes("irreversible_term"));
  // AMUX-CRAWL-003's scope said "deviation 정책 변경"; on a card the app filed, that
  // and any other word reach the Decision Maker.
  for (const question of [`A Task stopped.\n${evidence}\nWhat now?`, "Scope out: deviation 정책 변경. What now?",
    `Should we refund the payment?\n${evidence}`]) {
    const filed = core.routeDmQuestion(input(question, true));
    assert.ok(!filed.refusals?.includes("irreversible_term"), JSON.stringify(filed));
  }
  // The secret check still reads the whole card the app filed.
  const secret = core.routeDmQuestion(input("api key sk-ant-api03-" + "A".repeat(90), true));
  assert.ok(secret.refusals.includes("card_secret_detected"), JSON.stringify(secret));
});

test("v52: every rejection returns to todo; only a repeated finding blocks", async () => {
  const { decideAmuxV52ReviewDisposition } =
    await import("../lib/amux/v52ReviewCore.ts");
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 1),
    { status: "todo", reason: "review_server_rejected" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 3),
    { status: "todo", reason: "review_server_rejected" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("unknown", 0),
    { status: "todo", reason: "review_server_unknown" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("accept", 4),
    { status: "review", reason: "review_server_accepted" });
});

test("engineering agent: a card-scoped mismatch holds no other card; an unbound one still halts", async () => {
  const { engineeringAgentHalted, currentEngineeringAgentHalt } = await import("../lib/engineeringAgentStore.ts");
  const base = { openStateMismatches: 1, orphanedRuns: 1, unacknowledgedHalt: null };
  const scoped = { ...base, unscopedStateMismatches: 0 };
  assert.equal(engineeringAgentHalted(scoped), false);
  assert.equal(currentEngineeringAgentHalt(scoped), "none");
  assert.equal(engineeringAgentHalted({ ...scoped, unscopedStateMismatches: 1 }), true);
  assert.equal(engineeringAgentHalted({ ...scoped, unacknowledgedHalt: "unbound_app_pr" }), true);
});

test("DM merge keeps its allow list: lib code and API routes stay a person's", async () => {
  const { qaReleaseDmMergeAllowed } = await import("../lib/qaReleaseMergeLaneExclusionCore.ts");
  for (const path of ["lib/routerFailure.ts", "lib/sessionRevocationCore.ts", "lib/providerCostBudget.ts",
    "app/api/user/account/route.ts"]) {
    assert.equal(qaReleaseDmMergeAllowed(path, []), false, path);
  }
  assert.equal(qaReleaseDmMergeAllowed("components/ChatInput.tsx", []), true);
});

test("only a card the app filed skips the terms, proven by the row that recorded it; no switch holds it", async () => {
  const core = await import("../lib/amux/decisionMakerCore.ts");
  const card = { type: "decision", tags: [], title: "t",
    question: `${core.DM_EVIDENCE_OPEN}deploy to production${core.DM_EVIDENCE_CLOSE}`,
    options: [{ id: "a", label: "A", effect: "reversible", paths: [] },
      { id: "b", label: "B", effect: "reversible", paths: [] }],
    unblocks: "u", context: "", contextPaths: [], askType: "choice", resolution: "decision_only" };
  const decision = core.routeDmQuestion({ killSwitch: false, instanceMode: "proposal", card,
    askingProvider: "claude", throughput: { lastHour: 0, lastDay: 0 } });
  assert.ok(decision.refusals.includes("irreversible_term"), "absent proof: every word is read");
  const store = readFileSync("lib/amux/decisionMakerRequestStore.ts", "utf8");
  assert.doesNotMatch(store, /TERMS_FIXED_TEXT_ONLY/, "the 2026-11-14 switch is gone: no switch holds it back");
  for (const table of ["AmuxDmOwnerSettlement", "EngineeringAgentDmReview", "AmuxV22ResultReview",
    "AmuxIdeaSessionPlanRefusal", "AmuxIdeaCardCloseQuestion"])
    assert.ok(store.includes(`EXISTS (SELECT 1 FROM "${table}"`), `the proof reads ${table}`);
  assert.doesNotMatch(store.slice(store.indexOf("AS \"appFiledCard\"") - 900, store.indexOf("AS \"appFiledCard\"")),
    /AmuxV22TaskQuestion/, "a worker's own question is never app-filed");
  assert.ok(store.includes("appFiledCard: found.appFiledCard === true"));
});

test("a held card is left out of the publisher's queue and refused before its run's AMUX write", () => {
  const store = readFileSync("lib/engineeringAgentStore.ts", "utf8");
  const pick = store.slice(store.indexOf("export async function claimNextEngineeringAgentPublishWork"));
  assert.match(pick.slice(0, 6000), /AND \(NOT EXISTS \(\s+SELECT 1 FROM "EngineeringAgentRun" own/);
  const admission = store.slice(store.indexOf("export async function requireEngineeringAgentRunAdmission"));
  assert.match(admission.slice(0, 1200), /\(card \? await engineeringAgentCardHeld\(tx, card\) :\s+haltState\.openStateMismatches > 0 \|\| haltState\.orphanedRuns > 0\) refuse\("halted"\)/,
    "a start that names no card keeps the agent-wide halt");
  const execution = readFileSync("lib/amux/execution.ts", "utf8");
  assert.match(execution, /requireEngineeringAgentRunAdmission\(\s+engineeringAgentTransactionInAmux\(context\.attachedTransaction\),\s+\{ cardId: input\.taskId \}\)/);
});

test("dependency_closed is a stored escalation reason", async () => {
  const { storedAmuxEscalationReasonCode } = await import("../lib/amux/escalation.ts");
  assert.equal(storedAmuxEscalationReasonCode("dependency_closed", "execution-recovery"), "dependency_closed");
});
