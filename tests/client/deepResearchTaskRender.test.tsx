import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DeepResearchEngineRow, DeepResearchEngineSheet, RESEARCH_SHEET_OUTPUTS } from "@/components/chat/DeepResearchEngine";
import { researchEngineCopy } from "@/locales/researchEngine";

const offer = (taskAgent: boolean) => ({ offered: true, features: { defaultEntry: false, privateSources: false, projectSources: false,
  maxApprovedCredits: 2_000, taskAgent }, estimate: { lowCredits: 100, highCredits: 400, perCallCredits: 10 } });
const sheet = (taskAgent: boolean, initialOutput?: (typeof RESEARCH_SHEET_OUTPUTS)[number]) => renderToStaticMarkup(
  <DeepResearchEngineSheet open language="ko" onClose={() => undefined} conversationId={null} draft="" offer={offer(taskAgent)}
    {...(initialOutput ? { initialOutput } : {})} />);

test("with delegated tasks on, the Research sheet offers report, document, spreadsheet and slides, report first", () => {
  const ko = researchEngineCopy.ko;
  const html = sheet(true);
  assert.ok(html.includes('data-testid="dre-output"'));
  for (const value of RESEARCH_SHEET_OUTPUTS) assert.ok(html.includes(`data-testid="dre-output-${value}"`), value);
  for (const label of [ko.outputReport, ko.outputDocument, ko.outputSpreadsheet, ko.outputPresentation]) assert.ok(html.includes(label), label);
  assert.match(html, /aria-checked="true"[^>]*data-testid="dre-output-report"/u);
  assert.ok(html.includes(ko.briefQuestion), "report keeps the research wording");
  assert.ok(!html.includes('data-testid="dre-output-hint"'));
});

test("choosing a file deliverable turns the sheet into a task: what to do, and that it never sends or buys", () => {
  const ko = researchEngineCopy.ko;
  const html = sheet(true, "spreadsheet");
  assert.match(html, /aria-checked="true"[^>]*data-testid="dre-output-spreadsheet"/u);
  assert.ok(html.includes(ko.taskTitle) && html.includes(ko.taskQuestion));
  assert.ok(html.includes('data-testid="dre-output-hint"') && html.includes(ko.taskHint));
  assert.ok(ko.taskHint.includes("보내거나 게시하거나 구매하지 않습니다"));
});

test("with delegated tasks off, the sheet is Deep Research as before, even if an entry asks for a file", () => {
  const html = sheet(false, "presentation");
  assert.ok(!html.includes('data-testid="dre-output"'));
  assert.ok(html.includes(researchEngineCopy.ko.briefQuestion));
  assert.ok(!html.includes(researchEngineCopy.ko.taskQuestion));
});

test("the tools-menu row says work can come back as a file only when delegated tasks are on", () => {
  const on = renderToStaticMarkup(<DeepResearchEngineRow language="en" onOpen={() => undefined} taskAgent />);
  const off = renderToStaticMarkup(<DeepResearchEngineRow language="en" onOpen={() => undefined} />);
  assert.ok(on.includes(researchEngineCopy.en.taskRowHint));
  assert.ok(off.includes(researchEngineCopy.en.briefSourcesHint) && !off.includes(researchEngineCopy.en.taskRowHint));
});

test("every language has the task copy", () => {
  const keys = ["outputLabel", "outputReport", "outputDocument", "outputSpreadsheet", "outputPresentation", "taskTitle", "taskQuestion", "taskHint",
    "taskStart", "taskSteps", "taskOutline", "taskApprove", "taskFileNote", "taskRowHint", "notifyTitle", "taskNotifyTitle", "notifyBody",
    "taskColumnSection", "taskColumnContent", "taskColumnSource", "taskColumnLink", "taskColumnRetrieved"] as const;
  for (const [language, copy] of Object.entries(researchEngineCopy)) {
    for (const key of keys) assert.ok(typeof copy[key] === "string" && copy[key].trim(), `${language}.${key}`);
    if (language !== "en") assert.notEqual(copy.taskHint, researchEngineCopy.en.taskHint, `${language} is translated`);
  }
});
