import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tomverse-language", "ko"));
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/chatLocation.ts*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const plugin = `const fixtureGeolocation = {
      checkPermissions: async () => ({coarseLocation:sessionStorage.getItem('fixture-os-location') || 'prompt'}),
      requestPermissions: async options => {
        window.fixturePermissionOptions = options;
        sessionStorage.setItem('fixture-os-location','granted');
        return {coarseLocation:'granted'};
      },
      getCurrentPosition: async () => ({coords:{latitude:-27.469,longitude:153.025,accuracy:500},timestamp:Date.now()})
    };`;
    await route.fulfill({ response, body: plugin + source.replaceAll("Capacitor.isNativePlatform()", "true").replaceAll("createNativeLocationReader(Geolocation,", "createNativeLocationReader(fixtureGeolocation,").replaceAll("createNativeLocationConsent(session, Geolocation,", "createNativeLocationConsent(session, fixtureGeolocation,") });
  });
  await page.route("**/src/MobileApp.tsx*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("!demo &&", "true &&") });
  });
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const injection = `const {nativeChatLocation} = await import('/src/chatLocation.ts');
      transport.location=nativeChatLocation;
      const originalAccount=transport.account;
      transport.account=async()=>{const profile=await originalAccount();nativeChatLocation.setIdentity(profile.id);return profile;};`;
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await page.goto("/");
});

test("first-launch disclosure enables current location after permission and sign-in", async ({ page }) => {
  const disclosure = page.getByRole("dialog", { name: "현재 위치를 사용할까요?", exact: true });
  await expect(disclosure).toContainText("AI 제공자에게 전달");
  await page.screenshot({ path: test.info().outputPath("location-consent-light.png") });
  await disclosure.getByRole("button", { name: "위치 사용 허용", exact: true }).click();
  await expect(disclosure).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { fixturePermissionOptions: unknown }).fixturePermissionOptions)).toEqual({ permissions: ["coarseLocation"] });
  await page.getByRole("button", { name: "Tomverse로 계속", exact: true }).click();
  await expect(page.getByTestId("native-location-status")).toHaveCount(0);
  await expect(page.locator(".composer-area")).not.toContainText("현재 위치 사용 중");
  await page.screenshot({ path: test.info().outputPath("composer-location-enabled.png") });
  await page.getByRole("button", { name: "파일 첨부", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "현재 위치", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.reload();
  await expect(disclosure).toHaveCount(0);
  await page.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(toggle).not.toBeChecked();
});

test("not now closes first-launch consent without requesting OS location", async ({ page }) => {
  await page.getByRole("dialog").getByRole("button", { name: "나중에", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("fixture-os-location"))).toBeNull();
  await page.getByRole("button", { name: "Tomverse로 계속", exact: true }).click();
  await page.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(page.getByRole("switch", { name: "현재 위치", exact: true })).not.toBeChecked();
});
