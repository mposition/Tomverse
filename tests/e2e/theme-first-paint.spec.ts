import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * UI-001. The theme applied by the *first paint* must already be the one the
 * visitor ends up with.
 *
 * Before this, `.dark` could only be written by React, so every document
 * painted light and snapped to the user's theme after hydration. Two halves fix
 * it, and they are tested separately because they fail separately:
 *
 *  - `app/globals.css` answers "no explicit choice" from `prefers-color-scheme`
 *    with no script at all. This is what a `force-static`, publicly cached
 *    marketing page can honour, since it depends on nothing per-visitor.
 *  - `components/ThemeBootstrap.tsx` answers the one case CSS cannot: an
 *    explicit choice that contradicts the OS. It runs during HTML parsing,
 *    before the first paint.
 *
 * The assertions below compare the theme at the earliest moment the document
 * could have been painted -- captured by an init script, see
 * captureFromFirstPaint -- with the theme after hydration. Equal means no
 * flash. Asserting only the final state would pass on the very build this spec
 * exists to fail.
 */

const THEME_COOKIE = "tomverse_theme";
const LEGACY_STORAGE_KEY = "tomverse_theme_preference";

type ThemeSample = {
  className: string;
  dataTheme: string | null;
  backgroundColor: string;
  colorScheme: string;
};

type ThemeObservation = {
  firstPaint: ThemeSample | null;
  /** The same read taken at `DOMContentLoaded`, for diagnosis only. */
  domContentLoaded: ThemeSample | null;
  /** How many stylesheets the sample had to wait for, if any. */
  deferredForStylesheets: number | null;
  hydrated: ThemeSample;
  consoleErrors: string[];
  cspViolations: string[];
};

/**
 * Records the document's theme at the earliest moment the browser could have
 * painted it: the end of parsing, or -- if the render-blocking stylesheets have
 * not been applied by then -- the moment they are.
 *
 * The sample used to be taken at `DOMContentLoaded` alone, and that is not the
 * same moment in every engine: `DOMContentLoaded` does not wait for
 * stylesheets, and only *painting* does. Waiting for a pending one therefore
 * skips past nothing -- a render-blocking sheet is exactly what stops a first
 * paint -- so the wait below is kept as the correct place to start looking.
 *
 * It was not, however, what mobile WebKit was doing: the run that prompted this
 * reported no pending sheets at all and still read `rgba(0, 0, 0, 0)` from
 * `document.body`. Where that leaves the comparison is explained at
 * expectNoFlash, which is where it is acted on.
 */
async function captureFromFirstPaint(page: Page) {
  await page.addInitScript(() => {
    const read = () => {
      const root = document.documentElement;
      return {
        className: root.className,
        dataTheme: root.dataset.theme ?? null,
        // `--background` is applied to <body>, not <html> (app/globals.css),
        // so the painted colour has to be read there.
        backgroundColor: document.body
          ? getComputedStyle(document.body).backgroundColor
          : "",
        colorScheme: getComputedStyle(root).colorScheme,
      };
    };
    const store = (key: string, value: unknown) => {
      (window as unknown as Record<string, unknown>)[key] = value;
    };
    const record = () => {
      store("__firstPaintTheme", read());
    };
    const recordWhenPaintable = () => {
      // Kept as evidence rather than asserted on: when the two samples differ,
      // this one says the engine reached the end of parsing before its own
      // stylesheets, which is the difference that made this spec engine-
      // dependent in the first place.
      store("__domContentLoadedTheme", read());
      // `link.sheet` is null until the stylesheet has loaded *and* been applied
      // to the document, which is the property being waited on.
      const pending = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
      ).filter((link) => !link.sheet);
      if (pending.length === 0) {
        record();
        return;
      }
      store("__deferredForStylesheets", pending.length);
      let remaining = pending.length;
      for (const link of pending) {
        const settle = () => {
          remaining -= 1;
          if (remaining === 0) record();
        };
        link.addEventListener("load", settle, { once: true });
        // An error is not a reason to hold the sample back: the sheet will
        // never apply, so this is the state the document paints in.
        link.addEventListener("error", settle, { once: true });
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", recordWhenPaintable, {
        once: true,
      });
    } else {
      recordWhenPaintable();
    }
  });
}

async function observe(page: Page, path: string): Promise<ThemeObservation> {
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    // React reports a server/client mismatch as a hydration error. The theme
    // classes are under `suppressHydrationWarning`, so any that appears here is
    // a real one.
    if (/hydrat/i.test(text)) consoleErrors.push(text);
    if (/Content Security Policy|Refused to execute/i.test(text)) {
      cspViolations.push(text);
    }
  });

  await page.goto(path);
  await page.waitForLoadState("networkidle");

  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const stored = window as unknown as Record<string, unknown>;
    return {
      firstPaint: (stored.__firstPaintTheme as ThemeSample | undefined) ?? null,
      domContentLoaded:
        (stored.__domContentLoadedTheme as ThemeSample | undefined) ?? null,
      deferredForStylesheets:
        (stored.__deferredForStylesheets as number | undefined) ?? null,
      hydrated: {
        className: root.className,
        dataTheme: root.dataset.theme ?? null,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        colorScheme: getComputedStyle(root).colorScheme,
      },
    };
  });

  return { ...result, consoleErrors, cspViolations };
}

/**
 * Nothing about the theme changed between the first paint and hydration.
 *
 * The comparison is over the three things that *decide* the painted colour --
 * the explicit class, the `data-theme` it is mirrored in, and the resolved
 * `color-scheme` -- and then over the colour itself. That order matters,
 * because a colour is only evidence of a theme while it is one of the theme's
 * colours.
 *
 * Mobile WebKit reads `rgba(0, 0, 0, 0)` for `document.body` on the static
 * marketing documents at this moment, while reading `:root` correctly at the
 * same instant: the `/ko` case observes `color-scheme: dark`, which only the
 * stylesheet's `prefers-color-scheme` rule can have produced, so the sheet is
 * applied and the root is styled. Transparent is not a theme -- neither theme
 * paints it, the value was identical in cases whose expected colours were
 * opposite, and every theme signal in those same samples was already the final
 * one. The engine had not resolved `body` yet; it had painted nothing yet.
 *
 * So a transparent reading is treated as a colour this engine could not report
 * rather than as a flash, and it is recorded on the test instead of being
 * dropped in silence. What is not relaxed: the theme signals above are compared
 * on every engine, and each test still asserts the *hydrated* colour is the one
 * its theme requires. Removing the pre-paint bootstrap flips class, data-theme
 * and color-scheme all at once, so the regression this spec exists for still
 * fails everywhere.
 */
const UNPAINTED = "rgba(0, 0, 0, 0)";

/**
 * What the painted colour is decided by, and nothing else.
 *
 * `data-theme` is deliberately not part of it. It records the *choice*, not the
 * paint: a visitor with no explicit choice paints from `prefers-color-scheme`
 * with no attribute at all, and hydration then writes `data-theme="system"`
 * without changing a pixel. Comparing it would report that as a flash.
 */
const themeIdentity = (sample: ThemeSample) => ({
  dark: /(?:^|\s)dark(?:\s|$)/.test(sample.className),
  light: /(?:^|\s)light(?:\s|$)/.test(sample.className),
  colorScheme: sample.colorScheme,
});

function expectNoFlash(observation: ThemeObservation, label: string) {
  expect(observation.firstPaint, `${label}: first-paint sample missing`).not.toBeNull();
  // A failure here is read by someone who cannot reproduce it: WebKit is only
  // installed by one workflow. Both samples and the sheets waited for are
  // carried along so the next reader can tell a theme that flashed from an
  // engine that had not painted yet.
  const evidence = [
    `first paint ${JSON.stringify(observation.firstPaint)}`,
    `at DOMContentLoaded ${JSON.stringify(observation.domContentLoaded)}`,
    `stylesheets pending then: ${observation.deferredForStylesheets ?? 0}`,
  ].join("; ");
  expect(
    themeIdentity(observation.firstPaint!),
    `${label}: the theme changed after hydration (this is the flash) -- ${evidence}`
  ).toEqual(themeIdentity(observation.hydrated));
  if (observation.firstPaint!.backgroundColor === UNPAINTED) {
    test.info().annotations.push({
      type: "engine-could-not-report-a-painted-colour",
      description: `${label} -- ${evidence}`,
    });
  } else {
    expect(
      observation.firstPaint!.backgroundColor,
      `${label}: background changed after hydration (this is the flash) -- ${evidence}`
    ).toBe(observation.hydrated.backgroundColor);
  }
  expect(observation.consoleErrors, `${label}: hydration errors`).toEqual([]);
  expect(observation.cspViolations, `${label}: CSP violations`).toEqual([]);
}

const DARK_BACKGROUND = "rgb(10, 10, 10)";
const LIGHT_BACKGROUND = "rgb(255, 255, 255)";

test.describe("theme is correct on the first paint", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await captureFromFirstPaint(page);
  });

  // The half CSS answers on its own: no cookie, no stored value, so the OS
  // decides and a statically cached page is still correct.
  for (const colorScheme of ["light", "dark"] as const) {
    for (const path of ["/about", "/chat"]) {
      test(`no explicit choice follows the OS (${colorScheme}, ${path})`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme });
        const observation = await observe(page, path);
        const label = `system/${colorScheme}${path}`;

        expectNoFlash(observation, label);
        expect(observation.hydrated.backgroundColor, label).toBe(
          colorScheme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND
        );
      });
    }
  }

  // The half only the bootstrap can answer: the choice contradicts the OS, and
  // on /about the HTML is prerendered and cached with no theme in it at all.
  for (const [choice, colorScheme, expected] of [
    ["light", "dark", LIGHT_BACKGROUND],
    ["dark", "light", DARK_BACKGROUND],
  ] as const) {
    for (const path of ["/about", "/chat"]) {
      test(`an explicit ${choice} choice overrides an OS set to ${colorScheme} (${path})`, async ({
        page,
        context,
      }) => {
        await context.addCookies([
          { name: THEME_COOKIE, value: choice, url: "http://127.0.0.1:3100" },
        ]);
        await page.emulateMedia({ colorScheme });
        const observation = await observe(page, path);
        const label = `${choice}/os-${colorScheme}${path}`;

        expectNoFlash(observation, label);
        expect(observation.hydrated.backgroundColor, label).toBe(expected);
        expect(observation.hydrated.className, `${label}: class`).toContain(choice);
      });
    }
  }

  test("a cached marketing page carries no visitor theme in its HTML", async ({
    page,
  }) => {
    // The cache-poisoning guard: whatever this visitor's cookie says, the
    // prerendered document must not have been rendered with it, or the next
    // visitor behind the same cache entry inherits it.
    const response = await page.request.get("/about", {
      headers: { Cookie: `${THEME_COOKIE}=dark` },
    });
    const html = await response.text();
    const openingTag = /<html[^>]*>/.exec(html)?.[0] ?? "";
    expect(openingTag, "static marketing HTML must not carry a theme class").not.toMatch(
      /\b(dark|light)\b/
    );
    expect(openingTag, "nor a data-theme").not.toContain("data-theme");
    // ... while still shipping the script that corrects it client-side.
    expect(html).toContain(THEME_COOKIE);
  });

  test("a pre-cookie choice is migrated and then served from the cookie", async ({
    page,
    context,
  }) => {
    // Everyone who picked a theme before the cookie existed has it only in
    // localStorage. It must still apply on the first paint, and must be
    // promoted so the *server* can honour it next time.
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "dark");
    }, LEGACY_STORAGE_KEY);
    await page.emulateMedia({ colorScheme: "light" });

    const observation = await observe(page, "/chat");
    expectNoFlash(observation, "migration");
    expect(observation.hydrated.backgroundColor).toBe(DARK_BACKGROUND);

    const cookies = await context.cookies();
    expect(
      cookies.find((cookie) => cookie.name === THEME_COOKIE)?.value,
      "the stored choice must be promoted to the cookie"
    ).toBe("dark");
  });

  test("the cookie wins when the two stores disagree", async ({ page, context }) => {
    // A stale localStorage value must never override the cookie, or the theme
    // the server rendered from would be replaced after hydration.
    await context.addCookies([
      { name: THEME_COOKIE, value: "light", url: "http://127.0.0.1:3100" },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "dark");
    }, LEGACY_STORAGE_KEY);
    await page.emulateMedia({ colorScheme: "dark" });

    const observation = await observe(page, "/chat");
    expectNoFlash(observation, "cookie vs storage");
    expect(observation.hydrated.backgroundColor).toBe(LIGHT_BACKGROUND);
  });

  test("a localized marketing route is themed like the English one", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const observation = await observe(page, "/ko");
    expectNoFlash(observation, "localized marketing");
    expect(observation.hydrated.backgroundColor).toBe(DARK_BACKGROUND);
  });

  test("a soft navigation keeps the theme it arrived with", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: THEME_COOKIE, value: "dark", url: "http://127.0.0.1:3100" },
    ]);
    await page.emulateMedia({ colorScheme: "light" });
    await observe(page, "/about");

    const before = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    // Below `lg` the marketing header collapses its nav behind a menu button
    // (`MarketingChrome`'s `hidden … lg:flex`), so on a narrow project the link
    // has to be revealed before it can be clicked. Same page, same soft
    // navigation -- only the affordance that reaches it differs.
    const menu = page.getByRole("button", { name: /^(Menu|메뉴|菜单)$/ });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole("link", { name: /pricing/i }).first().click();
    await page.waitForLoadState("networkidle");
    const after = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );

    // The bootstrap is inert on a client navigation by design; the theme has to
    // survive on the class already applied rather than be re-applied.
    expect(after, "theme changed across a soft navigation").toBe(before);
    expect(after).toBe(DARK_BACKGROUND);
  });
});
