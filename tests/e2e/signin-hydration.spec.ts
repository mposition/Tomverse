import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * VAL-003. The Insight UI audit could not confirm or rule out a sign-in
 * hydration defect: legal copy that may change, duplicate or flash between the
 * server-rendered HTML and the hydrated DOM. Neither re-audit reproduced it,
 * and "we did not see it" is not the same finding as "it does not happen" --
 * so the check is written down rather than dropped.
 *
 * Each case renders the same page twice: once with JavaScript disabled, which
 * is exactly the server-rendered markup, and once hydrated.
 *
 * Result of running it (see .github/audits/ui-insight-followup.md):
 *
 * - No React hydration error is logged in any locale or theme.
 * - The card's structure is identical before and after hydration: same
 *   headings, same labels, same legal destinations, same paragraph count.
 * - `?lang=ko` used to change the visible text on hydration: the server
 *   rendered the English strings and the client swapped them to Korean, so a
 *   Korean visitor briefly read English legal links. Fixed by resolving the
 *   parameter on the server (see app/(site)/(application)/auth/signin/page.tsx); the
 *   Korean case below is the regression test for it.
 *
 * The SHA under test is logged so a run can be tied to a build.
 */

const LANGUAGES = ["ko", "en"] as const;
const THEMES = ["light", "dark"] as const;

const CARD = '[data-testid="signin-card"]';

type CardText = {
  headings: string[];
  labels: string[];
  links: Array<{ text: string; href: string }>;
  paragraphs: string[];
};

async function readCardText(page: Page): Promise<CardText> {
  return page.locator(CARD).evaluate((card) => {
    const collect = (selector: string) =>
      Array.from(card.querySelectorAll(selector))
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    return {
      headings: collect("h1, h2, h3"),
      labels: collect("label"),
      links: Array.from(card.querySelectorAll("a")).map((anchor) => ({
        text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
        href: anchor.getAttribute("href") ?? "",
      })),
      // Every paragraph, so a legal sentence that changes wording, doubles up
      // or disappears on hydration shows as a diff rather than as nothing.
      paragraphs: collect("p"),
    };
  });
}

async function readServerRenderedCard(browser: Browser, lang: string): Promise<CardText> {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`/auth/signin?lang=${lang}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(CARD)).toBeVisible();
    return await readCardText(page);
  } finally {
    await context.close();
  }
}

async function gotoHydratedSignIn(page: Page, lang: string) {
  await page.goto(`/auth/signin?lang=${lang}`);
  await expect(page.locator(CARD)).toBeVisible();
  await expect(page.locator(`${CARD} button`).first()).toBeEnabled();
  await page.waitForLoadState("networkidle");
  return readCardText(page);
}

for (const lang of LANGUAGES) {
  for (const theme of THEMES) {
    test(`sign-in hydration keeps its structure and logs no hydration error (${lang}, ${theme})`, async ({
      page,
      browser,
      baseURL,
    }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

      await page.emulateMedia({ colorScheme: theme });

      const buildInfo = await page.request.get(`${baseURL}/api/build-info`);
      const build = buildInfo.ok() ? await buildInfo.json() : null;
      // Recorded, not asserted: the point is that a result can be traced to a
      // build, not that any particular build is under test.
      console.log(
        `VAL-003 ${lang}/${theme} commit=${build?.commit ?? "unknown"} env=${
          build?.environment ?? "unknown"
        }`
      );

      const serverRendered = await readServerRenderedCard(browser, lang);
      const hydrated = await gotoHydratedSignIn(page, lang);

      expect(hydrated.headings.length, "heading count changed on hydration").toBe(
        serverRendered.headings.length
      );
      expect(hydrated.labels.length, "form label count changed on hydration").toBe(
        serverRendered.labels.length
      );
      expect(
        hydrated.paragraphs.length,
        "a paragraph appeared or disappeared on hydration"
      ).toBe(serverRendered.paragraphs.length);
      expect(
        hydrated.links.map((link) => link.href),
        "legal destinations changed on hydration"
      ).toEqual(serverRendered.links.map((link) => link.href));

      // Each legal document is linked exactly once, whichever pass you read.
      const legalHrefs = hydrated.links
        .map((link) => link.href)
        .filter((href) => href === "/terms" || href === "/privacy");
      expect(legalHrefs.sort()).toEqual(["/privacy", "/terms"]);

      const hydrationErrors = consoleErrors.filter((message) =>
        /hydrat|did not match|Minified React error #4\d\d/i.test(message)
      );
      expect(
        hydrationErrors,
        `React hydration errors on /auth/signin?lang=${lang}:\n${hydrationErrors.join("\n")}`
      ).toEqual([]);
    });
  }
}

test("English sign-in copy is byte-identical before and after hydration", async ({
  page,
  browser,
}) => {
  const serverRendered = await readServerRenderedCard(browser, "en");
  const hydrated = await gotoHydratedSignIn(page, "en");
  expect(hydrated).toEqual(serverRendered);

  // UI-009: one document, one name, on both passes.
  for (const pass of [serverRendered, hydrated]) {
    expect(pass.paragraphs.join(" ")).not.toContain("Terms of Service");
  }
});

// VAL-003, now fixed at the source: `/auth/signin` resolves `?lang=` on the
// server, so the Korean strings are in the first paint instead of arriving a
// tick after hydration. This is the assertion that was `fixme` while the gap
// was open, unchanged.
test("Korean sign-in copy is byte-identical before and after hydration", async ({
  page,
  browser,
}) => {
  const serverRendered = await readServerRenderedCard(browser, "ko");
  const hydrated = await gotoHydratedSignIn(page, "ko");
  expect(hydrated).toEqual(serverRendered);
});
