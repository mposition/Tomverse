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
  await expect(banner.getByTestId("provider-status-count")).toHaveText(
    "1 model unavailable"
  );
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

// RECON-OPS-002. Every fixture above has exactly one failed model and one
// candidate, which is the single shape where the banner's old copy could not
// be caught being wrong: "1 unavailable" over one button is true by accident.
// With six models down and three replacements on offer the same copy claimed
// the models were "currently limited" when they were unavailable, put a bare
// tally next to an unrelated number of buttons, and printed the three
// suggestion names once in its guidance sentence and again on the buttons
// directly below it.
test.describe("widespread outage copy and layout (RECON-OPS-002)", () => {
  // None of the six is part of the guest brand-trio default, so this is the
  // global variant of the banner -- add-a-fallback buttons rather than the
  // selected-only 1:1 swap, which keeps its own coverage above.
  const OUTAGE_MODEL_IDS = [
    "grok-4",
    "grok-3",
    "mistral-large-3",
    "mistral-medium-3-1",
    "codestral",
    "kimi-k2.7-code",
  ];
  const FALLBACK_MODEL_IDS = [
    "deepseek-v4-flash",
    "mistral-small-4",
    "qwen3.6-flash",
  ];
  const FALLBACK_MODEL_NAMES = ["DeepSeek-V4 Flash", "Mistral Small 4", "Qwen 3.6"];

  // The healthy replacements are reported too, so the snapshot holds nine
  // models in total: a count that says "6" has to be counting the failures
  // rather than the payload or the buttons.
  async function mockWidespreadOutage(page: Page) {
    await page.route("**/api/models/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: "2099-01-01T00:00:00.000Z",
          models: [
            ...OUTAGE_MODEL_IDS.map((id) => ({
              id,
              provider: "qa-outage",
              status: "unavailable",
              fallbackModelIds: FALLBACK_MODEL_IDS,
              fallbackHealth: "operational",
            })),
            ...FALLBACK_MODEL_IDS.map((id) => ({
              id,
              provider: "qa-healthy",
              status: "available",
              fallbackModelIds: [],
              fallbackHealth: "none",
            })),
          ],
        }),
      });
    });
  }

  test("the headline states unavailability, the count is one localized sentence, and suggestion names appear only on the buttons", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockWidespreadOutage(page);
    await page.goto("/chat");

    const banner = page.getByTestId("provider-outage-banner");
    await expect(banner).toBeVisible();

    await expect(banner.getByTestId("provider-status-title")).toHaveText(
      "Some models are temporarily unavailable"
    );
    // The old headline described an outage as a throttle.
    await expect(banner).not.toContainText("limited");

    await expect(banner.getByTestId("provider-status-count")).toHaveText(
      "6 models unavailable"
    );

    // One short pointer to the buttons, with no model names of its own: the
    // count and the suggestions can no longer be read as the same quantity.
    const guidance = banner.getByTestId("provider-status-guidance");
    await expect(guidance).toHaveText("Try a fallback model:");
    const guidanceText = (await guidance.textContent()) ?? "";
    for (const name of FALLBACK_MODEL_NAMES) {
      expect(
        guidanceText,
        `the guidance sentence must not repeat ${name}`
      ).not.toContain(name);
    }

    const fallbacks = banner.getByTestId("provider-status-fallback");
    await expect(fallbacks).toHaveCount(FALLBACK_MODEL_IDS.length);
    const bannerText = await banner.innerText();
    for (const [index, name] of FALLBACK_MODEL_NAMES.entries()) {
      // Naming the action, not just the model: the shuffle glyph is decorative
      // and cannot carry "switch" on its own.
      await expect(fallbacks.nth(index)).toHaveAccessibleName(`Switch to ${name}`);
      expect(
        bannerText.split(name).length - 1,
        `${name} must appear exactly once in the banner`
      ).toBe(1);
    }

    await expect(banner.getByTestId("provider-status-refresh")).toBeVisible();
  });

  test("Korean renders the same copy as whole sentences rather than assembled words", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockWidespreadOutage(page);
    await page.goto("/chat?lang=ko");

    const banner = page.getByTestId("provider-outage-banner");
    await expect(banner).toBeVisible();

    await expect(banner.getByTestId("provider-status-title")).toHaveText(
      "일부 모델을 일시적으로 사용할 수 없습니다"
    );
    // Korean puts the counter after the noun -- a number glued in front of a
    // translated "unavailable" could not produce this.
    await expect(banner.getByTestId("provider-status-count")).toHaveText(
      "모델 6개 사용 불가"
    );
    await expect(banner.getByTestId("provider-status-guidance")).toHaveText(
      "대체 모델을 사용해 보세요:"
    );

    const fallbacks = banner.getByTestId("provider-status-fallback");
    await expect(fallbacks).toHaveCount(FALLBACK_MODEL_IDS.length);
    for (const [index, name] of FALLBACK_MODEL_NAMES.entries()) {
      await expect(fallbacks.nth(index)).toHaveAccessibleName(`${name}(으)로 전환`);
    }

    const bannerText = await banner.innerText();
    for (const name of FALLBACK_MODEL_NAMES) {
      expect(
        bannerText.split(name).length - 1,
        `${name} must appear exactly once in the banner`
      ).toBe(1);
    }
  });

  // The bug report arrived as a screenshot whose right edge was cut off, which
  // looks like a missing refresh button or a page overflowing sideways. Neither
  // reproduces: measured here the document never scrolls horizontally and both
  // the banner and its refresh control sit inside the viewport at every width.
  // What does reproduce is the headline being clipped by `truncate`, which is
  // why it now wraps -- so these are the measurements that have to keep
  // holding, rather than a shell or useIsMobileShell change made on a hunch.
  test("banner geometry holds at phone widths and on a narrow desktop pointer", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockWidespreadOutage(page);

    const viewports = testInfo.project.name.startsWith("mobile")
      ? [
          { width: 320, height: 568 },
          { width: 390, height: 844 },
          { width: 430, height: 932 },
        ]
      : [
          // Narrow enough to share the mobile shell's width breakpoint while
          // keeping a fine pointer -- the case useIsMobileShell exists to tell
          // apart, and where the compact desktop sizing must survive.
          { width: 720, height: 800 },
          { width: 1280, height: 800 },
        ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/chat");
      const label = `[${testInfo.project.name} ${viewport.width}x${viewport.height}]`;

      const banner = page.getByTestId("provider-outage-banner");
      await expect(banner).toBeVisible();
      const refresh = banner.getByTestId("provider-status-refresh");
      await expect(refresh).toBeVisible();

      // The suggestion strip is allowed to scroll sideways; the document is
      // not. Measured, not assumed -- this is the claim the screenshot made.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${label} document horizontal overflow`).toBeLessThanOrEqual(1);

      // The defect the screenshot actually contained. `truncate` hid 98px of
      // the headline at 320px and 28px at 390px, so the one sentence saying
      // what was wrong was the first thing cut. It wraps now, and a future
      // `truncate` would fail here rather than pass every copy assertion while
      // showing "Some models are temporarily unavai...".
      const headline = await banner
        .getByTestId("provider-status-title")
        .evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
      expect(
        headline.clientWidth,
        `${label} headline must be a measurable box`
      ).toBeGreaterThan(0);
      expect(
        headline.scrollWidth - headline.clientWidth,
        `${label} headline must not be clipped`
      ).toBeLessThanOrEqual(1);

      for (const [name, locator] of [
        ["banner", banner],
        ["refresh", refresh],
      ] as const) {
        const box = (await locator.boundingBox())!;
        expect(box.x, `${label} ${name} left edge`).toBeGreaterThanOrEqual(0);
        expect(
          box.x + box.width,
          `${label} ${name} right edge inside the viewport`
        ).toBeLessThanOrEqual(viewport.width);
      }

      // Every action measured in a single pass, because scrolling the strip
      // between measurements would report the same screen coordinates for
      // different chips and turn a clean row into a phantom overlap.
      const boxes = await banner
        .locator(
          '[data-testid="provider-status-refresh"], [data-testid="provider-status-fallback"], [data-testid="provider-status-swap"]'
        )
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          })
        );
      expect(boxes.length, `${label} refresh plus one chip per suggestion`).toBe(
        1 + FALLBACK_MODEL_IDS.length
      );

      // UI-TOUCH-001 still holds at the widths added here, in both directions:
      // a phone gets real 44px targets, and the narrow desktop window keeps its
      // mouse-sized ones instead of inheriting the touch floor by width alone.
      for (const [index, box] of boxes.entries()) {
        if (testInfo.project.name.startsWith("mobile")) {
          expect(box.width, `${label} action ${index} width`).toBeGreaterThanOrEqual(
            43.5
          );
          expect(box.height, `${label} action ${index} height`).toBeGreaterThanOrEqual(
            43.5
          );
        } else {
          expect(box.height, `${label} action ${index} height`).toBeLessThan(43.5);
        }
      }

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

      // Keyboard and touch both have to reach all three suggestions, including
      // the ones the strip has scrolled past at 320px.
      const fallbacks = banner.getByTestId("provider-status-fallback");
      await expect(fallbacks).toHaveCount(FALLBACK_MODEL_IDS.length);
      for (let index = 0; index < FALLBACK_MODEL_IDS.length; index++) {
        const action = fallbacks.nth(index);
        await action.focus();
        await expect(
          action,
          `${label} suggestion ${index} must take keyboard focus`
        ).toBeFocused();
        await action.scrollIntoViewIfNeeded();
        const reachable = await action.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return hit === element || Boolean(hit && element.contains(hit));
        });
        expect(
          reachable,
          `${label} suggestion ${index} must be reachable by touch`
        ).toBe(true);
      }
    }
  });
});
