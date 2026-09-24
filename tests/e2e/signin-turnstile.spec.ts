import { expect, test } from "@playwright/test";
import {
  completeTurnstileChallenge,
  installTurnstileScript,
  prepareGuestPage,
  readTurnstileState,
} from "./support/app-fixtures";

test("email login reveals and reuses an interactive Turnstile at the form width", { tag: "@smoke" }, async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The lifecycle and geometry are covered once with an explicit viewport."
  );

  await prepareGuestPage(page, "en");
  await installTurnstileScript(page, "interactive");

  const requests: Array<string | null> = [];
  await page.route("**/api/auth/email-login/request", async (route) => {
    const body = route.request().postDataJSON() as {
      turnstileToken?: string;
    };
    requests.push(body.turnstileToken ?? null);
    if (!body.turnstileToken) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "TURNSTILE_REQUIRED" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/auth/signin?lang=en");
  await page.getByPlaceholder("you@example.com").fill("qa@example.com");
  await page.getByRole("button", { name: "Get login code" }).click();

  const slot = page.getByTestId("email-login-verification");
  const widget = page.getByTestId("qa-turnstile-widget");
  await expect(slot).toHaveAttribute("data-visible", "true");
  await expect(widget).toBeVisible();

  const [slotBox, widgetBox] = await Promise.all([
    slot.boundingBox(),
    widget.boundingBox(),
  ]);
  expect(slotBox).not.toBeNull();
  expect(widgetBox).not.toBeNull();
  expect(slotBox!.width).toBeGreaterThan(250);
  expect(widgetBox!.width).toBeGreaterThan(250);
  expect(widgetBox!.x).toBeGreaterThanOrEqual(slotBox!.x - 1);
  expect(widgetBox!.x + widgetBox!.width).toBeLessThanOrEqual(
    slotBox!.x + slotBox!.width + 1
  );

  expect(await completeTurnstileChallenge(page)).toBe(true);
  await expect(page.getByPlaceholder("000000")).toBeVisible();
  expect(requests).toEqual([null, "qa-turnstile-token-1"]);

  let state = await readTurnstileState(page);
  expect(state?.renders).toBe(1);
  expect(state?.executes).toBe(1);

  // The OTP screen can request a fresh code. Its Turnstile host must still be
  // mounted; otherwise the hook keeps a widget id whose iframe was detached
  // and this second challenge can never be completed.
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(slot).toHaveAttribute("data-visible", "true");
  await expect(widget).toBeVisible();
  expect(await completeTurnstileChallenge(page)).toBe(true);
  await expect.poll(() => requests).toEqual([
    null,
    "qa-turnstile-token-1",
    null,
    "qa-turnstile-token-2",
  ]);
  state = await readTurnstileState(page);
  expect(state?.renders).toBe(1);
  expect(state?.executes).toBe(2);
});
