import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import {
  mockGuestUsage,
  mockUserUsage,
  setRootFontSize,
} from "./support/chat-state-fixtures";

/**
 * The Chat starter catalogue on the welcome screen.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md.
 *
 * The rollout flag is resolved server-side into the chat page's RSC payload
 * and the e2e server runs with the database disabled, so the flag can never
 * read true on its own. `__tomverse_e2e_chat_starter` is the fixture-mode
 * override, the same pattern `__tomverse_e2e_image_generation` uses. A test
 * that never sets the cookie is therefore proving the flag-off posture, which
 * is the first thing this file asserts: nothing renders at all.
 */

const BASE_URL = "http://127.0.0.1:3100";

const enableStarterFlag = async (page: Page) => {
  await page.context().addCookies([
    { name: "__tomverse_e2e_chat_starter", value: "1", url: BASE_URL },
  ]);
};

const enableImageFlag = async (page: Page) => {
  await page.context().addCookies([
    { name: "__tomverse_e2e_image_generation", value: "1", url: BASE_URL },
  ]);
};

const gallery = (page: Page) => page.getByTestId("chat-starter-gallery");
const cards = (page: Page) => page.getByTestId("chat-starter-card");

const openWelcome = async (page: Page) => {
  await page.goto("/chat");
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
};

const hasHorizontalOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
  );

test.describe("Chat starter catalogue", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
  });

  test("with the flag off nothing renders at all", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // Not a disabled teaser, not an empty heading, not a reserved row: the
    // surface is absent. A person who cannot use a feature is not told about
    // it (docs/ui-contracts/prompt-refiner-suggestion.md section 1).
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);

    await expect(gallery(page)).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
  });

  test("with the flag on the gallery offers runnable cards within the screen cap", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    await enableStarterFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);

    await expect(gallery(page)).toBeVisible();
    const count = await cards(page).count();
    expect(count).toBeGreaterThan(0);
    // The registry may grow without limit; a first screen may not.
    expect(count).toBeLessThanOrEqual(6);

    // Every card that is not locked is runnable now, so none of them may be
    // hidden-state leftovers.
    for (let index = 0; index < count; index += 1) {
      const state = await cards(page).nth(index).getAttribute("data-starter-state");
      expect(["available", "locked"]).toContain(state);
    }
  });

  test("a locked card states its requirement before the click, not after", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // A guest sees the card that needs an account, with the requirement on the
    // card. The failure this covers is the other shape: a card that looks
    // runnable, is clicked, and only then refuses.
    await enableStarterFlag(page);
    await openWelcome(page);

    const locked = page.locator('[data-starter-state="locked"]');
    await expect(locked.first()).toBeVisible();
    // The lock chip is part of the offer, and it is inside the card's own
    // accessible name rather than in a tooltip nobody opens.
    await expect(
      locked.first().getByTestId("chat-starter-lock")
    ).toBeVisible();
    const name = await locked.first().textContent();
    expect((name ?? "").trim().length).toBeGreaterThan(0);
  });

  test("a card fills the composer draft and sends nothing", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    await enableStarterFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });

    // The send endpoint exactly, not `**/api/chat**`: that glob also catches
    // `/api/chat/preflight`, which the page uses for reasons unrelated to
    // sending, so counting it would make this assertion pass or fail for the
    // wrong reason. `route.fallback()` leaves the mock in place; nothing here
    // wants to change what a real send would do, only to observe that none
    // happens.
    let sends = 0;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() === "POST") sends += 1;
      await route.fallback();
    });

    await openWelcome(page);

    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toHaveValue("");

    const runnable = page.locator('[data-starter-state="available"]').first();
    await expect(runnable).toBeVisible();
    await runnable.click();

    await expect(textarea).not.toHaveValue("");
    const seeded = await textarea.inputValue();
    expect(seeded.trim().length).toBeGreaterThan(0);

    // The transcript is still empty and no request was made: a seed is a
    // starting point, never a send.
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    expect(sends).toBe(0);

    // A second card replaces the first card's sentence, because nobody has
    // edited it. Typed work is protected by the same rule, asserted below.
    const second = page.locator('[data-starter-state="available"]').nth(1);
    if (await second.count()) {
      await second.click();
      await expect(textarea).not.toHaveValue(seeded);
    }
  });

  test("a seed never overwrites something the person typed", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    await enableStarterFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("my own half finished question");
    await page.locator('[data-starter-state="available"]').first().click();

    await expect(textarea).toHaveValue("my own half finished question");
  });

  test("a card that does not want search puts the toggle back", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // Staging, 2026-09-15: picking the sourced-answer card and then changing
    // your mind left web search armed, so the next send was priced at 9
    // credits instead of 1. The seed now owns the toggle on the same terms it
    // owns the text -- it may put back what it put there.
    await enableStarterFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);

    const sourced = page.locator('[data-starter-id="sourced-answer"]');
    await expect(sourced).toBeVisible();
    await sourced.click();
    await expect(page.getByTestId("web-search-mode-chip")).toBeVisible();

    const plain = page.locator('[data-starter-id="compare-answers"]');
    await expect(plain).toBeVisible();
    await plain.click();
    await expect(page.getByTestId("web-search-mode-chip")).toHaveCount(0);
  });

  test("a seed stays ours across a language change", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // Cross review round 2, 2026-09-15: ownership was "is the draft one of the
    // sentences the cards produce in the active locale". Changing the language
    // took the sentence already in the box out of that set, so the next card
    // read it as the person's own writing, applied nothing, and the search the
    // first card armed could no longer be put back -- the 9-credit send again.
    // A guest, because the language control a guest has changes the locale in
    // place; a reload would clear the draft and prove nothing. The guest holds
    // enough credits for a searching send, or the guest-limit dialog opens
    // over the gallery the moment search is armed.
    await enableStarterFlag(page);
    await mockGuestUsage(page, 0, 1000);
    await openWelcome(page);

    const textarea = page.getByTestId("chat-textarea");
    const sourced = page.locator('[data-starter-id="sourced-answer"]');
    const plain = page.locator('[data-starter-id="compare-answers"]');
    await expect(sourced).toBeVisible();
    await sourced.click();
    await expect(page.getByTestId("web-search-mode-chip")).toBeVisible();
    const englishSeed = await textarea.inputValue();
    expect(englishSeed.trim().length).toBeGreaterThan(0);
    const englishPlainCard = (await plain.textContent()) ?? "";

    const isMobile = (page.viewportSize()?.width ?? 1024) < 768;
    if (isMobile) {
      await page.getByTestId("mobile-chat-shell").locator("header button").first().click();
    }
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="ko"]') })
      .last()
      .selectOption("ko");
    if (isMobile) await page.keyboard.press("Escape");

    // The locale really changed, and the draft survived it: otherwise the
    // assertions below would pass without exercising anything.
    await expect(plain).not.toHaveText(englishPlainCard);
    await expect(textarea).toHaveValue(englishSeed);

    await plain.click();
    await expect(textarea).not.toHaveValue(englishSeed);
    expect((await textarea.inputValue()).trim().length).toBeGreaterThan(0);
    await expect(page.getByTestId("web-search-mode-chip")).toHaveCount(0);
  });

  test("the gallery never takes the textarea's row, at 320px and at 200% text", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await enableStarterFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);
    await setRootFontSize(page, 32);

    await expect(gallery(page)).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Every rectangle is read in ONE evaluate, so they all describe the same
    // frame at the same scroll offset.
    //
    // The first version of this test measured the composer, then called
    // `scrollIntoViewIfNeeded` on each card and measured that -- comparing
    // viewport coordinates taken at different scroll positions, which reported
    // an overlap that does not exist. Scrolling is not needed to read layout:
    // an element below the fold still has a box.
    const geometry = await page.evaluate(() => {
      const rect = (node: Element) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const composer = document.querySelector('[data-testid="chat-textarea"]');
      return {
        composer: composer ? rect(composer) : null,
        cards: Array.from(
          document.querySelectorAll('[data-testid="chat-starter-card"]')
        ).map(rect),
      };
    });

    expect(geometry.composer).not.toBeNull();
    expect(geometry.cards.length).toBeGreaterThan(0);
    const composerBox = geometry.composer!;

    geometry.cards.forEach((box, index) => {
      // Inside the viewport horizontally: nothing here may push the page wide.
      expect(box.x, `card ${index} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
      expect(
        box.x + box.width,
        `card ${index} runs past the right edge`
      ).toBeLessThanOrEqual(321);
      // 44px touch target, which has to survive text scaling rather than be
      // squeezed by it.
      expect(box.height, `card ${index} is under the touch target`).toBeGreaterThanOrEqual(44);
      // And it may not sit on the textarea's row. Overlap is a rectangle
      // intersection, not a y comparison: the composer contract forbids
      // sharing the row, floating above it and overlapping it alike.
      const overlaps =
        box.x < composerBox.x + composerBox.width &&
        box.x + box.width > composerBox.x &&
        box.y < composerBox.y + composerBox.height &&
        box.y + box.height > composerBox.y;
      expect(overlaps, `card ${index} overlaps the composer`).toBe(false);
    });
  });

  test("the image card is locked for a Free account rather than hidden", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // Locked and hidden are different answers, and this is the one the
    // image-generation contract cares about: a feature the account could buy
    // must not be invisible to it.
    await enableStarterFlag(page);
    await enableImageFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Free" });
    await openWelcome(page);

    const imageCard = page.locator('[data-starter-id="compare-image-models"]');
    await expect(imageCard).toBeVisible();
    await expect(imageCard).toHaveAttribute("data-starter-state", "locked");
    await expect(imageCard.getByTestId("chat-starter-lock")).toBeVisible();
  });

  test("the image card refuses typed work like every other card", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // Cross review round 0, 2026-09-15: the studio branch returned before the
    // ownership test, so this card was the one card that could take over a
    // composer holding somebody's own sentence -- and carry them into another
    // workspace while doing it. The product a seed lands in is decided after
    // ownership, never before.
    await enableStarterFlag(page);
    await enableImageFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("my own half finished question");

    const imageCard = page.locator('[data-starter-id="compare-image-models"]');
    await expect(imageCard).toHaveAttribute("data-starter-state", "available");
    await imageCard.click();

    // The sentence is untouched and the chat is still the screen they are on:
    // a refused seed changes nothing, including where they are.
    await expect(textarea).toHaveValue("my own half finished question");
    await expect(page.getByTestId("image-generation-prompt")).toHaveCount(0);
  });

  test("the image card puts back the search a previous card armed", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // The same 9-credits-instead-of-1 defect staging found, on the path the
    // staging fix missed: sourced-answer arms search, the image card replaces
    // that seed, and the toggle has to come back with the sentence it came in
    // with.
    await enableStarterFlag(page);
    await enableImageFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro" });
    await openWelcome(page);

    await page.locator('[data-starter-id="sourced-answer"]').click();
    await expect(page.getByTestId("web-search-mode-chip")).toBeVisible();

    // The image workspace opened with the card's own sentence.
    await page.locator('[data-starter-id="compare-image-models"]').click();
    const imagePrompt = page.getByTestId("image-generation-prompt");
    await expect(imagePrompt).toBeVisible();
    expect((await imagePrompt.inputValue()).trim().length).toBeGreaterThan(0);

    // The toggle is asked about back in the chat, never from the image
    // workspace: over there the composer does not exist, so an absent chip
    // would say nothing about whether search was disarmed. Asserted from the
    // image side, this test passed against the very defect it is here to
    // catch.
    await page.getByTestId("image-generation-cancel-draft").click();
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expect(page.getByTestId("web-search-mode-chip")).toHaveCount(0);

    // And the chat composer kept nothing: the sourced card's seed was
    // withdrawn with its toggle, so what comes back is an empty box rather
    // than either card's sentence.
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
  });

  test("with the image flag off the image card is absent, not locked", { tag: "@ui-risk" }, async ({
    page,
  }) => {
    // Nothing is behind that lock in this deployment, so offering one would be
    // a sales promise the build cannot keep.
    await enableStarterFlag(page);
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Free" });
    await openWelcome(page);

    await expect(gallery(page)).toBeVisible();
    await expect(
      page.locator('[data-starter-id="compare-image-models"]')
    ).toHaveCount(0);
  });
});
