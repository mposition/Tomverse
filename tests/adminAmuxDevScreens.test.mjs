// The Development screens redesigned on 2026-11-07 (Ideas, Execution board,
// Release, AMUX settings, Safety & recovery). The redesign changes what is
// drawn and nothing about what is decided: no approval, budget, halt or
// release route moved, and these checks pin that and the honest-read rules
// (docs/ui-contracts/admin-console-ia.md, rule 8).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

test("the new presentation parts write nothing: no request method, no POST, no write route", () => {
  for (const path of [
    "components/admin/ui/AdminStepper.tsx",
    "components/admin/ui/AdminChannelIcon.tsx",
    "components/admin/AmuxAnalysisBudgetMeter.tsx",
    "components/admin/ReleaseTrainOverview.tsx",
    "components/admin/AmuxBacklogListPanel.tsx",
  ]) {
    const source = read(path);
    assert.equal(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/i.test(source), false, `${path} sends a write`);
    assert.equal(/\bPOST\b/.test(source), false, `${path} names POST`);
  }
  // The budget line reads the one existing snapshot route, with the console's deadline fetch.
  const meter = read("components/admin/AmuxAnalysisBudgetMeter.tsx");
  assert.ok(meter.includes('"/api/admin/amux/ideas/analysis-budget-settings"'));
  assert.equal(/\bfetch\(/.test(meter.replace(/adminFetch\(/g, "")), false, "a bare fetch has no deadline");
  assert.ok(meter.includes("response.status === 428"), "a stale sign-in is told apart from a failed read");
  assert.ok(meter.includes('kind: "unavailable"'), "a failed read says unavailable, never an empty bar");
});

test("an idea row only links to the idea: the approval panels and their blocking dialog are untouched", () => {
  const list = read("components/admin/AmuxIdeaProgressPanel.tsx");
  assert.equal(/adminFetch|method:/.test(list), false);
  assert.ok(list.includes("amuxIdeaFlowSteps(row.stage"));
  // The five-step bar replaced the six-bar grid; the bulk close panel is still mounted for closable ideas.
  assert.equal(list.includes("grid-cols-6"), false);
  assert.ok(list.includes("<AmuxIdeaClosePanel mode=\"selection\""));
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  for (const kept of ["<AmuxIdeaBusyDialog", "<AmuxInitialPlanPanel", "<AmuxIdeaAnalysisResultPanel", "<AmuxFrontierModelsPanel"]) {
    assert.ok(input.includes(kept), `${kept} is still part of the flow`);
  }
});

test("the card list counts only what its read returned, and says the counts are bounded", () => {
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.ok(page.includes("backlogList === null ? null : await listAmuxCardsForAdmin()"), "no summary read before the list itself was readable");
  assert.ok(page.includes("summary={cardSummary}"));
  const panel = read("components/admin/AmuxBacklogListPanel.tsx");
  assert.ok(panel.includes("summary ? summary.total : null"), "an unread count is null (Unavailable), never 0");
  assert.equal(/\?\?\s*0\b/.test(panel), false, "no null is turned into a zero");
  assert.ok(panel.includes("c.bounded("), "a bounded read states its bound");
  // A bad search keeps its form (it can be fixed or cleared), and a phone card still reaches the card.
  assert.ok(panel.indexOf("{searchForm}") < panel.indexOf("m.invalidSearch"), "the search form is shown with the invalid-search message");
  assert.ok(/cardTitle=\{\(row\) => \(\s*<Link/.test(panel), "the phone card's title links to the card");
});

test("the board groups the server lanes into five columns without changing a lane or its drop target", () => {
  const board = read("components/admin/AmuxExecutionWorkspace.tsx");
  assert.match(board, /waiting: \["tomverse_backlog", "amux_backlog", "todo"\]/);
  assert.match(board, /approval: \["attention"\]/);
  assert.match(board, /running: \["in_progress"\]/);
  assert.match(board, /review: \["in_review"\]/);
  // Every lane section keeps its attribute, and only AMUX Backlog accepts a card.
  assert.ok(board.includes("data-amux-lane={lane}"));
  assert.equal(board.split('lane === "amux_backlog"').length - 1 >= 2, true, "the drag-over and the drop both check the lane");
  assert.ok(board.includes("{...dropProps(lane)}"));
  // The card dialog, the move panel and the Decision Maker card are still the ones that were.
  for (const kept of ["<AmuxExecutionDialog", "<AmuxExecutionMovePanel", "<DecisionMakerAttentionCard"]) {
    assert.ok(board.includes(kept), `${kept} is still mounted`);
  }
  // A stopped card is red and links to Safety & recovery; it is never one the owner is asked about.
  assert.ok(board.includes("amuxBoardCardStuck({ lane, attentionReason: card.attentionReason, ownerQuestion: card.ownerQuestion })"));
  assert.ok(board.includes('href="/admin/amux-recovery?tab=safety" className={styles.safetyLink}'));
  // The channel is the class the worker was registered with, never a guess from its name.
  assert.ok(board.includes("workerChannels?.[card.worker]"));
  assert.equal(board.includes("amuxWorkerChannel("), false);
  const executionPage = read("app/(site)/(application)/admin/amux-execution/page.tsx");
  assert.ok(executionPage.includes("workerChannels={workerChannels}"));
  assert.ok(read("lib/amux/adminBoardWorkerChannels.ts").includes("amuxWorkerChannels(registry.rows)"), "the channel is the registered class");
  // A worker avatar and channel badge, and an age read when the board was read, not on each render.
  assert.ok(board.includes('<AdminPixelAvatar team="amux"'));
  assert.ok(board.includes("setNowMs(Date.now())"));
  assert.equal(/Date\.now\(\)/.test(board.slice(board.indexOf("const elapsedText"), board.indexOf("const dropProps"))), false);
});

test("the diagnostics tab keeps its placeholder and points at the review queue's evidence", () => {
  const page = read("app/(site)/(application)/admin/amux-execution/page.tsx");
  const diagnostics = page.slice(page.indexOf('tab.id === "diagnostics"'), page.indexOf("<AmuxOwnerQueueScreen"));
  assert.ok(diagnostics.includes("<AdminTabPlaceholder />"));
  assert.ok(diagnostics.includes('href="/admin/amux-execution?tab=review"'));
});

test("the release overview reads each source on its own and never draws a failed read as nothing", () => {
  const overview = read("components/admin/ReleaseTrainOverview.tsx");
  assert.ok(overview.includes("Promise.allSettled(["));
  assert.ok(overview.includes("admin_release_overview_read_failed"));
  // A train counts as departed only when its admission was recorded.
  assert.ok(overview.includes("qaTrainRoute(nowMs, hours, admittedHours ?? new Set())"));
  assert.ok(overview.includes("admission.emergency ? []"), "an emergency train never stands for a scheduled hour");
  assert.ok(overview.includes("value={selection === null ? null : selection.numbers.length}"));
  assert.ok(overview.includes("main === null || main.pullRequests === null ? null"));
  assert.ok(overview.includes('data-testid="release-merge-train-note"'), "merging stays the operator's merge-train");
  const page = read("app/(site)/(application)/admin/release/page.tsx");
  assert.ok(page.includes("<ReleaseTrainOverview nowMs={now.getTime()} />"));
  assert.ok(page.indexOf("<ReleaseTrainOverview") < page.indexOf("<AdminViewSwitch"), "the overview leads the QA tab");
  // The fixed-dark departure board is still the one literal-colour exception.
  assert.ok(read("tests/adminTheme.test.mjs").includes('const FIXED_DARK = ["components/admin/QaReleaseTrainBoard.tsx"]'));
});

test("the CI line keeps its reorder, stop and evaluate controls and adds the runner grid and the re-run warning", () => {
  const ci = read("components/admin/CiAdmissionSection.tsx");
  for (const kept of ['action: "move_top"', 'action: "move_bottom"', 'action: "set_capacity"', 'action: "stop"', 'action: "evaluate"', "ci-admission-handle-"]) {
    assert.ok(ci.includes(kept), `${kept} is still there`);
  }
  assert.ok(ci.includes('data-testid="ci-admission-runner-grid"'));
  assert.ok(ci.includes('data-testid="ci-admission-no-rerun"'));
  const messages = read("lib/adminMessages/ciAdmission.ts");
  assert.ok(/Do not mark a waiting pull request ready again, and do not re-run its CI/.test(messages));
});

test("every worker action keeps its test id on the channel cards, and the card shows no quota it does not have", () => {
  const workers = read("components/admin/AmuxWorkersOverview.tsx");
  for (const kept of ["amux-worker-${action}-${row.workerName}", "amux-worker-details-${row.workerName}", "amux-worker-status-${row.workerName}", "amux-worker-reason-${row.workerName}", "amux-worker-row-${row.workerName}"]) {
    assert.ok(workers.includes(kept), `${kept} is still there`);
  }
  assert.ok(workers.includes("m.screen.quotaNote"), "no per-worker weekly quota is recorded, and the screen says so");
  assert.equal(/progressbar/.test(workers), false, "no quota bar is drawn from nothing");
});

test("the halt card keeps the existing clear form and its three confirmations, behind the owner and the step-up", () => {
  const halts = read("components/admin/AmuxOrchestratorHaltsPanel.tsx");
  assert.ok(halts.includes("function ClearHaltForm"));
  assert.ok(halts.includes("amuxHaltClearReady(prefix, checks)"));
  assert.ok(halts.includes('const CLEAR_PATH = "/api/admin/amux/orchestrator-halts"'));
  assert.ok(halts.includes("<AdminApiFailureNotice failure={failure} returnTo={RETURN_TO} />"), "a stale sign-in still offers the way back");
  assert.ok(halts.includes("attention !== \"automatic_pending\" ? canClear ? <ClearHaltForm"), "no manual clear while the server is checking, none for a non-owner");
  const recovery = read("app/(site)/(application)/admin/amux-recovery/page.tsx");
  assert.ok(recovery.includes("<AmuxLegacyToolSection"), "the legacy tools stay closed sections");
});
