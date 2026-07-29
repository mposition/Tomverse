import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

type MockStatus = "limited" | "unavailable";

async function mockProviderStatus(page: Page, status: MockStatus) {
  let requestCount = 0;
  await page.route("**/api/models/status", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gemini-2-5-flash",
            provider: "google",
            status,
            fallbackModelIds: ["claude-haiku-4-5"],
          },
        ],
      }),
    });
  });
  return () => requestCount;
}

test("limited provider health stays hidden from users", async ({ page }) => {
  await prepareGuestPage(page, "en");
  const requestCount = await mockProviderStatus(page, "limited");

  await page.goto("/chat");
  await expect.poll(requestCount).toBeGreaterThan(0);
  await page.waitForTimeout(150);

  await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
  const dismissOnboarding = page.getByRole("button", {
    name: "Start using Tomverse",
  });
  if (await dismissOnboarding.isVisible()) {
    await dismissOnboarding.click();
  }
  await openModelPickerCatalogue(page);
  await expect(page.locator('[title="limited"]')).toHaveCount(0);
});

test("outage remains visible with a fallback suggestion", async ({ page }) => {
  await prepareGuestPage(page, "en");
  // The guest default already includes the GPT/Claude/Gemini brand trio, so
  // the fallback suggestion must be a model outside that trio -- otherwise
  // it's filtered out as "already selected" and no suggestion is shown.
  await page.route("**/api/models/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gemini-2-5-flash",
            provider: "google",
            status: "unavailable",
            fallbackModelIds: ["deepseek-v4-flash"],
          },
        ],
      }),
    });
  });

  await page.goto("/chat");

  const banner = page.getByTestId("provider-outage-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("1 unavailable");
  await expect(banner).toContainText("DeepSeek-V4 Flash");
});

test("retired models stay out of the user model catalogue", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.route("**/api/models/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gemini-2-5-pro",
            provider: "google",
            status: "unavailable",
            fallbackModelIds: ["gemini-3-1-pro"],
          },
        ],
      }),
    });
  });

  await page.goto("/chat");
  await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
  const dismissOnboarding = page.getByRole("button", {
    name: "Start using Tomverse",
  });
  if (await dismissOnboarding.isVisible()) {
    await dismissOnboarding.click();
  }

  const dialog = await openModelPickerCatalogue(page);
  await expect(page.getByText("Gemini 2.5 Pro", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByTestId("model-option").filter({ hasText: "Gemini 3.1 Pro" })
  ).toBeVisible();
});

test("clicking the banner's suggestion swaps the failed model instead of silently failing at the cap", async ({
  page,
}, testInfo) => {
  // Regression test for a reported bug: with 3 models already selected (the
  // max), the banner's suggestion button used to call the plain add/toggle
  // handler, which rejects once at the cap -- so clicking it did nothing at
  // all, and the failed model stayed selected. It must swap instead.
  //
  // desktop-model-panel only exists in DesktopChatShell, so this has always
  // been a desktop-shell assertion; without the guard it fails on the
  // mobile-* projects for that reason alone.
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "The 3-panel cap assertion only applies to the desktop chat shell."
  );
  await mockAuthenticatedApi(page);
  await page.route("**/api/models/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gpt-5-4-mini",
            provider: "openai",
            status: "unavailable",
            fallbackModelIds: ["mistral-small-4"],
          },
        ],
      }),
    });
  });

  await page.goto("/chat?lang=en");
  await openModelPickerCatalogue(page);
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();
  await page
    .locator('[data-testid="model-option"][data-model-id="claude-haiku-4-5"]')
    .click();
  // Escape steps back to the recommendations first, then closes the picker.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-input-popover")).toBeHidden();

  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);

  const banner = page.getByTestId("provider-outage-banner");
  await expect(banner).toBeVisible();
  const swapButton = banner.getByRole("button", {
    name: "Switch GPT-5.4 mini for Mistral Small 4",
  });
  await expect(swapButton).toBeVisible();

  await swapButton.click();

  await expect(
    page.locator('[data-testid="desktop-model-panel"][data-model-id="gpt-5-4-mini"]')
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="desktop-model-panel"][data-model-id="mistral-small-4"]')
  ).toBeVisible();
  // Still exactly 3 panels -- the failed model was replaced in place, not
  // just added on top (which the cap would have rejected outright).
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);
});

// UI-TOUCH-001. The outage banner is the recovery path when a selected model
// is down, so on a phone its refresh and its swap/fallback chips have to be
// tappable. They were 32x32 and 28px tall. The desktop copy of the same
// banner deliberately keeps its smaller, mouse-appropriate sizing, so both
// directions are asserted here rather than only the one that was failing.
test.describe("outage banner touch targets (UI-TOUCH-001)", () => {
  const MIN_TARGET = 44;
  const TOLERANCE = 0.5;

  async function unavailableSelectedModel(page: Page) {
    await page.route("**/api/models/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          models: [
            {
              id: "gemini-2-5-flash",
              provider: "google",
              status: "unavailable",
              fallbackModelIds: ["deepseek-v4-flash"],
              fallbackHealth: "operational",
            },
          ],
        }),
      });
    });
  }

  test("compact (phone) banner actions meet 44x44 and hit-test to themselves", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The compact banner is the mobile shell's rendering."
    );
    await prepareGuestPage(page, "en");
    await unavailableSelectedModel(page);

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/chat");
      const banner = page.getByTestId("provider-outage-banner");
      await expect(banner).toBeVisible();
      const label = `[${viewport.width}x${viewport.height}]`;

      const actions = [
        banner.getByTestId("provider-status-refresh"),
        // Whichever of the two the banner chose for this state.
        banner.getByTestId("provider-status-swap"),
        banner.getByTestId("provider-status-fallback"),
      ];
      let checked = 0;
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const action of actions) {
        const count = await action.count();
        for (let index = 0; index < count; index++) {
          const item = action.nth(index);
          await item.scrollIntoViewIfNeeded();
          const box = (await item.boundingBox())!;
          expect(box.width, `${label} action width`).toBeGreaterThanOrEqual(
            MIN_TARGET - TOLERANCE
          );
          expect(box.height, `${label} action height`).toBeGreaterThanOrEqual(
            MIN_TARGET - TOLERANCE
          );
          // Centre and the four points 22px away must all land on this
          // control, so the 44px box is real rather than a neighbour's.
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          const half = MIN_TARGET / 2 - TOLERANCE;
          for (const [dx, dy] of [
            [0, 0],
            [-half, 0],
            [half, 0],
            [0, -half],
            [0, half],
          ] as Array<[number, number]>) {
            const resolvesToSelf = await item.evaluate((element, [px, py]) => {
              const hit = document.elementFromPoint(px, py);
              return hit === element || Boolean(hit && element.contains(hit));
            }, [cx + dx, cy + dy] as [number, number]);
            expect(
              resolvesToSelf,
              `${label} hit-test at (${dx}, ${dy}) must resolve to this action`
            ).toBe(true);
          }
          boxes.push(box);
          checked += 1;
        }
      }
      expect(checked, `${label} expected the banner to render actions`).toBeGreaterThan(0);

      // No two actions may overlap: growing a chip must not steal its
      // neighbour's taps.
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const overlaps =
            boxes[a].x < boxes[b].x + boxes[b].width &&
            boxes[a].x + boxes[a].width > boxes[b].x &&
            boxes[a].y < boxes[b].y + boxes[b].height &&
            boxes[a].y + boxes[a].height > boxes[b].y;
          expect(overlaps, `${label} banner actions must not overlap`).toBe(false);
        }
      }

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);
    }
  });

  test("desktop banner keeps its original compact sizing", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "This checks the non-touch desktop path specifically."
    );
    await prepareGuestPage(page, "en");
    await unavailableSelectedModel(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/chat");

    const refresh = page
      .getByTestId("provider-outage-banner")
      .getByTestId("provider-status-refresh");
    await expect(refresh).toBeVisible();
    const box = (await refresh.boundingBox())!;
    expect(
      box.width < MIN_TARGET - TOLERANCE || box.height < MIN_TARGET - TOLERANCE,
      "desktop refresh should not have been enlarged with the mobile fix"
    ).toBe(true);
  });
});
