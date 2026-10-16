import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaInputPanel } from "@/components/admin/AmuxIdeaInputPanel";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  ANALYSIS_POLL_MAX_READS, analysisPollDelayMs, analysisPollWanted,
} from "@/lib/amux/ideaAnalysisPollCore";
import { defaultFrontierSelection, type AvailableFrontierModel } from "@/lib/amux/ideaFrontierCatalogUiCore";

// The one-stop flow from an idea to the plan approval: the operator presses only the two decisions policy
// requires (execution approval, plan approval) plus the one button that builds the review screen. Before, it was
// nine presses: check input, save, prepare the source plan, choose model and effort, check eligibility, prepare
// the exact preview, approve execution, refresh and read the result, approve the plan.

const read = (path: string) => readFileSync(path, "utf8");
const model = (over: Partial<AvailableFrontierModel>): AvailableFrontierModel => ({
  approvalId: "a1", approvalVersion: 1, provider: "openai", modelId: "gpt-x", allowedEfforts: ["low", "medium", "high"], ...over,
});

test("a new idea starts from a default model and effort, so it needs no model choice", () => {
  assert.equal(defaultFrontierSelection([]), null);
  assert.equal(defaultFrontierSelection([model({ allowedEfforts: [] })]), null, "a model with no allowed effort is not a default");
  // The model with the approved analysis price wins; otherwise the first approved model.
  const priced = model({ approvalId: "priced", provider: "anthropic", modelId: "claude-opus-5-5", allowedEfforts: ["medium", "high", "xhigh"] });
  assert.deepEqual(defaultFrontierSelection([model({ approvalId: "first" }), priced]), { approvalId: "priced", effort: "high" });
  assert.deepEqual(defaultFrontierSelection([model({ approvalId: "first" }), model({ approvalId: "second" })]),
    { approvalId: "first", effort: "high" }, "the first approved model when none has the approved price");
  // "high" when allowed (the mockup's level), else the highest allowed level.
  assert.deepEqual(defaultFrontierSelection([model({ allowedEfforts: ["low", "medium"] })]), { approvalId: "a1", effort: "medium" });
  assert.deepEqual(defaultFrontierSelection([model({ allowedEfforts: ["max", "xhigh", "ultra"] })]), { approvalId: "a1", effort: "ultra" });
  assert.deepEqual(defaultFrontierSelection([model({ allowedEfforts: ["low"] })]), { approvalId: "a1", effort: "low" });
});

test("the analysis is watched on a gentle, bounded schedule that respects the read limit", () => {
  // 10 reads a minute and 100 a day for the result route: 15 s is 4 a minute, then slower, then it stops.
  assert.equal(analysisPollDelayMs(0), 15_000);
  assert.equal(analysisPollDelayMs(11), 15_000);
  assert.equal(analysisPollDelayMs(12), 30_000);
  assert.equal(analysisPollDelayMs(27), 30_000);
  assert.equal(analysisPollDelayMs(28), 60_000);
  assert.equal(analysisPollDelayMs(47), 60_000);
  assert.equal(analysisPollDelayMs(48), null, "the watch ends");
  assert.equal(ANALYSIS_POLL_MAX_READS, 48);
  assert.ok(ANALYSIS_POLL_MAX_READS < 100, "well inside the daily limit of the route");
  // Only a running (or unread) analysis is worth another read; every terminal state stops it.
  assert.equal(analysisPollWanted(null), true);
  assert.equal(analysisPollWanted("pending"), true);
  for (const state of ["ready", "partial", "needs_owner_input", "cancelled", "provider_failed", "needs_new_preview"]) {
    assert.equal(analysisPollWanted(state), false, state);
  }
  const panel = read("components/admin/AmuxIdeaAnalysisResultPanel.tsx");
  assert.ok(panel.includes("document.hidden") && panel.includes('"visibilitychange"'), "paused while the tab is hidden");
  assert.ok(panel.includes("setWatchEnded(true)"), "a failed or refused read ends the watch (a 429 is never answered with more reads)");
  assert.equal(/method:\s*"POST"/.test(panel), false, "watching only reads");
  assert.ok(panel.includes("{m.analysisResultRefresh}"), "the manual re-read stays as a fallback");
  assert.ok(panel.includes("data-testid=\"amux-analysis-running\"") && panel.includes("m.analysisRunning"));
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  assert.ok(input.includes("watchToken={analysisWatch?.ideaId === submission.ideaId ? analysisWatch.token : 0}"),
    "watched only after an execution approval, and once more after each next page's approval");
  assert.ok(input.includes("watchChunk={continuationChunkIndex}") && input.includes("onExecutionApproved="));
  // Review finding: a multi-page analysis. The next page's approval must restart the watch and read that page.
  assert.ok(panel.includes("if (watchToken !== seenToken) {") && panel.includes("setReadsDone(0);") && panel.includes("setWatchEnded(false);"),
    "a new approval restarts the watch from a clean state");
  assert.ok(panel.includes("void refresh(watchChunk)"), "and the watch reads the page that was approved, not page 0");
  assert.ok(panel.includes("const autoPoll = watchToken > 0;"));
});

test("the default new-idea view has one primary button; the separate steps wait in a collapsed recovery section", () => {
  const markup = renderToStaticMarkup(createElement(AmuxIdeaInputPanel, {
    submissionAvailable: true, sourceScopePreviewAvailable: true, initialPlanAvailable: true, frontierModelsAvailable: true,
    transferPreviewAvailable: true, transferConfirmAvailable: true, analysisResultAvailable: true, analysisBudgetAvailable: true,
    operatorId: "owner-1",
  }));
  // Buttons that sit outside every <details>: the default view's controls.
  const outside = markup.replace(/<details[\s\S]*?<\/details>/g, "");
  const defaultButtons = [...outside.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  assert.equal(defaultButtons.length, 1, `only the one primary button is visible by default: ${defaultButtons.join(" | ")}`);
  assert.ok(defaultButtons[0].includes('data-testid="amux-idea-compose-action"'));
  // Rendered without a provider: whichever locale the default is.
  const m = markup.includes(adminAmuxIdeaInputMessages.ko.composeAction) ? adminAmuxIdeaInputMessages.ko : adminAmuxIdeaInputMessages.en;
  assert.ok(markup.includes(m.composeAction));
  assert.ok(markup.includes('data-testid="amux-idea-stepwise"'), "the separate steps remain, collapsed, for recovery");
  const stepwise = /<details[^>]*data-testid="amux-idea-stepwise"[\s\S]*?<\/details>/.exec(markup)?.[0] ?? "";
  assert.ok(stepwise.includes(m.preview) && stepwise.includes(m.submit), "check input and save live only in the recovery section");
  assert.equal(stepwise.includes(' open'), false, "collapsed");
  // The old step buttons are not in the default view.
  for (const label of [m.preview, m.submit, m.frontierSelectionCheck, m.transferPreviewPrepare, m.initialPlanPrepare, m.frontierModelsRefresh]) {
    assert.equal(outside.includes(label), false, `${label} is not a default control`);
  }
  assert.equal(markup.includes('data-testid="amux-idea-compose-model-details"'), true, "the model is collapsed under one line");
});

test("the default path holds exactly two decisions: the execution approval and the plan approval", () => {
  const frontier = read("components/admin/AmuxFrontierModelsPanel.tsx");
  // One approval button with a price (the legacy confirmation exists only when no approved price does, and says so).
  assert.equal((frontier.match(/void approveExecution\(\)/g) ?? []).length, 1);
  assert.ok(frontier.includes('executionPrice.kind === "none" ? <button type="button"'), "the legacy confirm is the no-price fallback only");
  assert.ok(frontier.includes("m.executionCardLeadConfirmOnly"), "and the card says what that path does not do");
  // The execution approval screen shows the idea, model, the exact payload (collapsed) and the single button.
  for (const part of ["m.executionIdeaTitle", "modelLine", "{m.executionTransferShow}", "{preview.value.prompt}", "{m.executionApprovalAction}"]) {
    assert.ok(frontier.includes(part), part);
  }
  // The compose view: input check, eligibility check and build-preview behind the one button, in that order.
  const start = frontier.slice(frontier.indexOf("const startReview = async"), frontier.indexOf("const continueReview = async"));
  assert.ok(start.indexOf("build.beforeBuild") < start.indexOf("checkSelection()") && start.indexOf("checkSelection()") < start.indexOf("await buildPreview(draft)"));
  assert.ok(start.includes("if (build.beforeBuild && !(await build.beforeBuild())) return;"), "a failed input check stops the chain");
  assert.ok(start.includes("if (!checked && !(await checkSelection())) return;"), "a failed eligibility check stops it too");
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  assert.ok(input.includes("beforeBuild: () => checkInput(),"), "the input check is the existing one");
  // Review findings: the chain saves what was clicked on and the idea cannot change under it; the saved idea's
  // one button passes the eligibility it just checked on to the preview.
  assert.ok(start.includes("const draft = build.draft;") && start.includes("await buildPreview(draft)"), "the clicked draft is the saved one");
  assert.ok(start.includes("build.onChain?.(true)") && start.includes("build.onChain?.(false)"));
  assert.ok(input.includes("onChain: setChainRunning,") && input.includes("const frozen = chainRunning ||"), "the idea is locked while the chain runs");
  const cont = frontier.slice(frontier.indexOf("const continueReview = async"), frontier.indexOf("const preparePreview = async"));
  assert.ok(cont.includes("await preparePreview(true)") && frontier.includes("!(checked || eligibleNow)"),
    "the check that just answered is not lost to a stale render");
  assert.ok(input.indexOf("const checkInput = async") < input.indexOf("const buildHooks"), "defined before the hooks that call it");
  // The plan approval opens by itself: it is part of the analysis result, mounted from the save on.
  const result = read("components/admin/AmuxIdeaAnalysisResultPanel.tsx");
  assert.ok(result.includes('view.state === "ready" && view.outcome === "propose" ? <AmuxIdeaPlanApprovalPanel'));
  // Never a retry of an unknown write: the build keeps its receipt-before-request and its read-back.
  const build = frontier.slice(frontier.indexOf("const buildPreview = async"), frontier.indexOf("const approveExecution = async"));
  assert.ok(build.indexOf("reserveBuildPreviewReceipt(") < build.indexOf('adminFetch("/api/admin/amux/ideas/build-preview"'));
  assert.equal((build.match(/adminFetch\(/g) ?? []).length, 1, "one request, never a retry");
  assert.ok(build.includes("build.onUnknown(requestId)"));
});
