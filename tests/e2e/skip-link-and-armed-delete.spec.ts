import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * UX-016 and UX-018.
 *
 * UX-016: there was no skip link anywhere. WCAG 2.4.1 is Level A, and on
 * `/chat` with a populated sidebar it was roughly thirty tab stops to the
 * composer on every load.
 *
 * UX-018: the project delete button armed on first press and never disarmed.
 * The only signals were a background colour and a toast that self-dismisses at
 * 3.2s, while the accessible name stayed "Delete project" in both states -- so
 * a screen-reader user heard the same thing before and after arming and
 * destroyed the project on the second press.
 */

const firstTabLandsOnSkipLink = async (page: Page) => {
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null
  );
  expect(focused).toBe("skip-to-content");
};

test.describe("skip link", () => {
  for (const route of ["/", "/pricing", "/chat", "/auth/signin", "/ko"]) {
    test(
      `${route} exposes a skip link as the first tab stop`,
      { tag: "@ui-risk" },
      async ({ page }) => {
        await prepareGuestPage(page, "en");
        await page.goto(route);
        await firstTabLandsOnSkipLink(page);

        const link = page.getByTestId("skip-to-content");
        // Hidden until focused, then genuinely on screen.
        const box = await link.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThan(1);
        expect(box!.height).toBeGreaterThan(1);

        // The target exists and is focusable.
        await link.press("Enter");
        const target = await page.evaluate(() => {
          const element = document.getElementById("main-content");
          return {
            exists: Boolean(element),
            focusable: element?.getAttribute("tabindex") === "-1",
          };
        });
        expect(target.exists).toBe(true);
        expect(target.focusable).toBe(true);
      }
    );
  }

  test(
    "the skip target adds no second main landmark",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await prepareGuestPage(page, "en");
      await page.goto("/pricing");
      // The wrapper is a display:contents div, so the page keeps exactly the
      // landmarks it declared for itself.
      const mainCount = await page.evaluate(
        () => document.querySelectorAll("main").length
      );
      expect(mainCount).toBeLessThanOrEqual(1);

      const wrapperIsMain = await page.evaluate(
        () => document.getElementById("main-content")?.tagName.toLowerCase()
      );
      expect(wrapperIsMain).toBe("div");
    }
  );

  test(
    "the skip link is localized",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.goto("/ko");
      await expect(page.getByTestId("skip-to-content")).toHaveText(
        "본문으로 건너뛰기"
      );
    }
  );
});

test.describe("project delete arming", () => {
  const openProjects = async (page: Page) => {
    await mockAuthenticatedApi(page);
    // The shared fixture returns no projects, and the control under test only
    // exists on a project row.
    await page.unroute("**/api/projects**");
    await page.route("**/api/projects**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [{ id: "project-1", name: "Quarterly review" }],
        }),
      })
    );

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/chat?lang=en");
    const organizer = page.getByTestId("sidebar-organizer-toggle");
    if ((await organizer.getAttribute("aria-expanded")) !== "true") {
      await organizer.click();
    }
    await expect(page.getByTestId("sidebar-projects")).toBeVisible();
  };

  test(
    "arming renames the control and reports its pressed state",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openProjects(page);

      const deleteButton = page
        .getByRole("button", { name: /delete project/i })
        .first();
      await expect(deleteButton).toHaveCount(1);

      await expect(deleteButton).toHaveAttribute("aria-pressed", "false");
      await deleteButton.click();

      // The name has to change, or arming is inaudible.
      const armed = page.getByRole("button", { name: /confirm deletion of/i });
      await expect(armed).toHaveCount(1);
      await expect(armed).toHaveAttribute("aria-pressed", "true");
    }
  );

  test(
    "an armed control disarms itself instead of staying primed",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openProjects(page);

      const deleteButton = page
        .getByRole("button", { name: /delete project/i })
        .first();
      await expect(deleteButton).toHaveCount(1);
      await deleteButton.click();
      await expect(
        page.getByRole("button", { name: /confirm deletion of/i })
      ).toHaveCount(1);

      // Disarms just after the confirming toast goes, rather than staying
      // primed until the next click minutes later.
      await expect(
        page.getByRole("button", { name: /confirm deletion of/i })
      ).toHaveCount(0, { timeout: 10_000 });
      await expect(
        page.getByRole("button", { name: /delete project/i }).first()
      ).toHaveAttribute("aria-pressed", "false");
    }
  );

  test(
    "Escape disarms without deleting",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openProjects(page);

      const deleteButton = page
        .getByRole("button", { name: /delete project/i })
        .first();
      await expect(deleteButton).toHaveCount(1);
      await deleteButton.click();
      await expect(
        page.getByRole("button", { name: /confirm deletion of/i })
      ).toHaveCount(1);

      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: /confirm deletion of/i })
      ).toHaveCount(0);
      // The project itself is untouched.
      await expect(
        page.getByRole("button", { name: /delete project/i })
      ).not.toHaveCount(0);
    }
  );
});

test(
  "admin search and privacy inputs carry a real accessible name",
  { tag: "@ui-risk" },
  async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/chat");

    // The sweep below is only meaningful once the fields it sweeps exist. An
    // earlier version ran straight after `goto` and passed against a page that
    // had not rendered the sidebar search or the per-panel follow-up fields --
    // it was green locally and found four unnamed fields the moment CI was
    // slightly slower. Wait for the last thing to mount, then assert the page
    // really is populated before trusting a count of zero.
    await expect(page.getByTestId("model-only-input").first()).toBeAttached();
    await expect(page.getByTestId("chat-textarea")).toBeAttached();

    const fields = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea"
        )
      ).map((field) => ({
        named: Boolean(
          field.getAttribute("aria-label") ||
            field.getAttribute("aria-labelledby") ||
            (field.labels && field.labels.length > 0)
        ),
        placeholder: field.getAttribute("placeholder"),
        testId: field.getAttribute("data-testid"),
        type: (field as HTMLInputElement).type,
      }))
    );
    expect(fields.length).toBeGreaterThanOrEqual(4);

    // UX-021's rule: no text field in the rendered app may rely on its
    // placeholder as its only name. A placeholder is announced inconsistently
    // and disappears as soon as the field has a value.
    const unnamed = fields.filter(
      (field) => !field.named && Boolean(field.placeholder)
    );
    expect(
      unnamed,
      `placeholder-only fields: ${JSON.stringify(unnamed)}`
    ).toEqual([]);
  }
);

test(
  "each model panel's follow-up field names its own model",
  { tag: "@ui-risk" },
  async ({ page }) => {
    // Three panels render three of these. A name that does not say *which*
    // model is the same as no name at all for anyone moving between form
    // fields, so the count of distinct names has to match the count of fields.
    await prepareGuestPage(page, "en");
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/chat");

    const inputs = page.getByTestId("model-only-input");
    await expect(inputs.first()).toBeAttached();
    const count = await inputs.count();
    expect(count).toBeGreaterThan(1);

    const names = await inputs.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") || "")
    );
    expect(names.every((name) => name.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(count);
  }
);
