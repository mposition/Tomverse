import { test, expect } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";

/**
 * docs/policy/external-conversation-import-and-memory.md §16.
 *
 * The seven-locale parity of the Release B privacy copy is a static test
 * (tests/memoryPrivacyCopy.test.mjs); §16 asks E2E to cover the two
 * representative locales rendering, and nothing more — a seven-locale
 * privacy matrix is explicitly out of scope.
 *
 * What this catches that the static test cannot: the section reaching the
 * page at all. A key that exists and is referenced in a `sections` array can
 * still fail to render if the page stops mapping over that array.
 */

const LOCALES = [
    { lang: "ko" as const, bundle: ko },
    { lang: "en" as const, bundle: en },
];

for (const { lang, bundle } of LOCALES) {
    test(`the privacy page renders the memory section in ${lang}`, async ({
        page,
    }) => {
        await prepareGuestPage(page, lang);
        await page.goto("/privacy");

        const heading = page.getByRole("heading", {
            name: bundle.privacyPolicy.memoryTitle,
        });
        await expect(heading).toBeVisible();

        // A distinctive clause rather than the whole paragraph: the assertion
        // should survive a copy edit that does not change what is disclosed.
        const sentence = bundle.privacyPolicy.memory.split(". ")[0];
        await expect(
            page.getByText(sentence.slice(0, 40), { exact: false }).first()
        ).toBeVisible();
    });
}
