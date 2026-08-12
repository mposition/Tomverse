import {
  ADMIN_E2E_IDENTITIES,
  FIXTURE_CUSTOMERS,
  FIXTURE_FEEDBACK,
  activeNavLink,
  adminApi,
  consoleHeading,
  expect,
  test,
} from "./support/console";

/**
 * Who may reach the Admin Console, and what they may do once there.
 *
 * Every case drives the real routes: the session is a genuine NextAuth JWT and
 * the authorization decision is made by `lib/adminAuth.ts` reading the same
 * environment variables a deployment uses. Nothing is stubbed, so a regression
 * in `resolveAdminSessionAccessState`, in the layout's redirect order, or in a
 * route handler's permission check fails here.
 */

const NOT_FOUND_HEADING = "We couldn't find that page";
const SWITCH_ACCOUNT_BUTTON = "Sign out and use another account";
/** Where the refusal happened, query string included. */
const REFUSED_URL = "/admin/refunds?status=pending";
const REFUSED_SIGN_IN_URL =
  "/auth/signin?callbackUrl=%2Fadmin%2Frefunds%3Fstatus%3Dpending&reason=switch-account";

test.describe("admin access control", () => {
  test("a signed-out visitor is sent to sign-in with the admin destination preserved", async ({
    page,
  }) => {
    await page.goto("/admin/overview");

    await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=%2Fadmin%2Foverview|\/auth\/signin\?callbackUrl=\/admin\/overview/);
    await expect(consoleHeading(page)).not.toHaveText("Overview");
  });

  test("a signed-in non-administrator is refused without learning the console exists", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    const response = await page.goto("/admin/overview");

    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: NOT_FOUND_HEADING })
    ).toBeVisible();
    // Nothing that would confirm an admin console is behind this URL.
    await expect(page.getByText("Admin Console", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Admin console navigation" })
    ).toHaveCount(0);
  });

  test("the refusal offers a way out of the current session without naming what was refused", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    const response = await page.goto(REFUSED_URL);

    expect(response?.status()).toBe(404);
    // The recovery the page adds. It has to be reachable by keyboard alone,
    // because it is the only control on the page that can change the outcome.
    const switchAccount = page.getByRole("button", {
      name: SWITCH_ACCOUNT_BUTTON,
    });
    await expect(switchAccount).toBeVisible();
    await expect(switchAccount).toBeEnabled();
    await switchAccount.focus();
    await expect(switchAccount).toBeFocused();

    await expect(
      page.getByText(
        "The link may be out of date, the page may have moved, or you may need to use a different account."
      )
    ).toBeVisible();
    // The old copy blamed everything except the account, which was the one
    // thing that could actually be wrong here.
    await expect(page.getByText("Nothing is wrong with your account")).toHaveCount(0);

    // Still nothing that would confirm what is behind the URL: no console
    // chrome, no role, no navigation, and no mention of administration at all.
    await expect(page.getByText("Admin Console", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Admin console navigation" })
    ).toHaveCount(0);
    await expect(page.getByText(/administrat/i)).toHaveCount(0);
    await expect(page.getByText(/permission|allowlist|not authorized/i)).toHaveCount(0);

    // The secondary routes out stay where they were.
    for (const name of [
      "Go to the homepage",
      "Open the chat workspace",
      "Contact support",
    ]) {
      await expect(page.getByRole("link", { name })).toBeVisible();
    }
  });

  test("an unrouted admin URL is answered identically, so the 404 is no oracle", async ({
    page,
    signInAs,
  }) => {
    // If the account-switch offer appeared only on real console routes, the
    // page would map the console's URL space for anyone who asked.
    await signInAs("member");
    const response = await page.goto("/admin/this-console-route-does-not-exist");

    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: NOT_FOUND_HEADING })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: SWITCH_ACCOUNT_BUTTON })
    ).toBeVisible();
  });

  test("switching accounts really ends the session and preserves the destination", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    await page.goto(REFUSED_URL);

    // The button is disabled while the sign-out is in flight, so a second
    // click cannot start a second one.
    await page.route("**/api/auth/signout", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    const switchAccount = page.getByRole("button", {
      name: SWITCH_ACCOUNT_BUTTON,
    });
    // Keyboard activation, since that is how this control is reached without a
    // pointer.
    await switchAccount.focus();
    await switchAccount.press("Enter");
    const pending = page.getByRole("button", { name: "Signing out…" });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");

    await expect(page).toHaveURL(REFUSED_SIGN_IN_URL);
    await expect(
      page.getByTestId("signin-account-switch-notice")
    ).toHaveText("The previous session was ended. Choose an account to continue.");

    // The session is gone from the browser and from the server's point of
    // view -- the whole point on a shared computer.
    const cookies = await page.context().cookies();
    expect(
      cookies.some((cookie) => cookie.name.endsWith("next-auth.session-token"))
    ).toBe(false);
    const session = await page.request.get("/api/auth/session");
    expect(await session.json()).toEqual({});

    // Signing in as an account that *is* on the allowlist lands on the
    // original destination, query string intact.
    await signInAs("owner");
    await page.reload();

    await expect(page).toHaveURL(REFUSED_URL);
    await expect(consoleHeading(page)).toHaveText("Refunds");
  });

  test("a failed sign-out re-enables the button and says so", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    await page.goto(REFUSED_URL);
    await page.route("**/api/auth/signout", (route) => route.abort());

    const switchAccount = page.getByRole("button", {
      name: SWITCH_ACCOUNT_BUTTON,
    });
    await switchAccount.click();

    // Announced, and named by the button that failed -- not just red text
    // somewhere on the page. (`getByRole("alert")` alone would also match
    // Next's route announcer.)
    const error = page.locator("#not-found-switch-account-error");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toHaveText(
      "Could not end the current session. Please try again."
    );
    await expect(switchAccount).toHaveAttribute(
      "aria-describedby",
      "not-found-switch-account-error"
    );
    await expect(switchAccount).toBeEnabled();
    // Still on the 404: a sign-out that did not happen must not be reported as
    // one by navigating away.
    await expect(page).toHaveURL(REFUSED_URL);

    // And the retry works once the endpoint does.
    await page.unroute("**/api/auth/signout");
    await switchAccount.click();
    await expect(page).toHaveURL(REFUSED_SIGN_IN_URL);
  });

  test("account switching asks the identity provider for the account chooser", async ({
    page,
  }) => {
    // Signed out, which is the state the sign-out above leaves behind: the
    // sign-in page forwards an authenticated visitor instead of offering
    // providers at all.
    //
    // The provider's own session is untouched; what changes is that this one
    // authorization request carries `prompt=select_account`, so a shared
    // computer cannot silently hand back the account that was just refused.
    const authorizationUrls: string[] = [];
    for (const provider of ["google", "azure-ad"]) {
      await page.route(`**/api/auth/signin/${provider}*`, async (route) => {
        authorizationUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ url: "/auth/signin?provider-stub=1" }),
        });
      });
    }
    // `signIn()` refuses to post to a provider the server does not list, and
    // the harness configures no Azure tenant. Listing it here is the only part
    // of this test that is not the real server -- what is under test is that
    // the page sends the same authorization parameter for both buttons, and
    // NextAuth merges that parameter into the provider's authorization URL by
    // one shared code path, which the Google leg exercises for real.
    await page.route("**/api/auth/providers*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          google: { id: "google", name: "Google", type: "oauth" },
          "azure-ad": { id: "azure-ad", name: "Azure Active Directory", type: "oauth" },
        }),
      })
    );

    await page.goto(REFUSED_SIGN_IN_URL);
    await page.getByRole("button", { name: /google/i }).click();
    await expect.poll(() => authorizationUrls.length).toBe(1);
    expect(authorizationUrls[0]).toContain("prompt=select_account");
    // The stub answers with a URL the client then navigates to; let that
    // settle before driving the next case.
    await page.waitForURL(/provider-stub=1/);

    await page.goto(REFUSED_SIGN_IN_URL);
    await page.getByRole("button", { name: /microsoft/i }).click();
    await expect.poll(() => authorizationUrls.length).toBe(2);
    expect(authorizationUrls[1]).toContain("/api/auth/signin/azure-ad");
    expect(authorizationUrls[1]).toContain("prompt=select_account");
    await page.waitForURL(/provider-stub=1/);

    // An ordinary sign-in is unchanged: nothing forces the chooser there.
    await page.goto("/auth/signin?callbackUrl=%2Fchat");
    await page.getByRole("button", { name: /google/i }).click();
    await expect.poll(() => authorizationUrls.length).toBe(3);
    expect(authorizationUrls[2]).not.toContain("prompt");
  });

  test("the admin API answers a non-administrator with 404 rather than 403", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    // 403 would confirm the endpoint exists and is merely forbidden. The
    // console's own users endpoint deliberately answers "Not found." instead.
    const response = await page.request.get("/api/admin/users?take=1");

    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Not found." });
  });

  test("a stale administrator session is sent to reauthentication and returns to the original destination", async ({
    page,
    signInAs,
  }) => {
    // Past the 8-hour ADMIN_SESSION_MAX_HOURS window the harness configures.
    await signInAs("owner", { authenticatedMinutesAgo: 9 * 60 });
    await page.goto("/admin/refunds");

    await expect(page).toHaveURL(
      "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Frefunds"
    );
    await expect(
      page.getByRole("heading", {
        name: "Administrator reauthentication required",
      })
    ).toBeVisible();
    await expect(page.getByText(ADMIN_E2E_IDENTITIES.owner.email)).toBeVisible();

    // Signing in again is what the card asks for. Once the session is recent,
    // the same URL forwards to where the administrator was originally going.
    await signInAs("owner");
    await page.goto("/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Frefunds");

    await expect(page).toHaveURL("/admin/refunds");
    await expect(consoleHeading(page)).toHaveText("Refunds");
  });

  test("readonly reaches every read surface but the console marks it unwritable", async ({
    page,
    signInAs,
  }) => {
    await signInAs("readonly");
    await page.goto("/admin/users");

    await expect(consoleHeading(page)).toHaveText("Users");
    await expect(page.getByText("Read-only for readonly")).toBeVisible();
    // The role badge in the header, and the sidebar's per-entry "Read" marker.
    await expect(page.getByText("Role: readonly")).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Admin console navigation",
    });
    await expect(activeNavLink(page)).toHaveAttribute("href", "/admin/users");
    // The marker is part of each entry's accessible name, so a screen reader
    // hears it rather than only seeing the "Read" chip.
    await expect(
      navigation.getByRole("link", { name: "Users, read-only" })
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: /^Refunds,.*read-only$/ })
    ).toBeVisible();
    // Entries with no write restriction stay unmarked.
    await expect(
      navigation.getByRole("link", { name: "Audit log", exact: true })
    ).toBeVisible();
  });

  test("readonly cannot mutate through the API even when the UI is bypassed", async ({
    page,
    signInAs,
  }) => {
    await signInAs("readonly");
    const api = adminApi(page);

    const feedback = await api.patch(
      `/api/admin/feedback/${FIXTURE_FEEDBACK.open.id}`,
      { status: "resolved" }
    );
    expect(feedback.status()).toBe(403);

    const planAdjust = await api.patch(
      `/api/admin/users/${FIXTURE_CUSTOMERS.activePro.id}/plan-adjust`,
      {
        plan: "Max",
        reason: "readonly should never reach this",
        confirmText: "ADJUST PLAN",
        subscriptionStatus: "manually_adjusted",
        billingInterval: "monthly",
      }
    );
    expect(planAdjust.status()).toBe(403);

    const incident = await api.post("/api/admin/incidents", {
      provider: "openai",
      status: "limited",
      title: "readonly should never reach this",
    });
    expect(incident.status()).toBe(403);

    // The read surfaces stay reachable for the same identity, so the 403s
    // above are the role check and not a session problem.
    expect((await api.get("/api/admin/users?take=1")).status()).toBe(200);
  });

  test("write permissions are scoped to the role that owns them", async ({
    page,
    signInAs,
  }) => {
    const api = adminApi(page);

    // support:write covers the feedback inbox and not the billing catalogue.
    // Closing feedback now requires the closure outcome the completion dialog
    // collects; the permission is what is under test, the payload just has to
    // be a valid close.
    await signInAs("support");
    const supportOnFeedback = await api.patch(
      `/api/admin/feedback/${FIXTURE_FEEDBACK.open.id}`,
      { status: "resolved", outcomeCode: "answered" }
    );
    expect(supportOnFeedback.status()).toBe(200);

    const supportOnPlan = await api.patch(
      `/api/admin/users/${FIXTURE_CUSTOMERS.activePro.id}/plan-adjust`,
      {
        plan: "Max",
        reason: "support should not be able to change a plan",
        confirmText: "ADJUST PLAN",
        subscriptionStatus: "manually_adjusted",
        billingInterval: "monthly",
      }
    );
    expect(supportOnPlan.status()).toBe(403);

    // billing:write is the mirror image.
    await signInAs("billing");
    const billingOnFeedback = await api.patch(
      `/api/admin/feedback/${FIXTURE_FEEDBACK.slaBreached.id}`,
      { status: "resolved", outcomeCode: "answered" }
    );
    expect(billingOnFeedback.status()).toBe(403);

    const billingOnIncident = await api.post("/api/admin/incidents", {
      provider: "openai",
      status: "limited",
      title: "billing should not be able to open an incident",
    });
    expect(billingOnIncident.status()).toBe(403);

    // ops:write owns incidents.
    await signInAs("ops");
    const opsOnIncident = await api.post("/api/admin/incidents", {
      provider: "openai",
      status: "limited",
      title: "E2E ops incident",
      message: "Opened by the admin E2E role matrix.",
    });
    expect(opsOnIncident.ok()).toBe(true);
  });
});
