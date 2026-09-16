import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test("desktop exposes stable QA contracts", { tag: "@smoke" }, async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/chat");

  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();

  const guestGuide = page.getByTestId("guest-quick-start");
  await expect(guestGuide).toContainText("Try 3 free AIs side by side, no login needed.");
  await expect(guestGuide).not.toContainText("auth.signIn");
  await guestGuide.getByTestId("guest-quick-start-help").click();
  await expect(
    page.getByText(
      "Guest chats stay in this browser. Guests can attach one local file per message and try AI Review once a month. Sign in to save chats, attach more files, connect Drive, and share."
    )
  ).toBeVisible();

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
  // The organizer's second block is the model filter now. "Labels" went with
  // the labels feature (2026-09-16), and the block that replaced it is the one
  // worth asserting: it renders only for an account that actually uses more
  // than one model, so it carries its own visibility rule.
  await expect(page.getByTestId("sidebar-model-filters")).toBeVisible();

  // UI-027. Located by its own test id rather than by `role="tooltip"`. These
  // popovers hold a heading, a paragraph and an external "learn more" link, and
  // a tooltip may not contain interactive content -- nothing announced the link
  // and there was no way to reach it, because a tooltip is not somewhere
  // assistive tech navigates into. They are disclosures now. What this test
  // asserts is unchanged: the popup is on screen, inside the viewport, and says
  // the right thing.
  await page.getByTestId("status-help").click();
  let popover = page.getByTestId("status-help-content");
  await expect(popover).toContainText("protection and sharing state");

  // "labels-help" went with the labels feature (2026-09-16). The two that
  // remain still cover what this loop checks -- a disclosure opened from the
  // organizer stays inside the viewport -- one of them anchored near the
  // bottom of the panel, which is where an overflow would show.
  for (const helpTestId of ["status-help", "projects-help"]) {
    if (helpTestId !== "status-help") {
      await page.keyboard.press("Escape");
      await page.getByTestId(helpTestId).click();
      popover = page.getByTestId(`${helpTestId}-content`);
      await expect(popover).toBeVisible();
    }

    const box = await popover.boundingBox();
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
  // Nine since the labels section went with the labels feature (2026-09-16):
  // the eight numbered sections plus the tour heading above them.
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(9);
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

test("mobile exposes stable QA contracts", { tag: "@smoke" }, async ({ page }) => {
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
  await expect(tour).toHaveCount(0);

  // The tour no longer auto-pops on load -- it only starts when requested
  // from the help menu.
  await page.getByTestId("sidebar-help-button").click();
  await page.getByTestId("sidebar-tour-replay").click();
  await expect(tour).toBeVisible();
  // Two steps, not three: the labels step went with the labels feature
  // (2026-09-16). Clicked by count rather than by step name because the last
  // click is the one that finishes the tour, and a spare click would land on
  // whatever the tour uncovered instead.
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
