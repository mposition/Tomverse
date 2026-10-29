import { expect, test, type Page } from "@playwright/test";
import { installTurnstileScript, mockAuthenticatedApi, mockChatStream, openRecentConversation, prepareGuestPage, readTurnstileState } from "./support/app-fixtures";
import { provideGeolocation } from "./support/engine-capabilities";

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

test("a guest receives the verification cookie before location analysis and the original answer", { tag: "@ui-risk" }, async ({ page, context }) => {
  await provideGeolocation(page, { latitude: -27.47, longitude: 153.025, accuracy: 150 });
  await prepareGuestPage(page, "en");
  await installTurnstileScript(page, "silent");
  const spentTokens: string[] = [];
  let analyses = 0;
  // Whether the browser holds the grant for this URL, read from its cookie jar.
  // WebKit stores the fulfilled response's cookie, but never shows a `Cookie`
  // header to an intercepting route (neither `headers()` nor `allHeaders()`),
  // so reading the header refused every follow-up on mobile-safari.
  const holdsGrant = async (url: string) =>
    (await context.cookies(url)).some(cookie => cookie.name === "qa_location_grant" && cookie.value === "1");
  await page.route("**/api/chat/location-intent", async route => {
    const { turnstileToken } = route.request().postDataJSON();
    if (turnstileToken) {
      expect(spentTokens).not.toContain(turnstileToken);
      spentTokens.push(turnstileToken);
      await route.fulfill({ json: { requiresLocation: false }, headers: { "Set-Cookie": "qa_location_grant=1; Path=/; HttpOnly; SameSite=Lax" } });
    } else if (!(await holdsGrant(route.request().url()))) {
      await route.fulfill({ status: 403, json: { code: "TURNSTILE_REQUIRED" } });
    } else {
      analyses++;
      await route.fulfill({ json: { requiresLocation: true } });
    }
  });
  await page.route("**/api/chat", async route => {
    expect(await holdsGrant(route.request().url())).toBe(true);
    expect(route.request().postDataJSON().currentLocation.latitude).toBe(-27.47);
    await route.fulfill({ contentType: "text/plain; charset=utf-8", body: "Location test reply." });
  });
  await page.goto("/review?lang=en&models=gemini-2-5-flash");
  expect((await send(page, "Where am I?")).currentLocation.latitude).toBe(-27.47);
  expect((await send(page, "What is nearby?")).currentLocation.latitude).toBe(-27.47);
  expect(analyses).toBe(1);
  expect(spentTokens).toHaveLength(1);
  expect((await readTurnstileState(page))?.issuedTokens).toHaveLength(1);
});

test("a location question automatically acquires permission and answers without opening tools", { tag: "@ui-risk" }, async ({ page }) => {
  const moveTo = await provideGeolocation(page, { latitude: -27.46977, longitude: 153.02512, accuracy: 10 });
  await openChat(page);
  let analyses = 0;
  await page.route("**/api/chat/location-intent", async route => {
    analyses++;
    expect(route.request().postDataJSON().text).toBe("지금 제가 있는 위치가 어디인가요?");
    await route.fulfill({ json: { requiresLocation: true } });
  });
  await expect(page.getByTestId("chat-location-status")).toHaveCount(0);
  expect((await send(page, "지금 제가 있는 위치가 어디인가요?")).currentLocation.latitude).toBe(-27.47);
  await expect(page.getByTestId("chat-location-status")).toBeVisible();
  await moveTo({ latitude: -33.8688, longitude: 151.2093 });
  expect((await send(page, "What is nearby now?")).currentLocation.latitude).toBe(-33.869);
  expect(analyses).toBe(1);
  await page.reload();
  await expect(page.getByText("What is nearby now?", { exact: true })).toBeVisible();
  expect((await send(page, "지금 제가 있는 위치가 어디인가요?")).currentLocation.latitude).toBe(-33.869);
  expect(analyses).toBe(2);
  await page.getByTestId("chat-location-disable").click();
  expect((await send(page, "Continue without my location")).currentLocation).toBeUndefined();
  expect(analyses).toBe(2);
});

test("an automatic permission denial continues without coordinates and never re-prompts", { tag: "@ui-risk" }, async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "locationRequests", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => {
        (window as unknown as { locationRequests: number }).locationRequests++;
        failure({ code: 1 });
      },
    } });
  });
  await openChat(page);
  let analyses = 0;
  await page.route("**/api/chat/location-intent", route => { analyses++; return route.fulfill({ json: { requiresLocation: true } }); });
  expect((await send(page, "Where am I?")).currentLocation).toBeUndefined();
  await expect(page.getByTestId("chat-location-status")).toContainText("permission denied");
  expect((await send(page, "What is nearby?")).currentLocation).toBeUndefined();
  expect(analyses).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { locationRequests: number }).locationRequests)).toBe(1);
});

test("foreground location is off by default, refreshed on each send, removable, and not restored on reload", { tag: "@ui-risk" }, async ({ page }) => {
  const moveTo = await provideGeolocation(page, { latitude: -27.4697701, longitude: 153.0251234, accuracy: 10 });
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

  await moveTo({ latitude: -33.8688123, longitude: 151.2093234, accuracy: 20 });
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

test("location status preserves the full-width input at 320px and 200% text", { tag: "@ui-risk" }, async ({ page }) => {
  await provideGeolocation(page, { latitude: -27.47, longitude: 153.025 });
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
