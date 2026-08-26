import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  openModelPickerCatalogue,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

// The composer used to render the web-search *mode* and its *readiness* as two
// separate blocks -- "Web search - Use web search" on one row, "Search-ready 1
// - Unsupported 0" on the next. The label repeated itself, and the healthy
// all-supported case (Unsupported 0) cost a whole row of answer space.
//
// One chip now carries the state. The normal case is one line; only a real
// exception -- some models cannot search, or none can -- earns anything more.

// From lib/webSearchCapability.ts: claude-haiku-4-5 has confirmed
// provider-native search; gpt-5-4-mini is unverified and DeepSeek V4 Flash is
// unsupported. All three are guest-selectable.
const SUPPORTED = "claude-haiku-4-5";
const UNSUPPORTED = ["gpt-5-4-mini", "deepseek-v4-flash"];
/**
 * Native, and still counted as one that cannot search.
 *
 * Gemini's Search grounding is charged per query and takes no ceiling -- not
 * on the tool and not on the request -- so no request may carry it. The
 * composer has to say so before the send: the alternative is what this whole
 * area was fixed for, a chip that promises a search and a dispatch that
 * refuses one.
 */
const UNBOUNDED_NATIVE = "gemini-2-5-flash";
const TITLE = "Web search state";
const CHAT_ID = "guest_web_search_state";

const seedGuestConversation = async (
  page: Page,
  models: string[],
  webSearchMode: "off" | "auto" | "always"
) => {
  await page.addInitScript(
    ({ chatId, models, title, webSearchMode }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title,
            selectedModels: models,
            disabledPanels: [],
            webSearchMode,
            createdAt: new Date().toISOString(),
          },
        ])
      );
      for (const modelId of models) {
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "Hello", status: "normal" },
            { id: "a1", role: "assistant", content: "Hi there.", status: "normal" },
          ])
        );
      }
    },
    { chatId: CHAT_ID, models, title: TITLE, webSearchMode }
  );
};

const open = async (page: Page) => {
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: TITLE });
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
};

const chip = (page: Page) => page.getByTestId("web-search-mode-chip");

/**
 * The chip says the same thing in two lengths. The mobile shell shortens the
 * *label* -- dropping the separator and the word "supported" -- but never the
 * row: the chip owns its own row above the textarea in both shells, per
 * docs/ui-contracts/mobile-chat-composer.md. Every state stays
 * distinguishable, and the full sentence is still what
 * `#web-search-state-description` carries. Which length is on screen is read
 * from the row's own `data-label-variant` rather than from the project name,
 * so this holds wherever the shell decides to mount.
 */
async function expectChipLabel(
  page: Page,
  labels: { full: string; compact: string }
) {
  const variant = await page
    .getByTestId("tool-status-chip-row")
    .getAttribute("data-label-variant");
  await expect(chip(page)).toContainText(
    variant === "compact" ? labels.compact : labels.full
  );
}

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "en");
});

test("web search off shows neither a chip nor a readiness line", { tag: "@ui-risk" }, async ({ page }) => {
  await seedGuestConversation(page, [SUPPORTED], "off");
  await open(page);

  await expect(chip(page)).toHaveCount(0);
  await expect(page.getByTestId("web-search-readiness-summary")).toHaveCount(0);
  await expect(page.getByTestId("web-search-unavailable-notice")).toHaveCount(0);
});

test("full support is one compact line with no 'Unsupported 0' row", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, [SUPPORTED], "always");
  await open(page);

  await expect(chip(page)).toHaveAttribute("data-tone", "neutral");
  await expect(chip(page)).toHaveAttribute("data-unsupported-count", "0");
  await expectChipLabel(page, { full: "Web search on", compact: "Web search" });
  // The words "web search" appear once, not twice.
  await expect(chip(page)).not.toContainText("Use web search");
  await expect(page.getByTestId("web-search-readiness-summary")).toHaveCount(0);
  await expect(page.getByTestId("web-search-exception-toggle")).toHaveCount(0);
  await expect(page.getByTestId("web-search-unavailable-notice")).toHaveCount(0);

  // The full request state is still available to assistive tech.
  const describedBy = await chip(page)
    .locator("[aria-describedby]")
    .first()
    .getAttribute("aria-describedby");
  const description = page.locator(`#${describedBy}`);
  await expect(description).toContainText("1 of 1 selected models can search");
  await expect(description).toContainText("Up to 8 extra credits");
  await expect(description).toContainText("refunded");
});

test("the composer does not grow extra rows just to say the normal state", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, [SUPPORTED], "off");
  await open(page);
  const before = (await page.getByTestId("chat-input").boundingBox())!.height;

  await page.locator('button[aria-controls="chat-input-popover"]').nth(0).click();
  await page.getByTestId("tools-web-search-row").click();
  await page.keyboard.press("Escape");

  await expect(chip(page)).toBeVisible();
  const after = (await page.getByTestId("chat-input").boundingBox())!.height;

  // One chip row (36px chip plus its margin), not a chip row *and* a
  // readiness row.
  expect(after - before).toBeLessThanOrEqual(60);
  await expectNoHorizontalOverflow(page);
});

test("partial support is the only case that earns a visible exception", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, [UNSUPPORTED[0], SUPPORTED, UNSUPPORTED[1]], "always");
  await open(page);

  await expect(chip(page)).toHaveAttribute("data-tone", "warning");
  await expectChipLabel(page, {
    full: "1/3 supported",
    compact: "Web search 1/3",
  });
  await expect(page.getByTestId("web-search-exception-detail")).toHaveCount(0);

  await page.getByTestId("web-search-exception-toggle").click();
  const detail = page.getByTestId("web-search-exception-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("GPT-5.4 mini");
  await expect(detail).toContainText("without a web search");
});

test("no capable model blocks with a way out instead of a silent fallback", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, UNSUPPORTED, "always");
  await open(page);

  await expect(chip(page)).toHaveAttribute("data-tone", "blocked");
  await expectChipLabel(page, {
    full: "Web search unavailable",
    compact: "No web search",
  });

  const notice = page.getByTestId("web-search-unavailable-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Add a search-capable model");

  await page.getByTestId("web-search-unavailable-turn-off").click();
  await expect(chip(page)).toHaveCount(0);
  await expect(notice).toHaveCount(0);
});

test(
  "a conversation stored as the retired auto mode opens with the switch off",
  { tag: "@ui-risk" },
  async ({ page }) => {
  // "auto" meant "ask me before searching", and the switch has no position
  // that can honour that. Reading it as on would turn a request to be asked
  // into standing permission to search and to spend the surcharge, so it opens
  // off -- indistinguishable from off, with nothing left over that promises a
  // search.
  await seedGuestConversation(page, [SUPPORTED, ...UNSUPPORTED], "auto");
  await open(page);

  await expect(chip(page)).toHaveCount(0);
  await expect(page.getByTestId("web-search-unavailable-notice")).toHaveCount(0);
  await expect(page.getByTestId("web-search-exception-toggle")).toHaveCount(0);

  await page.locator('button[aria-controls="chat-input-popover"]').nth(0).click();
  await expect(page.getByTestId("tools-web-search-row")).toHaveAttribute(
    "aria-checked",
    "false"
  );
  }
);

test("adding a model that cannot search updates the chip and the reservation together", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, [SUPPORTED], "always");
  await open(page);

  await expect(chip(page)).toHaveAttribute("data-supported-count", "1");
  await expect(chip(page)).toHaveAttribute("data-unsupported-count", "0");
  const creditsBefore = await page
    .getByTestId("request-credit-estimate")
    .innerText();

  const dialog = await openModelPickerCatalogue(page);
  await dialog
    .locator(`[data-testid="model-option"][data-model-id="${UNSUPPORTED[0]}"]`)
    .click();
  await dialog.getByTestId("model-picker-done").click();

  await expect(chip(page)).toHaveAttribute("data-supported-count", "1");
  await expect(chip(page)).toHaveAttribute("data-unsupported-count", "1");
  await expect(chip(page)).toHaveAttribute("data-tone", "warning");
  // The base cost grows with the extra model, but the search surcharge does
  // not -- an unsupported model reserves nothing for a search it cannot run.
  await expect(page.getByTestId("request-credit-estimate")).not.toHaveText(
    creditsBefore
  );
});

test("a native model whose search cost has no ceiling is counted as unsupported", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, [SUPPORTED, UNBOUNDED_NATIVE], "always");
  await open(page);

  await expect(chip(page)).toHaveAttribute("data-tone", "warning");
  await expect(chip(page)).toHaveAttribute("data-supported-count", "1");
  await expect(chip(page)).toHaveAttribute("data-unsupported-count", "1");

  await page.getByTestId("web-search-exception-toggle").click();
  const detail = page.getByTestId("web-search-exception-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Gemini");
  await expect(detail).toContainText("without a web search");
});

test("a selection of only unbounded native models blocks rather than promising a search", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await seedGuestConversation(page, [UNBOUNDED_NATIVE], "always");
  await open(page);

  await expect(chip(page)).toHaveAttribute("data-tone", "blocked");
  await expectChipLabel(page, {
    full: "Web search unavailable",
    compact: "No web search",
  });
  await expect(
    page.getByTestId("web-search-unavailable-notice")
  ).toContainText("Add a search-capable model");
});
