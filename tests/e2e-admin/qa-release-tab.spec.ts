import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";
import { buildQaReleaseDigest } from "../../lib/qaReleaseDigestBuildCore";

/**
 * Admin › Agent digests › QA and release (components/admin/AdminAgentDigestsPanel.tsx):
 * what needs the operator comes first, then the status figures, the main
 * release and the merge lane, and the latest digest; the train and the agent
 * settings are collapsed. CI admission is its own tab.
 */

const REVISION = 9_001;
const LATCH = 9_001;
const DIGEST_KEY = "qa-release:daily:e2e-qa-tab";
const now = new Date();
const date = now.toISOString().slice(0, 10);

const digest = buildQaReleaseDigest({
  digestDate: date,
  baseSha: "a".repeat(40),
  generatedAt: now.toISOString(),
  runDeadline: new Date(now.getTime() + 15 * 60_000).toISOString(),
  gateReport: {
    classified: [
      ...Array.from({ length: 9 }, (_, i) => ({ id: `GATE-E${i}`, status: "approved", verdict: "evidence_present" })),
      { id: "GATE-N1", status: "pending", verdict: "not_implemented" },
      { id: "GATE-N2", status: "pending", verdict: "not_implemented" },
      { id: "GATE-U1", status: "pending", verdict: "unmapped" },
    ],
  },
  hypotheticalReports: [],
  issueReport: { classified: [] },
  checks: [{ name: "check:release-records", result: "fail" }],
  ci: [
    { workflow: "e2e.yml", runId: "1001", job: "playwright", shard: 3, jobConclusion: "failure", label: "flaky_suspected" },
    { workflow: "admin-console-e2e.yml", runId: "1002", job: "admin-console-e2e-shard", shard: 1, jobConclusion: "timed_out", label: "infra" },
    { workflow: "e2e.yml", runId: "1003", job: "regression", shard: null, jobConclusion: "success", label: null },
  ],
  releaseLane: [],
  notChecked: [],
});
const payload = JSON.parse(JSON.stringify(digest));
const bytes = Buffer.from(JSON.stringify(payload));

const cleanup = async () => {
  const db = adminFixtureDatabase();
  await db.qaReleaseMergeLaneLatch.deleteMany({ where: { sequence: LATCH } });
  await db.agentDigestItem.deleteMany({ where: { agentKey: "qa-release", idempotencyKey: DIGEST_KEY } });
  await db.qaReleaseOperatorControl.deleteMany({ where: { revision: REVISION } });
};

test.afterEach(cleanup);

test("the QA and release tab leads with what needs the operator, and CI admission has its own tab", async ({ page, signInAs }) => {
  await cleanup();
  const db = adminFixtureDatabase();
  await db.qaReleaseOperatorControl.create({
    data: { revision: REVISION, digestEnabled: true, mergeLaneEnabled: true, developLaneOn: true, auditLogId: "e2e-qa-tab-control" },
  });
  await db.agentDigestItem.create({
    data: {
      id: randomUUID(),
      agentKey: "qa-release",
      kind: "daily_digest",
      schemaVersion: digest.schemaVersion,
      idempotencyKey: DIGEST_KEY,
      payload,
      payloadSha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    },
  });
  await db.qaReleaseMergeLaneLatch.create({
    data: { sequence: LATCH, latched: true, reason: "deploy_failed", auditLogId: "e2e-qa-tab-latch" },
  });

  await signInAs("owner");
  // The old address still lands here (ADMIN_AGENT_DIGESTS_LEGACY_TABS).
  await page.goto("/admin/agent-digests?tab=qa-release");
  await expect(page).toHaveURL(/\/admin\/qa-release\?tab=overview$/);
  await page.getByRole("button", { name: "Decline", exact: true }).click();

  const tab = page.getByTestId("qa-release-tab");
  await expect(tab).toBeVisible();
  // CI admission no longer sits on this tab.
  await expect(page.getByTestId("ci-admission-section")).toHaveCount(0);

  const attention = tab.getByTestId("qa-release-attention");
  await expect(attention.getByTestId("qa-release-attention-lane_latched")).toContainText("The develop merge lane is latched");
  await expect(attention.getByTestId("qa-release-attention-ci_failed")).toContainText("2 CI jobs failed");
  await expect(attention.getByTestId("qa-release-attention-checks_failed")).toContainText("1 static checks failed");

  await expect(tab.getByTestId("qa-release-status-gates")).toContainText("9 / 12");
  await expect(tab.getByTestId("agent-digest-failed-ci")).toContainText("e2e.yml › playwright #3");
  await expect(tab.getByTestId("agent-digest-failed-ci")).toContainText("flaky suspected");
  await expect(tab.getByTestId("qa-release-merge-lane")).toContainText("Latched");

  // The train and the settings start collapsed; the attention action opens its target.
  await expect(tab.getByTestId("qa-release-settings")).not.toHaveAttribute("open", "");
  await expect(tab.getByTestId("agent-digest-control")).toBeHidden();
  await attention.getByRole("link", { name: "Check and decide" }).click();
  await expect(tab.getByTestId("qa-release-merge-lane")).toBeInViewport();
  await page.screenshot({ path: "test-results-admin/qa-release-tab-dark.png", fullPage: true });

  await page.context().addCookies([{ name: "tomverse_admin_theme", value: "light", url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId("qa-release-tab")).toBeVisible();
  await page.screenshot({ path: "test-results-admin/qa-release-tab-light.png", fullPage: true });

  // CI admission is a tab of its own.
  await page.getByRole("link", { name: /^CI admission/ }).click();
  await expect(page).toHaveURL(/tab=ci-admission/);
  await expect(page.getByTestId("ci-admission-section")).toBeVisible();
  await expect(page.getByTestId("qa-release-tab")).toHaveCount(0);
});
