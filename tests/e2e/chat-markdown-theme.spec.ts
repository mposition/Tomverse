import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test("assistant code blocks keep readable contrast in the light theme", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  const state = await mockAuthenticatedApi(page);
  state.theme = "light";

  await page.route(/.*\/api\/conversations\/qa-conversation(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "qa-conversation",
        title: "Markdown contrast",
        selectedModels: ["gpt-5-4-mini"],
        disabledPanels: [],
        isLocked: false,
        shareEnabled: false,
        shareExpiresAt: null,
        nextCursor: null,
        messages: [
          {
            id: "assistant-code-block",
            role: "assistant",
            modelId: "gpt-5-4-mini",
            status: "normal",
            content: "추천 예시입니다.\n\n```text\nCompare AI answers in one place.\n```",
          },
        ],
      }),
    });
  });

  await page.goto("/chat");

  const code = page.locator('[data-message-role="assistant"] pre code').first();
  await expect(code).toContainText("Compare AI answers in one place.");

  const contrast = await code.evaluate((element) => {
    const pre = element.closest("pre");
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !pre) return 0;

    const toRgb = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const luminance = (rgb: number[]) => {
      const channels = rgb.map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const foreground = luminance(toRgb(getComputedStyle(element).color));
    const background = luminance(toRgb(getComputedStyle(pre).backgroundColor));
    const lighter = Math.max(foreground, background);
    const darker = Math.min(foreground, background);
    return (lighter + 0.05) / (darker + 0.05);
  });

  expect(contrast).toBeGreaterThanOrEqual(7);
});
