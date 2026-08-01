import { expect, test as base, type Page } from "@playwright/test";
import { resetAndSeedAdminFixtures } from "./database";
import { signIn, signOut, type SignInOptions } from "./session";
import {
  ADMIN_E2E_BASE_URL,
  type AdminE2EIdentityKey,
} from "./harness-config";

export { expect } from "@playwright/test";
export * from "./fixture-data";
export * from "./harness-config";

type AdminFixtures = {
  /**
   * Truncates and re-seeds the database before the test body runs. Automatic,
   * so no spec can accidentally inherit another spec's writes and no spec
   * depends on the order the file list happens to be in.
   */
  seededAt: Date;
  signInAs: (
    key: AdminE2EIdentityKey,
    options?: SignInOptions
  ) => Promise<void>;
  signOutOfAdmin: () => Promise<void>;
};

// Playwright names a fixture's second argument `use`, which the
// `react-hooks/rules-of-hooks` lint rule reads as a React hook call. It is
// just a callback, so it is named `provide` here.
export const test = base.extend<AdminFixtures>({
  seededAt: [
    async ({}, provide) => {
      const { seededAt } = await resetAndSeedAdminFixtures();
      await provide(seededAt);
    },
    { auto: true },
  ],
  signInAs: async ({ context }, provide) => {
    await provide(async (key, options) => {
      await signIn(context, key, options);
    });
  },
  signOutOfAdmin: async ({ context }, provide) => {
    await provide(async () => {
      await signOut(context);
    });
  },
});

/**
 * Sends an admin API request the way the console's own `fetch` does.
 *
 * `page.request` shares the browser context's cookie jar but does not add an
 * `Origin` header, and `lib/requestOrigin.ts` rejects every mutation that
 * arrives without a matching one. Omitting it would make a permission test
 * pass for the wrong reason -- a 403 from the CSRF guard looks exactly like a
 * 403 from the role check -- so the header is always set, and these helpers
 * are the only way the specs call a mutating endpoint.
 */
export const adminApi = (page: Page) => {
  const headers = { Origin: ADMIN_E2E_BASE_URL };
  return {
    get: (url: string) => page.request.get(url, { headers }),
    post: (url: string, data?: unknown) =>
      page.request.post(url, { headers, data: data ?? {} }),
    patch: (url: string, data?: unknown) =>
      page.request.patch(url, { headers, data: data ?? {} }),
    put: (url: string, data?: unknown) =>
      page.request.put(url, { headers, data: data ?? {} }),
    delete: (url: string, data?: unknown) =>
      page.request.delete(url, { headers, data: data ?? {} }),
  };
};

/** The console's `<h1>`, which `AdminConsoleShell` derives from the pathname. */
export const consoleHeading = (page: Page) =>
  page.getByRole("heading", { level: 1 });

/**
 * The sidebar entry the shell marks as the current page.
 *
 * `aria-current` rather than the active item's background colour: the visited
 * state is a real semantic, and asserting on a Tailwind class would tie the
 * suite to styling that is free to change.
 */
export const activeNavLink = (page: Page) =>
  page
    .getByRole("navigation", { name: "Admin console navigation" })
    .locator('a[aria-current="page"]');

/** Opens the mobile navigation drawer, which only exists below `lg`. */
export const openMobileNav = async (page: Page) => {
  await page.getByRole("button", { name: "Open admin navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Close navigation" })
  ).toBeVisible();
};
