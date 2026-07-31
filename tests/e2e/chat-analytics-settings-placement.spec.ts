import { expect, test, type Page } from "@playwright/test";
import { openRecentConversation, prepareGuestPage } from "./support/app-fixtures";
import { expectFivePointHitTest } from "./support/ui-audit";

/**
 * REAUDIT-P1-01. On /chat the floating "Analytics settings" pill was anchored
 * to the bottom-right corner -- the same corner the last model panel's
 * follow-up form ends in, and the same corner the shared composer runs to.
 * Measured on a 1440x900 desktop guest preview before the fix, and identically
 * at 1366x768 and 1920x1080 (the pill and the panel footer are both pinned to
 * that corner, so widening the window moves them together):
 *
 * | overlapped control | area |
 * |---|---:|
 * | third panel's send button | 1012px^2 |
 * | third panel's follow-up input | 522px^2 |
 * | shared composer (seeded conversation) | 771px^2 |
 *
 * Being the topmost layer, the pill also took every click that landed on it.
 * The fix is structural rather than an offset: the pill is not rendered on
 * /chat at all, and the entry point lives in normal document flow -- the
 * sidebar's account card when the sidebar is expanded, the rail's account menu
 * when it is collapsed.
 *
 * The fixture deliberately seeds a real guest conversation with history. An
 * empty conversation's panel footers are inert (send is disabled with no
 * conversation id), so measuring one proves nothing about the control a user
 * can actually press.
 */

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
const CHAT_ID = "guest_analytics_placement";
const TITLE = "Analytics placement";

const DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

async function seedGuestWorkspace(page: Page, theme: "light" | "dark") {
  await page.context().addCookies([
    { name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" },
  ]);
  await page.route("**/api/analytics/events", (route) =>
    route.fulfill({ status: 202, body: "" })
  );
  await page.addInitScript(
    ({ chatId, models, title, theme }) => {
      window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
      window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
      window.localStorage.setItem("tomverse_theme_preference", theme);
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title,
            selectedModels: models,
            disabledPanels: [],
            webSearchMode: "off",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ])
      );
      for (const modelId of models) {
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "Compare these.", status: "normal" },
            {
              id: "a1",
              role: "assistant",
              content: `Answer from ${modelId}.`,
              status: "normal",
            },
          ])
        );
      }
    },
    { chatId: CHAT_ID, models: MODELS, title: TITLE, theme }
  );
}

/**
 * Every analytics-owned box on the page against every control the workspace
 * needs, as areas. Zero is the only passing number: an overlay that merely
 * misses today moves the first time a label or a font changes.
 */
async function analyticsIntersections(page: Page) {
  return page.evaluate(() => {
    const analytics = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="analytics-settings-button"], [data-testid="chat-consent-notice"]'
      )
    );
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="model-only-input"], [data-testid="model-only-send"], [data-testid="chat-input"], [data-testid="comparison-action-rail"]'
      )
    );
    const results: { analytics: string; target: string; area: number }[] = [];
    for (const source of analytics) {
      const a = source.getBoundingClientRect();
      for (const target of targets) {
        const b = target.getBoundingClientRect();
        const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const area = Math.round(w * h);
        if (area <= 0) continue;
        results.push({
          analytics: source.dataset.testid!,
          target: `${target.dataset.testid}:${target.dataset.modelId ?? ""}`,
          area,
        });
      }
    }
    return results;
  });
}

test.describe("desktop chat analytics settings placement", () => {
  test.beforeEach(async (_, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "The floating pill and the model panel footers are a desktop-shell layout."
    );
  });

  for (const viewport of DESKTOP_VIEWPORTS) {
    for (const lang of ["en", "ko"] as const) {
      for (const theme of ["light", "dark"] as const) {
        test(
          `analytics never overlaps the workspace at ${viewport.width}x${viewport.height} ${lang}/${theme}`,
          { tag: "@ui-risk" },
          async ({ page }) => {
            test.setTimeout(90_000);
            await prepareGuestPage(page, lang);
            await seedGuestWorkspace(page, theme);
            await page.setViewportSize(viewport);
            await page.goto(`/chat?lang=${lang}&entry=guest-preview`);
            await openRecentConversation(page, { title: TITLE });

            // Real drafts, so every panel send is the enabled control a user
            // would press rather than a disabled placeholder.
            const inputs = page.getByTestId("model-only-input");
            const inputCount = await inputs.count();
            expect(inputCount, "seeded panels expose their follow-up inputs").toBeGreaterThan(0);
            for (let index = 0; index < inputCount; index += 1) {
              await inputs.nth(index).fill("follow-up");
            }

            // The shared helper samples the corners along the control's own
            // border radius, so a round send button is tested against its own
            // shape rather than the page behind it.
            const sends = page.getByTestId("model-only-send");
            const sendCount = await sends.count();
            expect(sendCount, "every seeded panel has a send").toBe(inputCount);
            for (let index = 0; index < sendCount; index += 1) {
              const send = sends.nth(index);
              await expect(send, `panel ${index}: send is enabled with a draft`).toBeEnabled();
              await expectFivePointHitTest(send, `panel ${index} send`);
            }

            expect(await analyticsIntersections(page)).toEqual([]);

            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(overflow, "document horizontal overflow").toBeLessThanOrEqual(1);
          }
        );
      }
    }
  }

  test(
    "the expanded sidebar carries the analytics entry point, and focus returns to it",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(90_000);
      await prepareGuestPage(page, "en");
      await seedGuestWorkspace(page, "light");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/chat?lang=en&entry=guest-preview");

      // The floating overlay is gone from this route entirely -- not merely
      // hidden by a media query.
      await expect(page.getByTestId("analytics-settings-button")).toHaveCount(0);

      const entry = page
        .getByTestId("sidebar-account-controls")
        .getByTestId("guest-analytics-cookie-settings");
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAccessibleName(/analytics|cookie/i);

      // Keyboard operable, and the round trip ends where it started.
      await entry.focus();
      await expect(entry).toBeFocused();
      await page.keyboard.press("Enter");

      const notice = page.getByTestId("chat-consent-notice");
      await expect(notice).toBeVisible();
      await notice.getByTestId("analytics-consent-accept").click();
      await expect(notice).toHaveCount(0);
      await expect(entry, "focus returns to the control that opened preferences").toBeFocused();
    }
  );

  test(
    "the collapsed sidebar rail keeps a path to the analytics choice",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(90_000);
      await prepareGuestPage(page, "en");
      await seedGuestWorkspace(page, "light");
      await page.addInitScript(() => {
        window.localStorage.setItem("tomverse_sidebar_collapsed_v1", "collapsed");
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/chat?lang=en&entry=guest-preview");

      const trigger = page.getByTestId("sidebar-rail-account-trigger");
      await expect(trigger).toBeVisible();
      await trigger.click();

      const railEntry = page.getByTestId("sidebar-rail-analytics-settings");
      await expect(railEntry).toBeVisible();
      await expect(railEntry).toHaveAccessibleName(/analytics/i);
      await railEntry.click();

      await expect(page.getByTestId("chat-consent-notice")).toBeVisible();
      expect(await analyticsIntersections(page)).toEqual([]);
    }
  );
});
