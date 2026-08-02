import {
  ADMIN_E2E_BASE_URL,
  ADMIN_E2E_IDENTITIES,
  FIXTURE_FEEDBACK,
  adminApi,
  consoleHeading,
  expect,
  test,
} from "./support/console";
import {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  readSessionContract,
} from "./support/session";

/**
 * The contract between the harness's session cookie and the server that reads
 * it.
 *
 * Every other spec in this directory assumes `signInAs()` produces a session
 * the server recognises. When that assumption broke -- `lib/auth.ts` began
 * choosing the cookie name from `NODE_ENV` while the harness still wrote the
 * development-mode name -- the suite reported it as a hundred locator timeouts
 * against a sign-in page, and not one of them said "the cookie name is wrong".
 *
 * These cases assert the contract itself, so the next time it moves the suite
 * says so directly. They deliberately check the round trip and not just the
 * cookie jar: a `Secure` cookie on an http origin can be stored and then never
 * sent, and only `/api/auth/session` can tell the two apart.
 */

test.describe("admin session contract", () => {
  test("a signed-in owner holds the production session cookie and the server agrees", async ({
    page,
    context,
    signInAs,
  }) => {
    await signInAs("owner");

    const cookies = await context.cookies(ADMIN_E2E_BASE_URL);
    const session = cookies.find((entry) => entry.name === SESSION_COOKIE_NAME);

    // The production name, with the attributes that make the `__Secure-`
    // prefix legitimate. Anything weaker here would mean the harness had been
    // made to pass by lowering the cookie's protection.
    expect(session, `expected a ${SESSION_COOKIE_NAME} cookie`).toBeTruthy();
    expect(session?.secure).toBe(true);
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
    expect(session?.path).toBe("/");
    expect(cookies.some((entry) => entry.name === LEGACY_SESSION_COOKIE_NAME)).toBe(
      false
    );

    // Stored is not sent. This is the assertion that proves Chromium replays a
    // `Secure` cookie to a loopback http origin and the server decodes it.
    const report = await readSessionContract(context, ADMIN_E2E_IDENTITIES.owner);
    expect(report.sessionStatus).toBe(200);
    expect(report.sessionEmail).toBe(ADMIN_E2E_IDENTITIES.owner.email);

    await page.goto("/admin/overview");
    await expect(page).toHaveURL("/admin/overview");
    await expect(consoleHeading(page)).toHaveText("Overview");
  });

  test("signing out returns the same route to sign-in", async ({
    page,
    context,
    signInAs,
    signOutOfAdmin,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/overview");
    await expect(consoleHeading(page)).toHaveText("Overview");

    await signOutOfAdmin();

    const cookies = await context.cookies(ADMIN_E2E_BASE_URL);
    expect(
      cookies.some(
        (entry) =>
          entry.name === SESSION_COOKIE_NAME ||
          entry.name === LEGACY_SESSION_COOKIE_NAME
      )
    ).toBe(false);

    const report = await readSessionContract(context, ADMIN_E2E_IDENTITIES.owner);
    expect(report.emailMatches).toBe(false);

    // `commit` is enough and deliberate: the redirect is decided server-side,
    // and the sign-in page's Turnstile script is unreachable behind the
    // network guard, so waiting for `load` would only buy a 15-second timeout.
    // `admin-access-control.spec.ts` already covers what that page renders.
    await page.goto("/admin/overview", { waitUntil: "commit" });
    await expect(page).toHaveURL(
      /\/auth\/signin\?callbackUrl=%2Fadmin%2Foverview|\/auth\/signin\?callbackUrl=\/admin\/overview/
    );
  });

  test("a readonly session reads through the API and is refused every write", async ({
    page,
    signInAs,
  }) => {
    await signInAs("readonly");
    const api = adminApi(page);

    expect((await api.get("/api/admin/users?take=1")).status()).toBe(200);
    expect(
      (
        await api.patch(`/api/admin/feedback/${FIXTURE_FEEDBACK.open.id}`, {
          status: "resolved",
        })
      ).status()
    ).toBe(403);
  });

  test("a member session is not told the console exists", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");

    // 403 would confirm the surface; the console answers 404 for both the page
    // and the API, and a working session is what makes that meaningful.
    expect((await page.goto("/admin/overview"))?.status()).toBe(404);
    expect((await page.request.get("/api/admin/users?take=1")).status()).toBe(
      404
    );
  });
});
