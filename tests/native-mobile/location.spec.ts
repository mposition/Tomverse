import { selectProduct } from "./workspaceNavigation";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "light"); });
  await page.route("https://tomverse.app/**", route => route.abort("blockedbyclient"));
  // Give the existing synthetic product transport the real location UI/session.
  // Request serialization and late credential races use the actual API transport
  // in nativeMobileTransport.test.mjs rather than this no-network UI fixture.
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const injection = `
      const { nativeChatLocation } = await import("/src/chatLocation.ts");
      transport.location = nativeChatLocation;
      const originalAccount = transport.account, originalSignOut = transport.signOut;
      transport.account = async () => { const profile = await originalAccount(); nativeChatLocation.setIdentity(profile.id); return profile; };
      transport.signOut = async () => { nativeChatLocation.setIdentity(null); return originalSignOut(); };
    `;
    expect(source).toContain("createRoot(container).render(");
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
});

test("the current native composer keeps location opt-in transient and preserves its input space", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -27.46977, longitude: 153.02512, accuracy: 10 });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.locator(".composer-add").click();
  await expect(page.getByTestId("native-location-toggle")).not.toBeChecked();
  await page.getByTestId("native-location-toggle").click();
  await expect(page.getByTestId("native-location-toggle")).toBeChecked();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await expect(page.getByTestId("native-location-status")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toBeVisible();
  const input = await page.locator(".composer textarea").boundingBox();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.locator(".composer-add").click();
  await page.getByTestId("native-location-toggle").click();
  await expect(page.getByTestId("native-location-toggle")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("native-location-status")).toHaveCount(0);
  const withoutLocation = await page.locator(".composer textarea").boundingBox();
  expect(input!.width).toBeGreaterThanOrEqual(withoutLocation!.width - 1);
  await page.locator(".composer-add").click(); await page.getByTestId("native-location-toggle").click();
  await expect(page.getByTestId("native-location-toggle")).toBeChecked();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('"latitude"');
  await page.reload(); await page.locator(".composer-add").click();
  await expect(page.getByTestId("native-location-toggle")).not.toBeChecked();
});

test("native Chat and Review share only the current account's transient location consent", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: -27.47, longitude: 153.025 });
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.locator(".composer-add").click(); await page.getByTestId("native-location-toggle").click();
  await expect(page.getByTestId("native-location-toggle")).toBeChecked(); await page.keyboard.press("Escape");
  await selectProduct(page, "review");
  await page.locator(".composer-add").click();
  await expect(page.getByTestId("native-location-toggle")).toBeChecked();
  await page.getByTestId("native-location-toggle").click(); await page.keyboard.press("Escape");
  await selectProduct(page, "chat");
  await expect(page.getByTestId("native-location-status")).toHaveCount(0);
});

for (const code of [1, 3]) {
  test(`native location failure ${code} keeps the current composer usable`, async ({ page }) => {
    await page.addInitScript(errorCode => {
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: errorCode }),
      } });
    }, code);
    await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
    await page.locator(".composer-add").click(); await page.getByTestId("native-location-toggle").click();
    await expect(page.getByTestId("native-location-toggle")).not.toBeChecked();
    await expect(page.locator(".tool-location").getByRole("status")).toContainText(code === 1 ? "권한" : "시간");
    await expect(page.getByTestId("native-location-status")).toHaveCount(0);
    await page.keyboard.press("Escape"); await page.getByRole("textbox").fill("Continue without location");
    await expect(page.getByRole("button", { name: "메시지 보내기", exact: true })).toBeEnabled();
  });
}
