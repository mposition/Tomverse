import { expect, test, type Page, type Route } from "@playwright/test";
import {
  createQaPngBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  restoreActiveConversation,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

// The composer's unsent question belongs to the conversation it was typed in.
// A single tab-wide `inputValue` used to carry a half-written question into
// whatever conversation the user opened next -- and the naive fix (clear the
// box on every switch) throws the first conversation's question away instead.
// These specs pin both halves: nothing leaks across conversations, and nothing
// is lost by merely looking at another one.
//
// Two conversations are the whole point, so this file brings its own list and
// per-conversation routes on top of mockAuthenticatedApi's single
// `qa-conversation` world. Routes registered later win (Playwright matches
// LIFO), so the shared fixture still supplies session, settings, usage,
// preflight and everything else.

const CONVERSATION_A = "qa-conversation";
const CONVERSATION_B = "qa-conversation-b";
const TITLE_A = "Conversation A";
const TITLE_B = "Conversation B";
const SELECTED_MODELS = ["gpt-5-4-mini", "claude-sonnet-5"];

const DRAFT_A = "Draft written in conversation A";
const DRAFT_B = "Draft written in conversation B";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type PreflightOutcome = "allow" | "credits-exhausted";

type DraftQaWorld = {
  deleted: Set<string>;
  locked: Set<string>;
  preflight: PreflightOutcome;
  preflightCalls: number;
  savedMessages: Record<string, Array<{ id: string; role: string; content: string }>>;
};

async function mockConversationPair(
  page: Page,
  options: { lockedIds?: string[] } = {}
): Promise<DraftQaWorld> {
  const world: DraftQaWorld = {
    deleted: new Set<string>(),
    locked: new Set<string>(options.lockedIds ?? []),
    preflight: "allow",
    preflightCalls: 0,
    savedMessages: {
      [CONVERSATION_A]: [
        { id: "a-user-1", role: "user", content: "First question in A" },
      ],
      [CONVERSATION_B]: [
        { id: "b-user-1", role: "user", content: "First question in B" },
      ],
    },
  };

  const row = (id: string, title: string) => ({
    id,
    title,
    selectedModels: SELECTED_MODELS,
    disabledPanels: [],
    webSearchMode: "off",
    isLocked: world.locked.has(id),
    shareEnabled: false,
    shareExpiresAt: null,
    messageCount: world.savedMessages[id]?.length ?? 0,
  });

  const visibleRows = () =>
    [row(CONVERSATION_A, TITLE_A), row(CONVERSATION_B, TITLE_B)].filter(
      (conversation) => !world.deleted.has(conversation.id)
    );

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill(json(visibleRows()));
  });

  const detailRoute = async (route: Route, id: string, title: string) => {
    const method = route.request().method();
    if (method === "DELETE") {
      world.deleted.add(id);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (method === "PATCH") {
      await route.fulfill(json(row(id, title)));
      return;
    }
    await route.fulfill(
      json({
        ...row(id, title),
        messages: world.savedMessages[id] ?? [],
        nextCursor: null,
      })
    );
  };

  await page.route(/.*\/api\/conversations\/qa-conversation-b\/messages(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        messages?: Array<{ id: string; role: string; content: string }>;
      };
      for (const message of body?.messages ?? []) {
        if (!message?.id) continue;
        world.savedMessages[CONVERSATION_B].push(message);
      }
      await route.fulfill(json({}, 201));
      return;
    }
    await route.fulfill(json({}));
  });

  await page.route(/.*\/api\/conversations\/qa-conversation-b(\?.*)?$/, (route) =>
    detailRoute(route, CONVERSATION_B, TITLE_B)
  );
  await page.route(/.*\/api\/conversations\/qa-conversation(\?.*)?$/, (route) =>
    detailRoute(route, CONVERSATION_A, TITLE_A)
  );

  // The pre-send credit guard, switchable per test: a refused send must leave
  // the draft exactly as the user typed it.
  await page.route("**/api/chat/preflight", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    world.preflightCalls += 1;
    if (world.preflight === "credits-exhausted") {
      await route.fulfill(
        json(
          {
            ok: false,
            code: "CREDIT_BALANCE_INSUFFICIENT",
            error: "Not enough credits for this comparison.",
            traceId: "qa-preflight-trace",
          },
          402
        )
      );
      return;
    }
    const body = route.request().postDataJSON() as {
      comparisonId?: string;
      modelIds?: string[];
    };
    await route.fulfill(
      json({
        ok: true,
        comparisonId: body.comparisonId || "qa-comparison",
        modelCount: body.modelIds?.length || 0,
        requiredCredits: body.modelIds?.length || 0,
      })
    );
  });

  return world;
}

async function openChat(page: Page, options: { lockedIds?: string[] } = {}) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: SELECTED_MODELS });
  await suppressTransientUi(page);
  const world = await mockConversationPair(page, options);
  await mockChatStream(page, "Draft isolation QA response");
  await restoreActiveConversation(page, CONVERSATION_A);

  await page.goto("/chat?lang=ko");
  await expect(textarea(page)).toBeVisible();
  await expectConversationOpen(page, CONVERSATION_A);
  return world;
}

const textarea = (page: Page) => page.getByTestId("chat-textarea");

const isMobileShell = (page: Page) =>
  page
    .getByTestId("mobile-chat-shell")
    .count()
    .then((count) => count > 0);

/** The sidebar row for one conversation, in whichever shell is rendering. */
function conversationRow(page: Page, id: string) {
  return page.locator(
    `[data-testid="sidebar-conversation-item"][data-conversation-id="${id}"]`
  );
}

async function openSidebar(page: Page) {
  if (!(await isMobileShell(page))) return;
  await page.getByTestId("mobile-sidebar-open").click();
  await expect(page.getByTestId("sidebar-conversation-list")).toBeVisible();
}

async function selectConversation(page: Page, id: string) {
  await openSidebar(page);
  await conversationRow(page, id).first().click();
  await expectConversationOpen(page, id);
}

async function startNewChat(page: Page) {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-chat").click();
}

/**
 * Waits on the shell's own record of which conversation is open, so a draft
 * assertion never races the switch it is about to check.
 */
async function expectConversationOpen(page: Page, id: string) {
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionStorage.getItem("tomverse_active_chat_id"))
    )
    .toBe(id);
}

async function submit(page: Page) {
  if (await isMobileShell(page)) {
    await page.getByTestId("chat-send-button").click();
    return;
  }
  await textarea(page).press("Enter");
}

test.describe("conversation-scoped composer drafts", () => {
  test("a draft does not follow the user into another conversation", async ({
    page,
  }) => {
    await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);

    await expect(textarea(page)).toHaveValue("");
  });

  test("returning to a conversation restores the draft written there", async ({
    page,
  }) => {
    await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);
    await expect(textarea(page)).toHaveValue("");

    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue(DRAFT_A);
  });

  test("two conversations keep separate drafts across repeated switches", async ({
    page,
  }) => {
    await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);
    await textarea(page).fill(DRAFT_B);

    for (const round of [1, 2, 3]) {
      await selectConversation(page, CONVERSATION_A);
      await expect(textarea(page), `round ${round}: A's draft`).toHaveValue(DRAFT_A);
      await selectConversation(page, CONVERSATION_B);
      await expect(textarea(page), `round ${round}: B's draft`).toHaveValue(DRAFT_B);
    }
  });

  test("re-selecting the conversation already open keeps its draft", async ({
    page,
  }) => {
    await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_A);

    await expect(textarea(page)).toHaveValue(DRAFT_A);
  });

  test("a send clears only the conversation it was sent from", async ({ page }) => {
    await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);
    await textarea(page).fill(DRAFT_B);
    await submit(page);

    await expect(textarea(page)).toHaveValue("");
    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: DRAFT_B }).first()
    ).toBeVisible();

    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue(DRAFT_A);
  });

  test("a refused pre-send check keeps the draft in the composer", async ({
    page,
  }) => {
    const world = await openChat(page);
    world.preflight = "credits-exhausted";

    await selectConversation(page, CONVERSATION_B);
    await textarea(page).fill(DRAFT_B);
    await submit(page);

    await expect.poll(() => world.preflightCalls).toBeGreaterThan(0);
    await expect(textarea(page)).toHaveValue(DRAFT_B);
    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: DRAFT_B })
    ).toHaveCount(0);

    // The refusal is local to this conversation: A is still holding nothing,
    // and B still has every character the user typed.
    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue("");
    await selectConversation(page, CONVERSATION_B);
    await expect(textarea(page)).toHaveValue(DRAFT_B);
  });

  test("an explicit new chat opens empty without discarding the other drafts", async ({
    page,
  }) => {
    await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await startNewChat(page);
    await expect(textarea(page)).toHaveValue("");

    // A draft written on the new-chat screen is its own draft, and it must not
    // reappear inside an existing conversation either.
    await textarea(page).fill("Draft written before this chat exists");
    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue(DRAFT_A);

    await startNewChat(page);
    await expect(textarea(page)).toHaveValue("");
  });

  test("deleting a conversation drops its draft and leaves the others alone", async ({
    page,
  }) => {
    const world = await openChat(page);

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);
    await textarea(page).fill(DRAFT_B);

    await openSidebar(page);
    await page
      .locator(`[data-testid="conversation-menu"][data-conversation-id="${CONVERSATION_B}"]`)
      .first()
      .click();
    await page
      .getByTestId("conversation-menu-panel")
      .getByRole("button", { name: "삭제" })
      .click();
    // The mobile shell closes its own drawer when a conversation action opens a
    // page-level dialog, so the confirmation is not behind it. This used to
    // press Escape here to close the drawer by hand, which only worked while
    // ConfirmDialog ignored Escape; it now owns Escape as the topmost modal
    // (UX-010), so pressing it here would dismiss the confirmation instead.
    if (await isMobileShell(page)) {
      await expect(page.getByTestId("sidebar-conversation-list")).toHaveCount(0);
    }
    await page
      .getByRole("dialog", { name: "삭제" })
      .getByRole("button", { name: "삭제" })
      .click();

    await expect.poll(() => world.deleted.has(CONVERSATION_B)).toBe(true);
    await expect(conversationRow(page, CONVERSATION_B)).toHaveCount(0);
    await expect(textarea(page)).toHaveValue("");

    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue(DRAFT_A);
  });

  test("a cancelled unlock changes neither the conversation nor its draft", async ({
    page,
  }) => {
    await openChat(page, { lockedIds: [CONVERSATION_B] });

    await textarea(page).fill(DRAFT_A);

    await openSidebar(page);
    await conversationRow(page, CONVERSATION_B).first().click();

    const unlockPrompt = page.locator("form", { hasText: "잠금 해제" });
    await expect(unlockPrompt).toBeVisible();
    await unlockPrompt.getByRole("button", { name: "취소" }).click();
    await expect(unlockPrompt).toHaveCount(0);

    // The locked conversation was never opened, so the draft still belongs to
    // -- and is still showing in -- conversation A.
    await expectConversationOpen(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue(DRAFT_A);
  });

  test("Korean IME text survives a conversation switch and a return", async ({
    page,
  }) => {
    await openChat(page);

    const input = textarea(page);
    await input.click();
    await page.keyboard.insertText("한국어 초안 확인");
    await expect(input).toHaveValue("한국어 초안 확인");

    // An uncommitted syllable, exactly as an IME holds it before commit.
    await input.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      element.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "하" })
      );
    });
    await page.keyboard.insertText("하");
    await input.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "하" }));
    });
    await expect(input).toHaveValue("한국어 초안 확인하");

    await selectConversation(page, CONVERSATION_B);
    await expect(textarea(page)).toHaveValue("");

    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue("한국어 초안 확인하");
    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: "한국어 초안 확인하" })
    ).toHaveCount(0);
  });
});

test.describe("conversation-scoped composer drafts: attachments", () => {
  async function pasteImage(page: Page, fileName: string) {
    const bytes = Array.from(createQaPngBuffer());
    const input = textarea(page);
    await input.focus();
    await input.evaluate(
      (element, { bytes: fileBytes, fileName: name }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
          new File([new Uint8Array(fileBytes)], name, { type: "image/png" })
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dataTransfer,
          })
        );
      },
      { bytes, fileName }
    );
  }

  test("an attachment stays with the conversation it was added to", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: SELECTED_MODELS });
    await suppressTransientUi(page);
    await mockConversationPair(page);
    const uploadState = await mockAttachmentUpload(page);
    await restoreActiveConversation(page, CONVERSATION_A);
    await page.goto("/chat?lang=ko");
    await expect(textarea(page)).toBeVisible();
    await expectConversationOpen(page, CONVERSATION_A);

    await pasteImage(page, "draft-a.png");
    await expect(page.getByAltText("draft-a.png")).toBeVisible();
    await expect.poll(() => uploadState.finalizeCount).toBe(1);

    // B must show neither A's finished attachment nor any upload card of its
    // own -- pending and failed cards are part of A's question too.
    await selectConversation(page, CONVERSATION_B);
    await expect(page.getByAltText("draft-a.png")).toHaveCount(0);
    await expect(page.getByTestId("attachment-tray")).toHaveCount(0);
    await expect(page.getByTestId("attachment-pending")).toHaveCount(0);
    await expect(page.getByTestId("attachment-failed")).toHaveCount(0);

    await pasteImage(page, "draft-b.png");
    await expect(page.getByAltText("draft-b.png")).toBeVisible();
    await expect(page.getByAltText("draft-a.png")).toHaveCount(0);

    // Back in A the preview is still there, and still renders -- switching
    // conversations must not have revoked the image it points at.
    await selectConversation(page, CONVERSATION_A);
    await expect(page.getByAltText("draft-a.png")).toBeVisible();
    await expect(page.getByAltText("draft-b.png")).toHaveCount(0);
    const decoded = await page
      .getByAltText("draft-a.png")
      .evaluate((image) => (image as HTMLImageElement).naturalWidth > 0);
    expect(decoded, "A's preview no longer resolves after the switch").toBe(true);
    expect(uploadState.finalizeCount).toBe(2);
  });
});

test.describe("conversation-scoped composer drafts: shell switch", () => {
  // Pinned viewports, so this runs on one engine rather than four times over.
  test.skip(
    ({ browserName, isMobile }) => browserName !== "chromium" || isMobile === true,
    "viewport-driven shell switching runs on desktop-chromium only"
  );

  test("the open conversation's draft survives a desktop-to-mobile switch", async ({
    page,
  }) => {
    await openChat(page);
    await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();

    await textarea(page).fill(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);
    await textarea(page).fill(DRAFT_B);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
    await expect(textarea(page)).toHaveValue(DRAFT_B);

    // The other conversation's draft crossed the shell boundary too.
    await selectConversation(page, CONVERSATION_A);
    await expect(textarea(page)).toHaveValue(DRAFT_A);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
    await expect(textarea(page)).toHaveValue(DRAFT_A);
    await selectConversation(page, CONVERSATION_B);
    await expect(textarea(page)).toHaveValue(DRAFT_B);
  });
});
