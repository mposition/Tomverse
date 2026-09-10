import {
  ADMIN_E2E_IDENTITIES,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";
import { signIn } from "./support/session";

test("a revoked session reaches sign-in and does not loop back to admin", async ({
  context,
  page,
}) => {
  // Set the real signed JWT without resolving it first. Resolving before the
  // database write would intentionally keep the old security snapshot for the
  // bounded cache TTL and would test cache timing instead of this redirect.
  await signIn(context, "owner");
  await adminFixtureDatabase().user.update({
    where: { id: ADMIN_E2E_IDENTITIES.owner.id },
    data: { sessionsRevokedAt: new Date(Date.now() + 60_000) },
  });

  await page.goto("/admin");

  await expect(page).toHaveURL(
    /\/auth\/signin\?callbackUrl=%2Fadmin%2Foverview|\/auth\/signin\?callbackUrl=\/admin\/overview/
  );
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /microsoft/i })).toBeVisible();

  // A rejected NextAuth session remains a truthy object with no user id. The
  // old client treated that object as authenticated and navigated back to the
  // callback immediately, producing the /admin <-> /auth/signin loop.
  const sessionResponse = await page.request.get("/api/auth/session");
  const rejectedSession = (await sessionResponse.json()) as {
    user?: { id?: string };
  };
  expect(rejectedSession.user?.id).toBeUndefined();

  await page.bringToFront();
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  await expect(page).toHaveURL(
    /\/auth\/signin\?callbackUrl=%2Fadmin%2Foverview|\/auth\/signin\?callbackUrl=\/admin\/overview/
  );
});
