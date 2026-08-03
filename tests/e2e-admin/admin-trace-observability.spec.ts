import {
  FIXTURE_FEEDBACK,
  FIXTURE_TRACE_REPORT,
  expect,
  test,
} from "./support/console";

/**
 * Trace-based error report observability in the Admin Console
 * (docs/policy/trace-feedback-automation.md).
 *
 * What must hold on the feedback inbox:
 *   - a verified report reads as an authenticated server fact, with its
 *     evidence block and its Phase 2 shadow-diagnosis line -- labelled as
 *     observation only, because no auto-fix pipeline is active;
 *   - a client-classified EMPTY_RESPONSE reads as exactly that, never as a
 *     verified server error;
 *   - the raw error report token appears nowhere (it is never stored, so
 *     nothing on this screen can even try).
 *
 * And on the observation metrics endpoint:
 *   - an admin gets the aggregate counts the Phase 3 go/no-go reads;
 *   - a non-administrator gets the same 404 every admin surface answers.
 */

test.describe("trace observability", () => {
  test("a verified report shows its evidence and its shadow diagnosis", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/feedback");

    const entry = page
      .getByTestId("feedback-entry")
      .filter({ hasText: FIXTURE_FEEDBACK.open.message });
    await expect(entry).toBeVisible();

    const verification = entry.getByTestId("feedback-trace-verification");
    await expect(verification).toContainText(
      "Verified server error (signed token)"
    );
    await expect(verification).toContainText(
      "server_generated (authenticated)"
    );
    await expect(verification).toContainText("Evidence recorded");

    const evidence = entry.getByTestId("feedback-trace-evidence");
    await expect(evidence).toContainText(
      FIXTURE_TRACE_REPORT.verified.errorCode
    );
    await expect(evidence).toContainText(
      FIXTURE_TRACE_REPORT.verified.release
    );
    await expect(evidence).toContainText("openai / gpt-5-6-luna");

    const shadowCase = entry.getByTestId("feedback-autofix-case");
    await expect(shadowCase).toContainText(
      "Shadow diagnosis (observation only, no auto-fix)"
    );
    await expect(shadowCase).toContainText("awaiting_human_review");
    await expect(shadowCase).toContainText("application_candidate");
  });

  test("a client-classified empty response never reads as verified", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/feedback");

    const entry = page
      .getByTestId("feedback-entry")
      .filter({ hasText: FIXTURE_FEEDBACK.slaBreached.message });
    await expect(entry).toBeVisible();

    const verification = entry.getByTestId("feedback-trace-verification");
    await expect(verification).toContainText(
      "Client-classified EMPTY_RESPONSE — server token not issued"
    );
    await expect(verification).toContainText("(client claim)");
    await expect(verification).not.toContainText("Verified server error");
    // No evidence row exists for it, and no shadow case was queued.
    await expect(entry.getByTestId("feedback-trace-evidence")).toHaveCount(0);
    await expect(entry.getByTestId("feedback-autofix-case")).toHaveCount(0);
  });

  test("the raw token never reaches the inbox markup", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/feedback");
    await expect(
      page
        .getByTestId("feedback-entry")
        .filter({ hasText: FIXTURE_FEEDBACK.open.message })
    ).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("terr1.");
    expect(html).not.toContain("errorReportToken");
  });

  test("observation metrics aggregate for admins and 404 for customers", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const response = await page.request.get("/api/admin/trace-diagnostics");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      shadowModeEnabled: boolean;
      reports: { withTraceId: number; verification: Record<string, number> };
      shadowCases: {
        byState: Record<string, number>;
        byClassification: Record<string, number>;
      };
    };
    // Both seeded traced reports are inside the 30-day window.
    expect(body.reports.withTraceId).toBeGreaterThanOrEqual(2);
    expect(body.reports.verification.verified).toBeGreaterThanOrEqual(1);
    expect(body.reports.verification.missing_token).toBeGreaterThanOrEqual(1);
    expect(
      body.shadowCases.byState.awaiting_human_review
    ).toBeGreaterThanOrEqual(1);
    expect(
      body.shadowCases.byClassification.application_candidate
    ).toBeGreaterThanOrEqual(1);
    // Aggregates only: no trace value, no report body, no token.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(FIXTURE_TRACE_REPORT.verified.traceId);
    expect(raw).not.toContain(FIXTURE_FEEDBACK.open.message);
  });

  test("a non-administrator gets a 404 from the metrics endpoint", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    const response = await page.request.get("/api/admin/trace-diagnostics");
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Not found." });
  });
});
