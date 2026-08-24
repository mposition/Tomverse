import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  finishControlledStream,
  installChatModelStub,
  pushControlledChunk,
  restoreActiveConversation,
  setDeterministicTheme,
  submitComposer,
  suppressTransientUi,
  waitForControlledStream,
  type ChatModelStubSpec,
} from "./support/chat-state-fixtures";

// ---------------------------------------------------------------------------
// UX-024. Switching conversations while a response is still streaming.
//
// `ChatPageClient.handleSelectConversation` opens with `if (isSending) return;`
// -- a guard that has never run, because `isSending` is a hardcoded `false`
// (the composer's busy state comes from each shell's own `isAnyModelResponding`
// instead, so the constant is inert everywhere else). The release checklist
// carried this forward as unmeasured: the shared fixture seeded a single
// conversation, so the switch could not be performed at all.
//
// These tests perform it, and the answer is that switching is safe and stays
// allowed. Nothing aborts the panel's request here (only "stop all" and the
// per-panel stop button do), and app/api/chat/route.ts persists the assistant
// message against the `conversationId` captured when the send started. The
// client never writes an assistant message itself, so the stream cannot follow
// the user into the conversation they switched to.
//
// What this file can judge: which conversation is open, and what each panel
// shows. What it deliberately does not judge: whether the answer is on the
// server afterwards. `installChatModelStub` answers POST /api/chat inside the
// page, so the real route -- and the only thing that persists an assistant
// message -- never runs. Asserting persistence here would be asserting the
// mock. That belongs to the server contract suite, not to a browser test.
// ---------------------------------------------------------------------------

const MODEL = "gpt-5-4-mini";
const OTHER_CONVERSATION = "qa-conversation-2";
// Twelve chunks 400ms apart: the stream is unambiguously still in flight when
// the switch happens, rather than a fast stub that has already finished by the
// time the click lands and would quietly test nothing.
const STREAM_CHUNKS = Array.from({ length: 12 }, (_, index) => `chunk${index} `);
const FIRST_CHUNK = "chunk0";
const OTHER_ANSWER = "This answer belongs to the second conversation.";
const THIRD_ANSWER = "This answer belongs to the third conversation.";
const SECOND_ANSWER = "This answer belongs to the brand new conversation.";
// Two halves of one answer, so "everything received so far" can be asserted as
// a single string rather than as two independent substrings.
const PARTIAL_ONE = "PARTIAL-ONE";
const PARTIAL_TWO = "PARTIAL-TWO";

async function openTwoConversationWorkspace(page: Page) {
  const authState = await mockAuthenticatedApi(page, {
    selectedModels: [MODEL],
    messages: [
      { id: "seed-user-1", role: "user", content: "First conversation seed." },
      {
        id: "seed-assistant-1",
        role: "assistant",
        content: "Seeded reply in the first conversation.",
        modelId: MODEL,
      },
    ],
    extraConversations: [
      {
        id: OTHER_CONVERSATION,
        title: "Second QA conversation",
        selectedModels: [MODEL],
        messages: [
          { id: "seed-user-2", role: "user", content: "Second conversation seed." },
          {
            id: "seed-assistant-2",
            role: "assistant",
            content: OTHER_ANSWER,
            modelId: MODEL,
          },
        ],
      },
    ],
  });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  return authState;
}

const conversationRow = (page: Page, id: string) =>
  page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${id}"]`);

test.describe("UX-024: switching conversations while a response streams", () => {
  test("both conversations are reachable from the sidebar", async ({ page }) => {
    await openTwoConversationWorkspace(page);

    await expect(conversationRow(page, "qa-conversation")).toBeVisible();
    await expect(conversationRow(page, OTHER_CONVERSATION)).toBeVisible();

    // The switch itself works when nothing is in flight -- establishing that
    // any failure below belongs to the streaming state, not to the fixture.
    await conversationRow(page, OTHER_CONVERSATION).click();
    await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
  });

  test("the switch is allowed mid-stream, and the stream does not follow", { tag: "@review-parity" }, async ({ page }) => {
    await openTwoConversationWorkspace(page);

    await installChatModelStub(page, {
      [MODEL]: { kind: "success", chunks: STREAM_CHUNKS, intervalMs: 400 },
    });

    await submitComposer(page, "Start a long answer.", DESKTOP_VIEWPORT.width);
    await expect(page.getByText(FIRST_CHUNK, { exact: false })).toBeVisible();
    // Proves the send is genuinely in flight: the composer is only disabled
    // while a panel reports `responding`. Without this the test could pass
    // against a stream that had already finished.
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();

    await conversationRow(page, OTHER_CONVERSATION).click();

    // Allowed: the sidebar selection actually moves.
    await expect(conversationRow(page, OTHER_CONVERSATION)).toHaveAttribute(
      "aria-current",
      "true"
    );
    // And the destination shows its own transcript and only its own -- the
    // in-flight answer from the conversation we left must not appear here,
    // during the stream or after it ends.
    await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
    await expect(page.getByText(FIRST_CHUNK, { exact: false })).toHaveCount(0);

    // The assertions above only prove the answer had not leaked *yet*. The
    // stub still has chunks to deliver, and a leak would arrive with them, so
    // wait out the rest of the stream before believing it.
    //
    // A fixed wait, deliberately: the whole point is that the abandoned stream
    // produces nothing observable here, so there is no element to wait on and
    // `toHaveCount(0)` would simply pass on its first poll. The stub's length
    // is known exactly (12 chunks x 400ms = 4.8s) and this clears it.
    await page.waitForTimeout(6_000);
    await expect(page.getByText(FIRST_CHUNK, { exact: false })).toHaveCount(0);
    await expect(
      page.getByText(STREAM_CHUNKS[STREAM_CHUNKS.length - 1].trim(), { exact: false })
    ).toHaveCount(0);
    await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
    await expect(conversationRow(page, OTHER_CONVERSATION)).toHaveAttribute(
      "aria-current",
      "true"
    );
  });

  test("the composer of the conversation arrived at is free at once", { tag: "@review-parity" }, async ({ page }) => {
    await openTwoConversationWorkspace(page);

    await installChatModelStub(page, {
      [MODEL]: { kind: "success", chunks: STREAM_CHUNKS, intervalMs: 400 },
    });

    await submitComposer(page, "Start a long answer.", DESKTOP_VIEWPORT.width);
    await expect(page.getByText(FIRST_CHUNK, { exact: false })).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();

    await conversationRow(page, OTHER_CONVERSATION).click();

    // Leaving a conversation mid-stream must not strand the composer disabled
    // in the conversation arrived at -- the panel that was responding belongs
    // to the conversation left behind. This used to hold only *after* the
    // abandoned stream finished, which is the whole of symptom (1): a busy
    // state keyed by model alone followed the user out of the conversation
    // that was busy. The default expect timeout is the assertion -- the run in
    // the other conversation has seconds of chunks still to deliver.
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
  });
});

// ===========================================================================
// STREAM-STATE-001. The rest of the same journey.
//
// The tests above establish that switching away is allowed and that the
// abandoned stream does not follow. They stop there, and everything the user
// actually reported lives past that point:
//
//   1. the conversation arrived at inherited the previous one's busy state --
//      its composer was disabled and it offered a stop button for a run it had
//      never started;
//   2. coming *back* to the conversation that was answering showed nothing --
//      the partial answer had accumulated in a `useState` inside a `ChatApp`
//      the shell unmounted on the switch, so it was thrown away while the
//      request kept running (and kept spending credits);
//   3. a conversation whose model selection differed from the previous one
//      kept a `responding` entry it had no panel for and no way to clear.
//
// The fix is per-conversation runtime state, not a relaxed busy check:
// lib/chatStreamRuntime.ts holds each panel's transcript and its in-flight
// request against (identity, conversation, model), and lib/chatRuntimeStatus.ts
// scopes what the composer reads to the conversation on screen. So these tests
// assert both halves: the conversation left behind keeps answering into its own
// key, and the conversation on screen answers only for itself.
//
// The stream is driven by the test (`kind: "controlled"`), not by a timer.
// "Mid-stream" is then a state the test holds for as long as it needs rather
// than a race against a fixed chunk interval.
// ===========================================================================

// The account default the settings fixture reports, so "New chat" -- which
// resets the selection to the account default -- lands on the same model the
// seeded conversation uses, and both sends reach the same stub entry.
const DEFAULT_MODEL = "gpt-5-6-luna";
const OTHER_MODEL = "claude-sonnet-5";
const CREATED_CONVERSATION = "qa-conversation-new";
const DIFFERENT_MODELS_CONVERSATION = "qa-conversation-3";

const SHELLS = [
  { name: "desktop", viewport: DESKTOP_VIEWPORT },
  { name: "mobile", viewport: MOBILE_VIEWPORT },
] as const;

type Shell = (typeof SHELLS)[number];

/**
 * Two controlled streams for the same model, consumed in order: the first send
 * (in the conversation we leave) and the second (in the conversation we go to).
 */
const CONTROLLED_STREAMS: ChatModelStubSpec = {
  [DEFAULT_MODEL]: [
    { kind: "controlled", channel: "stream-a" },
    { kind: "controlled", channel: "stream-b" },
  ],
};

async function openStreamWorkspace(page: Page, shell: Shell) {
  await mockAuthenticatedApi(page, {
    selectedModels: [DEFAULT_MODEL],
    messages: [
      { id: "seed-user-1", role: "user", content: "First conversation seed." },
      {
        id: "seed-assistant-1",
        role: "assistant",
        content: "Seeded reply in the first conversation.",
        modelId: DEFAULT_MODEL,
      },
    ],
    extraConversations: [
      {
        id: OTHER_CONVERSATION,
        title: "Second QA conversation",
        selectedModels: [DEFAULT_MODEL],
        messages: [
          { id: "seed-user-2", role: "user", content: "Second conversation seed." },
          {
            id: "seed-assistant-2",
            role: "assistant",
            content: OTHER_ANSWER,
            modelId: DEFAULT_MODEL,
          },
        ],
      },
      {
        // A conversation that compares a different model. Its panels can never
        // report on DEFAULT_MODEL, so a status keyed by model alone was the
        // only way its composer could learn about the other conversation's run.
        id: DIFFERENT_MODELS_CONVERSATION,
        title: "Third QA conversation",
        selectedModels: [OTHER_MODEL],
        messages: [
          { id: "seed-user-3", role: "user", content: "Third conversation seed." },
          {
            id: "seed-assistant-3",
            role: "assistant",
            content: THIRD_ANSWER,
            modelId: OTHER_MODEL,
          },
        ],
      },
      {
        // What "New chat" creates once its first send goes through: the create
        // route below answers with this id, so the new conversation has a real
        // transcript of its own rather than sharing the seeded one's.
        id: CREATED_CONVERSATION,
        title: "Brand new QA conversation",
        selectedModels: [DEFAULT_MODEL],
        messages: [],
      },
    ],
  });

  // POST /api/conversations answers with the primary conversation's id by
  // default, which would put a brand-new chat straight back into the
  // conversation it was started from. Registered after the fixture so it wins.
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: CREATED_CONVERSATION,
        title: "Brand new QA conversation",
        selectedModels: [DEFAULT_MODEL],
        disabledPanels: [],
        webSearchMode: "off",
        isLocked: false,
        shareEnabled: false,
        shareExpiresAt: null,
        assistantProfile: null,
      }),
    });
  });
  await page.route(`**/api/conversations/*/generate-title`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ title: "Brand new QA conversation" }),
    })
  );

  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.setViewportSize(shell.viewport);
  await page.goto("/chat?lang=ko");
  await expect(
    page.getByTestId(
      shell.name === "mobile" ? "mobile-chat-shell" : "desktop-chat-shell"
    )
  ).toBeVisible();
  await installChatModelStub(page, CONTROLLED_STREAMS);
}

const isMobile = (shell: Shell) => shell.viewport.width < 768;

async function openConversationList(page: Page, shell: Shell) {
  if (!isMobile(shell)) return;
  await page.getByTestId("mobile-sidebar-open").click();
  await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
}

async function switchToConversation(page: Page, shell: Shell, id: string) {
  await openConversationList(page, shell);
  await conversationRow(page, id).click();
}

async function startNewChat(page: Page, shell: Shell) {
  await openConversationList(page, shell);
  await page.getByTestId("sidebar-new-chat").click();
}

/** Starts the first answer and holds it open, one chunk in. */
async function startHeldAnswer(page: Page, shell: Shell) {
  await submitComposer(page, "Start a long answer.", shell.viewport.width);
  await waitForControlledStream(page, "stream-a");
  await pushControlledChunk(page, "stream-a", PARTIAL_ONE);
  await expect(page.getByText(PARTIAL_ONE, { exact: false })).toBeVisible();
  // Proves the send is genuinely in flight rather than already finished: the
  // composer is only in its sending state while a panel reports `responding`.
  await expect(page.getByTestId("chat-textarea")).toBeDisabled();
}

for (const shell of SHELLS) {
  test.describe(`STREAM-STATE-001 (${shell.name}): state is per conversation`, () => {
    test("a new chat is usable immediately, and sends its own request", async ({
      page,
    }) => {
      await openStreamWorkspace(page, shell);
      await startHeldAnswer(page, shell);

      await startNewChat(page, shell);

      // (1) The reported symptom. The previous conversation is still
      // answering; this one has never sent anything, so nothing here is busy.
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("chat-send-button")).toBeVisible();
      // The composer swaps its send button for a stop button while sending, so
      // a visible send button *is* the assertion that no stop button is offered
      // for the run left behind in the other conversation.
      await expect(page.getByText(PARTIAL_ONE, { exact: false })).toHaveCount(0);

      // And it can actually be used: the second request reaches the network
      // and streams into this conversation.
      await submitComposer(page, "A question of my own.", shell.viewport.width);
      await waitForControlledStream(page, "stream-b");
      await pushControlledChunk(page, "stream-b", SECOND_ANSWER);
      await expect(page.getByText(SECOND_ANSWER, { exact: false })).toBeVisible();

      // The first conversation's stream is still open and still nothing to do
      // with this one.
      await pushControlledChunk(page, "stream-a", PARTIAL_TWO);
      await expect(page.getByText(PARTIAL_TWO, { exact: false })).toHaveCount(0);

      await finishControlledStream(page, "stream-b");
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await finishControlledStream(page, "stream-a");
    });

    test("coming back mid-stream shows the partial answer, and stop still works", async ({
      page,
    }) => {
      await openStreamWorkspace(page, shell);
      await startHeldAnswer(page, shell);

      await switchToConversation(page, shell, OTHER_CONVERSATION);
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
      // A chunk that arrives while we are elsewhere belongs to the
      // conversation it was sent in, and must not surface here.
      await pushControlledChunk(page, "stream-a", PARTIAL_TWO);
      await expect(page.getByText(PARTIAL_TWO, { exact: false })).toHaveCount(0);
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();

      await switchToConversation(page, shell, "qa-conversation");

      // (2) Everything received so far is there -- including the chunk that
      // arrived while no panel was mounted on this conversation.
      await expect(
        page.getByText(`${PARTIAL_ONE}${PARTIAL_TWO}`, { exact: false })
      ).toBeVisible();
      // ...and it still reads as generating, with a stop that reaches the run.
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();
      const stopButton = page.getByTestId("stop-this-response");
      await expect(stopButton).toBeVisible();

      await stopButton.click();

      // A stop keeps what was generated and releases the composer.
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("chat-send-button")).toBeVisible();
      await expect(
        page.getByText(`${PARTIAL_ONE}${PARTIAL_TWO}`, { exact: false })
      ).toBeVisible();
      await expect(page.getByTestId("stop-this-response")).toHaveCount(0);
    });

    test("an answer that finished while away is shown once on return", async ({
      page,
    }) => {
      await openStreamWorkspace(page, shell);
      await startHeldAnswer(page, shell);

      await switchToConversation(page, shell, OTHER_CONVERSATION);
      await pushControlledChunk(page, "stream-a", PARTIAL_TWO);
      await finishControlledStream(page, "stream-a");
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();

      await switchToConversation(page, shell, "qa-conversation");

      const finished = page.getByText(`${PARTIAL_ONE}${PARTIAL_TWO}`, {
        exact: false,
      });
      await expect(finished).toBeVisible();
      // Once, not twice: the completed answer must not be joined by a second
      // copy re-read from the server, and must not flicker back to the
      // question that produced it.
      await expect(finished).toHaveCount(1);
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("stop-this-response")).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(finished).toHaveCount(1);
    });

    test("a conversation comparing different models is not held by the other one's run", async ({
      page,
    }) => {
      await openStreamWorkspace(page, shell);
      await startHeldAnswer(page, shell);

      await switchToConversation(page, shell, DIFFERENT_MODELS_CONVERSATION);

      // (3) This conversation has no panel for the model that is answering, so
      // it can never receive a report that clears one. Under a status keyed by
      // model alone the stale `responding` entry stayed forever.
      await expect(page.getByText(THIRD_ANSWER)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("chat-send-button")).toBeVisible();

      await pushControlledChunk(page, "stream-a", PARTIAL_TWO);
      await expect(page.getByText(PARTIAL_TWO, { exact: false })).toHaveCount(0);
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();

      await finishControlledStream(page, "stream-a");
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    });

    test("a failed answer releases its own conversation, and only that one", async ({
      page,
    }) => {
      await openStreamWorkspace(page, shell);
      // The second send fails outright; the first stays open throughout.
      await installChatModelStub(page, {
        [DEFAULT_MODEL]: [
          { kind: "controlled", channel: "stream-a" },
          { kind: "error", status: 500, code: "PROVIDER_ERROR" },
        ],
      });
      await startHeldAnswer(page, shell);

      await startNewChat(page, shell);
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();

      await submitComposer(page, "This one fails.", shell.viewport.width);
      // The error settles this conversation's run: its composer comes back.
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("chat-send-button")).toBeVisible();

      // ...and the other conversation's answer is still arriving, untouched by
      // the failure here.
      await switchToConversation(page, shell, "qa-conversation");
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();
      await pushControlledChunk(page, "stream-a", PARTIAL_TWO);
      await expect(
        page.getByText(`${PARTIAL_ONE}${PARTIAL_TWO}`, { exact: false })
      ).toBeVisible();

      await finishControlledStream(page, "stream-a");
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    });
  });
}
