import { expect, test, type Page } from "@playwright/test";
import {
  GUEST_ACTIVE_CHAT_STORAGE_KEY,
  GUEST_CONVERSATIONS_STORAGE_KEY,
} from "../../lib/guestChatInitialModels";
import { guestMessagesStorageKey } from "../../lib/guestConversationStorage";
import { CHAT_WELCOME_MESSAGE_ID } from "../../lib/chatTranscriptRecovery";
import {
  expectNoHorizontalOverflow,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

const question = "Synthetic mobile first question";
const answer = "Synthetic mobile first answer: saved in this browser.";

type SavedMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
};

type SavedConversation = { id: string; selectedModels: string[] };

async function readSavedConversation(page: Page) {
  return page.evaluate(
    ({ activeKey, conversationsKey }) => {
      const conversations = JSON.parse(
        localStorage.getItem(conversationsKey) || "[]"
      ) as SavedConversation[];
      return {
        activeId: sessionStorage.getItem(activeKey),
        conversations,
      };
    },
    {
      activeKey: GUEST_ACTIVE_CHAT_STORAGE_KEY,
      conversationsKey: GUEST_CONVERSATIONS_STORAGE_KEY,
    }
  );
}

async function readSavedMessages(page: Page, conversation: SavedConversation) {
  return page.evaluate(
    (keys) => keys.map((key) => JSON.parse(localStorage.getItem(key) || "[]") as SavedMessage[]),
    conversation.selectedModels.map((modelId) => guestMessagesStorageKey(conversation.id, modelId))
  );
}

// Only the provider response and public APIs are synthetic. Guest transcripts
// are written and restored by the actual product, without a storage seed or
// mock persistence hook. This does not verify account DB persistence.
for (const narrow of [false, true]) {
  test(`mobile first answer is saved and restored${narrow ? " at 320px" : ""}`, async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile browser flow only.");
    if (narrow) await page.setViewportSize({ width: 320, height: 640 });

    const blockedExternalRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(url.hostname)) {
        blockedExternalRequests.push(url.hostname);
        await route.abort("blockedbyclient");
        return;
      }
      await route.fallback();
    });
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, answer);
    let dispatches = 0;
    const dispatchesByModel: Record<string, number> = {};
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() === "POST") {
        const { modelId } = route.request().postDataJSON() as { modelId: unknown };
        expect(typeof modelId).toBe("string");
        const model = modelId as string;
        dispatchesByModel[model] = (dispatchesByModel[model] || 0) + 1;
        dispatches += 1;
      }
      await route.fallback();
    });

    await page.goto("/chat");
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
    await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("chat-textarea").fill(question);
    await page.getByTestId("chat-send-button").click();

    const visibleMessage = (role: string, text: string) =>
      page.locator(`[data-message-role="${role}"]`).filter({ visible: true }).filter({ hasText: text });
    await expect(visibleMessage("user", question)).toHaveCount(1);
    await expect(visibleMessage("assistant", answer)).toHaveCount(1);

    const saved = await readSavedConversation(page);
    expect(saved.conversations).toHaveLength(1);
    const conversation = saved.conversations[0];
    expect(conversation.id).toMatch(/^guest_/);
    expect(saved.activeId).toBe(conversation.id);
    expect(conversation.selectedModels.length).toBeGreaterThan(0);

    const expectedTurn = [
      { role: "user", content: question, status: "normal" },
      { role: "assistant", content: answer, status: "normal" },
    ];
    await expect.poll(async () => {
      const transcripts = await readSavedMessages(page, conversation);
      return transcripts.map((messages) => messages
        .filter((message) => message.id !== CHAT_WELCOME_MESSAGE_ID)
        .map(({ role, content, status }) => ({ role, content, status })));
    }).toEqual(conversation.selectedModels.map(() => expectedTurn));
    expect(dispatches).toBe(conversation.selectedModels.length);
    const expectedDispatches = Object.fromEntries(conversation.selectedModels.map((modelId) => [modelId, 1]));
    expect(dispatchesByModel).toEqual(expectedDispatches);
    const savedTranscripts = await readSavedMessages(page, conversation);
    for (const messages of savedTranscripts) {
      expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    }

    await page.reload();
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
    await expect(visibleMessage("user", question)).toHaveCount(1);
    await expect(visibleMessage("assistant", answer)).toHaveCount(1);
    expect(await readSavedConversation(page)).toEqual(saved);
    expect(await readSavedMessages(page, conversation)).toEqual(savedTranscripts);
    expect(dispatches).toBe(conversation.selectedModels.length);
    await expectNoHorizontalOverflow(page);

    // Read each restored model panel as well as its actual stored transcript.
    for (const modelId of conversation.selectedModels) {
      if (conversation.selectedModels.length > 1) {
        const modelTab = page.locator(`[data-testid="mobile-model-tab"][data-model-id="${modelId}"]`);
        await expect(modelTab).toBeVisible();
        await modelTab.click();
      }
      await expect(visibleMessage("user", question)).toHaveCount(1);
      await expect(visibleMessage("assistant", answer)).toHaveCount(1);
    }
    expect(dispatchesByModel).toEqual(expectedDispatches);
    expect(blockedExternalRequests).toEqual([]);
    await testInfo.attach("synthetic-saved-readback", {
      body: JSON.stringify({ saved, savedTranscripts, dispatches, dispatchesByModel, blockedExternalRequests }, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("restored-mobile-answer", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}
