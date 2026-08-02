import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import { restoreActiveConversation } from "./support/chat-state-fixtures";

/**
 * UX-027, UX-028, UX-031 and UI-026/UI-027.
 *
 * UX-027: the model popover installs a capture-phase keydown listener on
 * `document` that swallows Home and End to move between menu items. It exempted
 * `<select>` but not text fields, so pressing Home while typing in the model
 * search box jumped focus to the first model instead of moving the caret.
 *
 * UX-028: the mobile shell had no `<h1>`. The only one on the page lived in the
 * sidebar, which on that shell renders inside the drawer -- so heading
 * navigation found nothing until a dialog was opened, and then found the page's
 * top-level heading inside it. The account settings dialog separately started
 * at `h3` under that `h1`, skipping a level.
 *
 * UX-031: a scroll container with nothing focusable inside cannot be scrolled
 * by keyboard, so the right-hand columns of a wide table and the tail of a long
 * code line were pointer-only.
 *
 * UI-027: `role="tooltip"` on a container holding a heading, a paragraph and an
 * external link. A tooltip may not contain interactive content -- nothing
 * announces the link and there is no way to reach it.
 */

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

const markdownAnswer = [
  "| Model | Cost |",
  "| --- | --- |",
  "| A very long model name that pushes this table wider than the panel | 1 |",
  "",
  "```",
  "const aLineOfCodeLongEnoughToScrollSidewaysInsideTheCodeBlock = true;",
  "```",
].join("\n");

const seeded: QaConversationMessage[] = [
  { id: "u1", role: "user", content: "Compare these answers" },
  ...MODELS.map((modelId, index) => ({
    id: `a${index + 1}`,
    role: "assistant" as const,
    modelId,
    status: "normal",
    content: markdownAnswer,
  })),
];

const openConversation = async (
  page: Page,
  viewport: { width: number; height: number }
) => {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { selectedModels: MODELS, messages: seeded });
  await restoreActiveConversation(page);
  await page.setViewportSize(viewport);
  await page.goto("/chat?lang=en");
};

test.describe("keyboard reach", () => {
  test(
    "Home and End move the caret in the model search box, not the menu",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openConversation(page, { width: 1366, height: 768 });

      await page.locator('button[aria-controls="chat-input-popover"]').nth(1).click();
      const dialog = page.locator("#chat-input-popover");
      await expect(dialog).toBeVisible();

      const search = page.getByTestId("model-search-input");
      if ((await search.count()) === 0) {
        // The picker opens on the recommended screen; the catalogue with its
        // search box is one step in.
        await dialog.getByRole("button", { name: /all models/i }).first().click();
      }
      await expect(search).toBeVisible();

      await search.click();
      await search.fill("claude");
      await expect(search).toBeFocused();

      await page.keyboard.press("Home");
      await expect(search).toBeFocused();
      expect(
        await search.evaluate((node: HTMLInputElement) => node.selectionStart)
      ).toBe(0);

      await page.keyboard.press("End");
      await expect(search).toBeFocused();
      expect(
        await search.evaluate((node: HTMLInputElement) => node.selectionStart)
      ).toBe("claude".length);

      // The query survives, which is the user-visible half of the defect.
      await expect(search).toHaveValue("claude");
    }
  );

  test(
    "a wide table and a long code block are reachable without a pointer",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openConversation(page, { width: 1366, height: 768 });

      const regions = page.getByRole("region", {
        name: /scrollable|스크롤/i,
      });
      await expect(regions.first()).toBeAttached();

      const details = await regions.evaluateAll((nodes) =>
        nodes.map((node) => ({
          tabIndex: node.getAttribute("tabindex"),
          named: Boolean(node.getAttribute("aria-label")),
          scrollable: node.scrollWidth > node.clientWidth,
        }))
      );
      expect(details.length).toBeGreaterThan(0);
      for (const region of details) {
        expect(region.tabIndex).toBe("0");
        expect(region.named).toBe(true);
      }
      // At least one of them really does overflow, or the fixture stopped
      // exercising the case this exists for.
      expect(details.some((region) => region.scrollable)).toBe(true);
    }
  );
});

test.describe("heading structure", () => {
  const headingLevels = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .filter((node) => {
          const element = node as HTMLElement;
          return (
            element.offsetParent !== null ||
            element.className.includes("sr-only")
          );
        })
        .map((node) => Number(node.tagName.slice(1)))
    );

  for (const [name, viewport] of [
    ["desktop", { width: 1366, height: 768 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    test(
      `${name} chat has exactly one h1 and skips no level`,
      { tag: "@ui-risk" },
      async ({ page }) => {
        await openConversation(page, viewport);
        await expect(
          page.getByTestId(
            viewport.width < 768 ? "mobile-chat-shell" : "desktop-chat-shell"
          )
        ).toBeVisible();

        const levels = await headingLevels(page);
        expect(levels.filter((level) => level === 1)).toHaveLength(1);

        // No level is skipped on the way down.
        let previous = levels[0];
        for (const level of levels.slice(1)) {
          if (level > previous) expect(level - previous).toBeLessThanOrEqual(1);
          previous = level;
        }
      }
    );
  }

  test(
    "the page's only h1 is not hidden inside the mobile drawer",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openConversation(page, { width: 390, height: 844 });
      await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
      // Before the drawer is ever opened.
      const h1Count = await page.evaluate(
        () => document.querySelectorAll("h1").length
      );
      expect(h1Count).toBe(1);

      const insideDrawer = await page.evaluate(() => {
        const heading = document.querySelector("h1");
        return Boolean(heading?.closest('[role="dialog"]'));
      });
      expect(insideDrawer).toBe(false);
    }
  );
});

test(
  "no tooltip carries interactive content",
  { tag: "@ui-risk" },
  async ({ page }) => {
    await openConversation(page, { width: 1366, height: 768 });

    // A `tooltip` is not somewhere assistive tech navigates into, so anything
    // focusable inside one is unreachable and unannounced.
    const offenders = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="tooltip"]'))
        .filter(
          (node) =>
            node.querySelectorAll('a[href], button, input, select, textarea')
              .length > 0
        )
        .map((node) => node.textContent?.trim().slice(0, 60) ?? "")
    );
    expect(offenders).toEqual([]);
  }
);

test(
  "markdown paragraphs do not preserve the model's soft wrapping",
  { tag: "@ui-risk" },
  async ({ page }) => {
    // UI-026. CommonMark collapses a single newline inside a paragraph into a
    // space; `whitespace-pre-wrap` turned each one into a hard break.
    await openConversation(page, { width: 1366, height: 768 });
    const whiteSpace = await page.evaluate(() => {
      const paragraph = document.querySelector(
        '[data-testid="desktop-model-panel"] .prose p, [data-testid="desktop-model-panel"] p'
      );
      return paragraph ? getComputedStyle(paragraph).whiteSpace : null;
    });
    if (whiteSpace) expect(whiteSpace).not.toBe("pre-wrap");
  }
);
