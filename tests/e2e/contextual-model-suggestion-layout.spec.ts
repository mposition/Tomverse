import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { mockUserUsage, restoreActiveConversation, setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";

// The "A research model may help with sources" card appears above the input
// while the user is still typing. Its row layout used a viewport breakpoint
// (`sm:flex-row`), so in desktop Chat Studio's ~330px composer column the two
// buttons sat beside the copy and squeezed it to one word per line: the card
// grew to ~360px, "Continue with current models" was clipped at the column
// edge, and the send button was pushed below the 900px viewport. The layout
// now keys off the card's own container. These checks measure that geometry.

const PROMPT = "What's the weather outlook for Brisbane this weekend? Include sources.";
const TITLE = "A research model may help with sources";

const suggestionTitle = (page: Page) => page.getByText(TITLE, { exact: true });
// Waits on the card, not the title: the defect squeezed the title to a 0px
// column, which Playwright reports as "hidden" rather than as too narrow.
const suggestionCard = (page: Page) =>
  suggestionTitle(page).locator("xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]");

// The mobile shell needs a coarse pointer (useIsMobileShell), not just a narrow viewport.
test.use({ hasTouch: true });
test.setTimeout(120_000);
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Explicit desktop and mobile viewport coverage.");
});

async function openConversation(page: Page, viewport: { width: number; height: number }, appearance: "classic" | "studio") {
  await page.setViewportSize(viewport);
  await prepareGuestPage(page, "en", appearance, appearance);
  const account = await mockAuthenticatedApi(page, {
    productKey: "chat",
    selectedModels: ["gpt-6-luna"],
    selectionMode: "manual",
    language: "en",
    messages: [
      { id: "suggestion-question", role: "user", content: "How do I make a quick garlic pasta?" },
      {
        id: "suggestion-answer",
        role: "assistant",
        modelId: "gpt-6-luna",
        content: "Boil the pasta, warm garlic in olive oil, then toss everything together with a splash of pasta water.",
      },
    ],
  });
  account.theme = "light";
  await mockUserUsage(page, { plan: "Pro" });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.context().addCookies([
    { name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" },
  ]);
  await page.route("**/api/products/chat/capabilities", (route) => route.fulfill({ json: { autoSelection: { offered: false } } }));
  await page.route("**/api/chat/context", (route) => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  await page.goto("/chat?lang=en");
  await expect(page.getByText("How do I make a quick garlic pasta?", { exact: true }).first()).toBeVisible();
  await expect(page.locator(`[data-studio-product="chat"][data-review-appearance="${appearance}"]`)).toBeVisible();
}

async function expectCardFits(page: Page, label: string) {
  const card = suggestionCard(page);
  await expect(card, label).toBeVisible();
  const geometry = await card.evaluate((node) => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const cardRect = rect(node);
    const title = node.querySelector("p")!;
    const buttons = Array.from(node.querySelectorAll("button"));
    return {
      cardWidth: cardRect.width,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      cardHeight: cardRect.height,
      titleWidth: rect(title).width,
      buttons: buttons.map((button) => ({
        text: button.textContent?.trim(),
        left: rect(button).left,
        right: rect(button).right,
        clipped: button.scrollWidth > button.clientWidth + 1,
      })),
    };
  });
  // (a) The title has the column to itself rather than a one-word sliver.
  expect(geometry.titleWidth, `${label}: title width ${geometry.titleWidth} of card ${geometry.cardWidth}`).toBeGreaterThanOrEqual(geometry.cardWidth / 2);
  // (c) Both buttons stay inside the card and show their whole label.
  expect(geometry.buttons, label).toHaveLength(2);
  for (const button of geometry.buttons) {
    expect(button.left, `${label}: "${button.text}" left edge`).toBeGreaterThanOrEqual(geometry.cardLeft - 1);
    expect(button.right, `${label}: "${button.text}" right edge`).toBeLessThanOrEqual(geometry.cardRight + 1);
    expect(button.clipped, `${label}: "${button.text}" label clipped`).toBe(false);
  }
  return geometry;
}

async function expectSendInViewport(page: Page, label: string) {
  const send = page.getByTestId("chat-send-button").locator("visible=true");
  await expect(send).toBeVisible();
  const box = await send.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, label).not.toBeNull();
  expect(box!.y, `${label}: send top`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label}: send bottom vs viewport ${viewport.height}`).toBeLessThanOrEqual(viewport.height);
  expect(box!.x + box!.width, `${label}: send right`).toBeLessThanOrEqual(viewport.width);
}

const CASES = [
  { name: "desktop Studio 1440x900", viewport: { width: 1440, height: 900 }, appearance: "studio" as const },
  { name: "desktop Classic 1440x900", viewport: { width: 1440, height: 900 }, appearance: "classic" as const },
  { name: "mobile 390x844", viewport: { width: 390, height: 844 }, appearance: "classic" as const },
  { name: "mobile Studio 390x844", viewport: { width: 390, height: 844 }, appearance: "studio" as const },
  { name: "mobile 320x568", viewport: { width: 320, height: 568 }, appearance: "classic" as const },
];

for (const { name, viewport, appearance } of CASES) {
  test(`research suggestion card fits its column and keeps send on screen (${name})`, { tag: "@ui-risk" }, async ({ page }, info) => {
    await openConversation(page, viewport, appearance);
    const textarea = page.getByTestId("chat-textarea").locator("visible=true");
    await textarea.fill(PROMPT);
    await expect(suggestionCard(page)).toBeVisible();

    await expectCardFits(page, name);
    await textarea.focus();
    await expectSendInViewport(page, `${name} with card`);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`suggestion-card-${viewport.width}-${appearance}.png`) });

    // Dismissing only closes the card; the draft stays and is not sent.
    await page.getByRole("button", { name: "Continue with current models" }).click();
    await expect(suggestionTitle(page)).toHaveCount(0);
    await expect(textarea).toHaveValue(PROMPT);
    await expectSendInViewport(page, `${name} after dismiss`);
  });
}
