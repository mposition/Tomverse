import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

async function offerInstall(page: Page) {
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, {
      prompt: async () => { document.body.dataset.installPrompted = "yes"; },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(event);
  });
}

for (const collapsed of [false, true]) {
  test(`preferred-language install is in the ${collapsed ? "collapsed" : "expanded"} account menu`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("mobile"), "The desktop sidebar account menu is not rendered on the mobile shell.");
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { language: "ko" });
    await page.goto("/review?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await offerInstall(page);
    await expect(page.getByTestId("account-install-app")).toHaveCount(0);
    if (collapsed) {
      await page.getByTestId("sidebar-collapse-button").click();
      await page.getByTestId("sidebar-rail-account-trigger").click();
    } else {
      await page.getByTestId("account-menu-trigger").click();
    }
    await expect(page.getByTestId("account-install-app")).toHaveText("Tomverse 앱 설치");
    await page.screenshot({ path: test.info().outputPath(`account-install-${collapsed ? "collapsed" : "expanded"}-ko.png`) });
    expect(await page.locator("body").getAttribute("data-install-prompted")).toBeNull();
    await page.getByTestId("account-install-app").click();
    await expect(page.locator("body")).toHaveAttribute("data-install-prompted", "yes");
  });
}

test("a mobile guest can install from the account menu without a header row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "ko");
  await page.goto("/review?lang=ko");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await offerInstall(page);
  await page.getByTestId("mobile-sidebar-open").click();
  await page.getByTestId("sidebar-rail-account-trigger").click();
  const install = page.getByTestId("account-install-app");
  await expect(install).toHaveText("Tomverse 앱 설치");
  await install.scrollIntoViewIfNeeded();
  const box = await install.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: test.info().outputPath("account-install-guest-mobile-ko.png") });
  await install.click();
  await expect(page.locator("body")).toHaveAttribute("data-install-prompted", "yes");
});
