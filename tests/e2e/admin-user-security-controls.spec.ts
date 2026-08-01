import { expect, test, type Page, type Route } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * Regression cover for the admin customer security controls.
 *
 * The controls and the console shell are mounted by
 * `/e2e/admin-security-controls`, a route that only exists on the Playwright
 * fixture server (`isE2EFixtureMode()`), because the real `/admin/users/:id`
 * needs an authorised administrator session and a live database and the
 * fixture server has neither. The components under test -- AdminConsoleShell,
 * AppToastViewport and AdminUserSecurityControls -- are the exact ones the
 * real console renders.
 */

const HARNESS = "/e2e/admin-security-controls";
const TARGET_ID = "qa-target-user";
const SECURITY_PATH = `/api/admin/users/${TARGET_ID}/security`;
const DETAIL_PATH = `/api/admin/users/${TARGET_ID}`;

const REASON = "Customer confirmed the deletion request was a mistake";
const TICKET = "SUP-4821";

type SecurityRequest = {
  action: string;
  reason: string;
  until: string | null;
  incidentNote: string | null;
  provider: string | null;
  supportTicketReference: string | null;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The customer detail the console refetches after a successful restoration. */
const restoredDetail = {
  user: {
    id: TARGET_ID,
    accountStatus: "active",
    accountDeletionRequestedAt: null,
    accountDeletionScheduledFor: null,
    accountSuspendedUntil: null,
    accountSuspensionReason: null,
    aiUsageRestricted: false,
    aiUsageRestrictedUntil: null,
    aiUsageRestrictionReason: null,
    securityIncidentNote: null,
    lastLoginAt: "2026-07-30T08:15:00.000Z",
    accounts: [{ provider: "google", providerAccountId: "qa-google-account" }],
    _count: { sessions: 0 },
    usage: { timeZone: "UTC" },
  },
};

/**
 * Records every security request and answers with `respond`. Returns the
 * recorded bodies so a spec can assert on the payload that was actually sent.
 */
async function interceptSecurity(
  page: Page,
  respond: (route: Route, callIndex: number) => Promise<void> | void
) {
  const requests: SecurityRequest[] = [];
  await page.route(
    (url) => url.pathname === SECURITY_PATH,
    async (route) => {
      requests.push(JSON.parse(route.request().postData() || "{}"));
      await respond(route, requests.length - 1);
    }
  );
  return requests;
}

/**
 * Waits until React has hydrated the client tree that owns the toast listener.
 * `goto()` only guarantees the server HTML: dispatching before hydration would
 * fire the event into a document that has no listener yet.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    if (!element) return false;
    return Object.keys(element).some((key) => key.startsWith("__reactFiber$"));
  }, selector);
}

async function openHarness(page: Page, state?: string) {
  const response = await page.goto(state ? `${HARNESS}?state=${state}` : HARNESS);
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByTestId("admin-user-security-controls")).toBeVisible();
  await waitForHydration(page, '[data-testid="admin-security-reason"]');
}

// ---------------------------------------------------------------------------
// Client validation reaches the operator
// ---------------------------------------------------------------------------

test("an audit reason under five characters blocks the request and reports inline", async ({
  page,
}) => {
  const requests = await interceptSecurity(page, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill("bad");
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  const inlineError = page.getByTestId("admin-security-reason-error");
  await expect(inlineError).toBeVisible();
  await expect(inlineError).toContainText("at least 5 characters");

  // The same message is also announced, and the toast is the assertive one.
  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "error");
  await expect(toast).toHaveAttribute("role", "alert");

  const reason = page.getByTestId("admin-security-reason");
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toBeFocused();
  expect(requests).toHaveLength(0);
});

test("a support ticket reference under three characters blocks the restoration", async ({
  page,
}) => {
  const requests = await interceptSecurity(page, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill("SU");
  await page.getByTestId("admin-security-restore").click();

  const inlineError = page.getByTestId("admin-security-ticket-error");
  await expect(inlineError).toBeVisible();
  await expect(inlineError).toContainText("at least 3 characters");
  await expect(page.getByTestId("app-toast")).toBeVisible();
  await expect(page.getByTestId("admin-security-ticket")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  expect(requests).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Per-action request payloads
// ---------------------------------------------------------------------------

// The original defect: one shared expiry field, forwarded whatever the action,
// so a date left over from an earlier suspension made restoration fail with
// `The "restore_account" action does not accept an expiry.`
test("restore_account sends until: null even with an expiry left in the form", async ({
  page,
}) => {
  const requests = await interceptSecurity(page, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await page.route((url) => url.pathname === DETAIL_PATH, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page, "pendingDeletion");

  // The expiry input lives in the restrictions block, visibly separated from
  // the restoration block, but its state is still shared.
  await page.getByTestId("admin-security-until").fill("2099-01-01T09:00");
  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].action).toBe("restore_account");
  expect(requests[0].until).toBeNull();
  expect(requests[0].supportTicketReference).toBe(TICKET);
});

test("session revocation sends until: null even with an expiry left in the form", async ({
  page,
}) => {
  const requests = await interceptSecurity(page, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await page.route((url) => url.pathname === DETAIL_PATH, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page);

  await page.getByTestId("admin-security-until").fill("2099-01-01T09:00");
  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-revoke-sessions").click();

  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].action).toBe("revoke_sessions");
  expect(requests[0].until).toBeNull();
  expect(requests[0].supportTicketReference).toBeNull();
});

test("suspend and restrict_ai send the chosen expiry as an ISO instant", async ({
  page,
}) => {
  const requests = await interceptSecurity(page, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await page.route((url) => url.pathname === DETAIL_PATH, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page);

  await page.getByTestId("admin-security-until").fill("2099-03-04T05:06");
  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-suspend").click();
  await expect.poll(() => requests.length).toBe(1);

  await page.getByTestId("admin-security-until").fill("2099-03-04T05:06");
  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-toggle-ai").click();
  await expect.poll(() => requests.length).toBe(2);

  // The canonical Playwright projects pin the browser to UTC, so the
  // administrator's local wall clock is UTC here.
  const expected = new Date("2099-03-04T05:06Z").toISOString();
  expect(requests[0].action).toBe("suspend");
  expect(requests[0].until).toBe(expected);
  expect(requests[1].action).toBe("restrict_ai");
  expect(requests[1].until).toBe(expected);
});

// ---------------------------------------------------------------------------
// Server failures reach the screen
// ---------------------------------------------------------------------------

test("a 400 from the restore API is shown verbatim on the admin screen", async ({
  page,
}) => {
  await interceptSecurity(page, (route) =>
    route.fulfill(
      json(
        { error: 'The "restore_account" action does not accept an expiry.' },
        400
      )
    )
  );
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  const requestError = page.getByTestId("admin-security-request-error");
  await expect(requestError).toBeVisible();
  await expect(requestError).toContainText("does not accept an expiry");
  await expect(page.getByTestId("app-toast")).toContainText(
    "does not accept an expiry"
  );
});

test("a 409 for a deletion already in progress stays blocked and visible", async ({
  page,
}) => {
  await interceptSecurity(page, (route) =>
    route.fulfill(
      json(
        {
          error:
            "This account's permanent deletion has already started and can no longer be cancelled.",
          code: "DELETION_ALREADY_PROCESSING",
        },
        409
      )
    )
  );
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  await expect(page.getByTestId("admin-security-request-error")).toContainText(
    "already started"
  );
  // The account is still pending deletion: nothing optimistic was rendered.
  await expect(page.getByTestId("admin-security-account-status")).toContainText(
    "pending_deletion"
  );
});

test("a 428 asks for a fresh sign-in and links to the admin reauthentication route", async ({
  page,
}) => {
  await interceptSecurity(page, (route) =>
    route.fulfill(
      json(
        {
          error:
            "Sign in again before performing this high-risk administrator action.",
          code: "ADMIN_REAUTHENTICATION_REQUIRED",
        },
        428
      )
    )
  );
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  await expect(page.getByTestId("admin-security-request-error")).toContainText(
    /sign in again/i
  );
  const link = page.getByTestId("admin-security-reauthenticate-link");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    "href",
    /^\/auth\/admin-reauthenticate\?callbackUrl=/
  );
});

test("a response body that cannot be parsed still produces a visible error", async ({
  page,
}) => {
  await interceptSecurity(page, (route) =>
    route.fulfill({ status: 500, contentType: "text/html", body: "<html>502</html>" })
  );
  await openHarness(page);

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-revoke-sessions").click();

  await expect(page.getByTestId("admin-security-request-error")).toContainText(
    "500"
  );
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test("a successful restoration shows progress, confirms, and refreshes the account", async ({
  page,
}) => {
  const gate: { release: () => void } = { release: () => {} };
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  await interceptSecurity(page, async (route) => {
    await held;
    await route.fulfill(json(restoredDetail));
  });
  await page.route((url) => url.pathname === DETAIL_PATH, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page, "pendingDeletion");

  await expect(page.getByTestId("admin-security-deletion-schedule")).toBeVisible();
  await expect(page.getByTestId("admin-security-ai-status")).toContainText(
    "AI restricted"
  );

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  const restore = page.getByTestId("admin-security-restore");
  await restore.click();

  // In-flight: an action-specific progress label, and no second click possible.
  await expect(restore).toHaveText("Restoring...");
  await expect(restore).toBeDisabled();
  await expect(page.getByTestId("admin-security-revoke-sessions")).toBeDisabled();
  gate.release();

  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "success");
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toContainText("renewal stays off");

  // The reloaded detail is what is on screen: active, AI allowed, no schedule.
  await expect(page.getByTestId("admin-security-account-status")).toContainText(
    "Account active"
  );
  await expect(page.getByTestId("admin-security-ai-status")).toContainText(
    "AI allowed"
  );
  await expect(page.getByTestId("admin-security-deletion-schedule")).toHaveCount(0);
  await expect(page.getByTestId("admin-security-restore")).toHaveCount(0);
  await expect(page.getByTestId("admin-security-reason")).toHaveValue("");
});

test("an account that was already active is reported as a no-op, not a change", async ({
  page,
}) => {
  await interceptSecurity(page, (route) =>
    route.fulfill(json({ ...restoredDetail, alreadyRestored: true }))
  );
  await page.route((url) => url.pathname === DETAIL_PATH, (route) =>
    route.fulfill(json(restoredDetail))
  );
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill(REASON);
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  const toast = page.getByTestId("app-toast");
  await expect(toast).toContainText(/already active/i);
  await expect(toast).toHaveAttribute("data-tone", "info");
});

// ---------------------------------------------------------------------------
// Field semantics and accessibility wiring
// ---------------------------------------------------------------------------

test("every security input has a real label and helper text, not just a placeholder", async ({
  page,
}) => {
  await openHarness(page, "pendingDeletion");

  const fields = [
    { testId: "admin-security-reason", label: /Audit reason/ },
    { testId: "admin-security-incident-note", label: /Security incident note/ },
    { testId: "admin-security-until", label: /Control expiry/ },
    { testId: "admin-security-ticket", label: /Support ticket reference/ },
  ];

  for (const field of fields) {
    const input = page.getByTestId(field.testId);
    const id = await input.getAttribute("id");
    expect(id, `${field.testId} needs an id to be labelled`).toBeTruthy();
    const label = page.locator(`label[for="${id}"]`);
    await expect(label).toBeVisible();
    await expect(label).toHaveText(field.label);
    // No placeholder-only field: the requirement is a described, visible label.
    const describedBy = await input.getAttribute("aria-describedby");
    expect(describedBy, `${field.testId} needs helper text`).toBeTruthy();
    await expect(page.locator(`#${describedBy!.split(" ")[0]}`)).toBeVisible();
  }
});

test("the expiry field says what it applies to, when it lifts, and which clock it uses", async ({
  page,
}) => {
  await openHarness(page, "pendingDeletion");

  const hintId = (
    await page.getByTestId("admin-security-until").getAttribute("aria-describedby")
  )?.split(" ")[0];
  const hint = page.locator(`#${hintId}`);
  await expect(hint).toContainText("Suspend account");
  await expect(hint).toContainText("Restrict AI usage");
  await expect(hint).toContainText(/lifts automatically/i);
  await expect(hint).toContainText(/local time/i);
  await expect(hint).toContainText(/cancelling a scheduled deletion/i);

  // The restoration inputs and the restriction inputs are separate blocks, so
  // the expiry never reads as a requirement of restoring an account.
  const restoreGroup = page.getByTestId("admin-security-restore-group");
  await expect(restoreGroup).toBeVisible();
  await expect(restoreGroup.getByTestId("admin-security-until")).toHaveCount(0);
  await expect(restoreGroup.getByTestId("admin-security-ticket")).toHaveCount(1);
});

test("an inline error is wired to its field through aria-describedby", async ({
  page,
}) => {
  await openHarness(page, "pendingDeletion");

  await page.getByTestId("admin-security-reason").fill("no");
  await page.getByTestId("admin-security-ticket").fill(TICKET);
  await page.getByTestId("admin-security-restore").click();

  const input = page.getByTestId("admin-security-reason");
  const describedBy = (await input.getAttribute("aria-describedby")) || "";
  const errorId = await page
    .getByTestId("admin-security-reason-error")
    .getAttribute("id");
  expect(errorId).toBeTruthy();
  expect(describedBy.split(" ")).toContain(errorId);
});

// ---------------------------------------------------------------------------
// The toast viewport itself
// ---------------------------------------------------------------------------

test("the admin console shell renders dispatched toasts, one per event", async ({
  page,
}) => {
  await openHarness(page);
  await expect(page.getByTestId("app-toast-viewport")).toBeAttached();

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("tomverse:toast", {
        detail: { message: "Admin console probe", tone: "success" },
      })
    );
  });

  const toasts = page.getByTestId("app-toast");
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toContainText("Admin console probe");
  await expect(toasts).toHaveAttribute("role", "status");
  await expect(toasts).toHaveAttribute("aria-live", "polite");
});

test("consecutive toasts stack, dismiss by hand, and clear themselves", async ({
  page,
}) => {
  await openHarness(page);

  await page.evaluate(() => {
    for (const message of ["First probe", "Second probe"]) {
      window.dispatchEvent(
        new CustomEvent("tomverse:toast", { detail: { message, tone: "info" } })
      );
    }
  });
  await expect(page.getByTestId("app-toast")).toHaveCount(2);

  await page
    .getByTestId("app-toast")
    .first()
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(page.getByTestId("app-toast")).toHaveCount(1);
  await expect(page.getByTestId("app-toast")).toContainText("Second probe");

  // The survivor auto-dismisses without any further interaction.
  await expect(page.getByTestId("app-toast")).toHaveCount(0, { timeout: 15_000 });
});

test("the chat shell still renders exactly one toast per event", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chat");
  await waitForHydration(page, '[data-testid="chat-input"]');

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("tomverse:toast", {
        detail: { message: "Chat duplicate probe", tone: "info" },
      })
    );
  });

  // /chat has always had its own listener. The shared viewport must not be
  // mounted there as well, or every chat toast would render twice.
  await expect(page.getByText("Chat duplicate probe", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("app-toast-viewport")).toHaveCount(0);
});

test("a toast never overflows a 320px viewport or blocks a security control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openHarness(page);

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("tomverse:toast", {
        detail: {
          message:
            "A deliberately long administrator notification that has to wrap instead of widening the page",
          tone: "error",
        },
      })
    );
  });
  await expect(page.getByTestId("app-toast")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  const toastBox = await page.getByTestId("app-toast").boundingBox();
  expect(toastBox!.x).toBeGreaterThanOrEqual(0);
  expect(toastBox!.x + toastBox!.width).toBeLessThanOrEqual(overflow.clientWidth);

  // Every primary control stays reachable at its own centre point while the
  // toast is on screen -- measured with elementFromPoint, not toBeAttached().
  for (const testId of [
    "admin-security-reason",
    "admin-security-until",
    "admin-security-suspend",
    "admin-security-toggle-ai",
    "admin-security-revoke-sessions",
  ]) {
    const control = page.getByTestId(testId);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    const owns = await page.evaluate(
      ({ point, id }) => {
        const element = document.elementFromPoint(point.x, point.y);
        return Boolean(element?.closest(`[data-testid="${id}"]`));
      },
      {
        point: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
        id: testId,
      }
    );
    expect(owns, `${testId} was covered by the toast`).toBe(true);
  }
});
