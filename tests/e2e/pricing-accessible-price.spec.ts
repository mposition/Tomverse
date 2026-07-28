import { expect, test, type Page } from "@playwright/test";
import { mockPublicBillingConfig } from "./support/app-fixtures";

// UX-F007. The price and its billing period render as sibling spans so they
// can carry different type sizes. JSX drops the whitespace between sibling
// elements, so the pair had no text node between it, and assistive tech read
// the plan price as "$15per month" -- the visible gap came only from a CSS
// margin, which no text-based reading of the page can see.
//
// The spoken phrase is now supplied once via an sr-only node, and the visual
// pair is marked aria-hidden so nothing is announced twice.
//
// These assertions deliberately do NOT use innerText: innerText reflects
// rendered layout (and would show the CSS gap as whitespace), which is
// exactly what hid this defect. They read the page's text with aria-hidden
// subtrees removed -- the text a screen reader is actually offered.

/** Page text with aria-hidden subtrees removed, i.e. what is exposed to AT. */
function exposedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    // script/style carry no exposed text (the page embeds JSON-LD, which
    // contains prose of its own and would otherwise pollute these counts).
    clone
      .querySelectorAll('script, style, [aria-hidden="true"]')
      .forEach((node) => node.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ");
  });
}

test.describe("pricing price/period accessible text", () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicBillingConfig(page);
    await page.goto("/pricing?lang=en");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("a plan price reads as a phrase, never run into its period", async ({
    page,
  }) => {
    const text = await exposedText(page);

    expect(
      text,
      `a price ran straight into its period: ${text.slice(0, 500)}`
    ).not.toMatch(/\dper month/);

    expect(
      /\$\s?\d[\d.,]*\s+per month/.test(text),
      `expected a "<price> per month" phrase, saw: ${text.slice(0, 500)}`
    ).toBe(true);
  });

  test("each plan exposes its price phrase exactly once", async ({ page }) => {
    const text = await exposedText(page);

    const phrases = text.match(/\$\s?\d[\d.,]*\s+per month/g) ?? [];

    // One per plan card. If the visual split spans were still exposed, the
    // same plan would surface its price twice -- once as the spoken phrase
    // and once as the run-on pair.
    expect(
      phrases.length,
      `expected one price phrase per plan, saw ${JSON.stringify(phrases)}`
    ).toBe(3);

    for (const phrase of phrases) {
      const occurrences = phrases.filter((other) => other === phrase).length;
      expect(occurrences, `"${phrase}" is exposed ${occurrences} times`).toBe(1);
    }
  });
});
