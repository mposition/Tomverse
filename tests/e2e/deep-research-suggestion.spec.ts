import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

/**
 * The Deep Research expansion offer, end to end.
 *
 * The decision itself is pinned in `tests/deepResearchSuggestion.test.mjs` and
 * the card's markup in `tests/client/deepResearchSuggestionCard.test.tsx`.
 * What only a browser can show is the part in between: that the offer appears
 * after a real answer finishes and not before, that pressing it starts exactly
 * one deep research run carrying the original question, and that the answer
 * already on screen survives all of it.
 */

const DEEP_RESEARCH_MODEL_ID = "perplexity/sonar-deep-research";
const CHAT_MODEL_ID = "gpt-5-4-mini";

const RESEARCH_QUESTION =
  "Compare the latest sources on the 2026 solid-state battery market";
const TRANSLATION_QUESTION =
  "Translate this sentence into Korean: the meeting was cancelled";

const CHAT_ANSWER = "QA fixture: a short first-pass answer.";
const DEEP_RESEARCH_REPORT = "QA fixture: the deep research report.";

type CapturedChatRequest = {
  modelId?: string;
  messages?: Array<{ role?: string; content?: string }>;
  deepResearchDepth?: string;
};

/**
 * Deep Research is a Pro model (lib/models.ts), and the offer is only made to
 * viewers who could actually run it -- so the Free defaults in
 * `mockAuthenticatedApi` would hide the card for the right reason and prove
 * nothing about the rest.
 */
const asProPlan = async (page: Page) => {
  await page.unroute("**/api/user/usage**");
  await page.route("**/api/user/usage**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: "Pro",
        subscription: {
          status: "active",
          billingInterval: "monthly",
          currentPeriodEnd: "2099-01-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        usage: {
          creditsDay: 0,
          creditsMonth: 0,
          proModelResponsesMonth: 0,
          tokensDay: 0,
          tokensMonth: 0,
          costDay: 0,
          costMonth: 0,
        },
        balances: {
          dailyRemainingCredits: 300,
          dailyResetsAt: "2099-01-02T00:00:00.000Z",
          planRemainingCredits: 3000,
          planResetsAt: "2099-02-01T00:00:00.000Z",
          purchasedRemainingCredits: 0,
          purchasedFundedCostMicroUsd: 0,
          purchasedEarliestExpiry: null,
        },
        creditDebt: {
          credits: 0,
          fundedCostMicroUsd: 0,
          riskStatus: "clear",
          riskReason: null,
          riskAt: null,
        },
        recommendation: { primary: null, secondary: null },
        limits: {
          creditsDay: 300,
          creditsMonth: 3000,
          proModelResponsesMonth: 3000,
          tokensDay: 0,
          tokensMonth: 0,
          costDay: 0,
          costMonth: 0,
          maxModels: 3,
          allowAttachments: true,
          allowSharing: true,
          allowDownloads: true,
        },
      }),
    })
  );
};

/**
 * One `/api/chat` handler for both models, because the whole point is that
 * one question produces an ordinary answer and then, only on the press, a
 * second request on the research model. Two handlers could not tell the
 * difference between "the expansion ran" and "the first send did".
 *
 * The ordinary answer is held open until the test releases it, so the
 * "nothing while streaming" assertion is made against a genuinely unfinished
 * turn rather than a race.
 */
const mockChatAndDeepResearch = async (page: Page) => {
  const requests: CapturedChatRequest[] = [];
  let releaseChatAnswer: (() => void) | null = null;
  const chatAnswerReleased = new Promise<void>((resolve) => {
    releaseChatAnswer = resolve;
  });
  let statusPolls = 0;

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as CapturedChatRequest;
    requests.push(body);

    if (body.modelId === DEEP_RESEARCH_MODEL_ID) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "X-Request-ID": `qa-trace-deep-research-${requests.length}`,
          "X-Chat-Response-Mode": "async-job",
        },
        body: JSON.stringify({
          deepResearchJobId: `qa-deep-research-job-${requests.length}`,
          status: "submitted",
        }),
      });
      return;
    }

    await chatAnswerReleased;
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": `qa-trace-chat-${requests.length}` },
      body: CHAT_ANSWER,
    });
  });

  await page.route("**/api/chat/deep-research/status", async (route) => {
    statusPolls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        statusPolls === 1
          ? { status: "in_progress" }
          : { status: "completed", content: DEEP_RESEARCH_REPORT }
      ),
    });
  });

  return {
    requests,
    releaseChatAnswer: () => releaseChatAnswer?.(),
    deepResearchRequests: () =>
      requests.filter((request) => request.modelId === DEEP_RESEARCH_MODEL_ID),
  };
};

const openChat = async (
  page: Page,
  options: { selectedModels?: string[]; beforeNavigate?: (page: Page) => Promise<void> } = {}
) => {
  const selectedModels = options.selectedModels ?? [CHAT_MODEL_ID];
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { selectedModels });
  await asProPlan(page);
  const chat = await mockChatAndDeepResearch(page);
  // Routes have to be in place before the first load: the settings the client
  // seeds a new conversation from are read once, on mount.
  await options.beforeNavigate?.(page);
  await page.goto("/chat?lang=en");
  return chat;
};

/**
 * Exactly `limits.maxModels` in `asProPlan`, so the expansion has no free slot
 * to put Deep Research in.
 */
const FULL_SELECTION = [CHAT_MODEL_ID, "gpt-5-6-luna", "claude-sonnet-5"];

/**
 * The cap has to be reached by the conversation the test actually sends in,
 * and that is a *new* one -- `sendChatMessage` creates it, and the client
 * seeds it from the account's new-conversation combination, not from whatever
 * the seeded QA conversation holds. Setting `selectedModels` alone left the
 * send on the single default model, one slot short of the cap, so the
 * expansion took the free-slot branch and proved nothing.
 */
const withFullDefaultCombination = async (page: Page) => {
  await page.unroute("**/api/user/settings**");
  await page.route("**/api/user/settings**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        theme: "system",
        language: "en",
        defaultModel: CHAT_MODEL_ID,
        newConversationModelIds: FULL_SELECTION,
        timeZone: "UTC",
        timeZoneInitializedAt: null,
        timeZoneChangedAt: null,
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
        imageHandoffAutoGenerate: false,
      }),
    })
  );
};

const card = (page: Page) => page.getByTestId("deep-research-suggestion");

test("the offer waits for the answer, then expands it into one deep research run", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);

  await sendChatMessage(page, testInfo, RESEARCH_QUESTION);

  // Requirement 2: nothing is offered while the answer is still being written.
  await expect.poll(() => chat.requests.length).toBe(1);
  await expect(card(page)).toHaveCount(0);

  chat.releaseChatAnswer();
  await expect(page.getByText(CHAT_ANSWER).first()).toBeVisible({ timeout: 30_000 });

  // Requirement 1: the offer appears once the answer is complete.
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  // Requirement 5: one card for the question, however many panels answered it.
  await expect(card(page)).toHaveCount(1);

  // Requirement 10: the estimate is on the card, before the press.
  await expect(
    page.getByTestId("deep-research-suggestion-estimate")
  ).toBeVisible();

  // The card sits inside the bottom dock, which the mobile composer contract
  // measures: a full sentence in it must wrap rather than widen the page.
  await expectNoHorizontalOverflow(page);

  const expand = page.getByTestId("deep-research-suggestion-expand");
  await expect(expand).toBeEnabled();
  // Requirement 11: reachable and operable from the keyboard.
  await expand.focus();
  await expect(expand).toBeFocused();
  await page.keyboard.press("Enter");

  // Requirement 6: exactly one deep research request, carrying the original
  // question rather than whatever the composer holds.
  await expect.poll(() => chat.deepResearchRequests().length, {
    timeout: 30_000,
  }).toBe(1);
  const request = chat.deepResearchRequests()[0]!;
  const messages = request.messages ?? [];
  expect(messages[messages.length - 1]?.role).toBe("user");
  expect(messages[messages.length - 1]?.content).toBe(RESEARCH_QUESTION);
  expect(request.deepResearchDepth).toBe("standard");

  /*
    Requirement 7: the ordinary answer is still there, untouched.

    `.first()` rather than the bare locator because starting the run adds the
    research panel beside the existing one, and the conversation's history
    renders in both -- so the answer is on screen more than once. More than
    once is the passing side of this assertion; zero would be the failure.
  */
  await expect(page.getByText(CHAT_ANSWER).first()).toBeVisible();

  /*
    The deep research result arrives as its own follow-up answer, beside the
    first one rather than in place of it.

    Attached rather than visible, because the two shells put the second panel
    in different places: desktop shows both side by side, mobile puts each
    model behind its own tab and only the active one is painted. What this
    test is about is that the report is a *second* answer -- which is true in
    both -- and the panel layouts have their own contracts and their own specs.
  */
  await expect(page.getByText(DEEP_RESEARCH_REPORT).first()).toBeAttached({
    timeout: 60_000,
  });
  await expect(page.getByText(CHAT_ANSWER).first()).toBeVisible();

  // Requirement 6 again, from the other side: a second press cannot happen,
  // because the offer is gone once it has been acted on.
  await expect(card(page)).toHaveCount(0);
  expect(chat.deepResearchRequests()).toHaveLength(1);
});

test("declining closes the offer without writing anything to the conversation", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);

  await sendChatMessage(page, testInfo, RESEARCH_QUESTION);
  chat.releaseChatAnswer();
  await expect(page.getByText(CHAT_ANSWER).first()).toBeVisible({ timeout: 30_000 });
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  const messagesBefore = await page.getByTestId("chat-message").count();
  await page.getByTestId("deep-research-suggestion-dismiss").click();

  // Requirement 8: the card closes, and declining is not a message.
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("chat-message")).toHaveCount(messagesBefore);
  expect(chat.deepResearchRequests()).toHaveLength(0);
  await expect(page.getByText(CHAT_ANSWER).first()).toBeVisible();
});

test("the same question asked again is not offered a second time", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);

  await sendChatMessage(page, testInfo, RESEARCH_QUESTION);
  chat.releaseChatAnswer();
  await expect(card(page)).toBeVisible({ timeout: 30_000 });

  // Ignored, not declined: the card is simply left alone and the same
  // question is asked again. Requirement 8's other half -- "already offered"
  // ends the repeat just as a decline does.
  await sendChatMessage(page, testInfo, RESEARCH_QUESTION);
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(card(page)).toHaveCount(0);
});

test("a question Deep Research would not improve is never offered it", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);

  await sendChatMessage(page, testInfo, TRANSLATION_QUESTION);
  chat.releaseChatAnswer();
  await expect(page.getByText(CHAT_ANSWER).first()).toBeVisible({ timeout: 30_000 });

  // Requirement 3: a translation is finished work, not a research question.
  // Given a moment for the offer to appear if it were going to.
  await page.waitForTimeout(1_000);
  await expect(card(page)).toHaveCount(0);
});

/**
 * At the model cap the expansion has to take a slot from something already
 * selected. It asks which one.
 *
 * The panels are rendered straight from `selectedModels`, so dropping a model
 * takes its panel -- and the answers already in it -- out of the conversation,
 * and the change is written to `Conversation.selectedModels`, a column with no
 * history table. Picking the victim silently made that a single unconfirmed
 * press; these two cases are what stops it coming back.
 *
 * The assertion is on the PATCH rather than on what is drawn: the selection
 * reaching the server is the part that cannot be taken back.
 */
const watchSelectionWrites = async (page: Page) => {
  const writes: string[][] = [];
  await page.route(/.*\/api\/conversations\/[^/]+(\?.*)?$/, async (route) => {
    if (route.request().method() === "PATCH") {
      // `selectedModels`, the key the sync queue's PATCH actually carries.
      // Watching `models` recorded nothing at all, which would have made the
      // "nothing was written" assertion below pass without observing anything.
      const body = route.request().postDataJSON() as { selectedModels?: unknown } | null;
      if (Array.isArray(body?.selectedModels)) {
        writes.push(body.selectedModels as string[]);
      }
    }
    // Straight on to the fixture that actually stores it.
    await route.fallback();
  });
  return writes;
};

test("at the model cap the expansion asks which model to replace", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page, {
    selectedModels: FULL_SELECTION,
    beforeNavigate: withFullDefaultCombination,
  });
  const selectionWrites = await watchSelectionWrites(page);

  await sendChatMessage(page, testInfo, RESEARCH_QUESTION);
  chat.releaseChatAnswer();
  // Attached, not visible: at the cap the mobile shell puts each model in its
  // own tab and only the selected one is on screen, so the first panel's copy
  // of the answer is legitimately hidden. What this waits for is the turn
  // having finished, which the offer below then depends on.
  await expect(page.getByText(CHAT_ANSWER).first()).toBeAttached({ timeout: 30_000 });
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  const writesBefore = selectionWrites.length;
  await page.getByTestId("deep-research-suggestion-expand").click();

  // The choice is put to the user rather than made for them, and no selection
  // has been written while it is open.
  const dialog = page.getByTestId("replace-model-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  expect(chat.deepResearchRequests()).toHaveLength(0);
  expect(selectionWrites).toHaveLength(writesBefore);

  // Choosing one runs the research, and only then. The model the user picked
  // is the one that leaves; the two they did not pick stay.
  await dialog.getByRole("button", { name: /Luna/i }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => chat.deepResearchRequests().length, { timeout: 30_000 })
    .toBe(1);
  const written = selectionWrites.at(-1) ?? [];
  expect(written).toContain(DEEP_RESEARCH_MODEL_ID);
  expect(written).toContain(CHAT_MODEL_ID);
  expect(written).not.toContain("gpt-5-6-luna");
});

test("cancelling the cap dialog abandons the run and keeps every model", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page, {
    selectedModels: FULL_SELECTION,
    beforeNavigate: withFullDefaultCombination,
  });
  const selectionWrites = await watchSelectionWrites(page);

  await sendChatMessage(page, testInfo, RESEARCH_QUESTION);
  chat.releaseChatAnswer();
  // Attached, not visible: at the cap the mobile shell puts each model in its
  // own tab and only the selected one is on screen, so the first panel's copy
  // of the answer is legitimately hidden. What this waits for is the turn
  // having finished, which the offer below then depends on.
  await expect(page.getByText(CHAT_ANSWER).first()).toBeAttached({ timeout: 30_000 });
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  const writesBefore = selectionWrites.length;
  await page.getByTestId("deep-research-suggestion-expand").click();
  const dialog = page.getByTestId("replace-model-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Nothing ran, nothing was written, and the answer that prompted the offer
  // is still there. The pause is for a send that must not arrive.
  await page.waitForTimeout(1_000);
  expect(chat.deepResearchRequests()).toHaveLength(0);
  expect(selectionWrites).toHaveLength(writesBefore);
  await expect(page.getByText(CHAT_ANSWER).first()).toBeAttached();
});
