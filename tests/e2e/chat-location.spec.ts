import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, mockChatStream, openRecentConversation } from "./support/app-fixtures";

const openChat = async (page: Page) => {
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-6-luna"] });
  await mockChatStream(page, "Location test reply.");
  const response = await page.goto("/review?lang=en");
  expect(response?.headers()["permissions-policy"]).toContain("geolocation=(self)");
  await openRecentConversation(page);
};

const send = async (page: Page, text: string) => {
  await page.getByTestId("chat-textarea").fill(text);
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/chat" && r.method() === "POST");
  await page.getByTestId("chat-send-button").click();
  const payload = (await request).postDataJSON();
  await expect(page.getByTestId("chat-textarea")).toHaveValue("");
  await expect(page.getByTestId("chat-stop-all-button")).toHaveCount(0);
  return payload;
};

test("foreground location is off by default, refreshed on each send, removable, and not restored on reload", { tag: "@ui-risk" }, async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -27.4697701, longitude: 153.0251234, accuracy: 10 });
  await openChat(page);
  expect((await send(page, "Hello without location")).currentLocation).toBeUndefined();

  await page.getByTestId("composer-tools-button").click();
  const toggle = page.getByTestId("tools-location-row");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("AI providers");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-location-status")).toContainText("refreshed with each message");
  const first = await send(page, "What is near me?");
  expect(first.currentLocation.latitude).toBe(-27.47);
  expect(first.currentLocation.longitude).toBe(153.025);
  expect(first.currentLocation.accuracy).toBeGreaterThanOrEqual(150);

  await context.setGeolocation({ latitude: -33.8688123, longitude: 151.2093234, accuracy: 20 });
  const moved = await send(page, "How about here now?");
  expect(moved.currentLocation.latitude).toBe(-33.869);
  expect(moved.currentLocation.longitude).toBe(151.209);
  const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(persisted).not.toContain('"latitude"');

  await page.getByTestId("chat-location-disable").click();
  expect((await send(page, "Continue without location")).currentLocation).toBeUndefined();
  await page.getByTestId("composer-tools-button").click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await page.getByTestId("composer-tools-button").click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

for (const [code, message] of [[1, "permission denied"], [3, "timed out"]] as const) {
  test(`location failure ${code} is visible and never prevents sending without location`, { tag: "@ui-risk" }, async ({ page }) => {
    await page.addInitScript((errorCode) => {
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        getCurrentPosition: (_success: unknown, failure: (e: { code: number }) => void) => failure({ code: errorCode }),
      } });
    }, code);
    await openChat(page);
    await page.getByTestId("composer-tools-button").click();
    await page.getByTestId("tools-location-row").click();
    await expect(page.getByTestId("tools-location-row")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("tools-location-row")).toContainText(message);
    await page.keyboard.press("Escape");
    expect((await send(page, "Find cafes; I can enter a city instead")).currentLocation).toBeUndefined();
  });
}

test("location status preserves the full-width input at 320px and 200% text", { tag: "@ui-risk" }, async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -27.47, longitude: 153.025 });
  await page.setViewportSize({ width: 320, height: 700 });
  await openChat(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.getByTestId("composer-tools-button").click();
  await page.getByTestId("tools-location-row").click();
  await expect(page.getByTestId("tools-location-row")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-send-button")).toBeVisible();
  const input = await page.getByTestId("chat-textarea").boundingBox();
  expect(input!.width).toBeGreaterThan(260);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
