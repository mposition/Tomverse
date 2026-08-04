import { expect, test, type Page } from "@playwright/test";
import {
  DESKTOP_VIEWPORT,
  THREE_MODELS,
  enterConversation,
  submitComposer,
} from "./support/chat-state-fixtures";

/**
 * The client half of the §10 context bundle and §13.4's disclosure.
 *
 * Neither is reachable in production yet — injection is fail-closed behind
 * `memoryInjectionEnabled`, so nothing issues a bundle and no answer carries
 * a count. These specs drive the paths directly, which is the only way they
 * can be known to work before the flag is ever turned on.
 *
 * Two behaviours are worth pinning, and both are about restraint rather than
 * feature:
 *
 *   * the count is shown only when the server sent one. Absent is not zero,
 *     and §13.4 forbids a misleading indication;
 *   * a stale bundle is retried once for a single-model send and never for
 *     one panel of a comparison, whose panels share a snapshot on purpose.
 */

const [MODEL_A, MODEL_B, MODEL_C] = THREE_MODELS;

const ANSWER = "The answer that used memories.";
const RETRIED_ANSWER = "The answer after the context was prepared again.";
/** Only reachable if a comparison panel wrongly retried by itself. */
const PANEL_A_RETRY = "Panel A retried on its own.";

const panel = (page: Page, index: number) =>
  page.getByTestId("chat-message-list").nth(index);

/**
 * The context preparation endpoint, which the real one answers with `null`
 * for everyone today. Returning a token is what lets these specs exercise the
 * path the flag will one day open.
 */
async function mockContextPreparation(page: Page, options: { bundle?: string | null } = {}) {
  const state = { calls: 0 };
  await page.route("**/api/chat/context", async (route) => {
    state.calls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        contextBundle:
          options.bundle === undefined
            ? `qa-bundle-${state.calls}`
            : options.bundle,
        memoryUsedCount: 0,
      }),
    });
  });
  return state;
}

test.describe("chat memory context", () => {
  test("an answer states how many memories it was given @ui-risk", async ({
    page,
  }) => {
    await mockContextPreparation(page);
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      selectedModels: [MODEL_A],
      modelStub: {
        [MODEL_A]: {
          kind: "success",
          chunks: [ANSWER],
          intervalMs: 5,
          memoryUsedCount: 3,
        },
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "What do you know about me?", DESKTOP_VIEWPORT.width);

    await expect(panel(page, 0)).toContainText(ANSWER);
    const disclosure = page.getByTestId("memory-usage-disclosure");
    await expect(disclosure).toBeVisible();
    // The server's number, rendered as the server sent it.
    await expect(disclosure).toContainText("3");
  });

  test("an answer that used no memories says nothing at all", async ({
    page,
  }) => {
    await mockContextPreparation(page);
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      selectedModels: [MODEL_A],
      // No header: the ordinary case, and the one a "0 memories used" line
      // would misrepresent.
      modelStub: {
        [MODEL_A]: { kind: "success", chunks: [ANSWER], intervalMs: 5 },
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "An ordinary question.", DESKTOP_VIEWPORT.width);

    await expect(panel(page, 0)).toContainText(ANSWER);
    await expect(page.getByTestId("memory-usage-disclosure")).toHaveCount(0);
  });

  test("a single-model send whose context went stale is retried once @ui-risk", async ({
    page,
  }) => {
    const preparation = await mockContextPreparation(page);
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      selectedModels: [MODEL_A],
      modelStub: {
        [MODEL_A]: [
          {
            kind: "error",
            status: 409,
            code: "CHAT_CONTEXT_BUNDLE_STALE",
            message: "QA fixture: the context changed.",
            details: { requiresPreflight: true },
          },
          { kind: "success", chunks: [RETRIED_ANSWER], intervalMs: 5 },
        ],
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "Approve a memory mid-send.", DESKTOP_VIEWPORT.width);

    // The retry is automatic and invisible: the user sees an answer, not an
    // error they have to act on. Nothing had been shown when the refusal
    // arrived, which is the condition §10 attaches to retrying at all.
    await expect(panel(page, 0)).toContainText(RETRIED_ANSWER);
    // Prepared twice: once for the send, once for the retry. A retry that
    // re-presented the same bundle would be refused again -- and would be a
    // replay, not a recovery.
    expect(preparation.calls).toBeGreaterThanOrEqual(2);
  });

  test("a second stale refusal is surfaced instead of retried again", async ({
    page,
  }) => {
    await mockContextPreparation(page);
    const stale = {
      kind: "error" as const,
      status: 409,
      code: "CHAT_CONTEXT_BUNDLE_STALE",
      message: "QA fixture: the context changed.",
      details: { requiresPreflight: true },
    };
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      selectedModels: [MODEL_A],
      modelStub: {
        // Third attempt would only be reached by a second automatic retry,
        // which §10 forbids.
        [MODEL_A]: [
          stale,
          stale,
          { kind: "success", chunks: [PANEL_A_RETRY], intervalMs: 5 },
        ],
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "Approve a memory twice.", DESKTOP_VIEWPORT.width);

    await expect(
      panel(page, 0).getByRole("button", { name: "Retry", exact: true })
    ).toBeVisible();
    await expect(panel(page, 0)).not.toContainText(PANEL_A_RETRY);
    // The user is told what happened in their own language, and what fixes
    // it. The server's English sentence never reaches the panel.
    await expect(panel(page, 0)).toContainText("account memory changed");
    await expect(panel(page, 0)).not.toContainText("QA fixture");
  });

  test("one comparison panel never re-prepares on its own @ui-risk", async ({
    page,
  }) => {
    const preparation = await mockContextPreparation(page);
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      modelStub: {
        [MODEL_A]: [
          {
            kind: "error",
            status: 409,
            code: "CHAT_CONTEXT_BUNDLE_STALE",
            message: "QA fixture: the context changed.",
            details: { requiresPreflight: true },
          },
          { kind: "success", chunks: [PANEL_A_RETRY], intervalMs: 5 },
        ],
        [MODEL_B]: { kind: "success", chunks: ["Panel B answer."], intervalMs: 5 },
        [MODEL_C]: { kind: "success", chunks: ["Panel C answer."], intervalMs: 5 },
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "Compare three models.", DESKTOP_VIEWPORT.width);

    // The panels share one bundle lineage so that they see one snapshot.
    // Re-preparing this panel alone would put it on a different context from
    // its siblings, which is the thing sharing the lineage exists to prevent.
    await expect(panel(page, 1)).toContainText("Panel B answer.");
    await expect(panel(page, 2)).toContainText("Panel C answer.");
    // The refused panel never answers: its second attempt is only reachable
    // through a retry it must not take.
    await expect(panel(page, 0)).not.toContainText(PANEL_A_RETRY);
    await expect(panel(page, 0)).toContainText("account memory changed");
    // And it never re-prepares. A comparison's bundle comes from the
    // aggregate preflight, so this endpoint should not be reached at all --
    // not on the send, and not on the refusal. Any call here would be one
    // panel moving to a snapshot its siblings are not on.
    expect(preparation.calls).toBe(0);
  });
});
