import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

// Auto-generated conversation titles: after the first successful response,
// the client fires exactly one request to replace the interim title (a
// client-side slice of the first prompt, or "New Chat" for guests) with a
// short AI-generated one. Never delays sending, never regenerates on later
// turns, never overwrites a manual rename, and never surfaces an error if
// generation fails -- the interim title just stays as-is.

const sidebarList = (page: Page) => page.getByTestId("sidebar-conversation-list");

const openMobileSidebarIfNeeded = async (page: Page, testInfo: { project: { name: string } }) => {
  if (testInfo.project.name.startsWith("mobile")) {
    await page.getByTestId("mobile-sidebar-open").click();
  }
};

const mockGenerateTitle = async (
  page: Page,
  conversationId: string,
  handler: (body: { expectedTitle?: string }) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>
) => {
  let callCount = 0;
  await page.route(`**/api/conversations/${conversationId}/generate-title`, async (route) => {
    callCount += 1;
    const body = route.request().postDataJSON() as { expectedTitle?: string };
    const result = await handler(body);
    await route.fulfill({
      status: result.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(result.body ?? { updated: false }),
    });
  });
  return () => callCount;
};

const mockGuestConversationTitle = async (
  page: Page,
  handler: (body: { message?: string }) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>
) => {
  let callCount = 0;
  await page.route("**/api/chat/conversation-title", async (route) => {
    callCount += 1;
    const body = route.request().postDataJSON() as { message?: string };
    const result = await handler(body);
    await route.fulfill({
      status: result.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(result.body ?? { updated: false }),
    });
  });
  return () => callCount;
};

test.describe("conversation auto-title generation (logged-in)", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "These scenarios need the desktop multi-panel <select> layout and per-panel model picker."
    );
  });

  test("shows the interim title immediately, then swaps in the generated title after the first response", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);

    const getCallCount = await mockGenerateTitle(page, "qa-conversation", (body) => {
      expect(body.expectedTitle).toBe("Plan a weekend trip");
      return { body: { updated: true, title: "Weekend Trip Planning" } };
    });

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-title" },
        body: "Here is a weekend trip plan.",
      });
    });

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, "Plan a weekend trip");

    // Interim title (the client-side 30-char slice) shows immediately.
    await expect(sidebarList(page).getByText("Plan a weekend trip")).toBeVisible();

    // Once the response completes, the generated title replaces it.
    await expect(sidebarList(page).getByText("Weekend Trip Planning")).toBeVisible();
    await expect.poll(() => getCallCount()).toBe(1);
  });

  test("three simultaneous model panels only trigger one generate-title request", async ({
    page,
  }, testInfo) => {
    const models = ["claude-haiku-4-5", "gemini-2-5-flash", "deepseek-v4-flash"];
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, { selectedModels: models });

    const getCallCount = await mockGenerateTitle(page, "qa-conversation", () => ({
      body: { updated: true, title: "Multi Model Comparison" },
    }));

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { modelId?: string };
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": `qa-trace-${body.modelId}` },
        body: `Answer from ${body.modelId}.`,
      });
    });

    await page.goto("/chat");
    // Selecting the pre-existing conversation (its own selectedModels
    // already has all 3 models baked in) restores the panel selection
    // directly -- avoids depending on the model-picker UI, which is
    // mid-redesign in a concurrent, unrelated change at the time of writing.
    await openRecentConversation(page);
    await expect(page.locator('[data-testid="desktop-model-panel"] select')).toHaveCount(3);
    await sendChatMessage(page, testInfo, "Compare your answers please");

    await expect(page.getByText("Answer from claude-haiku-4-5.")).toBeVisible();
    await expect(page.getByText("Answer from gemini-2-5-flash.")).toBeVisible();
    await expect(page.getByText("Answer from deepseek-v4-flash.")).toBeVisible();
    await expect(sidebarList(page).getByText("Multi Model Comparison")).toBeVisible();

    // Give any accidental extra requests a moment to have fired before
    // asserting the final count.
    await page.waitForTimeout(300);
    expect(getCallCount()).toBe(1);
  });

  test("does not request a title again for the second message in the same conversation", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);

    const getCallCount = await mockGenerateTitle(page, "qa-conversation", () => ({
      body: { updated: true, title: "First Turn Title" },
    }));

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-followup" },
        body: "An answer.",
      });
    });

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, "First question");
    await expect(sidebarList(page).getByText("First Turn Title")).toBeVisible();

    await sendChatMessage(page, testInfo, "A follow-up question");
    await expect(page.getByText("An answer.").last()).toBeVisible();

    await page.waitForTimeout(300);
    expect(getCallCount()).toBe(1);
  });

  test("a manual rename that happens while generation is in flight is not overwritten", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);

    await mockGenerateTitle(page, "qa-conversation", async (body) => {
      // Simulate a slow provider call. The manual rename below (a PATCH,
      // handled by mockAuthenticatedApi's own route) completes first.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        body: { updated: body.expectedTitle === "Rename race test", title: "Should Not Appear" },
      };
    });

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-rename-race" },
        body: "An answer.",
      });
    });

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, "Rename race test");
    await expect(sidebarList(page).getByText("Rename race test")).toBeVisible();
    await expect(page.getByText("An answer.")).toBeVisible();

    // Manually rename via the sidebar menu right after the response lands,
    // before the (deliberately slow) title-generation request resolves.
    // mockAuthenticatedApi's /api/user/settings mock always reports Korean
    // ("ko"), so authenticated views render Korean UI chrome regardless of
    // the language seeded via prepareGuestPage -- match the other
    // authenticated specs' convention (e.g. comparison-review.spec.ts) of
    // asserting against the Korean copy for chrome text.
    await page.getByTestId("conversation-menu").first().click();
    await page.getByTestId("conversation-menu-panel").getByRole("button", { name: "이름 변경" }).click();
    const renameForm = page.locator("form").filter({ hasText: "이름 변경" });
    await renameForm.locator("input").fill("My Manually Renamed Chat");
    await renameForm.getByRole("button", { name: "확인", exact: true }).click();
    await expect(sidebarList(page).getByText("My Manually Renamed Chat")).toBeVisible();

    // Wait past the mocked generation delay -- the manual title must survive.
    await page.waitForTimeout(800);
    await expect(sidebarList(page).getByText("My Manually Renamed Chat")).toBeVisible();
    await expect(sidebarList(page).getByText("Should Not Appear")).toHaveCount(0);
  });

  test("a title-generation failure leaves the interim title in place with no visible error", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);

    await page.route("**/api/conversations/qa-conversation/generate-title", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    );

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-failure" },
        body: "An answer despite the title failure.",
      });
    });

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, "Title generation will fail");
    await expect(page.getByText("An answer despite the title failure.")).toBeVisible();

    await page.waitForTimeout(300);
    await expect(
      sidebarList(page).getByText("Title generation will fail")
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("the composer stays fully usable while a title-generation request is in flight", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);

    await page.route("**/api/conversations/qa-conversation/generate-title", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated: true, title: "Slow Title" }),
      });
    });

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-usable" },
        body: "First answer.",
      });
    });

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, "First message while title generates slowly");
    await expect(page.getByText("First answer.")).toBeVisible();

    // The title request is still in flight (1s delay) -- composer must not
    // be disabled or otherwise blocked by it.
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeEnabled();
    await sendChatMessage(page, testInfo, "Second message sent immediately");
    await expect(page.getByText("First answer.").last()).toBeVisible();
  });
});

test.describe("conversation auto-title generation (guest)", () => {
  test("guest gets a meaningful title in the sidebar after the first response, on both desktop and mobile", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockGuestConversationTitle(page, (body) => {
      expect(typeof body.message).toBe("string");
      return { body: { updated: true, title: "Guest Weekend Trip" } };
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-guest-title" },
        body: "A guest answer.",
      });
    });

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, "Plan my weekend as a guest");
    await expect(page.getByText("A guest answer.").first()).toBeVisible();

    await openMobileSidebarIfNeeded(page, testInfo);
    await expect(sidebarList(page).getByText("Guest Weekend Trip")).toBeVisible();

    // The generated title is written into the same localStorage-backed
    // conversations array the sidebar itself persists from -- not via a
    // separate write path.
    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("guest_conversations") || "[]")
    );
    expect(stored.some((c: { title?: string }) => c.title === "Guest Weekend Trip")).toBe(true);
  });

  test("guest conversation import preserves the already-generated title", async ({ page }) => {
    const GUEST_CHAT_ID = "guest_title_import_test";
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await page.addInitScript(
      ({ chatId }) => {
        const conversation = {
          id: chatId,
          title: "Generated Weekend Trip Title",
          selectedModels: ["gpt-5-4-mini"],
          disabledPanels: [],
          webSearchMode: "off",
          createdAt: new Date().toISOString(),
        };
        window.localStorage.setItem("guest_conversations", JSON.stringify([conversation]));
        window.localStorage.setItem(
          `guest_messages_${chatId}_gpt-5-4-mini`,
          JSON.stringify([
            { id: "u0", role: "user", content: "Plan my weekend trip", status: "normal" },
            { id: "a0", role: "assistant", content: "Here is a plan.", status: "normal" },
          ])
        );
      },
      { chatId: GUEST_CHAT_ID }
    );

    let importedTitle: string | null = null;
    await page.route("**/api/conversations/import-guest", async (route) => {
      const body = route.request().postDataJSON() as { title?: string };
      importedTitle = body.title ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, conversationId: "imported-qa-conversation" }),
      });
    });

    await page.goto("/chat?lang=en");
    await expect(page.getByRole("dialog", { name: "Import your guest conversations?" })).toBeVisible();
    await page.getByRole("button", { name: "Import current conversation only" }).click();

    await expect.poll(() => importedTitle).toBe("Generated Weekend Trip Title");
  });
});
