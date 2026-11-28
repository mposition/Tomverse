import assert from "node:assert/strict";
import { openCodeProject } from "./code-project-fixture";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const pad = (value: number) => String(value).padStart(2, "0");
const localInput = (instant: number) => {
  const date = new Date(instant);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

test("a read-only schedule set a few seconds ahead runs, and its run record keeps the result", { timeout: 120_000 }, async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "tomverse-scheduled-")));
  const root = join(folder, "project");
  const profile = join(folder, "profile-data", "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      return { text: "Scheduled read complete." };
    },
  }).start();
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile, { recursive: true })]);
    await writeFile(join(root, "notes.txt"), "read me");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    application = await launchNativeFixture(descriptor);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await openCodeProject(page);
    const state = () => page.evaluate(() => window.desktop.state());
    await expect.poll(async () => (await state()).codeCatalog).toBe("ready");

    await page.getByTestId("activity-button").click();
    await page.getByTestId("tab-schedules").click();
    // Schedules are off, and turning them on needs the person to read what that means.
    await expect(page.getByTestId("schedule-off")).toBeVisible();
    await expect(page.getByTestId("schedule-warning")).toContainText("without anyone confirming");
    await expect(page.getByTestId("schedule-warning")).toContainText("always needs your approval");
    await expect(page.getByTestId("schedule-turn-on")).toBeDisabled();
    assert.equal((await state()).schedules?.enabled, false);
    await page.getByLabel("I understand").check();
    await page.getByTestId("schedule-turn-on").click();
    await expect.poll(async () => (await state()).schedules?.enabled).toBe(true);

    // A schedule that asks for allow-all without a worktree and an enforced sandbox is refused, with the reason.
    await page.getByTestId("schedule-new").click();
    const form = page.getByTestId("schedule-form");
    await form.getByLabel("Name").fill("Refused");
    await form.getByLabel("Instruction").fill("Do everything");
    await form.getByLabel("Permission").selectOption("all");
    await form.getByLabel("Repeat").selectOption("daily");
    await page.getByTestId("schedule-save").click();
    await expect(page.getByRole("alert")).toContainText(/sandbox|worktree|Git/i);
    assert.equal((await state()).schedules?.items.length, 0);

    // A read-only schedule a few seconds ahead.
    await form.getByLabel("Name").fill("Read the notes");
    await form.getByLabel("Instruction").fill("Read notes.txt and say what it holds");
    await form.getByLabel("Permission").selectOption("readOnly");
    await form.getByLabel("Repeat").selectOption("once");
    await form.getByLabel("Date and time").fill(localInput(Date.now() + 8_000));
    await page.getByTestId("schedule-save").click();
    await expect.poll(async () => (await state()).schedules?.items.length).toBe(1);
    const item = (await state()).schedules!.items[0]!;
    assert.equal(item.permission, "read_only");
    assert.equal(item.taskMode, "ask");
    assert.equal(item.limits, "standard");
    assert.equal(item.project, root);
    assert.notEqual(item.nextRun, null);

    // It starts by itself, with nobody pressing anything, and the record keeps the outcome.
    await expect.poll(async () => (await state()).schedules?.runs[0]?.status, { timeout: 60_000 }).toBe("completed");
    const run = (await state()).schedules!.runs[0]!;
    assert.equal(run.scheduleId, item.id);
    assert.ok(run.startedAt && run.finishedAt && run.finishedAt >= run.startedAt);
    assert.ok(run.taskId);
    assert.deepEqual(run.files, { count: 0, paths: [] });
    const finished = (await state()).schedules!.items[0]!;
    assert.equal(finished.enabled, false);
    assert.equal(finished.disabledBy, "finished");
    assert.equal(finished.nextRun, null);
    await expect(page.getByTestId("run-row")).toHaveCount(1);
    await expect(page.getByTestId("run-row")).toContainText("Read the notes");
    await expect(page.getByTestId("run-row")).toContainText("Completed");
    assert.equal(gateway.completions.length > 0, true);

    // The result opens as an ordinary saved task.
    await page.getByTestId("run-open").click();
    await expect(page.getByText("Scheduled read complete.", { exact: true })).toBeVisible();
    assert.equal((await state()).task?.id, run.taskId);

    // The record is saved: it is there after a restart, and nothing is run again.
    const saved = JSON.parse(await readFile(join(profile, "schedules.json"), "utf8"));
    assert.equal(saved.runs.length, 1);
    assert.equal(saved.runs[0].status, "completed");
    const before = gateway.completions.length;
    await application.close();
    application = await launchNativeFixture(descriptor);
    const again = await application.firstWindow();
    await again.getByRole("button", { name: "Code", exact: true }).click();
    await openCodeProject(again);
    await again.getByTestId("activity-button").click();
    await again.getByTestId("tab-schedules").click();
    await expect(again.getByTestId("run-row")).toHaveCount(1);
    assert.equal(gateway.completions.length, before);
  } finally {
    await application?.close().catch(() => undefined);
    await gateway.stop();
    await removeNativeFixtureDirectory(folder);
  }
});
