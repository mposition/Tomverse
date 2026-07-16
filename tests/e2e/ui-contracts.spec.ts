import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test("desktop exposes stable QA contracts", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/chat");

  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-message-list")).toBeVisible();

  const guestGuide = page.getByTestId("guest-quick-start");
  await expect(guestGuide).toContainText("up to 3 free models");
  await expect(guestGuide).toContainText("Guest usage limits apply");
  await expect(guestGuide.getByRole("link", { name: "Login / Sign Up" })).toBeVisible();
  await expect(guestGuide).not.toContainText("auth.signIn");

  await page.getByTestId("sidebar-help-button").click();
  const helpLink = page.getByTestId("sidebar-help-link");
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveAttribute(
    "href",
    "/support/help-centre/chat-workspace?lang=en"
  );
  await expect(helpLink).toHaveAttribute("target", "_blank");

  await page.keyboard.press("Escape");
  const organizerToggle = page.getByTestId("sidebar-organizer-toggle");
  if ((await organizerToggle.getAttribute("aria-expanded")) !== "true") {
    await organizerToggle.click();
  }
  await expect(page.getByText("Status", { exact: true })).toBeVisible();
  await expect(page.getByText("Labels", { exact: true })).toBeVisible();

  await page.getByTestId("status-help").click();
  let tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("protection and sharing state");

  for (const helpTestId of ["status-help", "labels-help", "projects-help"]) {
    if (helpTestId !== "status-help") {
      await page.keyboard.press("Escape");
      await page.getByTestId(helpTestId).click();
      tooltip = page.getByRole("tooltip");
      await expect(tooltip).toBeVisible();
    }

    const box = await tooltip.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  }
});

test("chat workspace guide exposes the full help structure", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/support/help-centre/chat-workspace");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Use the Tomverse chat workspace with confidence",
    })
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(10);
  await expect(page.getByText("AI Review compares only the supplied answers.")).toBeVisible();
});

test("chat workspace guide honors the language passed from the app", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/support/help-centre/chat-workspace?lang=ko");

  await expect(page).toHaveURL(/\/support\/help-centre\/chat-workspace\?lang=ko$/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tomverse_language")))
    .toBe("ko");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Tomverse Chat 워크스페이스 사용 가이드",
    })
  ).toBeVisible();
  const localizedHelpLinks = page.locator(
    'a[href="/support/help-centre?lang=ko"]'
  );
  await expect(localizedHelpLinks).toHaveCount(2);
  await expect(localizedHelpLinks.first()).toBeVisible();
  await expect(localizedHelpLinks.last()).toBeVisible();
});

test("mobile exposes stable QA contracts", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto("/chat");

  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();

  await page
    .getByTestId("mobile-chat-shell")
    .locator("header")
    .getByRole("button")
    .first()
    .click();
  const organizerToggle = page.getByTestId("sidebar-organizer-toggle");
  if ((await organizerToggle.getAttribute("aria-expanded")) !== "true") {
    await organizerToggle.click();
  }
  await page.getByTestId("status-help").click();
  await expect(page.getByRole("dialog", { name: "Status" })).toContainText(
    "protection and sharing state"
  );
});

test("authenticated users can complete and replay the sidebar tour", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { showSidebarTour: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/chat");

  const tour = page.getByTestId("sidebar-tour");
  await expect(tour).toBeVisible();
  await page.getByTestId("sidebar-tour-next").click();
  await page.getByTestId("sidebar-tour-next").click();
  await page.getByTestId("sidebar-tour-next").click();
  await expect(tour).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tomverse_sidebar_tour_v1")))
    .toBe("completed");

  await page.getByTestId("sidebar-help-button").click();
  await page.getByTestId("sidebar-tour-replay").click();
  await expect(tour).toBeVisible();
  await page.getByTestId("sidebar-tour-skip").click();
  await expect(tour).toBeHidden();
});
