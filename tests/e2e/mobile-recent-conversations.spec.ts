import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

// The mobile new-chat screen used to render up to three recent conversations
// as title cards under the composer. That was both the tallest block on a
// 320x568 screen and a privacy leak: anyone who picked up the phone read real
// conversation titles without asking for them. The titles now live behind the
// same drawer the hamburger opens, and the welcome screen only says how many
// there are.
//
// Desktop is deliberately untouched -- it has the room, and its sidebar is
// already showing the same titles next to the cards.

const CHAT_PREFIX = "guest_recent";
const SENSITIVE_TITLE = "Oncology second opinion for my mother";

const seedGuestConversations = async (page: Page, titles: string[]) => {
  await page.addInitScript(
    ({ prefix, titles }) => {
      const conversations = titles.map((title, index) => ({
        id: `${prefix}_${index}`,
        title,
        selectedModels: ["gpt-5-4-mini"],
        disabledPanels: [],
        webSearchMode: "off",
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
      }));
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify(conversations)
      );
      for (const conversation of conversations) {
        window.localStorage.setItem(
          `guest_messages_${conversation.id}_gpt-5-4-mini`,
          JSON.stringify([
            { id: "u1", role: "user", content: "Hello", status: "normal" },
            { id: "a1", role: "assistant", content: "Hi there.", status: "normal" },
          ])
        );
      }
    },
    { prefix: CHAT_PREFIX, titles }
  );
};

test.describe("mobile recent-chat disclosure", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The compact disclosure replaces the cards only in the mobile shell."
    );
    await prepareGuestPage(page, "en");
  });

  test("no recent chats means no disclosure at all", async ({ page }) => {
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(page.getByTestId("recent-conversations-disclosure")).toHaveCount(0);
    await expect(page.getByTestId("recent-conversation-card")).toHaveCount(0);
  });

  for (const count of [1, 3]) {
    test(`${count} recent chat(s): a counted row, and no titles on screen`, async ({
      page,
    }) => {
      const titles = [SENSITIVE_TITLE, "Tax return questions", "Divorce paperwork"].slice(
        0,
        count
      );
      await seedGuestConversations(page, titles);
      await page.goto("/chat?lang=en");

      const disclosure = page.getByTestId("recent-conversations-disclosure");
      await expect(disclosure).toBeVisible();
      await expect(disclosure).toHaveAttribute("data-recent-count", String(count));
      await expect(disclosure).toHaveAccessibleName(
        count === 1 ? "View 1 recent chat" : `View ${count} recent chats`
      );

      // No title card, and no title text anywhere in the welcome screen's DOM.
      await expect(page.getByTestId("recent-conversation-card")).toHaveCount(0);
      const welcomeText = await page
        .getByTestId("chat-empty-state")
        .innerText();
      for (const title of titles) {
        expect(welcomeText).not.toContain(title);
      }
    });
  }

  test("the disclosure opens the existing drawer and returns focus on close", async ({
    page,
  }) => {
    await seedGuestConversations(page, [SENSITIVE_TITLE, "Tax return questions"]);
    await page.goto("/chat?lang=en");

    const disclosure = page.getByTestId("recent-conversations-disclosure");
    await disclosure.click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    // Only now -- after an explicit user action -- are titles shown.
    await expect(
      drawer.getByTestId("sidebar-conversation-item").filter({ hasText: SENSITIVE_TITLE })
    ).toBeVisible();
    // Focus moves into the drawer rather than staying behind the overlay.
    await expect(
      drawer.locator(":focus")
    ).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(disclosure).toBeFocused();
  });

  test("picking a chat from the drawer opens it", async ({ page }) => {
    await seedGuestConversations(page, [SENSITIVE_TITLE]);
    await page.goto("/chat?lang=en");

    await page.getByTestId("recent-conversations-disclosure").click();
    await page
      .getByRole("dialog")
      .getByTestId("sidebar-conversation-item")
      .filter({ hasText: SENSITIVE_TITLE })
      .click();

    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
  });

  test("at 320x568 the recent row stays smaller than the composer", async ({
    page,
  }) => {
    await seedGuestConversations(page, ["A", "B", "C"]);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?lang=en");

    const disclosureBox = await page
      .getByTestId("recent-conversations-disclosure")
      .boundingBox();
    const composerBox = await page.getByTestId("chat-input").boundingBox();
    expect(disclosureBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(disclosureBox!.height).toBeLessThan(composerBox!.height);
    expect(disclosureBox!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("desktop recent-chat cards are unchanged", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Desktop keeps the existing recent-conversation cards."
    );
    await prepareGuestPage(page, "en");
  });

  test("the welcome screen still lists recent conversations as cards", async ({
    page,
  }) => {
    await seedGuestConversations(page, ["First chat", "Second chat"]);
    await page.goto("/chat?lang=en");

    await expect(page.getByTestId("recent-conversation-card")).toHaveCount(2);
    await expect(page.getByTestId("recent-conversations-disclosure")).toHaveCount(0);
  });
});
