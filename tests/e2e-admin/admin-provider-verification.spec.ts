import { adminApi, expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * STG-R002: administrator provider verification and verified recovery, driven
 * on the real `/admin/providers` route.
 *
 * The rules are unit-tested in `tests/providerRecoveryCore.test.ts`
 * (`evaluateRecoveryEligibility`, `canOfferRecovery`) and enforced again inside
 * the recovery transaction. What none of that shows is whether the rendered
 * console reflects them -- and a disabled-looking button is exactly the thing
 * that can lie:
 *
 *  - is recovery really refused before a verification has succeeded,
 *  - does the cost confirmation really precede a billed provider call,
 *  - does a second click during a request in flight really send nothing.
 *
 * The panel is rendered from `getProviderHealthDashboard()` against the seeded
 * database, so the blocked state under test is a real `ProviderHealthState`
 * row rather than a prop. Verification results are seeded as real
 * `ProviderHealthCheck` rows for the same reason.
 *
 * No provider is ever called: `runProviderVerification` refuses to make a live
 * call outside production without an explicit opt-in, and the one case that
 * needs a POST held open intercepts it in the browser.
 */

const PROVIDER = "perplexity";
const VERIFY_PATH = "/api/admin/provider-health/verify";

const verifyButton = (page: import("@playwright/test").Page) =>
  page.getByTestId(`provider-verify-${PROVIDER}`);
const confirmButton = (page: import("@playwright/test").Page) =>
  page.getByTestId(`provider-verify-confirm-${PROVIDER}`);
const recoverButton = (page: import("@playwright/test").Page) =>
  page.getByTestId(`provider-recover-${PROVIDER}`);
const resultCard = (page: import("@playwright/test").Page) =>
  page.getByTestId(`provider-verification-result-${PROVIDER}`);
/**
 * The real console renders one verification block per provider, so any copy
 * assertion has to resolve inside this provider's block rather than matching
 * the same sentence in every other row.
 */
const verificationSection = (page: import("@playwright/test").Page) =>
  page.getByTestId(`provider-verification-${PROVIDER}`);

/**
 * The self-locking state this feature exists to release: a stale run of
 * failures with no success ever recorded.
 */
const blockProvider = (consecutiveFailures = 5) =>
  adminFixtureDatabase().providerHealthState.upsert({
    where: { provider: PROVIDER },
    create: {
      provider: PROVIDER,
      consecutiveFailures,
      lastFailureAt: new Date(Date.now() - 38 * 3_600_000),
      lastSuccessAt: null,
    },
    update: {
      consecutiveFailures,
      lastFailureAt: new Date(Date.now() - 38 * 3_600_000),
      lastSuccessAt: null,
    },
  });

const clearProviderBlock = () =>
  adminFixtureDatabase().providerHealthState.upsert({
    where: { provider: PROVIDER },
    create: {
      provider: PROVIDER,
      consecutiveFailures: 0,
      lastSuccessAt: new Date(),
    },
    update: { consecutiveFailures: 0, lastSuccessAt: new Date() },
  });

const seedVerification = (
  overrides: {
    status?: string;
    recoveryApplied?: boolean;
    diagnosticCode?: string | null;
    message?: string | null;
  } = {}
) =>
  adminFixtureDatabase().providerHealthCheck.create({
    data: {
      provider: PROVIDER,
      modelId: "perplexity/sonar",
      kind: "live_verification",
      status: overrides.status ?? "success",
      latencyMs: 412,
      diagnosticCode: overrides.diagnosticCode ?? null,
      errorCode: overrides.status === "failed" ? "SERVER_ERROR" : null,
      message: overrides.message ?? null,
      recoveryApplied: overrides.recoveryApplied ?? false,
      createdByEmail: "e2e-ops@tomverse.test",
    },
  });

const openProviders = async (page: import("@playwright/test").Page) => {
  const response = await page.goto("/admin/providers");
  expect(response?.status()).toBeLessThan(400);
  await expect(verifyButton(page)).toBeVisible();
};

test("recovery is refused until a verification has actually succeeded", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();

  // Blocked, but nothing on record authorises releasing it.
  await openProviders(page);
  await expect(recoverButton(page)).toBeDisabled();

  // A failed verification is evidence of a problem, not permission to clear one.
  await seedVerification({
    status: "failed",
    diagnosticCode: "PROVIDER_VERIFICATION_FAILED.AI_APICallError.HTTP_503",
    message: "Perplexity returned an error.",
  });
  await openProviders(page);
  await expect(resultCard(page)).toContainText("Verification failed");
  await expect(resultCard(page)).toContainText(
    "PROVIDER_VERIFICATION_FAILED.AI_APICallError.HTTP_503"
  );
  await expect(recoverButton(page)).toBeDisabled();
});

test("a successful verification on a blocked provider enables recovery and reports its result", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();
  await seedVerification();

  await openProviders(page);
  const card = resultCard(page);
  await expect(card).toContainText("Verification succeeded");
  await expect(card).toContainText("412 ms");
  await expect(card).toContainText("perplexity/sonar");
  await expect(recoverButton(page)).toBeEnabled();
});

test("a healthy provider offers no recovery, even with a successful verification", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await clearProviderBlock();
  await seedVerification();

  await openProviders(page);
  await expect(resultCard(page)).toContainText("Verification succeeded");
  // There is no block to clear. Same NOT_BLOCKED answer the API gives.
  await expect(recoverButton(page)).toBeDisabled();
});

test("a verification already used for a recovery cannot authorise a second one", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();
  await seedVerification({ recoveryApplied: true });

  await openProviders(page);
  await expect(resultCard(page)).toContainText("Already used for a recovery");
  await expect(recoverButton(page)).toBeDisabled();
});

test("a verification is not sent until the billed call is confirmed", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();
  await openProviders(page);

  const posts: string[] = [];
  await page.route(
    (url) => url.pathname === VERIFY_PATH,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts.push(route.request().postData() || "");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ check: { id: "held", status: "success" } }),
      });
    }
  );

  await verifyButton(page).click();
  // The first click opens the confirmation; it does not spend money.
  await expect(confirmButton(page)).toBeVisible();
  expect(posts).toHaveLength(0);
  await expect(
    verificationSection(page).getByText(
      "This sends a real, billed request to Perplexity."
    )
  ).toBeVisible();

  await confirmButton(page).click();
  await expect.poll(() => posts.length).toBe(1);
  // The acknowledgement the API requires is what the dialog stands for.
  expect(JSON.parse(posts[0]!)).toMatchObject({
    provider: PROVIDER,
    acknowledgeProviderCost: true,
  });
});

test("cancelling the confirmation sends nothing", async ({ page, signInAs }) => {
  await signInAs("ops");
  await blockProvider();
  await openProviders(page);

  let posted = false;
  await page.route(
    (url) => url.pathname === VERIFY_PATH,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted = true;
      return route.fallback();
    }
  );

  await verifyButton(page).click();
  await verificationSection(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmButton(page)).toBeHidden();
  expect(posted).toBe(false);
});

test("a second click while a verification is in flight starts no second billed call", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();
  await openProviders(page);

  let posts = 0;
  // Held in an object rather than a bare `let`, so the assignment inside the
  // promise executor is not narrowed away by control-flow analysis.
  const gate: { release: () => void } = { release: () => {} };
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  await page.route(
    (url) => url.pathname === VERIFY_PATH,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      await held;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ check: { id: "held", status: "success" } }),
      });
    }
  );

  await verifyButton(page).click();
  await confirmButton(page).click();

  await expect(verifyButton(page)).toBeDisabled();
  await expect(verifyButton(page)).toContainText("Running verification");
  // Clicking the disabled controls must not queue a second request.
  await verifyButton(page).click({ force: true }).catch(() => {});
  await recoverButton(page).click({ force: true }).catch(() => {});
  expect(posts).toBe(1);

  gate.release();
  await expect(verifyButton(page)).toBeEnabled();
});

test("a role without ops:write is refused by the server, and the console does not offer the controls", async ({
  page,
  signInAs,
}) => {
  await signInAs("support");
  await blockProvider();
  const check = await seedVerification();

  // The server is the control, so it is asserted first and directly.
  const verifyResponse = await adminApi(page).post(VERIFY_PATH, {
    provider: PROVIDER,
    acknowledgeProviderCost: true,
  });
  expect(verifyResponse.status()).toBe(403);
  const recoverResponse = await adminApi(page).post(
    "/api/admin/provider-health/recover",
    { provider: PROVIDER, checkId: check.id }
  );
  expect(recoverResponse.status()).toBe(403);

  // And the block is untouched by the refused calls.
  const state = await adminFixtureDatabase().providerHealthState.findUniqueOrThrow(
    { where: { provider: PROVIDER } }
  );
  expect(state.consecutiveFailures).toBe(5);

  await openProviders(page);
  await expect(verifyButton(page)).toBeDisabled();
  await expect(recoverButton(page)).toBeDisabled();
  await expect(
    verificationSection(page).getByText(
      "Running a verification requires the ops or owner admin role."
    )
  ).toBeVisible();
});

test("a recovery clears the block, is reported honestly, and leaves the traffic history alone", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();
  await seedVerification();
  await openProviders(page);

  await recoverButton(page).click();
  const notice = page.getByTestId("provider-verification-notice");
  await expect(notice).toContainText("Cleared 5 consecutive failures");
  await expect(notice).toContainText(
    "last successful traffic timestamp was not modified"
  );

  const state = await adminFixtureDatabase().providerHealthState.findUniqueOrThrow(
    { where: { provider: PROVIDER } }
  );
  expect(state.consecutiveFailures).toBe(0);
  // The invariant the whole feature rests on, observed through the console.
  expect(state.lastSuccessAt).toBeNull();

  const audit = await adminFixtureDatabase().adminAuditLog.findFirst({
    where: { action: "provider_recovery_succeeded", targetId: PROVIDER },
  });
  expect(audit).not.toBeNull();
});

test("the panel states that the verification call is billed by the provider", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await blockProvider();
  await openProviders(page);

  await expect(
    verificationSection(page).getByText("This call is billed by the provider.", {
      exact: false,
    })
  ).toBeVisible();
  await expect(
    verificationSection(page).getByText("never charges a customer", {
      exact: false,
    })
  ).toBeVisible();
});
