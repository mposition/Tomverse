import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test.describe("compact sidebar layout", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-compact",
      "Compact sidebar layout is verified at the short desktop viewport."
    );
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("auto-collapses organizer tools and preserves conversation space", async ({
    page,
  }) => {
    const organizerToggle = page.getByTestId("sidebar-organizer-toggle");
    await expect(organizerToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("sidebar-organizer-content")).toBeHidden();

    const conversationList = page.getByTestId("sidebar-conversation-list");
    const listBox = await conversationList.boundingBox();
    expect(listBox).not.toBeNull();
    expect(listBox!.height).toBeGreaterThanOrEqual(160);
  });

  test("persists a manual organizer preference and summarizes the active filter", async ({
    page,
  }) => {
    const organizerToggle = page.getByTestId("sidebar-organizer-toggle");
    await organizerToggle.click();
    await expect(organizerToggle).toHaveAttribute("aria-expanded", "true");
    // The status filters, which is what the organizer holds now. The label
    // filters this used to click went with the labels feature, and a selector
    // for a block that no longer renders fails as a missing element rather
    // than as the thing this case was written to check: that the collapsed
    // toggle still names the filter that is on.
    await page
      .getByTestId("sidebar-status-filters")
      .getByRole("button", { name: "비밀번호 잠금" })
      .click();
    await organizerToggle.click();
    await expect(organizerToggle).toContainText("비밀번호 잠금");
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("tomverse_sidebar_organizer_v1")
        )
      )
      .toBe("collapsed");

    await organizerToggle.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("tomverse_sidebar_organizer_v1")
        )
      )
      .toBe("expanded");
    await page.reload();
    await expect(page.getByTestId("sidebar-organizer-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });
});
