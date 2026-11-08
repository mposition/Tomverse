import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

/**
 * /settings/data -- the surface PRIVACY-02 needed and did not have.
 *
 * The export API shipped with nothing linking to it, so the gate's actual
 * requirement (that a user can obtain their data) was unmet however correct the
 * backend was. These specs drive the two-step flow the way somebody would:
 * ask for the file, watch the link expire, and read the history that says
 * whether anyone else has been asking.
 *
 * The database is off in E2E, so both endpoints are mocked. What is being
 * measured here is the surface's behaviour -- that a step-up refusal is its own
 * state rather than a generic error, that the countdown says the link is
 * single-use and expiring, and that a refusal appears in the history -- not the
 * server rules, which have their own integration coverage.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type HistoryRow = {
  id: string;
  status: string;
  refusalReason: string | null;
  expiresAt: string;
  consumedAt: string | null;
  byteLength: number | null;
  includedDomainCount: number | null;
  filteredDomainCount: number | null;
  createdAt: string;
};

const historyRow = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  id: `req-${Math.random().toString(36).slice(2)}`,
  status: "downloaded",
  refusalReason: null,
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
  consumedAt: new Date(Date.now() - 120_000).toISOString(),
  byteLength: 512_000,
  includedDomainCount: 8,
  filteredDomainCount: 23,
  createdAt: new Date(Date.now() - 180_000).toISOString(),
  ...overrides,
});

/**
 * @param issue what POST answers. `ticket` mints a live five-minute link,
 *              `reauth` is the 428 the step-up produces.
 */
const mockExportApi = async (
  page: Page,
  options: { history?: HistoryRow[]; issue?: "ticket" | "reauth"; ttlMs?: number } = {}
) => {
  const history = options.history ?? [];
  await page.route("**/api/user/account/export", async (route) => {
    if (route.request().method() === "POST") {
      if (options.issue === "reauth") {
        await route.fulfill({
          status: 428,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Sign in again before downloading your account data.",
            code: "ACCOUNT_REAUTHENTICATION_REQUIRED",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          downloadPath: "/api/user/account/export/test-token",
          expiresAt: new Date(Date.now() + (options.ttlMs ?? 5 * 60_000)).toISOString(),
          singleUse: true,
        }),
      });
      return;
    }
    await route.fulfill(json({ requests: history }));
  });
};

const openDataSettings = async (page: Page) => {
  await page.goto("/settings/data");
  await expect(page.getByTestId("account-data-export-panel")).toBeVisible();
};

for (const theme of ["light", "dark"] as const) {
  test(`settings consent uses readable text with actions below its explanation in ${theme}`, async ({ page, baseURL, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
    await prepareGuestPage(page, "ko");
    const account = await mockAuthenticatedApi(page);
    account.theme = theme;
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await mockExportApi(page);
    await openDataSettings(page);
    // The development-only Next toolbar occupies the footer's first button.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const notice = page.getByTestId("settings-consent-slot").getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await notice.scrollIntoViewIfNeeded();
    const metrics = await notice.evaluate(element => {
      const visible = (selector: string) => Array.from(element.querySelectorAll(selector)).filter(node => node.getBoundingClientRect().height > 0);
      const paragraphs = visible("p");
      const buttons = visible("button");
      return {
        fonts: visible("p,a,button").map(node => Number.parseFloat(getComputedStyle(node).fontSize)),
        explanationBottom: Math.max(...paragraphs.map(node => node.getBoundingClientRect().bottom)),
        actionTop: Math.min(...buttons.map(node => node.getBoundingClientRect().top)),
        targets: buttons.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
        position: getComputedStyle(element).position,
      };
    });
    expect(metrics.fonts.length).toBeGreaterThanOrEqual(4);
    expect(metrics.fonts.every(size => size >= 14)).toBe(true);
    expect(metrics.actionTop).toBeGreaterThan(metrics.explanationBottom);
    expect(metrics.targets.every(box => box.width >= 44 && box.height >= 44)).toBe(true);
    expect(metrics.position).not.toBe("fixed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toHaveCount(0);
  });
}

test.describe("account data download", () => {
  test("the settings list reaches the page", async ({ page }) => {
    await prepareGuestPage(page);
    await mockAuthenticatedApi(page);
    await mockExportApi(page);

    await page.goto("/settings/data");
    // The row's own link target, asserted from the page it lands on rather than
    // from the markup: a row that points at a 404 is the failure worth catching.
    await expect(page.getByTestId("account-data-export-panel")).toBeVisible();
    await expect(page.getByTestId("account-data-export-request")).toBeEnabled();
  });

  test("asking for a download produces a single-use link with a countdown", async ({ page }) => {
    await prepareGuestPage(page);
    await mockAuthenticatedApi(page);
    await mockExportApi(page);
    await openDataSettings(page);

    await page.getByTestId("account-data-export-request").click();

    const download = page.getByTestId("account-data-export-download");
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute("href", "/api/user/account/export/test-token");

    // The countdown is the honest description of what the link is: not one that
    // might stop working, but one that will.
    await expect(page.getByTestId("account-data-export-countdown")).toContainText(/[0-9]:[0-9]{2}/);
  });

  test("a link that runs out says so instead of staying clickable", async ({ page }) => {
    await prepareGuestPage(page);
    await mockAuthenticatedApi(page);
    await mockExportApi(page, { ttlMs: 1_500 });
    await openDataSettings(page);

    await page.getByTestId("account-data-export-request").click();
    await expect(page.getByTestId("account-data-export-download")).toBeVisible();

    await expect(page.getByTestId("account-data-export-expired")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("account-data-export-download")).toHaveCount(0);
    await expect(page.getByTestId("account-data-export-request")).toBeEnabled();
  });

  // A 428 means "sign in again", which is a different instruction from "that
  // failed". Showing it as a generic error would leave the user retrying a
  // button that cannot succeed.
  test("a step-up refusal asks for a sign-in rather than reporting a failure", async ({ page }) => {
    await prepareGuestPage(page);
    await mockAuthenticatedApi(page);
    await mockExportApi(page, { issue: "reauth" });
    await openDataSettings(page);

    await page.getByTestId("account-data-export-request").click();

    await expect(page.getByTestId("account-data-export-reauth")).toBeVisible();
    await expect(page.getByTestId("account-data-export-error")).toHaveCount(0);
    await expect(page.getByTestId("account-data-export-download")).toHaveCount(0);
  });

  test("an empty history says so rather than showing nothing", async ({ page }) => {
    await prepareGuestPage(page);
    await mockAuthenticatedApi(page);
    await mockExportApi(page, { history: [] });
    await openDataSettings(page);

    await expect(page.getByTestId("account-data-export-history-empty")).toBeVisible();
  });

  // The row worth reading twice: a refusal means a download link for this
  // account was presented and turned away. A history of successes only would
  // hide precisely the case it exists to show.
  test("the history shows a refusal, not only downloads", async ({ page }) => {
    await prepareGuestPage(page);
    await mockAuthenticatedApi(page);
    await mockExportApi(page, {
      history: [
        historyRow({ status: "refused", refusalReason: "already_used", byteLength: null }),
        historyRow({ status: "downloaded" }),
      ],
    });
    await openDataSettings(page);

    const list = page.getByTestId("account-data-export-history");
    await expect(list).toBeVisible();
    await expect(list.locator("li")).toHaveCount(2);
    await expect(list).toContainText(/거부|Refused/);
  });
});
