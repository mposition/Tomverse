import { expect, test, type Page, type Route } from "@playwright/test";
import {
  completeTurnstileChallenge,
  installTurnstileScript,
  mockAuthenticatedApi,
  prepareGuestPage,
  type QaLanguage,
} from "./support/app-fixtures";
import {
  restoreActiveConversation,
  setRootFontSize,
} from "./support/chat-state-fixtures";
import {
  expectInsideVisibleViewport,
  openOnScreenKeyboard,
} from "./support/ui-audit";

/**
 * Credential-shaped fixtures are assembled at runtime, never written out as
 * literals: a fake key is still a real key *shape* committed to the
 * repository, and .gitleaks.toml's allowlist is deliberately narrow (see
 * tests/gitleaksAllowlist.test.mjs).
 */
const fakeGoogleKey = () =>
  ["AIza", "SyD1x9Qp", "LmNv2345", "abcdEFGH", "ijkLMNop", "QRs"].join("");

// ---------------------------------------------------------------------------
// The chat "Send feedback" modal.
//
// The regressions these guard:
//   - the five-character minimum was enforced only by a disabled button, so a
//     user who typed three characters was told nothing at all;
//   - the modal was a bare <div> with no dialog semantics, no focus trap and no
//     way back to the button that opened it;
//   - a guest's submission never carried a Turnstile token, so /api/feedback --
//     which calls ensureGuestVerified for every unauthenticated caller -- could
//     not accept it;
//   - every failure read "Feedback could not be sent", and a failed send closed
//     the modal and threw away what had been typed.
//
// The minimum itself is product policy and is NOT under test for change: these
// assert that it still holds, from both directions.
// ---------------------------------------------------------------------------

type FeedbackQaState = {
  requests: Array<{
    message: string;
    traceId?: string;
    type?: string;
    hasToken: boolean;
    emailUpdates?: boolean;
    email?: string;
    language?: string;
  }>;
};

type FeedbackResponse =
  | { kind: "ok" }
  | { kind: "status"; status: number; code?: string }
  | { kind: "abort" };

/**
 * /api/feedback, scripted. The default is the successful shape the real route
 * returns, including the reference a user can quote back.
 */
async function mockFeedbackApi(
  page: Page,
  respond: () => FeedbackResponse = () => ({ kind: "ok" })
) {
  const state: FeedbackQaState = { requests: [] };

  await page.route("**/api/feedback", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      message?: string;
      traceId?: string;
      type?: string;
      turnstileToken?: string;
      emailUpdates?: boolean;
      email?: string;
      language?: string;
    };
    state.requests.push({
      message: String(body.message ?? ""),
      traceId: body.traceId,
      type: body.type,
      hasToken: typeof body.turnstileToken === "string" && body.turnstileToken.length > 0,
      emailUpdates: body.emailUpdates,
      email: body.email,
      language: body.language,
    });

    const outcome = respond();
    if (outcome.kind === "abort") {
      await route.abort("failed");
      return;
    }
    if (outcome.kind === "status") {
      await route.fulfill({
        status: outcome.status,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Failed.",
          ...(outcome.code ? { code: outcome.code } : {}),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        feedbackId: "clzfeedback0001abcd",
        reference: "0001ABCD",
        // Mirrors the real route: enabled only when the caller opted in.
        emailUpdatesEnabled: body.emailUpdates === true,
      }),
    });
  });

  return state;
}

/**
 * The feedback trigger lives in the sidebar on both shells; on a phone that
 * sidebar is a drawer that has to be opened first. Resolving that here keeps
 * every test below shell-agnostic.
 */
const openFeedbackFromSidebar = async (page: Page) => {
  // Wait for whichever shell this viewport rendered before deciding which one
  // it is; probing too early reads "no mobile shell" on both.
  await page.waitForSelector(
    '[data-testid="mobile-chat-shell"], [data-testid="sidebar-feedback-button"]'
  );
  const drawer = page.getByTestId("mobile-sidebar-drawer");
  const mobileMenu = page.getByTestId("mobile-sidebar-open");
  const drawerAlreadyOpen = await drawer.isVisible().catch(() => false);
  if (!drawerAlreadyOpen && (await mobileMenu.isVisible().catch(() => false))) {
    await mobileMenu.click();
    await expect(drawer).toBeVisible();
  }
  const trigger = page.getByTestId("sidebar-feedback-button");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByTestId("feedback-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
};

const openMobileFeedback = async (page: Page) => {
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  return openFeedbackFromSidebar(page);
};

const gotoAuthenticatedChat = async (page: Page, language: QaLanguage = "en") => {
  await prepareGuestPage(page, language);
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  // `?lang=` is what pins the language for a chat page; the stored preference
  // alone is restored asynchronously and would race these assertions.
  await page.goto(`/chat?lang=${language}`);
};

// ---------------------------------------------------------------------------
// The minimum, explained
// ---------------------------------------------------------------------------

test.describe("minimum length guidance", () => {
  test("an empty box disables sending and says why @ui-risk", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);

    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    const hint = page.getByTestId("feedback-message-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(/at least 5 characters/i);
    // The rule is stated in the DOM, not carried by the button's colour alone.
    await expect(hint).toHaveAttribute("data-tone", "neutral");
    await expect(page.getByTestId("feedback-message-counter")).toHaveText("0 / 2,000");
  });

  test("one to four characters report how many are still needed", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    const message = page.getByTestId("feedback-message");
    const hint = page.getByTestId("feedback-message-hint");

    for (const [typed, remaining] of [
      ["a", 4],
      ["ab", 3],
      ["abc", 2],
      ["abcd", 1],
    ] as const) {
      await message.fill(typed);
      await expect(hint).toHaveText(new RegExp(`Add ${remaining} more`));
      await expect(hint).toHaveAttribute("data-tone", "warning");
      await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    }
  });

  test("exactly five characters can be sent", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    await page.getByTestId("feedback-message").fill("abcde");

    await expect(page.getByTestId("feedback-submit")).toBeEnabled();
    await expect(page.getByTestId("feedback-message-hint")).toHaveAttribute(
      "data-tone",
      "ready"
    );
    await expect(page.getByTestId("feedback-message-counter")).toHaveText("5 / 2,000");
  });

  test("padding is not content: four characters in whitespace cannot be sent", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    await page.getByTestId("feedback-message").fill("   abcd   ");

    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await expect(page.getByTestId("feedback-message-counter")).toHaveText("4 / 2,000");
    await expect(page.getByTestId("feedback-message-hint")).toHaveText(/Add 1 more/);
  });

  test("whitespace alone cannot be sent", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    await page.getByTestId("feedback-message").fill("          ");

    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await expect(page.getByTestId("feedback-message-counter")).toHaveText("0 / 2,000");
  });

  test("2,000 characters is the ceiling and the field stops there", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    const message = page.getByTestId("feedback-message");

    await message.fill("a".repeat(2_000));
    await expect(page.getByTestId("feedback-message-counter")).toHaveText(
      "2,000 / 2,000"
    );
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();

    // maxLength refuses the 2,001st character rather than letting the server
    // reject the whole submission.
    await message.press("End");
    await message.pressSequentially("bb");
    await expect(message).toHaveValue("a".repeat(2_000));
  });

  test("the guidance is wired to the textarea and the send button", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const dialog = await openFeedbackFromSidebar(page);

    const hintId = await page.getByTestId("feedback-message-hint").getAttribute("id");
    const counterId = await page
      .getByTestId("feedback-message-counter")
      .getAttribute("id");
    await expect(page.getByTestId("feedback-message")).toHaveAttribute(
      "aria-describedby",
      `${hintId} ${counterId}`
    );
    await expect(page.getByTestId("feedback-submit")).toHaveAttribute(
      "aria-describedby",
      new RegExp(hintId as string)
    );
    // Announced, not merely rendered.
    await expect(page.getByTestId("feedback-message-hint")).toHaveRole("status");
    await expect(dialog).toBeVisible();
  });

  test("the rule does not live only in the placeholder", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    const placeholder = await page
      .getByTestId("feedback-message")
      .getAttribute("placeholder");
    expect(placeholder ?? "").not.toMatch(/5/);
    await expect(page.getByTestId("feedback-message-hint")).toHaveText(/5/);
  });
});

// ---------------------------------------------------------------------------
// Trace ID
// ---------------------------------------------------------------------------

test.describe("trace ID", () => {
  test("a submission without a trace ID goes through", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-trace").fill("");
    await page.getByTestId("feedback-message").fill("no trace attached here");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests).toHaveLength(1);
    expect(feedback.requests[0].traceId).toBeUndefined();
  });

  test("a trace ID alone does not unlock a too-short message", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-trace").fill("0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012");
    await page.getByTestId("feedback-message").fill("hi");

    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    expect(feedback.requests).toHaveLength(0);
  });

  test("a malformed trace ID is a hint, never a blocker", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-trace").fill("it broke yesterday afternoon");
    await page.getByTestId("feedback-message").fill("the feedback text survives");

    await expect(page.getByTestId("feedback-trace-hint")).toHaveText(
      /does not look like a trace ID/i
    );
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();

    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].message).toBe("the feedback text survives");
  });
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

test.describe("submission", () => {
  test("a burst of clicks produces exactly one request", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const feedback = await mockFeedbackApi(page);
    // Hold the response open so every click lands while one is in flight.
    await page.unroute("**/api/feedback");
    await page.route("**/api/feedback", async (route) => {
      feedback.requests.push({
        message: String(
          (route.request().postDataJSON() as { message?: string }).message ?? ""
        ),
        hasToken: false,
      });
      await held;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, reference: "0001ABCD" }),
      });
    });

    await openFeedbackFromSidebar(page);
    await page.getByTestId("feedback-message").fill("double submit attempt");
    const submit = page.getByTestId("feedback-submit");
    await submit.click();
    // The button disables itself, so force the extra clicks through.
    await submit.click({ force: true, timeout: 2_000 }).catch(() => {});
    await submit.click({ force: true, timeout: 2_000 }).catch(() => {});
    await page.keyboard.press("Enter");

    expect(feedback.requests).toHaveLength(1);
    release();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
  });

  test("Enter inside the textarea inserts a newline and does not submit", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    const message = page.getByTestId("feedback-message");
    await message.click();
    await message.pressSequentially("first line");
    await message.press("Enter");
    await message.pressSequentially("second line");
    await message.press("Shift+Enter");

    await expect(message).toHaveValue("first line\nsecond line\n");
    expect(feedback.requests).toHaveLength(0);
    await expect(page.getByTestId("feedback-dialog")).toBeVisible();
  });

  test("a server failure keeps the dialog, the draft and offers a retry", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    let attempt = 0;
    const feedback = await mockFeedbackApi(page, () => {
      attempt += 1;
      return attempt === 1
        ? { kind: "status", status: 500, code: "FEEDBACK_SUBMIT_FAILED" }
        : { kind: "ok" };
    });
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("this should survive a 500");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeVisible();
    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /server problem/i
    );
    await expect(page.getByTestId("feedback-message")).toHaveValue(
      "this should survive a 500"
    );

    // The same draft can simply be sent again.
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests).toHaveLength(2);
    expect(feedback.requests[1].message).toBe("this should survive a 500");
  });

  test("a network failure keeps the draft too", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await mockFeedbackApi(page, () => ({ kind: "abort" }));
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("offline draft is kept");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /network problem/i
    );
    await expect(page.getByTestId("feedback-message")).toHaveValue(
      "offline draft is kept"
    );
  });

  test("a 429 tells the user to wait rather than to fix their text", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await mockFeedbackApi(page, () => ({
      kind: "status",
      status: 429,
      code: "API_RATE_LIMITED",
    }));
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("too many submissions");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /Too many requests/i
    );
    await expect(page.getByTestId("feedback-dialog")).toBeVisible();
  });

  test("a 400 points at the input, a 413 at the length", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    let status = 400;
    await mockFeedbackApi(page, () => ({ kind: "status", status }));
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("some feedback text");
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /Check what you entered/i
    );

    status = 413;
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-submit-error")).toHaveText(/too long/i);
  });

  test("an unmapped status falls back to a generic message with a reference", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    await mockFeedbackApi(page, () => ({ kind: "status", status: 418 }));
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("unmapped failure path");
    await page.getByTestId("feedback-submit").click();

    const error = page.getByTestId("feedback-submit-error");
    await expect(error).toBeVisible();
    // A safe, quotable reference -- and nothing from the response body.
    await expect(error).toHaveText(/[A-F0-9]{8}/);
  });

  test("a response body cannot become user-facing copy", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await page.route("**/api/feedback", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "PLEASE-ENTER-YOUR-PASSWORD-AT-evil.example",
          code: "PLEASE-ENTER-YOUR-PASSWORD",
        }),
      })
    );
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("hostile response body");
    await page.getByTestId("feedback-submit").click();

    const error = page.getByTestId("feedback-submit-error");
    await expect(error).toBeVisible();
    await expect(error).not.toContainText("evil.example");
    await expect(error).not.toContainText("PLEASE-ENTER-YOUR-PASSWORD");
  });

  test("only a stored submission clears the form and confirms receipt", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("everything worked");
    await page.getByTestId("feedback-trace").fill("0d1f6b1e-9a2c-4d3f");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    const toast = page.getByTestId("app-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-tone", "success");
    await expect(toast).toContainText("0001ABCD");

    // Reopening starts from a clean form.
    await openFeedbackFromSidebar(page);
    await expect(page.getByTestId("feedback-message")).toHaveValue("");
    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
  });

  test("a stored submission whose notification email failed still reads as success", async ({
    page,
  }) => {
    // The route distinguishes the two: a 200 means the report is in the
    // database, whatever happened to the operator notification afterwards.
    await gotoAuthenticatedChat(page);
    await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("stored but not emailed");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    await expect(page.getByTestId("app-toast")).toHaveAttribute(
      "data-tone",
      "success"
    );
  });
});

// ---------------------------------------------------------------------------
// Guest verification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Email status updates: per-report consent
// ---------------------------------------------------------------------------

test.describe("email status updates consent", () => {
  test("consent is off by default and the payload says so", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await expect(page.getByTestId("feedback-email-updates")).not.toBeChecked();
    await page.getByTestId("feedback-message").fill("no updates please");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].emailUpdates).toBe(false);
    expect(feedback.requests[0].email).toBeUndefined();
    // The success toast must not promise emails nobody asked for.
    const toast = page.getByTestId("app-toast");
    await expect(toast).toBeVisible();
    await expect(toast).not.toContainText(/status updates/i);
  });

  test("a signed-in user who opts in sees the account hint and sends no address", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-email-updates").check();
    // The account email is resolved server-side; the dialog neither asks for
    // nor accepts an address from a signed-in caller.
    await expect(
      page.getByTestId("feedback-email-updates-account-hint")
    ).toBeVisible();
    await expect(page.getByTestId("feedback-notify-email")).toHaveCount(0);

    await page.getByTestId("feedback-message").fill("account email updates");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].emailUpdates).toBe(true);
    expect(feedback.requests[0].email).toBeUndefined();
    const toast = page.getByTestId("app-toast");
    await expect(toast).toHaveAttribute("data-tone", "success");
    await expect(toast).toContainText("receipt and status updates");
  });

  test("a guest who opts in must supply a valid address before sending", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "silent");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("guest wants updates");
    await page.getByTestId("feedback-email-updates").check();
    const emailInput = page.getByTestId("feedback-notify-email");
    await expect(emailInput).toBeVisible();

    // An empty or malformed address blocks the send and says why.
    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await emailInput.fill("not-an-email");
    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await expect(page.getByTestId("feedback-notify-email-hint")).toContainText(
      /valid email/i
    );

    await emailInput.fill("guest@example.com");
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].emailUpdates).toBe(true);
    expect(feedback.requests[0].email).toBe("guest@example.com");
    expect(feedback.requests[0].language).toBe("en");
    const toast = page.getByTestId("app-toast");
    await expect(toast).toContainText("receipt and status updates");
  });

  test("unchecking consent hides the guest address field and sends none", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "silent");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-email-updates").check();
    await page.getByTestId("feedback-notify-email").fill("guest@example.com");
    await page.getByTestId("feedback-email-updates").uncheck();
    await expect(page.getByTestId("feedback-notify-email")).toHaveCount(0);

    await page.getByTestId("feedback-message").fill("changed my mind");
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].emailUpdates).toBe(false);
    expect(feedback.requests[0].email).toBeUndefined();
  });

  test("the Korean consent copy is translated, not raw keys", async ({ page }) => {
    await gotoAuthenticatedChat(page, "ko");
    await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    const label = page.getByTestId("feedback-email-updates");
    await expect(label).toBeVisible();
    const dialog = page.getByTestId("feedback-dialog");
    await expect(dialog).toContainText("처리 상태를 이메일로 받기");
    await expect(dialog).not.toContainText("feedback.emailUpdatesLabel");
  });
});

test.describe("guest verification", () => {
  test("a signed-in user submits without any Turnstile token", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("signed in feedback");
    // No verification surface exists for a signed-in caller, before or after.
    await expect(page.getByTestId("feedback-verification")).toHaveAttribute(
      "data-visible",
      "false"
    );
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].hasToken).toBe(false);
  });

  test("a guest's submission carries a verified token", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "silent");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("guest feedback text");
    // A silent pass shows the guest nothing at all.
    await expect(page.getByTestId("feedback-verification")).toHaveAttribute(
      "data-visible",
      "false"
    );
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests).toHaveLength(1);
    expect(feedback.requests[0].hasToken).toBe(true);
  });

  test("an interactive challenge appears inside the dialog and can be solved", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "interactive");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    const dialog = await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("guest with a challenge");
    await page.getByTestId("feedback-submit").click();

    const slot = page.getByTestId("feedback-verification");
    await expect(slot).toHaveAttribute("data-visible", "true");
    // Inside the dialog, not behind it: the modal is on top of everything else.
    expect(await dialog.locator('[data-testid="feedback-verification"]').count()).toBe(1);

    expect(await completeTurnstileChallenge(page)).toBe(true);
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].hasToken).toBe(true);
  });

  test("cancelling verification keeps the draft and says so", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "interactive");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("cancel the check");
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-verification")).toHaveAttribute(
      "data-visible",
      "true"
    );
    await page.getByTestId("feedback-verification-cancel").click();

    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /security check was cancelled/i
    );
    await expect(page.getByTestId("feedback-message")).toHaveValue("cancel the check");
    expect(feedback.requests).toHaveLength(0);
  });

  test("a failed check is described as a security failure, not a bad message", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "error");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("the check will fail");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /security check could not be completed/i
    );
    await expect(page.getByTestId("feedback-message")).toHaveValue("the check will fail");
    expect(feedback.requests).toHaveLength(0);
  });

  test("an expired check is distinguished from a failed one", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "expired");
    await page.goto("/chat?lang=en");
    await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("the check will expire");
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-submit-error")).toHaveText(/expired/i);
  });

  test("no Turnstile token is ever rendered into the dialog", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "interactive");
    await page.goto("/chat?lang=en");
    await mockFeedbackApi(page, () => ({ kind: "status", status: 500 }));
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("token must not leak");
    await page.getByTestId("feedback-submit").click();
    await completeTurnstileChallenge(page);
    await expect(page.getByTestId("feedback-submit-error")).toBeVisible();

    const dialogText = await page.getByTestId("feedback-dialog").innerText();
    expect(dialogText).not.toContain("qa-turnstile-token");
  });
});

// ---------------------------------------------------------------------------
// Error-report mode
// ---------------------------------------------------------------------------

test.describe("error report mode", () => {
  const openErrorReport = async (page: Page) => {
    const trigger = page.getByTestId("report-error-button").first();
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByTestId("feedback-dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  };

  const seedFailedTurn = async (page: Page) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini"],
      messages: [
        { id: "u1", role: "user", content: "Hello", status: "normal" },
        {
          id: "a1",
          role: "assistant",
          modelId: "gpt-5-4-mini",
          content:
            "Provider error.\nauthorization: Bearer SUPERSECRETTOKENVALUE\nTrace ID: 0d1f6b1e",
          status: "error",
        },
      ],
    });
    // Without an active conversation the shell opens on its welcome view, and
    // the seeded transcript -- including the failed turn -- is never loaded.
    await restoreActiveConversation(page);
    await page.goto("/chat?lang=en");
  };

  test("it submits with no typing at all, using a compliant default", async ({
    page,
  }) => {
    await seedFailedTurn(page);
    const feedback = await mockFeedbackApi(page);
    await openErrorReport(page);

    await expect(page.getByTestId("feedback-message")).toHaveValue("");
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests).toHaveLength(1);
    const sent = feedback.requests[0].message;
    // The server's five-character contract is satisfied by real content, not
    // bypassed.
    expect(sent.trim().length).toBeGreaterThanOrEqual(5);
    expect(sent).toContain("Provider error.");
  });

  test("credentials in the attached error never leave the browser", async ({ page }) => {
    await seedFailedTurn(page);
    const feedback = await mockFeedbackApi(page);
    await openErrorReport(page);
    await page.getByTestId("feedback-submit").click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    const sent = feedback.requests[0].message;
    expect(sent).not.toContain("SUPERSECRETTOKENVALUE");
    expect(sent).toContain("[redacted]");
  });

  test("a half-written description is not silently replaced", async ({ page }) => {
    await seedFailedTurn(page);
    await mockFeedbackApi(page);
    await openErrorReport(page);

    await page.getByTestId("feedback-message").fill("ab");
    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await expect(page.getByTestId("feedback-message-hint")).toHaveText(/Add 3 more/);
  });

  test("general feedback in the same session still needs five characters", async ({
    page,
  }) => {
    await seedFailedTurn(page);
    await mockFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await page.getByTestId("feedback-message").fill("abcd");
    await expect(page.getByTestId("feedback-submit")).toBeDisabled();
    await page.getByTestId("feedback-message").fill("abcde");
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Dialog accessibility
// ---------------------------------------------------------------------------

test.describe("dialog semantics", () => {
  test("it is a labelled modal dialog @ui-risk", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const dialog = await openFeedbackFromSidebar(page);

    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = await dialog.getAttribute("aria-labelledby");
    const describedBy = await dialog.getAttribute("aria-describedby");
    await expect(page.locator(`#${labelledBy}`)).toHaveText(/feedback/i);
    await expect(page.locator(`#${describedBy}`)).not.toHaveText("");
  });

  test("opening moves focus into the dialog", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    await expect(page.getByTestId("feedback-message")).toBeFocused();
  });

  test("Tab is trapped inside the dialog", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const dialog = await openFeedbackFromSidebar(page);

    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((node) =>
        node.contains(document.activeElement)
      );
      expect(inside, `focus escaped the dialog after ${step + 1} tabs`).toBe(true);
    }
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Shift+Tab");
      const inside = await dialog.evaluate((node) =>
        node.contains(document.activeElement)
      );
      expect(inside, `focus escaped backwards after ${step + 1} tabs`).toBe(true);
    }
  });

  test("Escape closes it and focus returns to the trigger", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    await page.keyboard.press("Escape");

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    await expect(page.getByTestId("sidebar-feedback-button")).toBeFocused();
  });

  test("the close button closes it and returns focus too", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await openFeedbackFromSidebar(page);
    const close = page.getByTestId("feedback-close");
    await expect(close).toHaveAttribute("aria-label", /close/i);
    await close.click();

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    await expect(page.getByTestId("sidebar-feedback-button")).toBeFocused();
  });

  test("the page behind the dialog cannot scroll", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const before = await page.evaluate(() => document.body.style.overflow);
    await openFeedbackFromSidebar(page);
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

    // Closing restores whatever the shell had set, rather than clearing it: on
    // a phone this dialog opens over the sidebar drawer, which owns its own
    // lock and is still open underneath.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    const drawerStillOpen = await page
      .getByTestId("mobile-sidebar-drawer")
      .isVisible()
      .catch(() => false);
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe(drawerStillOpen ? "hidden" : before);
  });

  test("nothing is clipped at 200% text scaling", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    await setRootFontSize(page, 32);
    const dialog = await openFeedbackFromSidebar(page);

    // The dialog scrolls rather than cutting its own controls off.
    const submit = page.getByTestId("feedback-submit");
    await submit.scrollIntoViewIfNeeded();
    const [dialogBox, submitBox, hintBox] = await Promise.all([
      dialog.boundingBox(),
      submit.boundingBox(),
      page.getByTestId("feedback-message-hint").boundingBox(),
    ]);
    expect(dialogBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(hintBox).not.toBeNull();
    expect(submitBox!.width).toBeGreaterThan(0);
    expect(submitBox!.height).toBeGreaterThanOrEqual(40);
    // No horizontal clipping of the guidance.
    expect(hintBox!.x + hintBox!.width).toBeLessThanOrEqual(
      dialogBox!.x + dialogBox!.width + 1
    );
    const overflowsHorizontally = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1
    );
    expect(overflowsHorizontally).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test("the dialog and its controls fit a phone @ui-risk", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const dialog = await openMobileFeedback(page);

    const viewport = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.height).toBeLessThanOrEqual(viewport.height);

    for (const testId of [
      "feedback-message",
      "feedback-message-hint",
      "feedback-trace",
      "feedback-submit",
      "feedback-close",
    ]) {
      const control = page.getByTestId(testId);
      await control.scrollIntoViewIfNeeded();
      const controlBox = (await control.boundingBox())!;
      expect(controlBox.width, testId).toBeGreaterThan(0);
      expect(controlBox.x + controlBox.width, testId).toBeLessThanOrEqual(
        viewport.width + 1
      );
    }

    const overflows = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1
    );
    expect(overflows).toBe(false);
  });

  test("the focused form and submit action clear the on-screen keyboard @ui-risk", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const dialog = await openMobileFeedback(page);
    await expect(page.getByTestId("feedback-message")).toBeFocused();

    await openOnScreenKeyboard(page, 300);
    await expectInsideVisibleViewport(page, dialog, "feedback dialog");

    const submit = page.getByTestId("feedback-submit");
    await submit.scrollIntoViewIfNeeded();
    await expectInsideVisibleViewport(page, submit, "feedback submit");
  });

  test("a guest challenge is reachable on a phone", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installTurnstileScript(page, "interactive");
    await page.goto("/chat?lang=en");
    const feedback = await mockFeedbackApi(page);
    await openMobileFeedback(page);

    await page.getByTestId("feedback-message").fill("mobile guest feedback");
    await page.getByTestId("feedback-submit").click();

    const slot = page.getByTestId("feedback-verification");
    await expect(slot).toHaveAttribute("data-visible", "true");
    await slot.scrollIntoViewIfNeeded();
    const box = (await slot.boundingBox())!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

    expect(await completeTurnstileChallenge(page)).toBe(true);
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    expect(feedback.requests[0].hasToken).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Localisation
// ---------------------------------------------------------------------------

test.describe("localisation", () => {
  test("Korean shows translated guidance, not a raw key", async ({ page }) => {
    await gotoAuthenticatedChat(page, "ko");
    await openFeedbackFromSidebar(page);

    const hint = page.getByTestId("feedback-message-hint");
    await expect(hint).toHaveText(/5자 이상/);
    await expect(hint).not.toHaveText(/feedback\./);

    await page.getByTestId("feedback-message").fill("ab");
    await expect(hint).toHaveText(/3자를 더/);
    await expect(page.getByTestId("feedback-close")).toHaveAttribute(
      "aria-label",
      /피드백/
    );
  });

  test("Korean failures use translated copy", async ({ page }) => {
    await gotoAuthenticatedChat(page, "ko");
    await mockFeedbackApi(page, () => ({ kind: "status", status: 429 }));
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("한도 초과 확인");
    await page.getByTestId("feedback-submit").click();

    const error = page.getByTestId("feedback-submit-error");
    await expect(error).toHaveText(/요청이 너무 많습니다/);
    await expect(error).not.toHaveText(/feedback\./);
  });
});

// ---------------------------------------------------------------------------
// Closing while a submission is in flight
// ---------------------------------------------------------------------------

test.describe("closing mid-flight", () => {
  /** Holds /api/feedback open so the dialog is genuinely mid-send. */
  const heldFeedbackApi = async (page: Page, outcome: "ok" | "fail" = "ok") => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/feedback", async (route) => {
      await held;
      if (outcome === "fail") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ code: "FEEDBACK_SUBMIT_FAILED" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, reference: "0001ABCD" }),
      });
    });
    return () => release();
  };

  test("the dialog closes during a send instead of locking shut", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const release = await heldFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("closing while it sends");
    await page.getByTestId("feedback-submit").click();
    // Mid-flight: the close control is live, not disabled.
    await expect(page.getByTestId("feedback-close")).toBeEnabled();
    await page.getByTestId("feedback-close").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();

    // And the user is told the send is still running.
    await expect(page.getByTestId("app-toast")).toContainText(/still sending/i);
    release();
  });

  test("Escape also closes during a send", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const release = await heldFeedbackApi(page);
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("escape while it sends");
    await page.getByTestId("feedback-submit").click();
    await page.keyboard.press("Escape");

    await expect(page.getByTestId("feedback-dialog")).toBeHidden();
    await expect(page.getByTestId("sidebar-feedback-button")).toBeFocused();
    release();
  });

  test("a success that lands after closing still confirms receipt", async ({ page }) => {
    await gotoAuthenticatedChat(page);
    const release = await heldFeedbackApi(page, "ok");
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("finishes after closing");
    await page.getByTestId("feedback-submit").click();
    await page.getByTestId("feedback-close").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();

    release();
    const toast = page.getByTestId("app-toast");
    await expect(toast).toHaveAttribute("data-tone", "success");
    await expect(toast).toContainText("0001ABCD");
  });

  test("a failure that lands after closing reaches the user, and keeps the draft", async ({
    page,
  }) => {
    await gotoAuthenticatedChat(page);
    const release = await heldFeedbackApi(page, "fail");
    await openFeedbackFromSidebar(page);

    await page.getByTestId("feedback-message").fill("fails after closing");
    await page.getByTestId("feedback-submit").click();
    await page.getByTestId("feedback-close").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();

    release();
    // The dialog is gone, so the toast is the only channel left.
    const toast = page.getByTestId("app-toast");
    await expect(toast).toHaveAttribute("data-tone", "error");
    await expect(toast).toContainText(/server problem/i);

    // Reopening shows the same reason and the text that was never sent.
    await openFeedbackFromSidebar(page);
    await expect(page.getByTestId("feedback-message")).toHaveValue(
      "fails after closing"
    );
    await expect(page.getByTestId("feedback-submit-error")).toHaveText(
      /server problem/i
    );
  });
});

// ---------------------------------------------------------------------------
// What the attached diagnostics actually contain
// ---------------------------------------------------------------------------

test.describe("diagnostics disclosure", () => {
  const seedErrorWithSecret = async (page: Page) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini"],
      messages: [
        { id: "u1", role: "user", content: "Hello", status: "normal" },
        {
          id: "a1",
          role: "assistant",
          modelId: "gpt-5-4-mini",
          content: [
            "Provider error for model claude-haiku-4-5-20251001.",
            "Trace ID: 0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012",
            `upstream key ${fakeGoogleKey()} rejected`,
          ].join("\n"),
          status: "error",
        },
      ],
    });
    await restoreActiveConversation(page);
    await page.goto("/chat?lang=en");
    await page.getByTestId("report-error-button").first().click();
    await expect(page.getByTestId("feedback-dialog")).toBeVisible();
  };

  test("the user can read exactly what will be attached @ui-risk", async ({ page }) => {
    await seedErrorWithSecret(page);

    // Not hidden behind the scenes: the preview is in the dialog.
    const preview = page.getByTestId("feedback-diagnostics");
    await expect(preview).toBeVisible();
    await preview.click();
    const body = page.getByTestId("feedback-diagnostics-body");
    await expect(body).toBeVisible();

    const shown = await body.inputValue();
    // The key is gone even though no pattern in the denylist matches it.
    expect(shown).not.toContain(fakeGoogleKey());
    expect(shown).toContain("[redacted]");
    // The diagnostics that make the report useful survive.
    expect(shown).toContain("0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012");
    expect(shown).toContain("claude-haiku-4-5-20251001");
  });

  test("what is previewed is what is sent", async ({ page }) => {
    await seedErrorWithSecret(page);
    const feedback = await mockFeedbackApi(page);

    const body = page.getByTestId("feedback-diagnostics-body");
    await page.getByTestId("feedback-diagnostics").click();
    const shown = (await body.inputValue()).trim();

    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();

    const sent = feedback.requests[0].message;
    expect(sent).toContain(shown);
    expect(sent).not.toContain(fakeGoogleKey());
  });

  test("the user can delete what the sanitiser could not recognise", async ({
    page,
  }) => {
    // The complete answer to "a pattern cannot know what it missed": a short
    // secret no detector can separate from ordinary text is still removable,
    // because the field is the user's to edit.
    await seedErrorWithSecret(page);
    const feedback = await mockFeedbackApi(page);

    await page.getByTestId("feedback-diagnostics").click();
    const body = page.getByTestId("feedback-diagnostics-body");
    await body.fill("Provider error. (details removed by the reporter)");

    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();

    const sent = feedback.requests[0].message;
    expect(sent).toContain("details removed by the reporter");
    // The original diagnostics, sanitised or not, are gone.
    expect(sent).not.toContain("0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012");
  });

  test("the diagnostics can be dropped entirely", async ({ page }) => {
    await seedErrorWithSecret(page);
    const feedback = await mockFeedbackApi(page);

    await page.getByTestId("feedback-diagnostics").click();
    await page.getByTestId("feedback-diagnostics-attach").uncheck();
    await expect(page.getByTestId("feedback-diagnostics-body")).toBeHidden();
    await expect(page.getByTestId("feedback-diagnostics-omitted")).toBeVisible();

    // The report still submits -- the default description satisfies the
    // five-character contract on its own.
    await expect(page.getByTestId("feedback-submit")).toBeEnabled();
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-dialog")).toBeHidden();

    const sent = feedback.requests[0].message;
    expect(sent.trim().length).toBeGreaterThanOrEqual(5);
    expect(sent).not.toContain("Provider error");
    expect(sent).not.toContain("0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012");
  });
});
