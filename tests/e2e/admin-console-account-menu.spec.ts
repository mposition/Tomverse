import { expect, test, type Page } from "@playwright/test";

/**
 * The Admin Console's account menu.
 *
 * The header used to render the signed-in administrator's name as a `<span>`,
 * so the console had no sign-out at all -- and "sign out completely, then sign
 * in again" is the only thing that clears either administrator authentication
 * window. An operator refused a high-risk change was told to do something the
 * console gave them no control for.
 *
 * The fixture route mounts the real `AdminConsoleShell`, which is where the
 * menu lives, so these run on the desktop and mobile projects alike: the chip
 * was `hidden md:flex`, and a phone is exactly where a missing sign-out
 * stranded someone.
 */

const FIXTURE = "/e2e/admin-console-fixture";

const openConsole = async (page: Page) => {
  await page.goto(FIXTURE);
  await expect(page.getByTestId("admin-account-menu-trigger")).toBeVisible();
  await page.waitForFunction(() => {
    const element = document.querySelector(
      '[data-testid="admin-account-menu-trigger"]'
    );
    return (
      !!element &&
      Object.keys(element).some((key) => key.startsWith("__reactFiber$"))
    );
  });
};

test.describe("admin console account menu", () => {
  test("is reachable and names the account and role", async ({ page }) => {
    await openConsole(page);

    const trigger = page.getByRole("button", {
      name: /Account menu for QA Administrator \(owner\)/i,
    });
    // The visible label is truncated and hidden below `md`, so the accessible
    // name is what has to carry the identity on every viewport.
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = page.getByRole("menu", { name: "Administrator account" });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Return to Tomverse" })
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Sign out" })
    ).toBeVisible();
  });

  test("opens, moves and closes from the keyboard", async ({ page }) => {
    await openConsole(page);
    const trigger = page.getByTestId("admin-account-menu-trigger");

    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Administrator account" });
    await expect(menu).toBeVisible();

    // The first item takes focus on open, so the menu is usable without a
    // pointer at all.
    await expect(page.getByTestId("admin-account-menu-home")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("admin-account-menu-signout")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("admin-account-menu-home")).toBeFocused();

    // Escape closes it and hands focus back, rather than dropping the caller
    // at the top of the document.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("says that signing out does not extend either window", async ({
    page,
  }) => {
    await openConsole(page);
    await page.getByTestId("admin-account-menu-trigger").click();

    // Sign-out is a way *out*, never a way to refresh a step-up window. The
    // menu says so, because the tempting misreading is that pressing it is a
    // cheaper substitute for the reauthentication flow.
    await expect(
      page.getByRole("menu", { name: "Administrator account" })
    ).toContainText(/does not extend the administrator or high-risk sign-in/i);
  });

  test("closes when the pointer goes elsewhere", async ({ page }) => {
    await openConsole(page);
    await page.getByTestId("admin-account-menu-trigger").click();
    await expect(page.getByTestId("admin-account-menu")).toBeVisible();

    // A real press somewhere the menu is not. Deliberately a coordinate rather
    // than a locator: on a narrow viewport the open menu covers most of what
    // is under it, so a locator click would be intercepted by the menu itself
    // and prove nothing about pressing outside it.
    const box = await page.getByTestId("admin-account-menu").boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(8, Math.round((box?.y ?? 100) + (box?.height ?? 0) + 40));
    await expect(page.getByTestId("admin-account-menu")).toHaveCount(0);
  });

  test("does not disturb the console's own navigation", async ({ page }) => {
    await openConsole(page);

    // The header's other controls are unchanged and still reachable with the
    // menu present: the command palette on every viewport, the drawer button
    // only below `lg`, where it belongs.
    await expect(
      page.getByRole("button", {
        name: "Open global search and command palette",
      })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open notification center" })
    ).toBeVisible();

    const viewport = page.viewportSize();
    const drawerButton = page.getByRole("button", {
      name: "Open admin navigation",
    });
    if (viewport && viewport.width < 1024) {
      await expect(drawerButton).toBeVisible();
    } else {
      await expect(drawerButton).toBeHidden();
    }
  });
});
