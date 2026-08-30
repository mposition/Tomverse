import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

/**
 * The web-search offer, end to end.
 *
 * The decision is pinned in `tests/webSearchRetrySuggestion.test.mjs`, the
 * words in `tests/webSearchSuggestionCopy.test.mjs` and the markup in
 * `tests/client/webSearchSuggestionCard.test.tsx`. What only a browser can
 * show is the part in between: that a question needing current information
 * ends in an offer rather than a dead end, that pressing it re-sends *that*
 * question exactly once with search on, and that doing so does not quietly
 * change what the conversation is set to.
 */

/** Native OpenAI search, dispatchable -- see lib/webSearchCapability.ts. */
const SEARCHING_MODEL_ID = "gpt-5-6-luna";
/** Deliberately `unverified` in the same table: this model cannot search. */
const NON_SEARCHING_MODEL_ID = "gpt-5-4-mini";

const WEATHER_QUESTION = "What is the weather in Seoul today?";
const ORDINARY_QUESTION =
  "Explain the difference between recursion and iteration";

const FIRST_ANSWER = "QA fixture: an answer written without searching.";
const SEARCHED_ANSWER = "QA fixture: an answer written from the web.";

type CapturedChatRequest = {
  modelId?: string;
  webSearchMode?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

type ChatFailure = { status: number; code: string } | null;

/**
 * One `/api/chat` handler for both sends, because the whole point is telling
 * them apart: the first carries no `webSearchMode`, the second carries
 * `"always"`. Two handlers could not show that the second is a re-run of the
 * first rather than a fresh question.
 *
 * The first answer is held open until the test releases it, so "nothing while
 * streaming" is asserted against a genuinely unfinished turn rather than a
 * race.
 */
/**
 * The out-of-band chunk a real searching turn appends
 * (`lib/webSearchStreamTrailer.ts`). Citations only resolve once the whole
 * turn settles, so they cannot ride in a header; the client splits this off
 * the text stream and reads `WebSearchExecution` out of it.
 */
const searchMetadataTrailer = (executed: boolean) =>
  `\u0000TOMVERSE_SEARCH_METADATA${JSON.stringify({
    searchMetadata: {
      requested: true,
      supported: true,
      executed,
      provider: "openai",
      tool: "web_search",
      queryCount: executed ? 1 : 0,
      citations: executed
        ? [{ url: "https://example.invalid/qa", title: "QA fixture source" }]
        : [],
    },
  })}`;

const mockChat = async (page: Page) => {
  const requests: CapturedChatRequest[] = [];
  let releaseFirstAnswer: (() => void) | null = null;
  const firstAnswerReleased = new Promise<void>((resolve) => {
    releaseFirstAnswer = resolve;
  });
  /** What the *searching* send should come back as. Null means success. */
  let searchFailure: ChatFailure = null;
  /** Whether the successful searching answer reports that it really searched. */
  let searchExecuted = true;
  /*
    Optional gate on the step *between* the press and the send being accepted.

    The card marks itself as starting on the press and stops when the send is
    accepted -- from there the panel's own streaming state is the progress. On
    a mocked backend that whole window is a few milliseconds, so asserting it
    directly is a race, and holding the chat *response* does not help: the send
    is accepted before the request goes out.

    `/api/chat/context` is inside that window (every send prices its context
    before it is accepted), so holding it holds exactly the state under test.
  */
  let holdSend: Promise<void> | null = null;
  let releaseSendGate: (() => void) | null = null;
  await page.route("**/api/chat/context", async (route) => {
    if (holdSend) await holdSend;
    await route.fallback();
  });

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as CapturedChatRequest;
    requests.push(body);

    if (body.webSearchMode === "always") {
      if (searchFailure) {
        await route.fulfill({
          status: searchFailure.status,
          contentType: "application/json",
          headers: { "X-Request-ID": `qa-trace-search-${requests.length}` },
          body: JSON.stringify({
            error: "QA fixture refusal.",
            code: searchFailure.code,
            traceId: `qa-trace-search-${requests.length}`,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": `qa-trace-search-${requests.length}` },
        // The stream trailer a real searching turn carries. Without it the
        // page has no evidence a search ran, which is a different outcome
        // (`searched` vs `said nothing`) and would not exercise this one.
        body: `${SEARCHED_ANSWER}${searchMetadataTrailer(searchExecuted)}`,
      });
      return;
    }

    await firstAnswerReleased;
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": `qa-trace-chat-${requests.length}` },
      body: FIRST_ANSWER,
    });
  });

  return {
    requests,
    releaseFirstAnswer: () => releaseFirstAnswer?.(),
    failSearchWith: (failure: ChatFailure) => {
      searchFailure = failure;
    },
    reportSearchExecuted: (executed: boolean) => {
      searchExecuted = executed;
    },
    holdSend: () => {
      holdSend = new Promise<void>((resolve) => {
        releaseSendGate = resolve;
      });
    },
    releaseSend: () => {
      holdSend = null;
      releaseSendGate?.();
      releaseSendGate = null;
    },
    searchingRequests: () =>
      requests.filter((request) => request.webSearchMode === "always"),
  };
};

/**
 * Every PATCH the page makes to the conversation, so "the switch was not
 * changed" can be asserted on what reached the server rather than on what is
 * drawn. The stored mode is the part that cannot be taken back.
 */
const watchConversationWrites = async (page: Page) => {
  const writes: Record<string, unknown>[] = [];
  await page.route(/.*\/api\/conversations\/[^/]+(\?.*)?$/, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown> | null;
      if (body) writes.push(body);
    }
    await route.fallback();
  });
  return writes;
};

/**
 * Which models a *new* conversation starts on.
 *
 * `mockAuthenticatedApi`'s `selectedModels` seeds the stored QA conversation,
 * and `sendChatMessage` creates a new one -- which the client seeds from the
 * account's new-conversation combination instead. Setting only the first left
 * every send on the account default, so the "this model cannot search" case
 * was quietly running on a model that could.
 */
const withDefaultCombination = async (
  page: Page,
  modelIds: string[],
  language: "en" | "ko"
) => {
  await page.unroute("**/api/user/settings**");
  await page.route("**/api/user/settings**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        theme: "system",
        language,
        defaultModel: modelIds[0],
        newConversationModelIds: modelIds,
        timeZone: "UTC",
        timeZoneInitializedAt: null,
        timeZoneChangedAt: null,
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
        imageHandoffAutoGenerate: false,
      }),
    })
  );
};

const openChat = async (
  page: Page,
  options: { selectedModels?: string[]; language?: "en" | "ko" } = {}
) => {
  const selectedModels = options.selectedModels ?? [SEARCHING_MODEL_ID];
  const language = options.language ?? "en";
  await prepareGuestPage(page, language);
  await mockAuthenticatedApi(page, { selectedModels });
  const chat = await mockChat(page);
  // Routes have to be in place before the first load: the settings a new
  // conversation is seeded from are read once, on mount.
  await withDefaultCombination(page, selectedModels, language);
  await page.goto(`/chat?lang=${language}`);
  return chat;
};

const card = (page: Page) => page.getByTestId("web-search-suggestion");
const confirm = (page: Page) => page.getByTestId("web-search-suggestion-confirm");
const dismiss = (page: Page) => page.getByTestId("web-search-suggestion-dismiss");

/** The first send, answered without searching -- where every test starts. */
const answerWithoutSearching = async (
  page: Page,
  testInfo: TestInfo,
  chat: Awaited<ReturnType<typeof mockChat>>,
  question = WEATHER_QUESTION
) => {
  await sendChatMessage(page, testInfo, question);
  await expect.poll(() => chat.requests.length).toBe(1);
  // The first send carries no mode at all: the switch is off, which is the
  // whole reason the offer exists.
  expect(chat.requests[0]?.webSearchMode).toBeUndefined();
  chat.releaseFirstAnswer();
  await expect(page.getByText(FIRST_ANSWER).first()).toBeVisible({
    timeout: 30_000,
  });
};

test("a question needing current information ends in an offer, not a dead end", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);
  const conversationWrites = await watchConversationWrites(page);

  await sendChatMessage(page, testInfo, WEATHER_QUESTION);
  // Nothing is offered while the answer is still being written.
  await expect.poll(() => chat.requests.length).toBe(1);
  await expect(card(page)).toHaveCount(0);

  chat.releaseFirstAnswer();
  await expect(page.getByText(FIRST_ANSWER).first()).toBeVisible({
    timeout: 30_000,
  });

  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  // One card for the question, however many panels answered it.
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toHaveAttribute("data-state", "enable");
  await expect(confirm(page)).toBeEnabled();
  await expect(dismiss(page)).toBeEnabled();

  // The card sits in the bottom dock, which the mobile composer contract
  // measures: a full sentence in it must wrap rather than widen the page.
  await expectNoHorizontalOverflow(page);

  // Reachable and operable from the keyboard alone.
  await confirm(page).focus();
  await expect(confirm(page)).toBeFocused();
  await page.keyboard.press("Enter");

  // Exactly one searching request, carrying the original question rather than
  // whatever the composer holds -- and the user never retyped it.
  await expect
    .poll(() => chat.searchingRequests().length, { timeout: 30_000 })
    .toBe(1);
  const searched = chat.searchingRequests()[0]!;
  const messages = searched.messages ?? [];
  expect(messages[messages.length - 1]?.role).toBe("user");
  expect(messages[messages.length - 1]?.content).toBe(WEATHER_QUESTION);

  await expect(page.getByText(SEARCHED_ANSWER).first()).toBeAttached({
    timeout: 60_000,
  });
  // The first answer is still there: the re-run adds, it does not erase.
  await expect(page.getByText(FIRST_ANSWER).first()).toBeAttached();

  // The offer is gone once acted on, so a second press cannot happen.
  await expect(card(page)).toHaveCount(0);
  expect(chat.searchingRequests()).toHaveLength(1);

  /*
    And the conversation's own switch is untouched. Answering "yes, check this
    one" is consent for one question; a silent global write would mean every
    later send in this conversation quietly paid the search surcharge.
  */
  expect(
    conversationWrites.filter((body) => "webSearchMode" in body)
  ).toHaveLength(0);
});

test("declining closes the offer and changes nothing", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);
  const conversationWrites = await watchConversationWrites(page);

  await answerWithoutSearching(page, testInfo, chat);
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  const messagesBefore = await page.getByTestId("chat-message").count();
  await dismiss(page).click();

  await expect(card(page)).toHaveCount(0);
  // Declining is not a message, not a search, and not a settings change.
  await expect(page.getByTestId("chat-message")).toHaveCount(messagesBefore);
  expect(chat.searchingRequests()).toHaveLength(0);
  expect(
    conversationWrites.filter((body) => "webSearchMode" in body)
  ).toHaveLength(0);
  await expect(page.getByText(FIRST_ANSWER).first()).toBeVisible();
});

test("a model that cannot search says so and offers no search action", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page, {
    selectedModels: [NON_SEARCHING_MODEL_ID],
  });

  await answerWithoutSearching(page, testInfo, chat);

  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  await expect(card(page)).toHaveAttribute("data-state", "unsupported");
  /*
    No dead CTA. A disabled "Check the web" would be the same dead end this
    feature removes, one screen later -- so the button is not rendered at all,
    and the card can still be put away.
  */
  await expect(confirm(page)).toHaveCount(0);
  await expect(dismiss(page)).toBeEnabled();
  expect(chat.searchingRequests()).toHaveLength(0);
});

test("a failed search keeps the question and offers one retry", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);
  chat.failSearchWith({ status: 500, code: "PROVIDER_ERROR" });

  await answerWithoutSearching(page, testInfo, chat);
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  // Held from here, not before: the gate is on every send, and holding it
  // during the first one would stop the answer the offer is made about.
  chat.holdSend();
  await confirm(page).click();

  /*
    Loading feedback is immediate: the card marks itself as starting on the
    press, before any answer exists.

    It is a short window on purpose. Once the send is accepted the card retires
    and the panel's own streaming state is the progress -- the same handover
    the Deep Research expansion makes. That handover is asserted in the success
    case above; here the run is about to fail, and a refusal can arrive fast
    enough that the card is back as `error` before an intermediate "gone" frame
    can be observed. Pinning a frame that only exists when the failure is slow
    would be a race rather than a requirement, so this asserts the immediate
    mark and then where the run lands.
  */
  await expect(card(page)).toHaveAttribute("data-starting", "true");
  // And while it is starting, both actions are shut: a second press cannot
  // get through and start a second run.
  await expect(confirm(page)).toBeDisabled();
  await expect(dismiss(page)).toBeDisabled();

  chat.releaseSend();
  await expect
    .poll(() => chat.searchingRequests().length, { timeout: 30_000 })
    .toBe(1);
  await expect(card(page)).toHaveAttribute("data-state", "error", {
    timeout: 30_000,
  });

  // The question survived the failure: retrying sends the same one again, and
  // the user never retyped it.
  chat.failSearchWith(null);
  await expect(confirm(page)).toBeEnabled({ timeout: 15_000 });
  await confirm(page).click();
  await expect
    .poll(() => chat.searchingRequests().length, { timeout: 30_000 })
    .toBe(2);
  const retried = chat.searchingRequests()[1]!;
  const messages = retried.messages ?? [];
  expect(messages[messages.length - 1]?.content).toBe(WEATHER_QUESTION);

  await expect(page.getByText(SEARCHED_ANSWER).first()).toBeAttached({
    timeout: 60_000,
  });
  await expect(card(page)).toHaveCount(0);
  // No third send: each press produced exactly one request, so neither the
  // failure nor the retry duplicated the question in the transcript.
  await page.waitForTimeout(1_000);
  expect(chat.searchingRequests()).toHaveLength(2);
});

test("a refusal the account cannot lift is stated as one, with no retry", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);
  chat.failSearchWith({ status: 503, code: "WEB_SEARCH_COST_UNBOUNDED" });

  await answerWithoutSearching(page, testInfo, chat);
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  await confirm(page).click();

  await expect
    .poll(() => chat.searchingRequests().length, { timeout: 30_000 })
    .toBe(1);
  // Blocked, not error: the server said the search cannot be authorized at
  // all, so pressing again would be refused again.
  await expect(card(page)).toHaveAttribute("data-state", "blocked", {
    timeout: 30_000,
  });
  await expect(confirm(page)).toHaveCount(0);
  await expect(dismiss(page)).toBeEnabled();

  // Dismissible even here: a card that cannot be put away is worse than none.
  await dismiss(page).click();
  await expect(card(page)).toHaveCount(0);
  expect(chat.searchingRequests()).toHaveLength(1);
});

test("a provider that declines to search is not reported as a search", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);
  // The turn succeeds, and its own metadata says no search ran. That is a
  // different outcome from a failed request and from a turn that said nothing,
  // and it is the one where the offer's promise went unkept.
  chat.reportSearchExecuted(false);

  await answerWithoutSearching(page, testInfo, chat);
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  await confirm(page).click();

  await expect
    .poll(() => chat.searchingRequests().length, { timeout: 30_000 })
    .toBe(1);
  await expect(card(page)).toHaveAttribute("data-state", "error", {
    timeout: 30_000,
  });
  // The answer that did arrive is kept: nothing is thrown away for it.
  await expect(page.getByText(SEARCHED_ANSWER).first()).toBeAttached();
});

test("an ordinary question is not offered a search", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);

  await answerWithoutSearching(page, testInfo, chat, ORDINARY_QUESTION);

  // Given a moment for the offer to appear if it were going to.
  await page.waitForTimeout(1_000);
  await expect(card(page)).toHaveCount(0);
});

test("the same question asked again is not offered a second time", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page);

  await answerWithoutSearching(page, testInfo, chat);
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  // Ignored rather than declined: being shown the card is itself an answer to
  // "have we asked?", so asking the same thing again does not ask again.
  await sendChatMessage(page, testInfo, WEATHER_QUESTION);
  await expect(card(page)).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(card(page)).toHaveCount(0);
});

test("the Korean card reads as Korean, with no markdown left showing", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const chat = await openChat(page, { language: "ko" });

  await answerWithoutSearching(page, testInfo, chat, "오늘 서울 날씨 알려줘");
  await expect(card(page)).toBeVisible({ timeout: 15_000 });

  await expect(confirm(page)).toHaveText("웹에서 확인");
  await expect(dismiss(page)).toHaveText("지금은 안 함");
  /*
    Nothing from the question is interpolated into the card, so no `**서울**`
    can survive into it -- this asserts the property rather than the absence of
    one string, because the copy is fixed and a raw asterisk anywhere in it
    would be a bug wherever it came from.
  */
  const text = (await card(page).innerText()).trim();
  expect(text).not.toMatch(/\*\*|(^|\s)#{1,6}\s|\[[^\]]*\]\([^)]*\)/);
  expect(text.length).toBeGreaterThan(0);
});
