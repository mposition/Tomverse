// Whether a Scout turn got an answer at all (docs/policy/product-research-agent.md §14),
// and what the Scout does when it did not: it reports the failure the way a
// customer does, with the error card's own "오류 신고" button.
//
// 2026-11-16: the 04:00 run sent four real turns into a release where every GPT 6
// Luna stream ended empty. The walker wrote "no file was made" and the judge model
// was handed the error card as a screen to critique; it suggested removing a
// duplicate button and hiding the trace ID. A customer reported the same failure
// five hours later. A turn that does not answer is a product failure, whatever the
// screen looks like, so this module reads the product's own verdict on the turn
// (the message status the chat renders) instead of leaving it to the judge.
//
// The report goes through the customer path on purpose: the product's signed
// error token rides with it, so support triage, trace analysis and the fix lane
// treat it exactly like a person's report, and the report flow itself is tested.

/** The newest assistant message the chat rendered. */
const LAST_ANSWER = '[data-testid="chat-message"][data-message-role="assistant"]';

/** At most this many reports per run: one failure class is one report, not one per turn. */
export const SCOUT_TURN_REPORTS_MAX = 3;

/** The one write a report needs, opened only while the report is sent. */
const FEEDBACK_PATH = "/api/feedback";

/**
 * The product's verdict on the newest answer: `failed` when the chat marked it as
 * an error (a refusal, an empty answer, a broken stream, a timeout), with the
 * error code the chat holds; `none` when there is no answer at all.
 */
export async function readTurnOutcome(page) {
  const answer = page.locator(LAST_ANSWER).last();
  if ((await answer.count().catch(() => 0)) === 0) return { state: "none", errorCode: null, modelId: null };
  const [status, code, modelId, text] = await Promise.all([
    answer.getAttribute("data-message-status").catch(() => null),
    answer.getAttribute("data-error-code").catch(() => null),
    answer.getAttribute("data-model-id").catch(() => null),
    answer.innerText({ timeout: 1_000 }).catch(() => ""),
  ]);
  const failed = status === "error";
  return {
    state: failed ? "failed" : text.trim() ? "answered" : "empty",
    errorCode: failed ? (code || "UNKNOWN") : null,
    modelId: modelId || null,
  };
}

/** The line the judge reads first, so a failed turn is judged as a failure. */
export function turnOutcomeFact(outcome) {
  if (outcome.state === "answered") return null;
  const model = outcome.modelId ? ` on model ${outcome.modelId}` : "";
  if (outcome.state === "failed") {
    return `TURN FAILED: the product did not answer this turn${model}; the chat shows an error with code ${outcome.errorCode}. This is a product failure, not a layout question.`;
  }
  return `TURN FAILED: the turn ended with no answer at all${model}. This is a product failure, not a layout question.`;
}

/** The text of the Scout's report: what was tried and what came back. Never more. */
export const scoutReportText = (subject, outcome) =>
  `[Scout 자동 점검] ${subject}: 답변을 받지 못했습니다` +
  `${outcome.errorCode ? ` (오류 코드 ${outcome.errorCode})` : ""}` +
  `${outcome.modelId ? `, 모델 ${outcome.modelId}` : ""}.`;

/**
 * Sends the failure through the error card's own report button, as the test
 * account. The walker's write rule opens for exactly one POST to the feedback
 * route while the dialog submits. Email receipts stay off (the dialog's default),
 * so the only mail is the support notice every report sends. Answers whether the
 * report was accepted, or why not; never throws.
 */
export async function reportFailedTurn(page, rules, subject, outcome, { timeoutMs = 20_000 } = {}) {
  const button = page.locator(LAST_ANSWER).last().getByTestId("report-error-button");
  if (!(await button.isVisible().catch(() => false))) return { reported: false, reason: "no_report_button" };
  let writes = 0;
  // Restored after: a journey keeps its own write rule open across steps.
  const previous = rules.allowWrite;
  rules.allowWrite = (method, url) => method === "POST" && new URL(url).pathname === FEEDBACK_PATH && ++writes <= 1;
  try {
    await button.click();
    const dialog = page.getByTestId("feedback-dialog");
    await dialog.waitFor({ state: "visible", timeout: timeoutMs });
    await dialog.getByTestId("feedback-message").fill(scoutReportText(subject, outcome));
    const consent = dialog.getByTestId("feedback-email-updates");
    if (await consent.isChecked().catch(() => false)) await consent.uncheck();
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === FEEDBACK_PATH && candidate.request().method() === "POST", { timeout: timeoutMs }),
      dialog.getByTestId("feedback-submit").click(),
    ]);
    return response.ok() ? { reported: true } : { reported: false, reason: `status_${response.status()}` };
  } catch (error) {
    return { reported: false, reason: typeof error?.name === "string" ? error.name : "error" };
  } finally {
    rules.allowWrite = previous;
  }
}

/**
 * The walker's per-run budget of reports and its counts. One report per failure
 * class (code and model) a run: four turns failing the same way are one defect.
 */
export function createTurnReporter({ max = SCOUT_TURN_REPORTS_MAX } = {}) {
  const seen = new Set();
  const counts = { turnFailures: 0, reported: 0 };
  return {
    counts,
    /** Checks the newest answer; reports it once per class when it failed. Returns the fact line, or null. */
    async check(page, rules, subject) {
      const outcome = await readTurnOutcome(page);
      const fact = turnOutcomeFact(outcome);
      if (!fact) return null;
      counts.turnFailures += 1;
      const key = `${outcome.errorCode ?? outcome.state}|${outcome.modelId ?? ""}`;
      // A turn the walker's own rule broke is the walker's failure, not the product's.
      if (outcome.state !== "failed" || (rules.refusedWrites?.length ?? 0) > 0 || seen.has(key) || seen.size >= max) return fact;
      seen.add(key);
      const result = await reportFailedTurn(page, rules, subject, outcome);
      if (result.reported) counts.reported += 1;
      console.warn(JSON.stringify({ event: "product_research_scout_turn_failed", subject, errorCode: outcome.errorCode, modelId: outcome.modelId, ...result }));
      return `${fact} The Scout reported it with the product's own error report button (${result.reported ? "accepted" : `not sent: ${result.reason}`}).`;
    },
  };
}
