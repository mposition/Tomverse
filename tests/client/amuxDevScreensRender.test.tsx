import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxAnalysisBudgetMeter } from "@/components/admin/AmuxAnalysisBudgetMeter";
import { AdminChannelIcon } from "@/components/admin/ui/AdminChannelIcon";
import { AdminStepper } from "@/components/admin/ui/AdminStepper";
import { amuxIdeaFlowSteps } from "@/lib/adminAmuxFlow";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";

const flow = adminAmuxScreensMessages.en.ideas.flow;

test("the five-step bar names each step, marks the current one and writes the state as text", () => {
  const steps = amuxIdeaFlowSteps("plan_approval")!.map((step) => ({ ...step, label: flow.steps[step.id] }));
  const html = renderToStaticMarkup(<AdminStepper label={flow.label} stateWords={flow.states} steps={steps} />);
  assert.equal((html.match(/data-step="/g) ?? []).length, 5);
  assert.match(html, /aria-label="Idea progress"/);
  // Plan approval is the one step marked as the current one for assistive technology.
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(html, /data-step="plan_approval" data-state="current" aria-current="step"/);
  assert.match(html, /Execution approval<span class="sr-only"> \(done\)<\/span>/);
  assert.match(html, /PR<span class="sr-only"> \(not yet\)<\/span>/);
});

test("a step that stopped is marked as such, in words as well as colour", () => {
  const steps = amuxIdeaFlowSteps("execution", { attention: true })!.map((step) => ({ ...step, label: flow.steps[step.id] }));
  const html = renderToStaticMarkup(<AdminStepper label={flow.label} stateWords={flow.states} steps={steps} />);
  assert.match(html, /data-step="execution" data-state="attention"/);
  assert.match(html, /Run<span class="sr-only"> \(stopped here\)<\/span>/);
});

test("a channel icon is decorative without a label and named with one", () => {
  const decorative = renderToStaticMarkup(<AdminChannelIcon channel="codex" />);
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /role="img"/);
  const named = renderToStaticMarkup(<AdminChannelIcon channel="claude" label="Claude" />);
  assert.match(named, /role="img"/);
  assert.match(named, /aria-label="Claude"/);
  assert.match(named, /data-channel="claude"/);
});

test("before the budget is read the meter says it is reading, and draws no zero bar", () => {
  const html = renderToStaticMarkup(<AmuxAnalysisBudgetMeter />);
  assert.match(html, /role="status"/);
  assert.match(html, /Reading the analysis budget/);
  assert.doesNotMatch(html, /role="progressbar"/);
});
