import {
  FIXTURE_MARKETING,
  consoleHeading,
  expect,
  test,
} from "./support/console";

/**
 * The read-only Marketing console
 * (docs/policy/marketing-automation.md §6.1, docs/ui-contracts/admin-console-ia.md).
 *
 * Two things are being pinned here, and they are different claims.
 *
 * The first is that seeded rows reach the screen. A 200 would pass with an
 * empty panel, and this panel fetches after mount, so only a browser can tell
 * the difference between "nothing is waiting" and "the fetch failed".
 *
 * The second is the permission split, which is the part a future change is
 * most likely to get wrong: policy §6.1 gives 기록 열람 ordinary admin
 * authentication, so an administrator with no `marketing:write` and an
 * administrator whose step-up has aged out must both still be able to read.
 * An operator who opens this page to find out why nothing published cannot be
 * told to sign in again -- that refusal reads as a broken console and hides
 * the very state they came for.
 */

test.describe("marketing console", () => {
  test("the queue shows what the Guard sent to a person, and says how many rows it lists", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/marketing?tab=queue");

    await expect(consoleHeading(page)).toHaveText("Marketing");
    await expect(page.getByText(FIXTURE_MARKETING.pending.renderedText)).toBeVisible();
    await expect(
      page.getByText(FIXTURE_MARKETING.channel.accountSlug, { exact: false }).first()
    ).toBeVisible();
    // The Guard's own verdict and code, not a re-derivation of them.
    await expect(
      page.getByText(FIXTURE_MARKETING.pending.guardCode, { exact: false }).first()
    ).toBeVisible();
    // The contract's rule about counts: a page of the newest N says N, and
    // does not present it as a total.
    await expect(page.getByText(/Newest 20 of this section/)).toBeVisible();
  });

  test("published posts carry where they went", async ({ page, signInAs }) => {
    await signInAs("owner");
    await page.goto("/admin/marketing?tab=published");

    await expect(
      page.getByText(FIXTURE_MARKETING.published.externalUrl, { exact: false })
    ).toBeVisible();
  });

  test("accounts show the brand account and its mode", async ({ page, signInAs }) => {
    await signInAs("owner");
    await page.goto("/admin/marketing?tab=accounts");

    await expect(
      page.getByText(FIXTURE_MARKETING.channel.accountSlug, { exact: false }).first()
    ).toBeVisible();
    await expect(page.getByText("approval_mode", { exact: false })).toBeVisible();
  });

  test("reports list the seeded period", async ({ page, signInAs }) => {
    await signInAs("owner");
    await page.goto("/admin/marketing?tab=reports");

    await expect(
      page.getByText(FIXTURE_MARKETING.report.sourceVersion, { exact: false })
    ).toBeVisible();
  });

  test("a section a later stage owns says so instead of looking empty", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");

    await page.goto("/admin/marketing?tab=comments");
    await expect(page.getByText(/stage S4/)).toBeVisible();
    // Not the empty state: "nothing is waiting" would be a false claim about a
    // feature nothing writes yet.
    await expect(page.getByText("Nothing here yet.")).toHaveCount(0);

    await page.goto("/admin/marketing?tab=experiments");
    await expect(page.getByText(/stage S5/)).toBeVisible();
  });

  test("an administrator without marketing:write still reads the queue", async ({
    page,
    signInAs,
  }) => {
    await signInAs("readonly");
    await page.goto("/admin/marketing?tab=queue");

    await expect(consoleHeading(page)).toHaveText("Marketing");
    await expect(page.getByText(FIXTURE_MARKETING.pending.renderedText)).toBeVisible();
  });

  test("a support administrator reads it too", async ({ page, signInAs }) => {
    await signInAs("support");
    await page.goto("/admin/marketing?tab=accounts");

    await expect(
      page.getByText(FIXTURE_MARKETING.channel.accountSlug, { exact: false }).first()
    ).toBeVisible();
  });

  test("someone who is not an administrator gets nothing", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    const response = await page.goto("/admin/marketing?tab=queue");

    expect(response?.status()).toBeGreaterThanOrEqual(400);
  });
});
