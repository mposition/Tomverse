import { test, expect, type Page } from "@playwright/test";

/**
 * The §22 import/memory report reader.
 *
 * Its whole contract is how it renders things that are *not* numbers: a
 * metric nothing measures, and a rate with no denominator. Both look like
 * zero if rendered carelessly, and both mean the opposite of zero.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const memoryReport = (overrides: Record<string, unknown> = {}) => ({
  windowDays: 7,
  generatedAt: "2026-08-04T00:00:00.000Z",
  memoriesUnavailable: false,
  runsUnavailable: false,
  truncated: false,
  memories: {
    total: 12,
    byStatus: { active: 6, candidate: 4, rejected: 2 },
    approvalRate: 0.75,
    rejectionRate: 0.25,
    editedRate: 0.5,
    sensitiveRate: 0.125,
    userAuthored: 3,
  },
  runs: {
    total: 3,
    byStatus: { completed: 2, failed: 1 },
    byPair: [
      {
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
        runs: 3,
        completed: 2,
        failed: 1,
        cancelled: 0,
        failureRate: 0.3333,
      },
    ],
  },
  counters: {
    validator_rejected: 5,
    source_delete_memory_deleted: 2,
    source_delete_memory_suspended: 1,
    memory_expired: 4,
  },
  unavailable: [
    {
      metric: "injection_ratio",
      reason: "no chat request builds a memory context yet (§10 wiring)",
    },
  ],
  ...overrides,
});

const mockReports = async (
  page: Page,
  options: {
    memory?: Record<string, unknown>;
    memoryStatus?: number;
    importsStatus?: number;
  } = {}
) => {
  await page.route(
    (url) => url.pathname === "/api/admin/memory",
    (route) =>
      options.memoryStatus && options.memoryStatus !== 200
        ? route.fulfill({
            status: options.memoryStatus,
            contentType: "application/json",
            body: JSON.stringify({ error: "Failed to load the memory report." }),
          })
        : route.fulfill(json(memoryReport(options.memory)))
  );
  await page.route(
    (url) => url.pathname === "/api/admin/external-imports",
    (route) =>
      options.importsStatus && options.importsStatus !== 200
        ? route.fulfill({ status: options.importsStatus, body: "" })
        : route.fulfill(json({ windowDays: 7, imports: { total: 0 } }))
  );
};

const openPanel = async (page: Page) => {
  await page.goto("/e2e/admin-console-fixture?view=memory");
  await expect(page.getByTestId("admin-memory-import-panel")).toBeVisible();
};

const followupProxy = {
  memory: {
    answers: 40,
    followups: 12,
    regenerates: 4,
    followupRate: 0.3,
    regenerateRate: 0.1,
  },
  plain: {
    answers: 80,
    followups: 20,
    regenerates: 4,
    followupRate: 0.25,
    regenerateRate: 0.05,
  },
  followupDifference: 0.05,
  regenerateDifference: 0.05,
};

/**
 * The follow-up proxy arrived after this reader shipped and after these tests
 * were written, and nothing here covered it. Reading it unconditionally meant a
 * report without it threw during render, and the error boundary answered by
 * replacing the whole Admin Console with "Something went wrong" — so the panel
 * you open *because* something is wrong became the second thing that was.
 *
 * Both directions are asserted, because only one of them is the interesting
 * one: a report that carries the proxy shows both arms, and a report that does
 * not says so and still renders everything else.
 */
test("the follow-up proxy shows both arms when the report carries them", async ({
  page,
}) => {
  await mockReports(page, { memory: { followupProxy } });
  await openPanel(page);

  const section = page.getByTestId("admin-memory-followup-proxy");
  await expect(section).toContainText("30%");
  await expect(section).toContainText("25%");
  // Read as a comparison, never as a rate on its own.
  await expect(section).toContainText("vs");
  await expect(
    page.getByTestId("admin-memory-followup-proxy-unavailable")
  ).toHaveCount(0);
});

test("a report without the follow-up proxy says so instead of crashing", async ({
  page,
}) => {
  // The default mock omits it, exactly as the endpoint's older shape did.
  await mockReports(page);
  await openPanel(page);

  await expect(
    page.getByTestId("admin-memory-followup-proxy-unavailable")
  ).toContainText("Not measured");
  // Two arms of "0% vs 0%" would read as a measured result showing no
  // difference, which is the one conclusion the absence does not support.
  await expect(page.getByTestId("admin-memory-followup-proxy")).not.toContainText(
    "0% vs 0%"
  );
  // And the rest of the report is still there -- the point of the guard.
  await expect(page.getByTestId("admin-memory-status-list")).toContainText("active");
});

test("the report renders counts, rates and the per-pair breakdown", async ({
  page,
}) => {
  await mockReports(page);
  await openPanel(page);

  await expect(page.getByTestId("admin-memory-status-list")).toContainText("active");
  await expect(page.getByTestId("admin-memory-counter-list")).toContainText(
    "validator rejected"
  );
  const rows = page.getByTestId("admin-memory-pair-rows").locator("tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("gpt-5-6-luna");
  await expect(rows.first()).toContainText("33.3%");
});

test("an unmeasured metric is listed with its reason, not shown as zero", async ({
  page,
}) => {
  await mockReports(page);
  await openPanel(page);

  const unavailable = page.getByTestId("admin-memory-unavailable");
  await expect(unavailable).toContainText("injection ratio");
  await expect(unavailable).toContainText("§10 wiring");
  // The thing this panel exists to avoid: an unmeasured metric rendered as 0%.
  await expect(unavailable).not.toContainText("0%");
});

test("a rate with no denominator reads as no data, not as zero", async ({
  page,
}) => {
  await mockReports(page, {
    memory: {
      memories: {
        total: 2,
        byStatus: { candidate: 2 },
        approvalRate: null,
        rejectionRate: null,
        editedRate: null,
        sensitiveRate: null,
        userAuthored: 0,
      },
    },
  });
  await openPanel(page);

  const panel = page.getByTestId("admin-memory-import-panel");
  await expect(panel).toContainText("—");
  await expect(panel).not.toContainText("0%");
});

test("the row cap is stated rather than left to look like the whole window", async ({
  page,
}) => {
  await mockReports(page, { memory: { truncated: true } });
  await openPanel(page);

  await expect(page.getByTestId("admin-memory-caveat")).toContainText("row cap");
});

test("a missing import report does not blank the memory figures", async ({
  page,
}) => {
  await mockReports(page, { importsStatus: 500 });
  await openPanel(page);

  await expect(page.getByTestId("admin-import-missing")).toBeVisible();
  await expect(page.getByTestId("admin-memory-status-list")).toBeVisible();
});

test("a failed memory report says so instead of rendering an empty panel", async ({
  page,
}) => {
  await mockReports(page, { memoryStatus: 500 });
  await openPanel(page);

  await expect(page.getByTestId("admin-memory-error")).toBeVisible();
  await expect(page.getByTestId("admin-memory-status-list")).toHaveCount(0);
});
