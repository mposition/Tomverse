import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";

// The production incident that produced this suite: a Pro account with 2,932
// plan credits saw "Standard 일일 제한 없음" -- which reads as "nothing can
// stop this request" -- and was then refused by a hidden internal US$1.50/day
// cost ceiling it was never shown.
//
// So the account surface has to say two things at once, on both shells:
//   1. exactly what has no limit (daily *credit* limit on Standard models), and
//   2. what still binds -- the monthly plan credits and when they reset.

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
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
}

for (const shell of ["desktop", "mobile"] as const) {
    test.describe(`${shell} credit entitlement disclosure`, () => {
        test.beforeEach(async ({}, testInfo) => {
            test.skip(
                !testInfo.project.name.startsWith(shell),
                `Runs in ${shell} projects.`
            );
        });

        test("no daily limit is stated as a credit limit, with the allowance that does bind", async ({
            page,
        }) => {
            await prepareChat(page, PRO_UNLIMITED_DAILY);
            const menu = await openAccountMenu(page, shell === "mobile");

            const daily = menu.getByTestId("account-daily-credits");
            await expect(daily).toBeVisible();
            // Never the bare word "unlimited": it has to name what is unlimited.
            await expect(daily).toContainText("일일 크레딧 제한 없음");
            await expect(daily).toContainText("Standard");

            // The monthly plan credits are the allowance that can still block,
            // so they are shown alongside, not hidden behind the daily line.
            const planCredits = menu.getByTestId("account-plan-credits");
            await expect(planCredits).toBeVisible();
            await expect(planCredits).toContainText("2,932");

            // And the user is told when that allowance resets, rather than
            // being shown no reset at all.
            await expect(menu.getByTestId("account-credits-reset")).toBeVisible();
        });

        test("a real daily allowance shows today's usage, the remainder and its reset", async ({
            page,
        }) => {
            await prepareChat(page, PRO_WITH_DAILY_LIMIT);
            const menu = await openAccountMenu(page, shell === "mobile");

            const daily = menu.getByTestId("account-daily-credits");
            await expect(daily).toContainText("232");
            await expect(daily).toContainText("300");
            await expect(menu.getByTestId("account-credits-reset")).toBeVisible();
            await expect(
                menu.getByTestId("account-plan-credits")
            ).toContainText("2,932");
        });
    });
}
