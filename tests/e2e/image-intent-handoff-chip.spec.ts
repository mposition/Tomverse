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

/**
 * Counts what the opt-in actually changes: requests to spend credits.
 *
 * Asserted instead of a spinner because `data-generating` follows the polled
 * timeline, and this suite has no image backend -- a submit that was made and
 * then failed looks identical to one that never happened.
 */
const countGenerationRequests = async (page: Page) => {
  const prompts: string[] = [];
  await page.route("**/api/images/generations", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { prompt?: unknown };
      if (typeof body?.prompt === "string") prompts.push(body.prompt);
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "not wired in this suite" }),
      });
    }
    return route.fallback();
  });
  return { count: () => prompts.length, prompts: () => [...prompts] };
};

const type = async (page: Page, text: string) => {
  // A composer mid-send is not editable, and `fill` on a disabled textarea is
  // silently a no-op -- which reads as the feature ignoring the new draft
  // rather than as the test typing into a box that was not listening. The
  // mobile shell locks the box while a turn is in flight; desktop does not.
  await expect(composer(page)).toBeEditable();
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
  test("a text-dense visual gets the chip too", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, INFOGRAPHIC_DRAFT);
    // It was excluded while the destination was an open product question. What
    // the exclusion produced was the model naming the workspace in prose it
    // could not act on -- see docs/policy/image-generation.md §13. The SVG is
    // still what the answer makes; this is offered beside it.
    await expect(chip(page)).toBeVisible();
  });

  test("an attached image still gets no chip", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    // The workspace starts from text, so it cannot edit or describe a picture
    // that is already here. Offering it would send the person somewhere that
    // cannot do what they asked.
    await type(page, "change the background of this");
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

  test("the offer survives the send and carries the question that was asked", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await expect(chip(page)).toBeVisible();

    // Sending is what used to end the offer. It is also the moment most people
    // decide they wanted the picture, having read what the chat could give
    // them instead.
    await page.getByTestId("chat-send-button").click();
    await expect(composer(page)).toHaveValue("");
    await expect(chip(page)).toBeVisible();

    await page.getByTestId("image-intent-handoff-accept").click();
    // The empty composer is not the prompt. The question that was asked is.
    await expect(page.getByTestId("image-generation-prompt")).toHaveValue(
      RASTER_DRAFT
    );
  });

  test("a dismissal made before the send is still a dismissal after it", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-dismiss").click();
    await expect(chip(page)).toHaveCount(0);

    // Same question, already answered. Asking again after the send would be
    // the product not listening.
    await page.getByTestId("chat-send-button").click();
    await expect(composer(page)).toHaveValue("");
    await expect(chip(page)).toHaveCount(0);
  });

  test("an ordinary question sent afterwards ends the offer", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await page.getByTestId("chat-send-button").click();
    await expect(chip(page)).toBeVisible();

    // The offer is about the last question asked, so a new question that wants
    // no picture replaces it rather than leaving the old one on screen.
    await type(page, "what foods help with high blood pressure?");
    await expect(chip(page)).toHaveCount(0);
    await page.getByTestId("chat-send-button").click();
    await expect(composer(page)).toHaveValue("");
    await expect(chip(page)).toHaveCount(0);
  });

  /* ---------------------------------------------------------------------- */
  /* "Generate without asking next time"                                       */
  /* ---------------------------------------------------------------------- */

  test("the press lands with the prompt and the price, and generates nothing", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    const submitted = await countGenerationRequests(page);
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-accept").click();

    // The default, and the whole reason the opt-in has to be opted into: a
    // press is navigation, and navigation does not spend credits.
    await expect(page.getByTestId("image-generation-prompt")).toHaveValue(
      RASTER_DRAFT
    );
    await page.waitForTimeout(600);
    expect(submitted.count()).toBe(0);
  });

  test("the opt-in can only be set where the price is", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-accept").click();

    const toggle = page.getByTestId("image-generation-auto-generate-toggle");
    await expect(toggle).toBeVisible();

    // The contract's "quoted before submission" survives the opt-in only if
    // the choice is made in front of the number it is about: the credit badge
    // is on the submit button, in the same row.
    const toggleBox = await toggle.boundingBox();
    const submitBox = await page
      .getByTestId("image-generation-submit")
      .boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    const sharesTheRow =
      Math.abs(
        toggleBox!.y + toggleBox!.height / 2 - (submitBox!.y + submitBox!.height / 2)
      ) <
      Math.max(toggleBox!.height, submitBox!.height);
    expect(sharesTheRow).toBe(true);
  });

  test("with the opt-in on, the press generates without a second click", async ({
    page,
  }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    const submitted = await countGenerationRequests(page);
    await page.goto("/chat?lang=en");

    // Turned on the way a person turns it on: in the workspace, beside the
    // price, before going back to ask for a picture.
    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-accept").click();
    await page
      .getByTestId("image-generation-auto-generate-toggle")
      .getByRole("checkbox")
      .check();
    await page.getByTestId("image-generation-cancel-draft").click();

    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-accept").click();

    await expect(page.getByTestId("image-generation-prompt")).toHaveValue(
      RASTER_DRAFT
    );
    // The request itself, not a spinner: what this feature changes is whether
    // credits are spent, and the POST is where that happens.
    await expect.poll(() => submitted.count()).toBe(1);
    expect(submitted.prompts()).toEqual([RASTER_DRAFT]);
  });

  test("the opt-in stays revocable on the screen it acts on", async ({ page }) => {
    await enableImageGenerationFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await page.goto("/chat?lang=en");

    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-accept").click();
    const checkbox = page
      .getByTestId("image-generation-auto-generate-toggle")
      .getByRole("checkbox");
    await checkbox.check();
    await page.getByTestId("image-generation-cancel-draft").click();

    await type(page, RASTER_DRAFT);
    await page.getByTestId("image-intent-handoff-accept").click();
    // It has just spent credits on a press. The place to take that permission
    // back is the place it was given, and it is still there while the request
    // runs.
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
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
