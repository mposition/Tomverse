import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";

// Owner direction 2026-10-20: profile credit numbers become usage gauges.
// Monthly usage remains visible when no daily quota applies; a real daily
// quota has a separate gauge. The underlying limits and reset are unchanged.

const PRO_UNLIMITED_DAILY = {
    plan: "Pro" as const,
    usage: { creditsDay: 68, creditsMonth: 68 },
    balances: {
        dailyRemainingCredits: null,
        planRemainingCredits: 2_932,
        purchasedRemainingCredits: 0,
    },
    limits: { creditsDay: 0, creditsMonth: 3_000 },
};

const PRO_WITH_DAILY_LIMIT = {
    plan: "Pro" as const,
    usage: { creditsDay: 68, creditsMonth: 68 },
    balances: {
        dailyRemainingCredits: 232,
        planRemainingCredits: 2_932,
        purchasedRemainingCredits: 0,
    },
    limits: { creditsDay: 300, creditsMonth: 3_000 },
};

async function openAccountMenu(page: Page, isMobile: boolean) {
    if (isMobile) {
        await page.getByTestId("mobile-sidebar-open").click();
    }
    await page.getByTestId("account-menu-trigger").click();
    const menu = page.getByTestId("account-menu");
    await expect(menu).toBeVisible();
    return menu;
}

async function prepareChat(page: Page, patch: Parameters<typeof mockUserUsage>[1]) {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
    await mockUserUsage(page, patch);
    await page.goto("/review?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
}

for (const shell of ["desktop", "mobile"] as const) {
    test.describe(`${shell} credit entitlement disclosure`, { tag: "@ui-risk" }, () => {
        test.beforeEach(async ({}, testInfo) => {
            test.skip(
                !testInfo.project.name.startsWith(shell),
                `Runs in ${shell} projects.`
            );
        });

        test("profile shows monthly usage percentage when no daily quota applies", async ({
            page,
        }) => {
            await prepareChat(page, PRO_UNLIMITED_DAILY);
            const menu = await openAccountMenu(page, shell === "mobile");

            const gauges = menu.getByTestId("usage-percent-gauge");
            await expect(gauges).toHaveCount(1);
            await expect(gauges).toContainText("2%");
            await expect(menu.getByRole("progressbar")).toHaveAttribute("value", "2");
            await expect(menu).not.toContainText("2,932");
            await expect(menu.getByTestId("account-credits-reset")).toBeVisible();
        });

        test("profile shows daily and monthly usage percentages with reset time", async ({
            page,
        }) => {
            await prepareChat(page, PRO_WITH_DAILY_LIMIT);
            const menu = await openAccountMenu(page, shell === "mobile");

            const gauges = menu.getByTestId("usage-percent-gauge");
            await expect(gauges).toHaveCount(2);
            await expect(gauges.nth(0)).toContainText("2%");
            await expect(gauges.nth(1)).toContainText("23%");
            await expect(menu.getByTestId("account-credits-reset")).toBeVisible();
            await expect(menu).not.toContainText("2,932");
        });
    });
}
