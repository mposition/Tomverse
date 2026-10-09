import { expect, test, type Page, type Route } from "@playwright/test";
import { CHAT_WELCOME_MESSAGE_ID } from "../../lib/chatTranscriptRecovery";
import { GUEST_ACTIVE_CHAT_STORAGE_KEY, GUEST_CONVERSATIONS_STORAGE_KEY } from "../../lib/guestChatInitialModels";
import { guestMessagesStorageKey } from "../../lib/guestConversationStorage";
import { prepareGuestPage } from "./support/app-fixtures";

const firstQuestion = "Synthetic E02 first question";
const firstAnswer = "Synthetic E02 first answer";
const followup = "Synthetic E02 follow-up question";
const followupAnswer = "Synthetic E02 follow-up answer";
const unsent = "Synthetic E02 unsent draft\nwith exact whitespace  ";

type Message = { id: string; role: string; content: string; status: string };
type Conversation = { id: string; selectedModels: string[] };
type Dispatch = {
  modelId: string;
  sourceUserMessageId?: string;
  messages: Array<{ id?: string; role: string; content: string }>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function savedConversation(page: Page) {
  return page.evaluate(({ activeKey, listKey }) => {
    const conversations = JSON.parse(localStorage.getItem(listKey) || "[]") as Conversation[];
    return { activeId: sessionStorage.getItem(activeKey), conversations };
  }, { activeKey: GUEST_ACTIVE_CHAT_STORAGE_KEY, listKey: GUEST_CONVERSATIONS_STORAGE_KEY });
}

async function transcripts(page: Page, conversation: Conversation) {
  return page.evaluate((keys) => keys.map((key) =>
    JSON.parse(localStorage.getItem(key) || "[]") as Message[]),
  conversation.selectedModels.map((id) => guestMessagesStorageKey(conversation.id, id)));
}

const visibleMessage = (page: Page, role: string, text: string) =>
  page.getByTestId("chat-message-list").filter({ visible: true }).first()
    .locator(`[data-message-role="${role}"]`).filter({ hasText: text });

async function selectModel(page: Page, modelId: string) {
  const tab = page.locator(`[data-testid="mobile-model-tab"][data-model-id="${modelId}"]`);
  if (await tab.isVisible()) await tab.click();
}

// Public APIs/provider transport are synthetic; the product owns all guest
// transcript writes and restoration. Offline/online keeps the same document:
// guest drafts intentionally remain tab memory under the identity-scope policy.
async function world(page: Page) {
  const blockedExternal: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith("http") && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      blockedExternal.push(url.hostname);
      await route.abort("blockedbyclient");
    } else await route.fallback();
  });
  await prepareGuestPage(page, "en");
  const requests: Dispatch[] = [];
  let respond: (route: Route, body: Dispatch) => Promise<void> = async (route, body) => {
    await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8",
      body: body.messages.at(-1)?.content === firstQuestion ? firstAnswer : followupAnswer });
  };
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Dispatch;
    requests.push(body);
    await respond(route, body);
  });
  await page.goto("/chat");
  const input = page.getByTestId("chat-textarea");
  await expect(input).toBeVisible();
  await input.fill(firstQuestion);
  await page.getByTestId("chat-send-button").click();
  await expect(visibleMessage(page, "assistant", firstAnswer)).toHaveCount(1);
  const saved = await savedConversation(page);
  expect(saved.conversations).toHaveLength(1);
  const conversation = saved.conversations[0];
  expect(saved.activeId).toBe(conversation.id);
  await expect.poll(async () => (await transcripts(page, conversation)).map((messages) =>
    messages.filter(({ id }) => id !== CHAT_WELCOME_MESSAGE_ID).map(({ role, content, status }) =>
      ({ role, content, status })))).toEqual(conversation.selectedModels.map(() => [
    { role: "user", content: firstQuestion, status: "normal" },
    { role: "assistant", content: firstAnswer, status: "normal" },
  ]));
  expect(requests.map(({ modelId }) => modelId).sort()).toEqual([...conversation.selectedModels].sort());
  return { input, conversation, requests, blockedExternal,
    setResponder: (next: typeof respond) => { respond = next; } };
}

function expectContext(request: Dispatch, question = followup) {
  expect(request.messages.map(({ role, content }) => ({ role, content }))).toEqual([
    { role: "user", content: firstQuestion },
    { role: "assistant", content: firstAnswer },
    { role: "user", content: question },
  ]);
}

async function expectUniqueStorage(page: Page, conversation: Conversation) {
  const stored = await transcripts(page, conversation);
  for (const messages of stored) expect(new Set(messages.map(({ id }) => id)).size).toBe(messages.length);
  return stored;
}

test.describe("E02 guest follow-up and reconnect", () => {
test("follow-up retains context across reconnect and reload without replay", async ({ page }, testInfo) => {
  const state = await world(page);
  await page.context().setOffline(true);
  await state.input.fill(unsent);
  await page.context().setOffline(false);
  await expect(state.input).toHaveValue(unsent);
  expect(state.requests).toHaveLength(state.conversation.selectedModels.length);
  await state.input.fill(followup);
  await page.getByTestId("chat-send-button").click();
  await expect(visibleMessage(page, "assistant", followupAnswer)).toHaveCount(1);
  await expect.poll(() => state.requests.length).toBe(2 * state.conversation.selectedModels.length);
  for (const id of state.conversation.selectedModels) {
    const requests = state.requests.filter(({ modelId }) => modelId === id);
    expect(requests).toHaveLength(2);
    expectContext(requests[1]);
  }
  await expect.poll(async () => (await transcripts(page, state.conversation)).map((messages) =>
    messages.filter(({ id }) => id !== CHAT_WELCOME_MESSAGE_ID).map(({ content }) => content)))
    .toEqual(state.conversation.selectedModels.map(() => [firstQuestion, firstAnswer, followup, followupAnswer]));
  const stored = await expectUniqueStorage(page, state.conversation);
  const savedBeforeReload = await savedConversation(page);
  await page.reload();
  for (const id of state.conversation.selectedModels) {
    await selectModel(page, id);
    await expect(visibleMessage(page, "user", firstQuestion)).toHaveCount(1);
    await expect(visibleMessage(page, "assistant", followupAnswer)).toHaveCount(1);
  }
  expect(await savedConversation(page)).toEqual(savedBeforeReload);
  expect(await transcripts(page, state.conversation)).toEqual(stored);
  expect(state.requests).toHaveLength(2 * state.conversation.selectedModels.length);
  expect(state.blockedExternal).toEqual([]);
  await testInfo.attach("synthetic-followup-readback", { body: JSON.stringify({ stored, requests: state.requests }), contentType: "application/json" });
});

test("competing sends during preflight preserve newer unsent input and create one turn", async ({ page }) => {
  const state = await world(page);
  const gate = deferred();
  const entered = deferred();
  let preflights = 0;
  await page.route("**/api/chat/preflight", async (route) => {
    preflights += 1;
    entered.resolve();
    await gate.promise;
    await route.fallback();
  });
  await state.input.fill(followup);
  // Both events reach the actual submit handlers in the same JS turn, before
  // React can paint a disabled send button. No direct product handler call.
  await page.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>('[data-testid="chat-send-button"]')!;
    send.click(); send.click();
    document.querySelector('[data-testid="chat-textarea"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  });
  await entered.promise;
  try { await state.input.fill(unsent); } finally { gate.resolve(); }
  await expect(visibleMessage(page, "assistant", followupAnswer)).toHaveCount(1);
  await expect(state.input).toHaveValue(unsent);
  expect(preflights).toBe(1);
  for (const id of state.conversation.selectedModels) {
    const requests = state.requests.filter(({ modelId }) => modelId === id);
    expect(requests).toHaveLength(2);
    expectContext(requests[1]);
  }
  const stored = await expectUniqueStorage(page, state.conversation);
  for (const messages of stored) {
    expect(messages.filter(({ role, content }) => role === "user" && content === followup)).toHaveLength(1);
    expect(messages.some(({ content }) => content === unsent)).toBe(false);
  }
  expect(state.blockedExternal).toEqual([]);
});

for (const failure of ["http-error", "disconnect"] as const) {
  test(`${failure} preserves context and unsent input through explicit retry`, async ({ page }, testInfo) => {
    const state = await world(page);
    const failedModel = state.conversation.selectedModels[0];
    let attempts = 0;
    state.setResponder(async (route, body) => {
      if (body.modelId === failedModel && ++attempts === 1) {
        if (failure === "disconnect") await route.abort("internetdisconnected");
        else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic E02 provider unavailable" }) });
      } else await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: followupAnswer });
    });
    await state.input.fill(followup);
    await page.getByTestId("chat-send-button").click();
    await selectModel(page, failedModel);
    const retry = page.getByRole("button", { name: "Retry", exact: true }).filter({ visible: true });
    await expect(retry).toHaveCount(1);
    await expect(state.input).toBeEnabled();
    await page.context().setOffline(true);
    await state.input.fill(unsent);
    const beforeReconnect = await expectUniqueStorage(page, state.conversation);
    await page.context().setOffline(false);
    await expect(state.input).toHaveValue(unsent);
    expect(await transcripts(page, state.conversation)).toEqual(beforeReconnect);
    expect(state.requests).toHaveLength(2 * state.conversation.selectedModels.length);
    // Competing retry clicks must share the send-preparation fence too.
    await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(visibleMessage(page, "assistant", followupAnswer)).toHaveCount(1);
    await expect(state.input).toHaveValue(unsent);
    for (const id of state.conversation.selectedModels) {
      const requests = state.requests.filter(({ modelId }) => modelId === id);
      expect(requests).toHaveLength(id === failedModel ? 3 : 2);
      expectContext(requests[1]);
      if (id === failedModel) {
        const originalUserId = requests[1].messages.filter(({ role }) => role === "user").at(-1)?.id;
        expect(typeof originalUserId).toBe("string");
        expect(requests[2].messages.filter(({ role }) => role === "user").at(-1)?.id).toBe(originalUserId);
        expect(requests[2].messages.slice(0, 2).map(({ role, content }) => ({ role, content }))).toEqual([
          { role: "user", content: firstQuestion },
          { role: "assistant", content: firstAnswer },
        ]);
      }
    }
    const stored = await expectUniqueStorage(page, state.conversation);
    for (const [index, messages] of stored.entries()) {
      // An explicit retry appends one new turn and retains the failed turn as
      // history. Two competing clicks must still append only that one retry.
      expect(messages.filter(({ role, content }) => role === "user" && content === followup))
        .toHaveLength(state.conversation.selectedModels[index] === failedModel ? 2 : 1);
      expect(messages.some(({ content }) => content === unsent)).toBe(false);
    }
    expect(state.blockedExternal).toEqual([]);
    await testInfo.attach("synthetic-recovery-readback", { body: JSON.stringify({ failure, stored, requests: state.requests }), contentType: "application/json" });
  });
}
});
