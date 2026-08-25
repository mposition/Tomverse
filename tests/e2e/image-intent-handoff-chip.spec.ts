import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";

/**
 * The composer's image-request handoff chip -- entry point 5 of
 * docs/ui-contracts/image-generation-workspace.md.
 *
 * What this file is defending is the sentence that made a fifth entry point
 * acceptable at all: **the chip is an entry point, not an execution.** It
 * appears, it can be ignored, and nothing happens until it is pressed. A
 * regression that switched the draft on its own, or submitted a generation,
 * would still "work" in a screenshot -- so it is asserted here rather than
 * left to review.
 *
 * The opt-in flag is resolved server-side and the e2e server runs with the
 * database disabled, so `__tomverse_e2e_image_generation` is the fixture
 * override, the same one the workspace spec uses. Tests that never set it
 * prove the flag-off posture.
 */

const BASE_URL = "http://127.0.0.1:3100";

const enableImageGenerationFlag = async (page: Page) => {
  await page.context().addCookies([
    { name: "__tomverse_e2e_image_generation", value: "1", url: BASE_URL },
  ]);
};

const chip = (page: Page) => page.getByTestId("image-intent-handoff-suggestion");
const composer = (page: Page) => page.getByTestId("chat-textarea");

/** A draft the shared classifier reads as unmistakable raster generation. */
const RASTER_DRAFT = "draw a picture of a cat sitting on a windowsill";
/** A text-dense visual: deliberately out of scope until the L3 work lands. */
const INFOGRAPHIC_DRAFT = "draw an infographic about blood pressure and food";

const type = async (page: Page, text: string) => {
  await composer(page).fill(text);
  // The verdict follows the settled draft rather than each keystroke.
  await page.waitForTimeout(300);
};

test.describe("guest", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
  });

  test("no chip exists while the feature flag is off", async ({ page }) => {
    await page.goto("/chat?lang=en");
    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toHaveCount(0);
  });

  test("a guest sees the chip with the sign-in requirement stated before the click", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await page.goto("/chat?lang=en");
    await type(page, RASTER_DRAFT);

    await expect(chip(page)).toBeVisible();
    await expect(chip(page)).toHaveAttribute("data-locked", "true");
    // Locked exposure: the condition is readable in the row itself, not
    // discovered after pressing it.
    await expect(page.getByTestId("image-intent-handoff-requirement")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the chip never blocks an ordinary chat submit", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await page.goto("/chat?lang=en");
    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toBeVisible();

    // Ignoring the offer and sending is the chat turn the person typed.
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await expect(composer(page)).toHaveValue(RASTER_DRAFT);
  });
});

test.describe("signed in", () => {
  test("a text-dense visual gets no chip", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, INFOGRAPHIC_DRAFT);
    // Routing an infographic to a text-to-image workspace is a wrong answer,
    // not a shortcut: the destination for this class is still an open product
    // question -- see
    // .github/audits/image-intent-auto-switch-2026-08-24.md §6.
    await expect(chip(page)).toHaveCount(0);
  });

  test("an ordinary question gets no chip", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, "what foods help with high blood pressure?");
    await expect(chip(page)).toHaveCount(0);
  });

  test("an explicit ASCII request is not treated as an image request", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, "draw it in ASCII art please");
    await expect(chip(page)).toHaveCount(0);
  });

  test("a Pro account is handed to the image draft only after pressing", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toBeVisible();
    await expect(chip(page)).toHaveAttribute("data-locked", "false");

    // Still in chat: appearing is not acting.
    await expect(page.getByTestId("image-generation-prompt")).toHaveCount(0);

    await page.getByTestId("image-intent-handoff-accept").click();

    // Now in the workspace, carrying the draft as the starting prompt, and no
    // generation has been submitted.
    await expect(page.getByTestId("image-generation-prompt")).toBeVisible();
    await expect(page.getByTestId("image-generation-prompt")).toHaveValue(
      RASTER_DRAFT
    );
  });

  test("dismissing hides the chip and leaves the draft alone", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toBeVisible();

    await page.getByTestId("image-intent-handoff-dismiss").click();
    await expect(chip(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue(RASTER_DRAFT);

    // A trivial edit does not bring it back.
    await type(page, `${RASTER_DRAFT}!`);
    await expect(chip(page)).toHaveCount(0);
  });

  test("a substantially rewritten draft may offer once more", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, "draw a cat");
    await expect(chip(page)).toBeVisible();
    await page.getByTestId("image-intent-handoff-dismiss").click();
    await expect(chip(page)).toHaveCount(0);

    await type(
      page,
      "draw a cat in watercolour on a rainy street at night with neon signs"
    );
    await expect(chip(page)).toBeVisible();

    // And only once: a second dismissal is final for this draft.
    await page.getByTestId("image-intent-handoff-dismiss").click();
    await expect(chip(page)).toHaveCount(0);
    await type(
      page,
      "draw a cat in watercolour on a rainy street at night with neon signs and rain puddles everywhere"
    );
    await expect(chip(page)).toHaveCount(0);
  });

  test("the chip owns its own row and never overlaps the textarea", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toBeVisible();

    // The mobile composer contract: the textarea keeps a dedicated full-width
    // row with a complete visible line, and nothing floats above it.
    const chipBox = await chip(page).boundingBox();
    const textareaBox = await composer(page).boundingBox();
    expect(chipBox).not.toBeNull();
    expect(textareaBox).not.toBeNull();
    expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(textareaBox!.y + 1);
    expect(textareaBox!.height).toBeGreaterThanOrEqual(28);
    await expectNoHorizontalOverflow(page);
  });

  test("the chip is reachable and operable from the keyboard", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toBeVisible();

    const accept = page.getByTestId("image-intent-handoff-accept");
    await accept.focus();
    await expect(accept).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("image-generation-prompt")).toBeVisible();
  });

  test("nothing appears while a Korean composition is in progress", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=ko");

    const textarea = composer(page);
    await textarea.click();
    // A composition that is still open: the row must not appear and resize the
    // composer under the cursor mid-syllable. `fill` goes through the native
    // value setter so React sees the text, exactly as an IME's own input
    // events would.
    await textarea.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
    });
    await textarea.fill("고양이 그림 그려 줘");
    await page.waitForTimeout(300);
    await expect(chip(page)).toHaveCount(0);

    // Committed: the offer may appear now.
    await textarea.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "고양이 그림 그려 줘",
        })
      );
    });
    await page.waitForTimeout(300);
    await expect(chip(page)).toBeVisible();
  });
});
