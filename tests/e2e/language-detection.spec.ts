import { expect, test } from "@playwright/test";
import { CHAT_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

test.use({ locale: "ko-KR" });

test("a fresh private-style session uses the browser language before opening a product", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  await page.goto("/");

  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tomverse_language")))
    .toBe("ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");

  // The Korean label and destination must preserve the detected language
  // for whichever product is currently offered to this visitor.
  const guestChatAvailable = await page.getByTestId("launch-homepage")
    .getAttribute("data-guest-chat-trial-available") === "true";
  const startHref = guestChatAvailable ? `${CHAT_WORKSPACE_PATH}?lang=ko` : "/review?lang=ko";
  const destination = new URL(startHref, page.url()).href;
  const startProduct = page.getByTestId("landing-primary-cta");
  await expect(startProduct).toContainText(guestChatAvailable ? "Chat 시작하기" : "Review 시작하기");
  await expect(startProduct).toHaveAttribute("href", startHref);

  await startProduct.click();
  await expect(page).toHaveURL(destination);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
});

test("an explicit locale route still overrides the browser preference", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  await page.goto("/en");

  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tomverse_language")))
    .toBe("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
