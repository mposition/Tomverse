import { expect, test, type Page } from "@playwright/test";

/**
 * STG-R002: the Provider Health panel's verification and recovery controls.
 *
 * The rules these controls encode are unit-tested in
 * `tests/providerRecoveryCore.test.ts` (`evaluateRecoveryEligibility`,
 * `canOfferRecovery`) and enforced again server-side by
 * `/api/admin/provider-health/recover`, which re-reads the evidence inside its
 * own transaction. What none of that shows is whether the rendered console
 * actually reflects them: whether the recovery button is really disabled
 * before a successful verification, whether the cost confirmation really
 * appears before a billed call is made, and whether a second click during a
 * request in flight is really refused.
 *
 * Those are the things a disabled-looking button can lie about, so they are
 * asserted here against a real browser.
 *
 * Every response is controlled with network interception. Nothing on the
 * server is relaxed: the real `/api/admin/**` handlers keep their session,
 * permission, rate-limit and cooldown checks, and this spec never reaches a
 * provider.
 */

const PROVIDER = "perplexity";
const VERIFY_PATH = "/api/admin/provider-health/verify";
const RECOVER_PATH = "/api/admin/provider-health/recover";

const verifyButton = (page: Page) =>
  page.getByTestId(`provider-verify-${PROVIDER}`);
const confirmButton = (page: Page) =>
  page.getByTestId(`provider-verify-confirm-${PROVIDER}`);
const recoverButton = (page: Page) =>
  page.getByTestId(`provider-recover-${PROVIDER}`);
const resultCard = (page: Page) =>
  page.getByTestId(`provider-verification-result-${PROVIDER}`);

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const successfulCheck = (overrides: Record<string, unknown> = {}) => ({
  id: "check-success-1",
  provider: PROVIDER,
  status: "success",
  modelId: "perplexity/sonar",
  latencyMs: 412,
  diagnosticCode: null,
  errorCode: null,
  message: null,
  createdAt: new Date().toISOString(),
  createdByEmail: "qa@tomverse.app",
  recoveryApplied: false,
  ...overrides,
});

const failedCheck = () =>
  successfulCheck({
    id: "check-failed-1",
    status: "failed",
    diagnosticCode: "PROVIDER_VERIFICATION_FAILED.AI_APICallError.HTTP_503",
    errorCode: "SERVER_ERROR",
    message: "Perplexity returned an error.",
  });

/**
 * Serves the panel's history endpoint. `checks` is what GET returns, so a test
 * can open the page with a verification already on record.
 */
async function openFixture(
  page: Page,
  {
    providerState = "incident",
    canVerify = true,
    lastCheck = null,
  }: {
    providerState?: "incident" | "operational" | "noVerificationModel";
    canVerify?: boolean;
    lastCheck?: Record<string, unknown> | null;
  } = {}
) {
  await page.route(
    (url) => url.pathname === VERIFY_PATH,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill(
            json({
              providers: {
                [PROVIDER]: {
                  provider: PROVIDER,
                  lastCheck,
                  recentRecoveries: [],
                },
              },
            })
          )
        : route.fallback()
  );
  // The panel refreshes the dashboard on a visibility tick and again after
  // every action. That request is left pending rather than answered: any
  // response would replace the server-rendered fixture row -- unmounting the
  // very controls under test -- and a rejection would raise a load-failure
  // banner that the error assertions below would then have to exclude.
  // Leaving it in flight keeps the initial snapshot exactly as rendered.
  await page.route(
    (url) => url.pathname === "/api/admin/provider-health",
    () => new Promise<void>(() => {})
  );

  const response = await page.goto(
    `/e2e/admin-console-fixture?view=provider-health&providerState=${providerState}&canVerify=${canVerify}`
  );
  expect(response?.status()).toBeLessThan(400);
  await expect(verifyButton(page)).toBeVisible();
}

test("a verification is not sent until the billed call is confirmed", async ({
  page,
}) => {
  await openFixture(page);

  const posts: string[] = [];
  await page.route(
    (url) => url.pathname === VERIFY_PATH,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts.push(route.request().postData() || "");
      return route.fulfill(json({ check: successfulCheck() }));
    }
  );

  await verifyButton(page).click();
  // The first click opens the confirmation, it does not spend money.
  await expect(confirmButton(page)).toBeVisible();
  expect(posts).toHaveLength(0);
  await expect(
    page.getByText("This sends a real, billed request to Perplexity.")
  ).toBeVisible();

  await confirmButton(page).click();
  await expect.poll(() => posts.length).toBe(1);
  // The cost acknowledgement the API requires is what the dialog stands for.
  expect(JSON.parse(posts[0]!)).toMatchObject({
    provider: PROVIDER,
    acknowledgeProviderCost: true,
  });
});

test("cancelling the confirmation sends nothing", async ({ page }) => {
  await openFixture(page);

  let posted = false;
  await page.route(
    (url) => url.pathname === VERIFY_PATH,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted = true;
      return route.fulfill(json({ check: successfulCheck() }));
    }
  );

  await verifyButton(page).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmButton(page)).toBeHidden();
  expect(posted).toBe(false);
});

test("recovery is refused until a verification has actually succeeded", async ({
  page,
}) => {
  // Blocked provider, no verification on record: nothing authorises a recovery.
  await openFixture(page, { providerState: "incident", lastCheck: null });
  await expect(recoverButton(page)).toBeDisabled();

  // A failed verification is evidence of a problem, not permission to clear one.
  await page.reload();
  await openFixture(page, {
    providerState: "incident",
    lastCheck: failedCheck(),
  });
  await expect(resultCard(page)).toContainText("Verification failed");
  await expect(recoverButton(page)).toBeDisabled();
});

test("a successful verification on a blocked provider enables recovery, and reports its result", async ({
  page,
}) => {
  await openFixture(page, {
    providerState: "incident",
    lastCheck: successfulCheck(),
  });

  const card = resultCard(page);
  await expect(card).toContainText("Verification succeeded");
  await expect(card).toContainText("412 ms");
  await expect(card).toContainText("perplexity/sonar");
  await expect(recoverButton(page)).toBeEnabled();
});

test("a failed verification reports its diagnostic code and sanitized message", async ({
  page,
}) => {
  await openFixture(page, {
    providerState: "incident",
    lastCheck: failedCheck(),
  });

  const card = resultCard(page);
  await expect(card).toContainText("Verification failed");
  await expect(card).toContainText(
    "PROVIDER_VERIFICATION_FAILED.AI_APICallError.HTTP_503"
  );
  await expect(card).toContainText("Perplexity returned an error.");
});

test("a healthy provider offers no recovery even after a successful verification", async ({
  page,
}) => {
  // There is no block to clear, so the control stays refused -- the same
  // NOT_BLOCKED answer the API gives.
  await openFixture(page, {
    providerState: "operational",
    lastCheck: successfulCheck(),
  });
  await expect(resultCard(page)).toContainText("Verification succeeded");
  await expect(recoverButton(page)).toBeDisabled();
});

test("an already-consumed verification cannot authorise a second recovery", async ({
  page,
}) => {
  await openFixture(page, {
    providerState: "incident",
    lastCheck: successfulCheck({ recoveryApplied: true }),
  });
  await expect(resultCard(page)).toContainText("Already used for a recovery");
  await expect(recoverButton(page)).toBeDisabled();
});

test("a second click while a verification is in flight starts no second billed call", async ({
  page,
}) => {
  await openFixture(page);

  let posts = 0;
  // Held open so the request is still in flight while the second click is
  // attempted. Kept in an object rather than a bare `let`, so the assignment
  // inside the executor is not narrowed away by control-flow analysis.
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
      return route.fulfill(json({ check: successfulCheck() }));
    }
  );

  await verifyButton(page).click();
  await confirmButton(page).click();

  await expect(verifyButton(page)).toBeDisabled();
  await expect(verifyButton(page)).toContainText("Running verification");
  // Clicking the disabled control must not queue a second request.
  await verifyButton(page).click({ force: true }).catch(() => {});
  await recoverButton(page).click({ force: true }).catch(() => {});
  expect(posts).toBe(1);

  gate.release();
  await expect(verifyButton(page)).toBeEnabled();
});

test("without ops:write the controls are unavailable and the reason is stated", async ({
  page,
}) => {
  await openFixture(page, { providerState: "incident", canVerify: false });
  await expect(verifyButton(page)).toBeDisabled();
  await expect(recoverButton(page)).toBeDisabled();
  await expect(
    page.getByText("Running a verification requires the ops or owner admin role.")
  ).toBeVisible();
});

test("a provider with no eligible verification model says so instead of offering the call", async ({
  page,
}) => {
  await openFixture(page, { providerState: "noVerificationModel" });
  await expect(verifyButton(page)).toBeDisabled();
  await expect(
    page.getByText("No enabled model is available to verify this provider with.")
  ).toBeVisible();
});

test("the panel states that the verification call is billed by the provider", async ({
  page,
}) => {
  await openFixture(page);
  await expect(
    page.getByText("This call is billed by the provider.", { exact: false })
  ).toBeVisible();
  // And that it is not a customer-facing charge.
  await expect(
    page.getByText("never charges a customer", { exact: false })
  ).toBeVisible();
});

test("a successful recovery reports what it cleared, and that traffic history was untouched", async ({
  page,
}) => {
  await openFixture(page, {
    providerState: "incident",
    lastCheck: successfulCheck(),
  });

  await page.route(
    (url) => url.pathname === RECOVER_PATH,
    (route) =>
      route.fulfill(
        json({
          provider: PROVIDER,
          previousConsecutiveFailures: 5,
          resultingConsecutiveFailures: 0,
          traceId: "trace-recover-1",
        })
      )
  );

  await recoverButton(page).click();
  const notice = page.getByTestId("provider-verification-notice");
  await expect(notice).toContainText("Cleared 5 consecutive failures");
  await expect(notice).toContainText(
    "last successful traffic timestamp was not modified"
  );
});

test("a refused recovery surfaces the server's reason rather than claiming success", async ({
  page,
}) => {
  await openFixture(page, {
    providerState: "incident",
    lastCheck: successfulCheck(),
  });

  await page.route(
    (url) => url.pathname === RECOVER_PATH,
    (route) =>
      route.fulfill(
        json(
          {
            error:
              "This verification has already been used to recover the provider. Run a new verification first.",
            reason: "VERIFICATION_ALREADY_CONSUMED",
          },
          409
        )
      )
  );

  await recoverButton(page).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "already been used to recover" })
  ).toBeVisible();
  await expect(page.getByTestId("provider-verification-notice")).toBeHidden();
});
