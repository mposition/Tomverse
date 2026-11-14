import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// AMUX process audit bundle 2 (owner decision 2026-11-14, AMUXFLOW/B2):
// stopped cards in one place, the Decision Maker first. Every switch is off
// by default; each test names the switch it turns on.

test("the term check skips evidence blocks only when exempt, and never an unclosed one", async () => {
  const { dmTermCheckText, DM_EVIDENCE_OPEN, DM_EVIDENCE_CLOSE } = await import("../lib/amux/decisionMakerCore.ts");
  const text = `Should it run again?\n${DM_EVIDENCE_OPEN}\ndelete the token row\n${DM_EVIDENCE_CLOSE}\nPick one.`;
  assert.equal(dmTermCheckText(text, false), text);
  assert.equal(dmTermCheckText(text, true), "Should it run again?\n\nPick one.");
  const lone = `Ask\n${DM_EVIDENCE_OPEN}\ndeploy to production`;
  assert.equal(dmTermCheckText(lone, true), lone, "a lone marker hides nothing");
});

test("routing: evidence words no longer send a system card to the operator, a fixed word still does", async () => {
  const core = await import("../lib/amux/decisionMakerCore.ts");
  const card = (question) => ({
    type: "decision", tags: [], title: "Owner queue: AMUX-X-001", question,
    options: [{ id: "retry", label: "Run the Task again", effect: "reversible", paths: [] },
      { id: "close", label: "Close the card", effect: "reversible", paths: [] }],
    unblocks: "A retry runs the Task again.", context: "", contextPaths: [],
    askType: "choice", resolution: "decision_only",
  });
  const evidence = `${core.DM_EVIDENCE_OPEN}\nIts findings: the migration deletes the token\n${core.DM_EVIDENCE_CLOSE}`;
  const input = (question, exempt) => ({ killSwitch: false, instanceMode: "proposal", card: card(question),
    askingProvider: "claude", throughput: { lastHour: 0, lastDay: 0 }, evidenceTermsExempt: exempt });
  const strict = core.routeDmQuestion(input(`A Task stopped.\n${evidence}\nWhat now?`, false));
  assert.ok(strict.route === "operator" && strict.refusals.includes("irreversible_term"));
  const exempt = core.routeDmQuestion(input(`A Task stopped.\n${evidence}\nWhat now?`, true));
  assert.ok(!exempt.refusals?.includes("irreversible_term"), JSON.stringify(exempt));
  const asked = core.routeDmQuestion(input(`Should we deploy this?\n${evidence}`, true));
  assert.ok(asked.refusals.includes("irreversible_term"), "a word in the fixed question still routes");
});

test("v52: every rejection returns to todo with the switch on; off, the second still blocks", async () => {
  const { decideAmuxV52ReviewDisposition, amuxV52RejectRetryInBudgetEnabled } =
    await import("../lib/amux/v52ReviewCore.ts");
  assert.equal(amuxV52RejectRetryInBudgetEnabled(undefined), false);
  assert.equal(amuxV52RejectRetryInBudgetEnabled("enabled"), true);
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 1, false),
    { status: "blocked", reason: "review_server_rejected_twice" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 3, true),
    { status: "todo", reason: "review_server_rejected" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("unknown", 0, true),
    { status: "blocked", reason: "review_server_unknown" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("accept", 4, true),
    { status: "review", reason: "review_server_accepted" });
});

test("engineering agent: a card-scoped mismatch holds no other card; an unbound one still halts", async () => {
  const { engineeringAgentHalted, currentEngineeringAgentHalt } = await import("../lib/engineeringAgentStore.ts");
  const base = { openStateMismatches: 1, orphanedRuns: 1, unacknowledgedHalt: null, circuitLatched: false };
  assert.equal(engineeringAgentHalted(base), true, "off: a mismatch halts everything");
  assert.equal(currentEngineeringAgentHalt(base), "state_mismatch");
  const scoped = { ...base, cardScoped: true, unscopedStateMismatches: 0 };
  assert.equal(engineeringAgentHalted(scoped), false);
  assert.equal(currentEngineeringAgentHalt(scoped), "none");
  assert.equal(engineeringAgentHalted({ ...scoped, unscopedStateMismatches: 1 }), true);
  assert.equal(engineeringAgentHalted({ ...scoped, circuitLatched: true }), true, "the circuit still halts");
  assert.equal(engineeringAgentHalted({ ...scoped, unacknowledgedHalt: "unbound_app_pr" }), true);
});

test("the stalled card sweep reads only a promoted todo Task whose budget is spent", async () => {
  const sweep = await import("../lib/amux/stalledCardSweep.ts");
  assert.equal(sweep.amuxStalledCardSweepEnabled(undefined), false);
  assert.equal(sweep.amuxStalledCardSweepEnabled("enabled"), true);
  const calls = [];
  const tx = { $queryRaw: async (strings, ...values) => {
    calls.push({ sql: strings.join("?").replace(/\s+/g, " "), values });
    return [];
  } };
  await sweep.readAmuxStalledCards(tx, 5);
  const { sql, values } = calls[0];
  assert.ok(sql.includes(`w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'`));
  assert.ok(sql.includes(`w."archivedAt" IS NULL AND w."v22AssignmentId" IS NULL`));
  assert.ok(sql.includes(`e."status" IN ('open', 'acknowledged')`), "a card already in the queue is left");
  assert.ok(sql.includes(`w."status" = 'todo' AND w."v22ReceiptId" IS NOT NULL`),
    "only a promoted card, which the settlement can file");
  assert.ok(!sql.includes("backlog"), "a backlog card is not swept: the settlement cannot file it");
  assert.ok(values.includes(5) && values.includes("attempt_budget_exhausted"));
});

test("DM merge keeps its allow list: lib code and API routes stay a person's", async () => {
  const { qaReleaseDmMergeAllowed } = await import("../lib/qaReleaseMergeLaneExclusionCore.ts");
  for (const path of ["lib/routerFailure.ts", "lib/sessionRevocationCore.ts", "lib/providerCostBudget.ts",
    "app/api/user/account/route.ts"]) {
    assert.equal(qaReleaseDmMergeAllowed(path, []), false, path);
  }
  assert.equal(qaReleaseDmMergeAllowed("components/ChatInput.tsx", []), true);
});

test("only a card the app filed earns the evidence exemption; a worker's markers are plain text", async () => {
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
  assert.match(store, /dmTermsFixedTextOnlyEnabled\(process\.env\[DM_TERMS_FIXED_TEXT_ONLY_ENV\]\) &&/);
  assert.ok(store.includes('EXISTS (SELECT 1 FROM "AmuxDmOwnerSettlement" s'),
    "the exemption needs the settlement row that recorded this local card");
  assert.ok(store.includes("found.appFiledCard === true"));
});

test("a held card is left out of the publisher's queue and refused before its run's AMUX write", () => {
  const store = readFileSync("lib/engineeringAgentStore.ts", "utf8");
  const pick = store.slice(store.indexOf("export async function claimNextEngineeringAgentPublishWork"));
  assert.match(pick.slice(0, 6000), /AND \(\$\{!cardScoped\} OR NOT EXISTS \(\s+SELECT 1 FROM "EngineeringAgentRun" own/);
  const admission = store.slice(store.indexOf("export async function requireEngineeringAgentRunAdmission"));
  assert.match(admission.slice(0, 1200), /haltState\.cardScoped && \(card \? await engineeringAgentCardHeld\(tx, card\) :\s+haltState\.openStateMismatches > 0 \|\| haltState\.orphanedRuns > 0\)\)/,
    "a start that names no card keeps the agent-wide halt");
  const execution = readFileSync("lib/amux/execution.ts", "utf8");
  assert.match(execution, /requireEngineeringAgentRunAdmission\(\s+engineeringAgentTransactionInAmux\(context\.attachedTransaction\),\s+\{ cardId: input\.taskId \}\)/);
});

test("the stalled card sweep runs after the tick's answer is decided", () => {
  const route = readFileSync("app/api/internal/amux/auto-promotion/tick/route.ts", "utf8");
  const decided = route.indexOf("const response = await claimAndPromote();");
  const swept = route.indexOf("await sweepStalledCardsAfterTick();");
  assert.ok(decided > 0 && swept > decided);
  assert.ok(route.indexOf("const result = await tickV22WorkerClaim();") > swept, "the claim lives in claimAndPromote");
});

test("dependency_closed is a stored escalation reason", async () => {
  const { storedAmuxEscalationReasonCode } = await import("../lib/amux/escalation.ts");
  assert.equal(storedAmuxEscalationReasonCode("dependency_closed", "execution-recovery"), "dependency_closed");
});
