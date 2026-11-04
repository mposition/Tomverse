import { test, expect } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { en } from "../../locales/en";

/**
 * WCAG 1.4.10 (Reflow) and 2.1.1 (Keyboard) on `/privacy`.
 *
 * The provider destination table is 720px wide by design and sits inside its
 * own horizontal scroller. That scroller was a grid item's descendant, and a
 * grid item's automatic minimum size is its min-content width -- so the 720px
 * took the whole "External AI providers" section with it: the transfer
 * paragraph and the seven-item list stopped wrapping at the viewport and were
 * cut off at 320px, while every other section wrapped.
 *
 * Two independent things are measured, each able to fail on its own:
 *
 * 1. the document does not scroll sideways, and every paragraph and list item
 *    of the providers section ends inside the viewport;
 * 2. the table is still wide and still reachable -- its scroller overflows,
 *    carries an accessible name and is focusable, so a keyboard-only reader
 *    can reach the columns past "Storage".
 */

const NARROW = { width: 320, height: 568 } as const;

test.use({ viewport: NARROW });

test("the provider section wraps at 320px while its table scrolls", {
    tag: "@ui-risk",
}, async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.setViewportSize(NARROW);
    await page.goto("/privacy?lang=en");

    const providersHeading = page.getByRole("heading", {
        name: en.privacyPolicy.providersTitle,
    });
    await expect(providersHeading).toBeVisible();

    const scroller = page.getByRole("region", {
        name: en.privacyPolicy.providerTableTitle,
    });
    await expect(scroller).toBeVisible();
    // The wide table is the point of the scroller; a non-overflowing one would
    // mean the table stopped being wide and this guard stopped guarding.
    const scrollerOverflow = await scroller.evaluate(
        (node) => node.scrollWidth - node.clientWidth
    );
    expect(scrollerOverflow).toBeGreaterThan(0);
    await expect(scroller).toHaveAttribute("tabindex", "0");

    // The visible indicator: a reader who cannot see a scrollbar still needs
    // to be told the remaining columns are sideways.
    await expect(
        page.getByText(en.privacyPolicy.providerTableScrollHint)
    ).toBeVisible();

    const measurement = await page.evaluate(() => {
        const doc = document.documentElement;
        const section = Array.from(document.querySelectorAll("section")).find(
            (candidate) =>
                candidate.querySelector("table, [role='region']") !== null &&
                candidate.querySelector("h2") !== null
        );
        const prose = section
            ? Array.from(section.querySelectorAll("p, li, h2, h3"))
            : [];
        let widest = 0;
        let offender: string | null = null;
        for (const element of prose) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.right <= widest) continue;
            widest = rect.right;
            offender = (element.textContent ?? "").slice(0, 60);
        }
        return {
            documentOverflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth),
            clientWidth: doc.clientWidth,
            proseCount: prose.length,
            widestProseRight: Math.round(widest),
            offender,
        };
    });

    // A section with no prose would pass the width assertion vacuously.
    expect(measurement.proseCount).toBeGreaterThan(5);
    expect(
        measurement.documentOverflowPx,
        `the privacy page scrolls sideways: ${JSON.stringify(measurement)}`
    ).toBeLessThanOrEqual(1);
    expect(
        measurement.widestProseRight,
        `providers-section text runs off screen: ${JSON.stringify(measurement)}`
    ).toBeLessThanOrEqual(measurement.clientWidth + 1);
});
