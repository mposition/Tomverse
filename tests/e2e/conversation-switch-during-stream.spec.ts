import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";
import {
  DESKTOP_VIEWPORT,
  installChatModelStub,
  restoreActiveConversation,
  setDeterministicTheme,
  submitComposer,
  suppressTransientUi,
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

  test("the composer is released once the abandoned stream finishes", { tag: "@review-parity" }, async ({ page }) => {
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
    // to the conversation left behind.
    await expect(page.getByTestId("chat-textarea")).toBeEnabled({ timeout: 10_000 });
  });
});
