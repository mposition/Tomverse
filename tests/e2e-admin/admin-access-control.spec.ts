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
    await expect(activeNavLink(page)).toHaveText("Users");
    await expect(
      navigation.getByRole("link", { name: "Users Read" })
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "Refunds Read" })
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
    await signInAs("support");
    const supportOnFeedback = await api.patch(
      `/api/admin/feedback/${FIXTURE_FEEDBACK.open.id}`,
      { status: "resolved" }
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
      { status: "resolved" }
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
