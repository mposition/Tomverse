import assert from "node:assert/strict";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { decideNativePatch, launchNativeFixture } from "./launch-native-fixture";

test("Accept Edits survives startup and keeps commands behind approval", { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-project-permissions-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({
    script(_body, index) {
      if (index === 0) return fixtureInitialWorkPlan;
      if (index === 1) return { toolCalls: [{ name: "apply_patch", args: {
        edits: [{ path: "sample.txt", action: "update", replacements: [{ old: "before", new: "after" }] }],
      } }] };
      if (index === 2) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "--version"] } }] };
      return { text: "The scoped edit is complete." };
    },
  }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(root, "sample.txt"), "before\n");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    const open = async () => {
      app = await launchNativeFixture(descriptor);
      const page = await app.firstWindow();
      await openCodeProject(page);
      await selectCodeMode(page, "agent");
      return page;
    };
    const initial = await open();
    const select = initial.getByLabel("Project permissions");
    await expect(select).toHaveValue("manual");
    await select.selectOption("accept_edits");
    await expect(select).toHaveValue("accept_edits");
    await app!.close();
    const page = await open();
    await expect(page.getByLabel("Project permissions")).toHaveValue("accept_edits");
    await assert.rejects(page.evaluate(() => window.desktop.start({
      prompt: "Read only", mode: "ask", model: "fake-coder", effort: "default", permissionProfile: "accept_edits",
    })));
    assert.equal(gateway.completions.length, 0);
    await page.getByRole("textbox", { name: "Code request" }).fill("Edit the sample file");
    const [approval] = await Promise.all([
      app!.waitForEvent("window", { timeout: 15_000 }),
      page.getByRole("button", { name: "Send Code request" }).click(),
    ]);
    await expect(approval.getByText("run_command", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "after\n");
    await decideNativePatch(approval, "Deny");
    await expect(page.getByText("The scoped edit is complete.", { exact: true })).toBeVisible();
    assert.equal(gateway.completions.length, 4);
    const transcript = gateway.completions[3]?.body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(transcript.filter(({ role }) => role === "tool").at(-1)?.content, "The user declined.");
    const taskId = (await page.evaluate(() => window.desktop.state())).task?.id;
    assert.ok(taskId);
    const [namespace] = await readdir(join(profile, "code"));
    const journal = JSON.parse(await readFile(join(profile, "code", namespace, "sessions", taskId, "session.json"), "utf8"));
    assert.equal(journal.codePermission, "desktop-accept-edits-v1");
    await expect(page.getByRole("button", { name: "Linked GitHub pull requests" })).toBeVisible();
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
