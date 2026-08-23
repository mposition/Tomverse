import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
} from "./support/app-fixtures";
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
 *     and §13.4 forbids a misleading indication. Both halves of "the server
 *     sent one" are driven: the streaming header, and the stored answer read
 *     back when the conversation is reopened;
 *   * a stale bundle is retried once for a single-model send and never for
 *     one panel of a comparison, whose panels share a snapshot on purpose.
 */

const [MODEL_A, MODEL_B, MODEL_C] = THREE_MODELS;

const ANSWER = "The answer that used memories.";
const RETRIED_ANSWER = "The answer after the context was prepared again.";
/** Only reachable through a retry: the first attempt is always refused. */
const PANEL_A_RECOVERED = "Panel A recovered answer.";

const STALE = {
  kind: "error" as const,
  status: 409,
  code: "CHAT_CONTEXT_BUNDLE_STALE",
  message: "QA fixture: the context changed.",
  details: { requiresPreflight: true },
};

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

  test("an answer names memory and profile knowledge separately @ui-risk", async ({
    page,
  }) => {
    // docs/policy/external-conversation-import-and-memory.md §14.3. The two counts are
    // different claims about where the answer came
    // from, so the sentence has to carry both numbers rather than a sum --
    // 2 and 3 are chosen so that a merged "5" fails this outright.
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
          memoryUsedCount: 2,
          knowledgeChunkCount: 3,
        },
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "What does my document say?", DESKTOP_VIEWPORT.width);

    await expect(panel(page, 0)).toContainText(ANSWER);
    const disclosure = page.getByTestId("memory-usage-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText("2");
    await expect(disclosure).toContainText("3");
    await expect(disclosure).not.toContainText("5");
  });

  test("an answer given only profile knowledge says only that @ui-risk", async ({
    page,
  }) => {
    // The header for memory is absent here, which is not the same as zero:
    // the sentence must name knowledge and must not claim any memory.
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
          knowledgeChunkCount: 4,
        },
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "What does my document say?", DESKTOP_VIEWPORT.width);

    await expect(panel(page, 0)).toContainText(ANSWER);
    const disclosure = page.getByTestId("memory-usage-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText("4");
    await expect(disclosure).not.toContainText("account memories");
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

  test("reopening the conversation states it again", async ({ page }) => {
    // The disclosure used to live only in the streaming response header, so
    // it was true while the answer was being written and gone the next time
    // the conversation was opened. This drives the other path: a stored
    // answer, read back through the conversation endpoint, with nothing
    // streaming at all.
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini"],
      messages: [
        { id: "stored-user", role: "user", content: "What do you know about me?" },
        {
          id: "stored-answer",
          role: "assistant",
          content: ANSWER,
          modelId: "gpt-5-4-mini",
          memoryUsedCount: 3,
        },
      ],
    });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

    await expect(panel(page, 0)).toContainText(ANSWER);
    const disclosure = page.getByTestId("memory-usage-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText("3");
  });

  test("a reopened answer with no stored count still says nothing", async ({
    page,
  }) => {
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini"],
      messages: [
        { id: "stored-user", role: "user", content: "An ordinary question." },
        {
          id: "stored-answer",
          role: "assistant",
          content: ANSWER,
          modelId: "gpt-5-4-mini",
        },
      ],
    });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);

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
          { kind: "success", chunks: [PANEL_A_RECOVERED], intervalMs: 5 },
        ],
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "Approve a memory twice.", DESKTOP_VIEWPORT.width);

    await expect(
      panel(page, 0).getByRole("button", { name: "Retry", exact: true })
    ).toBeVisible();
    await expect(panel(page, 0)).not.toContainText(PANEL_A_RECOVERED);
    // The user is told what happened in their own language, and what fixes
    // it. The server's English sentence never reaches the panel.
    await expect(panel(page, 0)).toContainText("account memory changed");
    await expect(panel(page, 0)).not.toContainText("QA fixture");
  });

  test("a stale comparison re-prepares once, as a set @ui-risk", async ({
    page,
  }) => {
    const preparation = await mockContextPreparation(page);
    await enterConversation(page, {
      theme: "light",
      lang: "en",
      viewport: DESKTOP_VIEWPORT,
      modelStub: {
        // Every panel is refused, which is what actually happens: they present
        // one bundle against one server state, so they get one verdict. Each
        // then answers from its second attempt.
        [MODEL_A]: [
          STALE,
          { kind: "success", chunks: [PANEL_A_RECOVERED], intervalMs: 5 },
        ],
        [MODEL_B]: [
          STALE,
          { kind: "success", chunks: ["Panel B answer."], intervalMs: 5 },
        ],
        [MODEL_C]: [
          STALE,
          { kind: "success", chunks: ["Panel C answer."], intervalMs: 5 },
        ],
      },
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await submitComposer(page, "Compare three models.", DESKTOP_VIEWPORT.width);

    // The run recovers, and it recovers together: every panel answers, and
    // none of them is left showing the refusal.
    await expect(panel(page, 0)).toContainText(PANEL_A_RECOVERED);
    await expect(panel(page, 1)).toContainText("Panel B answer.");
    await expect(panel(page, 2)).toContainText("Panel C answer.");
    await expect(page.getByText("account memory changed")).toHaveCount(0);

    // Once, for the whole set. Three preparations would put the three panels
    // on three snapshots -- the per-panel retry §10 forbids, wearing the
    // recovery's clothes. The send itself takes its bundle from the aggregate
    // preflight, so this count is the re-preparation and nothing else.
    expect(preparation.calls).toBe(1);
  });
});
