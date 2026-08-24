import { expect, test } from "@playwright/test";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  THREE_MODELS,
  enterConversation,
  submitComposer,
} from "./support/chat-state-fixtures";

/**
 * Partial failure and recovery in a multi-model turn.
 *
 * The retry affordance was already captured by the visual-regression suite,
 * but only as a rendered screenshot: nothing clicked it. So a retry that sent
 * nothing, re-ran every panel instead of the failed one, or left the error
 * banner behind after a successful second attempt would have shipped with a
 * green suite.
 *
 * The stub answers each model from an ordered list of attempts, which is what
 * makes "only the failed model was re-requested" directly observable: the
 * healthy panels are given a *different* second answer, so if they had been
 * re-requested their text would have changed.
 */

const [MODEL_A, MODEL_B, MODEL_C] = THREE_MODELS;

const FIRST_B = "Panel B first answer.";
const FIRST_C = "Panel C first answer.";
/** Only ever reachable if a healthy panel is wrongly re-requested. */
const SECOND_B = "Panel B was re-requested.";
const SECOND_C = "Panel C was re-requested.";
const RECOVERED_A = "Panel A recovered answer.";

const panel = (page: import("@playwright/test").Page, index: number) =>
  page.getByTestId("chat-message-list").nth(index);

test.describe("multi-model failure and recovery", () => {
  test("one failing model leaves the other panels' answers intact", { tag: "@review-parity" }, async ({
    page,
  }) => {
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      modelStub: {
        [MODEL_A]: {
          kind: "error",
          status: 500,
          message: "QA fixture: upstream failure.",
        },
        [MODEL_B]: { kind: "success", chunks: [FIRST_B], intervalMs: 5 },
        [MODEL_C]: { kind: "success", chunks: [FIRST_C], intervalMs: 5 },
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(
      page,
      "One model should fail while the others answer.",
      DESKTOP_VIEWPORT.width
    );

    // The healthy panels still deliver, which is the whole point of comparing
    // several models at once.
    await expect(panel(page, 1)).toContainText(FIRST_B);
    await expect(panel(page, 2)).toContainText(FIRST_C);

    // Exactly one panel is in the error state, and it offers a retry.
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toHaveCount(1);
    await expect(retry).toBeEnabled();
    await expect(panel(page, 0)).not.toContainText(FIRST_B);
  });

  test("retrying a failed model re-requests only that model and recovers the answer", { tag: "@review-parity" }, async ({
    page,
  }) => {
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      modelStub: {
        // First attempt fails, second succeeds.
        [MODEL_A]: [
          { kind: "error", status: 500, message: "QA fixture: upstream failure." },
          { kind: "success", chunks: [RECOVERED_A], intervalMs: 5 },
        ],
        // A second answer that must never appear: reaching it would mean the
        // retry re-ran a panel that had already succeeded.
        [MODEL_B]: [
          { kind: "success", chunks: [FIRST_B], intervalMs: 5 },
          { kind: "success", chunks: [SECOND_B], intervalMs: 5 },
        ],
        [MODEL_C]: [
          { kind: "success", chunks: [FIRST_C], intervalMs: 5 },
          { kind: "success", chunks: [SECOND_C], intervalMs: 5 },
        ],
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(
      page,
      "Fail once, then recover on retry.",
      DESKTOP_VIEWPORT.width
    );

    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toHaveCount(1);
    await retry.click();

    /*
      The failed panel recovers on the second attempt, in place.

      `handleRetryLast` used to append a new turn and leave the failed one
      above it, so a recovered panel showed the same question twice -- once
      erroring, once answered -- and kept an error card for an attempt that no
      longer stood. Worse, the appended turn re-named the failed turn's
      attachments, and `/api/chat` refused the transcript for it: a retry of
      any turn carrying a file could not succeed at all. A retry now rebuilds
      its own turn (`lib/chatRetryTranscript.ts`), so what is left is the
      question, asked once, and the answer.
    */
    await expect(panel(page, 0)).toContainText(RECOVERED_A);
    await expect(panel(page, 0)).not.toContainText("QA fixture: upstream failure.");
    await expect(
      panel(page, 0).getByText("Fail once, then recover on retry.")
    ).toHaveCount(1);
    // Nothing is in an error state any more, so nothing offers a retry.
    await expect(
      page.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);

    // Only the failed model was re-requested: the healthy panels never reach
    // their second scripted answer.
    await expect(panel(page, 1)).toContainText(FIRST_B);
    await expect(panel(page, 2)).toContainText(FIRST_C);
    await expect(page.getByText(SECOND_B)).toHaveCount(0);
    await expect(page.getByText(SECOND_C)).toHaveCount(0);

    // The composer is usable again for the next turn.
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  });

  test("an empty provider response is reported rather than left blank", { tag: "@review-parity" }, async ({
    page,
  }) => {
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      selectedModels: [MODEL_A],
      modelStub: { [MODEL_A]: { kind: "empty" } },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(
      page,
      "The provider returns nothing at all.",
      DESKTOP_VIEWPORT.width
    );

    // A 200 with a zero-byte body must not read as a delivered answer.
    await expect(
      page.getByRole("button", { name: "Retry", exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  });

  test("retry is reachable and usable on a phone-sized viewport", async ({
    page,
  }) => {
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: MOBILE_VIEWPORT,
      selectedModels: [MODEL_A],
      modelStub: {
        [MODEL_A]: [
          { kind: "error", status: 503, message: "QA fixture: provider busy." },
          { kind: "success", chunks: [RECOVERED_A], intervalMs: 5 },
        ],
      },
    });
    await page.setViewportSize(MOBILE_VIEWPORT);
    await submitComposer(
      page,
      "Fail once on mobile, then recover.",
      MOBILE_VIEWPORT.width
    );

    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    // Reachable by its own centre point, not merely attached.
    const box = await retry.boundingBox();
    expect(box).not.toBeNull();
    const topmost = await page.evaluate(
      ([x, y]) =>
        document
          .elementFromPoint(x as number, y as number)
          ?.closest("button")
          ?.textContent?.trim() ?? null,
      [box!.x + box!.width / 2, box!.y + box!.height / 2]
    );
    expect(topmost).toContain("Retry");

    await retry.click();
    await expect(panel(page, 0)).toContainText(RECOVERED_A);
  });
});
