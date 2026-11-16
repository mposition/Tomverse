import assert from "node:assert/strict";
import test from "node:test";

import {
  SCOUT_TURN_REPORTS_MAX,
  createTurnReporter,
  readTurnOutcome,
  scoutReportText,
  turnOutcomeFact,
} from "../lib/productResearchScoutTurnHealth.mjs";
import {
  SCOUT_DAILY_RUN_HOUR_UTC,
  SCOUT_DEPLOY_CHECK_GENERATION,
  SCOUT_DEPLOY_CHECK_TASK_ENV,
  SCOUT_FIXTURES,
  SCOUT_GENERATIONS,
  SCOUT_LONG_FIXTURE_CHARS,
  scoutRunMode,
} from "../lib/productResearchScoutBrowserPolicy.mjs";
import { longNotes } from "../lib/productResearchScoutGeneration.mjs";
import { requestedScoutGenerations } from "../lib/productResearchScoutSubjects.ts";
import { productionFailureLines } from "../lib/productResearchScoutProductionFailures.ts";
import { JOURNEY_FAMILIES, JOURNEY_SYSTEM_PROMPT, journeyPromptText } from "../lib/productResearchScoutJourneyCore.ts";
import { SCOUT_SYSTEM_PROMPT } from "../lib/productResearchScoutCore.ts";

/**
 * A page with one assistant message, as the chat renders it: its status and
 * error code as data attributes, and a report button only on an error card.
 */
const pageWith = ({ status = "normal", code = null, modelId = "gpt-6-luna", text = "an answer", reportButton = false } = {}) => {
  const clicks = [];
  const answer = {
    count: async () => 1,
    getAttribute: async (name) => ({ "data-message-status": status, "data-error-code": code, "data-model-id": modelId })[name] ?? null,
    innerText: async () => text,
    getByTestId: () => ({ isVisible: async () => reportButton, click: async () => clicks.push("report") }),
  };
  return { clicks, locator: () => ({ last: () => answer }) };
};
const emptyPage = () => ({ locator: () => ({ last: () => ({ count: async () => 0 }) }) });

test("the chat's own verdict decides whether a turn failed", async () => {
  assert.deepEqual(await readTurnOutcome(pageWith()), { state: "answered", errorCode: null, modelId: "gpt-6-luna" });
  assert.deepEqual(await readTurnOutcome(pageWith({ status: "error", code: "EMPTY_RESPONSE", text: "응답이 비어 있습니다" })),
    { state: "failed", errorCode: "EMPTY_RESPONSE", modelId: "gpt-6-luna" });
  assert.deepEqual(await readTurnOutcome(pageWith({ status: "error", code: null })), { state: "failed", errorCode: "UNKNOWN", modelId: "gpt-6-luna" });
  assert.equal((await readTurnOutcome(pageWith({ text: "  " }))).state, "empty");
  assert.equal((await readTurnOutcome(emptyPage())).state, "none");
});

test("a failed turn leads the judge's signals as a product failure, never as a layout question", () => {
  assert.equal(turnOutcomeFact({ state: "answered", errorCode: null, modelId: null }), null);
  const fact = turnOutcomeFact({ state: "failed", errorCode: "ATTACHMENT_TEXT_TOO_LARGE", modelId: "gpt-6-luna" });
  assert.match(fact, /^TURN FAILED: /);
  assert.match(fact, /ATTACHMENT_TEXT_TOO_LARGE/);
  assert.match(fact, /gpt-6-luna/);
  assert.match(turnOutcomeFact({ state: "empty", errorCode: null, modelId: null }), /^TURN FAILED: .*no answer at all/);
  // The judge is told what the line means (the 2026-11-16 run critiqued the error card's buttons instead).
  assert.match(SCOUT_SYSTEM_PROMPT, /TURN FAILED line, the product did not answer/);
  assert.match(SCOUT_SYSTEM_PROMPT, /never only the look of the error card/);
});

test("the report names what was tried and what came back, and nothing else", () => {
  assert.equal(
    scoutReportText("generated.xlsx", { errorCode: "EMPTY_RESPONSE", modelId: "gpt-6-luna" }),
    "[Scout 자동 점검] generated.xlsx: 답변을 받지 못했습니다 (오류 코드 EMPTY_RESPONSE), 모델 gpt-6-luna.",
  );
});

test("one failure class is one report a run, a walker-broken turn is never reported, and the counts say so", async () => {
  const reporter = createTurnReporter();
  const rules = { allowWrite: null, refusedWrites: [] };
  // No report button on screen: counted as a failure, the report says why it was not sent.
  const first = await reporter.check(pageWith({ status: "error", code: "EMPTY_RESPONSE" }), rules, "generated.pdf");
  assert.match(first, /not sent: no_report_button/);
  // The same code on the same model again: a fact for the judge, no second report attempt.
  const again = pageWith({ status: "error", code: "EMPTY_RESPONSE", reportButton: true });
  assert.match(await reporter.check(again, rules, "generated.docx"), /^TURN FAILED/);
  assert.deepEqual(again.clicks, [], "the same failure class is reported once");
  // A turn whose writes the walker refused may be the walker's own failure.
  const walkerBroken = pageWith({ status: "error", code: "CHAT_APPLICATION_ERROR", reportButton: true });
  await reporter.check(walkerBroken, { allowWrite: null, refusedWrites: ["POST /api/x"] }, "generated.journey");
  assert.deepEqual(walkerBroken.clicks, []);
  // An answered turn adds nothing.
  assert.equal(await reporter.check(pageWith(), rules, "generated.xlsx"), null);
  assert.deepEqual(reporter.counts, { turnFailures: 3, reported: 0 });
  assert.equal(rules.allowWrite, null, "the report's write rule is never left open");
  assert.ok(SCOUT_TURN_REPORTS_MAX >= 1);
});

test("the hourly walker does the full look once a day and otherwise only checks a new build", () => {
  assert.equal(scoutRunMode(new Date(Date.UTC(2026, 10, 15, SCOUT_DAILY_RUN_HOUR_UTC, 3))), "daily");
  assert.equal(scoutRunMode(new Date(Date.UTC(2026, 10, 15, 11, 3))), "deploy_check");
  // The check is the first generation, so the daily cap never crowds it out, and it is off until its switch is set.
  assert.equal(SCOUT_GENERATIONS[0].id, SCOUT_DEPLOY_CHECK_GENERATION);
  assert.deepEqual(SCOUT_GENERATIONS[0].attachments, ["sales.csv"]);
  const asked = { generations: [SCOUT_DEPLOY_CHECK_GENERATION] };
  assert.deepEqual(requestedScoutGenerations(asked, {}), []);
  assert.deepEqual(requestedScoutGenerations(asked, { [SCOUT_DEPLOY_CHECK_TASK_ENV]: "1" }), [SCOUT_DEPLOY_CHECK_GENERATION]);
});

test("three long fixtures together pass 300,000 characters, each its own text", () => {
  const names = ["long-notes-a.txt", "long-notes-b.txt", "long-notes-c.txt"];
  for (const name of names) assert.ok(Object.hasOwn(SCOUT_FIXTURES, name), name);
  const texts = ["a", "b", "c"].map((letter) => longNotes(letter));
  for (const text of texts) assert.equal(text.length, SCOUT_LONG_FIXTURE_CHARS);
  assert.ok(texts.reduce((sum, text) => sum + text.length, 0) > 300_000);
  assert.equal(new Set(texts).size, 3);
  assert.match(texts[0], /synthetic test data/);
  assert.equal(longNotes("a"), texts[0], "deterministic");
});

test("the planner covers limits, accumulation and recovery, and reproduces what users hit first", () => {
  assert.ok(JOURNEY_FAMILIES.some((family) => family.startsWith("limits and accumulation")));
  assert.ok(JOURNEY_FAMILIES.some((family) => family.startsWith("recovery after a failure")));
  assert.match(JOURNEY_SYSTEM_PROMPT, /When <production> lists failures real users hit lately/);
  const prompt = journeyPromptText([], new Date("2026-11-16T18:00:00Z"), ["AI_EMPTY_RESPONSE.ERR_INVALID_STATE on gpt-6-luna (stream): 8 in the last 48 hours"]);
  assert.match(prompt, /<production>\n- AI_EMPTY_RESPONSE\.ERR_INVALID_STATE on gpt-6-luna \(stream\): 8 in the last 48 hours\n<\/production>/);
  assert.match(journeyPromptText([], new Date("2026-11-16T18:00:00Z")), /<production>\nnone\n<\/production>/);
});

test("production failures reach the planner as codes and counts only, most frequent first", () => {
  const lines = productionFailureLines([
    { code: "ATTACHMENT_TEXT_TOO_LARGE", modelId: "gpt-6-luna", phase: "request_size", count: 7 },
    { code: "AI_EMPTY_RESPONSE.ERR_INVALID_STATE", modelId: "gpt-6-luna", phase: "stream", count: 5 },
    { code: "AI_EMPTY_RESPONSE.ERR_INVALID_STATE", modelId: "gpt-6-luna", phase: "stream", count: 3 },
    { code: "has spaces and words", modelId: null, phase: null, count: 99 },
    { code: "ZERO", modelId: null, phase: null, count: 0 },
  ]);
  assert.deepEqual(lines, [
    "AI_EMPTY_RESPONSE.ERR_INVALID_STATE on gpt-6-luna (stream): 8 in the last 48 hours",
    "ATTACHMENT_TEXT_TOO_LARGE on gpt-6-luna (request_size): 7 in the last 48 hours",
  ]);
  assert.equal(productionFailureLines(Array.from({ length: 20 }, (_, i) => ({ code: `CODE_${i}`, modelId: null, phase: null, count: i + 1 }))).length, 8);
});

test("the chat still renders what the walker reads and the report dialog it fills", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const list = read("components/chat/ChatMessageList.tsx");
  for (const marker of ["data-message-status={msg.status", "data-error-code={msg.status === \"error\"", "triggerTestId=\"report-error-button\""]) {
    assert.ok(list.includes(marker), marker);
  }
  const dialog = read("components/chat/FeedbackButton.tsx");
  for (const id of ["feedback-dialog", "feedback-message", "feedback-email-updates", "feedback-submit"]) {
    assert.ok(dialog.includes(`data-testid="${id}"`), id);
  }
});
