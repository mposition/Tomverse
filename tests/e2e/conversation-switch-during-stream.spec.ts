import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  finishControlledStream,
  installChatModelStub,
  installDeepResearchStatusController,
  mockUserUsage,
  pushControlledChunk,
  restoreActiveConversation,
  setDeterministicTheme,
  submitComposer,
  suppressTransientUi,
  waitForControlledStream,
  type ChatModelStubSpec,
  type DeepResearchStatusController,
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

// ===========================================================================
// STREAM-STATE-002: the same guarantee for a deep-research job.
//
// Deep research is the one answer that does not stream. `perplexity/
// sonar-deep-research` cannot, so app/api/chat/route.ts submits it as a job
// and answers immediately with `X-Chat-Response-Mode: async-job`; the panel
// then polls /api/chat/deep-research/status until the job reaches a terminal
// state. That poll is a plain async loop, not a subscription, and it outlives
// the panel that started it -- which is exactly why it needs the same
// per-conversation runtime key an ordinary stream needs.
//
// It is also the case where losing the state costs the most. A deep-research
// turn is 16 credits and runs for minutes, so "leave the conversation and the
// answer is gone" is not a repaint away from being fixed: the job has been
// paid for, it is still running server-side, and nothing in the UI would ever
// show it again.
//
// Two contracts, and the second is not visible from inside the page at all:
//
//   1. the job writes to its own conversation's key, so leaving and returning
//      shows the phase it is in, or the answer if it finished while away;
//   2. re-attaching to a running job must not start a *second* poll for it.
//      `pollCount` is how that is asserted -- a duplicate poll would double
//      the request rate against a job the user is already paying for, and
//      nothing on screen would look wrong.
//
// The polls are answered by the test rather than by a timer (see
// `installDeepResearchStatusController`), so none of this waits out the
// client's real 5s interval.
// ===========================================================================

const DEEP_RESEARCH_MODEL = "perplexity/sonar-deep-research";
const DEEP_RESEARCH_CONVERSATION = "qa-conversation-deep-research";
const DEEP_RESEARCH_ANSWER = "The finished deep research report.";
const RESUMED_JOB_ID = "qa-deep-research-job-resumed";

/**
 * A workspace whose primary conversation compares the deep-research model.
 *
 * The plan is raised to Pro because that model's `minimumPlan` is Pro and the
 * shared auth fixture reports Free. This is a fixture fact, not a claim about
 * entitlement: what is under test is the job's runtime state across a switch,
 * and a composer refusing the send for a plan reason would test the refusal
 * instead.
 */
async function openDeepResearchWorkspace(
  page: Page,
  shell: Shell,
  options: { pendingJob?: boolean } = {}
): Promise<DeepResearchStatusController> {
  await mockAuthenticatedApi(page, {
    selectedModels: [DEEP_RESEARCH_MODEL],
    messages: [
      { id: "seed-user-dr", role: "user", content: "Research this for me." },
      ...(options.pendingJob
        ? [
            {
              // The state a reload lands in: the job outlived the page, and
              // the transcript says which job to re-attach to.
              id: "seed-assistant-dr",
              role: "assistant" as const,
              content: "",
              modelId: DEEP_RESEARCH_MODEL,
              status: "pending",
              pendingJobId: RESUMED_JOB_ID,
            },
          ]
        : [
            {
              id: "seed-assistant-dr",
              role: "assistant" as const,
              content: "An earlier report in this conversation.",
              modelId: DEEP_RESEARCH_MODEL,
            },
          ]),
    ],
    extraConversations: [
      {
        id: DEEP_RESEARCH_CONVERSATION,
        title: "Ordinary QA conversation",
        selectedModels: [DEFAULT_MODEL],
        messages: [
          { id: "seed-user-dr-2", role: "user", content: "Second conversation seed." },
          {
            id: "seed-assistant-dr-2",
            role: "assistant",
            content: OTHER_ANSWER,
            modelId: DEFAULT_MODEL,
          },
        ],
      },
    ],
  });
  await mockUserUsage(page, { plan: "Pro" });
  // Before the navigation, not after it. A conversation seeded with a pending
  // job re-attaches to it *during load*, so a controller installed after
  // `goto` would miss that first poll -- it would reach the real endpoint
  // instead, and the test would sit waiting for a poll it never saw.
  const research = await installDeepResearchStatusController(page);
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
  await installChatModelStub(page, {
    [DEEP_RESEARCH_MODEL]: { kind: "async-job" },
  });
  return research;
}

/** The phase text the panel paints before its first poll returns. */
const researchingStatus = (page: Page) =>
  page
    .getByTestId("chat-message-list")
    .getByText("심층 리서치 요청 중", { exact: false });

for (const shell of SHELLS) {
  test.describe(`STREAM-STATE-002 (${shell.name}): deep research is per conversation`, () => {
    test("a job that finished while away is shown on return, once", async ({
      page,
    }) => {
      const research = await openDeepResearchWorkspace(page, shell);

      await submitComposer(page, "Research this deeply.", shell.viewport.width);
      // The job is submitted and the panel is waiting on its first poll.
      await research.waitForPoll();
      await expect(researchingStatus(page)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();

      await switchToConversation(page, shell, DEEP_RESEARCH_CONVERSATION);
      // The job belongs to the conversation it was started in. This one has
      // never run anything, so it is free -- and shows none of the job's state.
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(researchingStatus(page)).toHaveCount(0);

      // The job finishes while no panel is mounted on its conversation. Under
      // the old per-component state this write had nowhere to land.
      await research.answerPoll({
        status: "completed",
        content: DEEP_RESEARCH_ANSWER,
      });
      await expect(page.getByText(DEEP_RESEARCH_ANSWER)).toHaveCount(0);

      await switchToConversation(page, shell, "qa-conversation");

      const report = page.getByText(DEEP_RESEARCH_ANSWER, { exact: false });
      await expect(report).toBeVisible();
      // Once: not joined by a second copy re-read from the server, and not
      // replaced by the phase text the job was last showing.
      await expect(report).toHaveCount(1);
      await expect(researchingStatus(page)).toHaveCount(0);
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("stop-this-response")).toHaveCount(0);
    });

    test("returning to a running job shows it running, stops it, and never double-polls", async ({
      page,
    }) => {
      const research = await openDeepResearchWorkspace(page, shell);

      await submitComposer(page, "Research this deeply.", shell.viewport.width);
      await research.waitForPoll();
      await expect(researchingStatus(page)).toBeVisible();

      await switchToConversation(page, shell, DEEP_RESEARCH_CONVERSATION);
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
      await switchToConversation(page, shell, "qa-conversation");

      // Still running, and it says so -- with a stop that reaches the job.
      await expect(researchingStatus(page)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();
      const stopButton = page.getByTestId("stop-this-response");
      await expect(stopButton).toBeVisible();

      // Contract 2. The panel remounted twice; the job is one job, so the
      // poll it is parked on is still the only one that was ever made.
      expect(research.pollCount()).toBe(1);

      await stopButton.click();

      // A deep-research stop is not instant, and the test says so rather than
      // hiding it. The poll checks its abort signal at the top of each tick --
      // the signal is deliberately not passed into `fetch`, because each poll
      // is a short independent request and there is no long-held connection to
      // tear down -- so a stop lands within one poll interval. Answering the
      // parked poll here is what lets the loop reach that check: without it the
      // client sits inside a fetch that the test is holding open, which is a
      // property of this fixture and not of the product.
      await research.answerPoll({ status: "in_progress" });

      // A stop is a client-side detachment -- the job keeps running server
      // side -- so what has to be true is that this conversation says it
      // stopped and gives the composer back. The timeout covers the client's
      // real 5s poll interval.
      const settled = { timeout: 15_000 };
      await expect(
        page
          .getByTestId("chat-message-list")
          .getByText("응답 생성이 중지되었습니다", { exact: false })
      ).toBeVisible(settled);
      await expect(page.getByTestId("chat-textarea")).toBeEnabled(settled);
      await expect(page.getByTestId("stop-this-response")).toHaveCount(0);
      // The abort is seen before the next request goes out, so the stopped job
      // is not polled again.
      expect(research.pollCount()).toBe(1);
    });

    test("a job restored from the transcript is re-attached exactly once", async ({
      page,
    }) => {
      // No send here: the conversation is *loaded* holding a pending job, which
      // is the state a reload mid-research lands in. The re-attach is what puts
      // the UI back on it.
      const research = await openDeepResearchWorkspace(page, shell, {
        pendingJob: true,
      });

      await research.waitForPoll();
      await expect(researchingStatus(page)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();

      await switchToConversation(page, shell, DEEP_RESEARCH_CONVERSATION);
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await switchToConversation(page, shell, "qa-conversation");

      await expect(researchingStatus(page)).toBeVisible();
      // The re-attach is recorded on the runtime key, not in a per-component
      // ref, so returning to the conversation does not start a second poll for
      // the job the first one is still watching.
      expect(research.pollCount()).toBe(1);

      await research.answerPoll({
        status: "completed",
        content: DEEP_RESEARCH_ANSWER,
      });
      await expect(page.getByText(DEEP_RESEARCH_ANSWER, { exact: false })).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    });
  });
}

// ===========================================================================
// STREAM-STATE-003: a comparison keeps each panel's own state across a switch.
//
// The two blocks above both use a single model, which leaves the *model* half
// of the runtime key untested from the browser: with one panel per
// conversation, a key that dropped `modelId` entirely would still pass every
// assertion in them. A comparison is where that half is load-bearing -- three
// panels stream at once into one conversation, and each owns its own answer.
//
// It is also where the states diverge. Leaving a comparison mid-run and coming
// back is not one question but three: the panel still streaming, the panel that
// finished while nobody was watching, and -- in the second test -- the
// deep-research panel, which is not streaming at all but polling a job. They
// have to come back as what they each are, not as whatever the last one to
// report happened to be.
//
// The composer is the third assertion. `isAnyModelResponding` reads the
// conversation on screen and the models it has not paused
// (lib/chatRuntimeStatus.ts), so a comparison with one panel done and one still
// running must still read as busy -- releasing on the first panel to finish
// would let a second send land on top of a run that is still going.
// ===========================================================================

const ALPHA_ONE = "ALPHA-ONE";
const ALPHA_TWO = "ALPHA-TWO";
const BETA_ONE = "BETA-ONE";
const BETA_TWO = "BETA-TWO";

/**
 * Brings `modelId`'s panel on screen and returns it.
 *
 * The two shells disclose a comparison differently and this is the whole of
 * the difference: desktop lays every panel out side by side, mobile shows one
 * at a time behind a tab strip. Scoping to the panel matters on desktop
 * precisely because the sibling *is* on screen -- a page-level `getByText`
 * would happily find the other model's answer and call it this one's.
 */
async function modelPanel(page: Page, shell: Shell, modelId: string) {
  if (!isMobile(shell)) {
    return page.locator(
      `[data-testid="desktop-model-panel"][data-model-id="${modelId}"]`
    );
  }
  await page
    .locator(`[data-testid="mobile-model-tab"][data-model-id="${modelId}"]`)
    .click();
  // Model ids carry `/` and `-`, so this is an attribute match rather than a
  // `#id` selector.
  return page.locator(`[id="mobile-model-tabpanel-${modelId}"]`);
}

async function openComparisonWorkspace(
  page: Page,
  shell: Shell,
  models: string[],
  stub: ChatModelStubSpec
): Promise<DeepResearchStatusController> {
  await mockAuthenticatedApi(page, {
    selectedModels: models,
    messages: [
      { id: "seed-user-cmp", role: "user", content: "Comparison seed." },
    ],
    extraConversations: [
      {
        id: OTHER_CONVERSATION,
        title: "Second QA conversation",
        selectedModels: [DEFAULT_MODEL],
        messages: [
          { id: "seed-user-cmp-2", role: "user", content: "Second conversation seed." },
          {
            id: "seed-assistant-cmp-2",
            role: "assistant",
            content: OTHER_ANSWER,
            modelId: DEFAULT_MODEL,
          },
        ],
      },
    ],
  });
  // Pro because the deep-research model in the second test is a Pro model, and
  // because both tests should differ only in the models they compare.
  await mockUserUsage(page, { plan: "Pro" });
  // Installed before the navigation for the same reason the deep-research
  // opener does it: a poll must never be able to reach the real endpoint.
  // Nothing here seeds a pending job, so the first poll cannot land until the
  // send -- but the order should not be the thing keeping that true.
  const research = await installDeepResearchStatusController(page);
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
  await installChatModelStub(page, stub);
  return research;
}

for (const shell of SHELLS) {
  test.describe(`STREAM-STATE-003 (${shell.name}): a comparison is per panel`, () => {
    test("each panel keeps its own answer, and the composer waits for the last one", async ({
      page,
    }) => {
      await openComparisonWorkspace(page, shell, [DEFAULT_MODEL, OTHER_MODEL], {
        [DEFAULT_MODEL]: { kind: "controlled", channel: "cmp-alpha" },
        [OTHER_MODEL]: { kind: "controlled", channel: "cmp-beta" },
      });

      await submitComposer(page, "Compare these two.", shell.viewport.width);
      await waitForControlledStream(page, "cmp-alpha");
      await waitForControlledStream(page, "cmp-beta");
      await pushControlledChunk(page, "cmp-alpha", ALPHA_ONE);
      await pushControlledChunk(page, "cmp-beta", BETA_ONE);

      // Each answer is in its own panel and in no other.
      const alpha = await modelPanel(page, shell, DEFAULT_MODEL);
      await expect(alpha.getByText(ALPHA_ONE, { exact: false })).toBeVisible();
      await expect(alpha.getByText(BETA_ONE, { exact: false })).toHaveCount(0);
      const beta = await modelPanel(page, shell, OTHER_MODEL);
      await expect(beta.getByText(BETA_ONE, { exact: false })).toBeVisible();
      await expect(beta.getByText(ALPHA_ONE, { exact: false })).toHaveCount(0);
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();

      await switchToConversation(page, shell, OTHER_CONVERSATION);
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();

      // While we are away the two panels diverge: one finishes, one keeps
      // going. Both writes have to land on their own key.
      await pushControlledChunk(page, "cmp-beta", BETA_TWO);
      await finishControlledStream(page, "cmp-beta");
      await pushControlledChunk(page, "cmp-alpha", ALPHA_TWO);

      await switchToConversation(page, shell, "qa-conversation");

      const alphaBack = await modelPanel(page, shell, DEFAULT_MODEL);
      await expect(
        alphaBack.getByText(`${ALPHA_ONE}${ALPHA_TWO}`, { exact: false })
      ).toBeVisible();
      const betaBack = await modelPanel(page, shell, OTHER_MODEL);
      await expect(
        betaBack.getByText(`${BETA_ONE}${BETA_TWO}`, { exact: false })
      ).toBeVisible();
      // One panel finished, the other did not, so the conversation is still
      // busy. Releasing here would let a second send land on a live run.
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();

      await finishControlledStream(page, "cmp-alpha");
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("chat-send-button")).toBeVisible();
    });

    test("a deep-research panel and a streaming panel both survive the switch", async ({
      page,
    }) => {
      const research = await openComparisonWorkspace(
        page,
        shell,
        [DEFAULT_MODEL, DEEP_RESEARCH_MODEL],
        {
          [DEFAULT_MODEL]: { kind: "controlled", channel: "cmp-alpha" },
          [DEEP_RESEARCH_MODEL]: { kind: "async-job" },
        }
      );

      await submitComposer(page, "Compare a stream and a job.", shell.viewport.width);
      await waitForControlledStream(page, "cmp-alpha");
      await pushControlledChunk(page, "cmp-alpha", ALPHA_ONE);
      await research.waitForPoll();

      // Two panels in two different transports, in one conversation.
      const streaming = await modelPanel(page, shell, DEFAULT_MODEL);
      await expect(streaming.getByText(ALPHA_ONE, { exact: false })).toBeVisible();
      const researching = await modelPanel(page, shell, DEEP_RESEARCH_MODEL);
      await expect(
        researching.getByText("심층 리서치 요청 중", { exact: false })
      ).toBeVisible();

      await switchToConversation(page, shell, OTHER_CONVERSATION);
      await expect(page.getByText(OTHER_ANSWER)).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();

      await pushControlledChunk(page, "cmp-alpha", ALPHA_TWO);

      await switchToConversation(page, shell, "qa-conversation");

      const streamingBack = await modelPanel(page, shell, DEFAULT_MODEL);
      await expect(
        streamingBack.getByText(`${ALPHA_ONE}${ALPHA_TWO}`, { exact: false })
      ).toBeVisible();
      const researchingBack = await modelPanel(page, shell, DEEP_RESEARCH_MODEL);
      await expect(
        researchingBack.getByText("심층 리서치 요청 중", { exact: false })
      ).toBeVisible();
      // The comparison remounted twice and the job is still one job.
      expect(research.pollCount()).toBe(1);

      // The job finishes; the stream is still going, so the composer waits.
      await research.answerPoll({
        status: "completed",
        content: DEEP_RESEARCH_ANSWER,
      });
      const finishedResearch = await modelPanel(page, shell, DEEP_RESEARCH_MODEL);
      await expect(
        finishedResearch.getByText(DEEP_RESEARCH_ANSWER, { exact: false })
      ).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).toBeDisabled();

      await finishControlledStream(page, "cmp-alpha");
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    });
  });
}
