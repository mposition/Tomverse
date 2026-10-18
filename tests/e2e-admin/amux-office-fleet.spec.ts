import { randomUUID } from "node:crypto";

import { AMUX_WORKER_REGISTRY_V31_SEED } from "@/lib/amux/workerRegistryCore";

import { expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

test("the AMUX floor shows the resident roster, not obsolete runtime workers", async ({ page, signInAs }) => {
  const now = new Date();
  // Orchestration policy version 35, section 3 (R2c): the floor seats every
  // registered worker that is not retired, so the registry holds the thirteen
  // production registered in R1 (seven active, six requested). Each event
  // points at an audit row; the fixture schema has no triggers to require more.
  const database = adminFixtureDatabase();
  for (const entry of AMUX_WORKER_REGISTRY_V31_SEED) {
    const audit = await database.adminAuditLog.create({
      data: { action: "amux.worker.register", targetType: "AmuxWorker", targetId: entry.workerName,
        summary: "office e2e registry seed" },
    });
    await database.amuxWorkerRegistryEvent.create({
      data: {
        id: randomUUID(), workerName: entry.workerName, providerClass: entry.workerName.split("-")[0]!,
        roleCeiling: entry.roleCeiling, desiredState: entry.desiredState, revision: 1,
        actorUserId: "office-e2e-owner", auditLogId: audit.id,
      },
    });
  }
  await database.amuxWorkerRuntime.createMany({
    data: ["devin-worker", "engineering-runner", "cursor-worker"].map((workerName) => ({
      workerName, instanceId: "office-e2e", status: "idle", dispatchReady: true,
      heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + 90_000),
    })),
  });
  await signInAs("owner");
  await page.goto("/admin/office");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  const workers = page.getByTestId("agent-office-amux-person");
  await expect(workers).toHaveCount(13);
  const labels = await workers.evaluateAll((elements) => elements.map((el) => el.getAttribute("aria-label")));
  expect(labels.some((label) => label?.includes("devin-worker"))).toBe(false);
  expect(labels.some((label) => label?.includes("engineering-runner"))).toBe(false);
  for (const prefix of ["cursor-", "copilot-"]) {
    expect(labels.filter((label) => label?.startsWith(prefix))).toHaveLength(3);
  }
  await expect(page.getByTestId("agent-office-amux-note")).toContainText("policy v27");
  // Historical runtime rows cannot grant an unadmitted resident a green light.
  const cursor = workers.filter({ hasText: "cursor-worker" });
  await expect(cursor).toHaveAttribute("data-worker-state", /^(not_admitted|catalog_unknown)$/);
  await expect(page.getByTestId("agent-office-amux-connection")).toHaveAttribute("data-connection-state", "waiting");

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(workers).toHaveCount(13);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overlaps = await workers.evaluateAll((elements) => {
      const boxes = elements.map((element) => element.lastElementChild!.getBoundingClientRect());
      return boxes.some((a, i) => boxes.some((b, j) => i < j && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
    });
    expect(overlaps).toBe(false);
    await page.getByTestId("agent-office-world").screenshot({ path: `test-results-admin/agent-office-amux-${viewport.width}.png` });
  }
});
