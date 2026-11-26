import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function launch(prefix: string, gateway: FakeGateway) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(join(root, "sum.js"), "export const sum = (a, b) => a - b;\n");
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Open local folder" }).click();
  return { directory, root, profile, app, page };
}

async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

const send = (page: Page) => page.getByRole("button", { name: "Send Code request" });
const answerDialog = (app: ElectronApplication, response: number) =>
  app.evaluate(({ dialog }, choice) => { dialog.showMessageBox = async () => ({ response: choice, checkboxChecked: false }); }, response);
const exists = (path: string) => access(path).then(() => true, () => false);
const isSub = (body: { messages?: Array<{ content?: unknown }> }) => /subagent of Tomverse CLI/.test(String(body.messages?.[0]?.content));

/** One task: plan, create made.txt after approval, answer. */
const fileScript = (body: Parameters<typeof fixtureNeedsWorkPlan>[0]) => {
  if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
  const results = fixtureOperationResults(body).length;
  if (results === 0) {
    return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "made.txt", action: "create", content: "hello\n" }], explanation: "make the file" } }] };
  }
  return { text: "Made the file." };
};

test("Code lists the subagents the model started, with their reports as unverified", { timeout: 90_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (isSub(body)) {
        return body.messages.some((message: { role: string }) => message.role === "tool")
          ? { text: "sum() subtracts instead of adding (sum.js line 1)." }
          : { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
      }
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      return fixtureOperationResults(body).length === 0
        ? { toolCalls: [{ name: "delegate", args: { kind: "explore", tasks: ["Find out what sum() does"] } }] }
        : { text: "The subagent found the bug." };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-subagents-", gateway);
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("What is wrong with sum?");
    await send(page).click();
    await expect(page.getByText("The subagent found the bug.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const panel = page.getByRole("region", { name: "Subagents · 1" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Explore", { exact: true })).toBeVisible();
    await expect(panel.getByText("Done", { exact: true })).toBeVisible();
    await expect(panel.getByText("2 request(s)", { exact: true })).toBeVisible();
    await expect(panel.getByText("Find out what sum() does", { exact: true })).toBeVisible();
    await panel.getByText("Report (not verified)", { exact: true }).click();
    await expect(panel.locator("pre")).toContainText("sum() subtracts instead of adding");
    // Its two requests are part of the task's own requests, not a separate count.
    assert.equal(gateway.completions.filter((entry) => isSub(entry.body)).length, 2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});

test("Code rewinds a finished task to a message: the file comes back out, the message returns to the input box", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({ script: fileScript }).start();
  const { directory, root, app, page } = await launch("tomverse-desktop-rewind-", gateway);
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("Make the file");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send(page).click()]);
    await press(approval, "Allow once");
    await expect(page.getByText("Made the file.", { exact: true })).toBeVisible({ timeout: 30_000 });
    assert.equal(await readFile(join(root, "made.txt"), "utf8"), "hello\n");

    // Cancelling the confirmation changes nothing.
    await answerDialog(app, 0);
    await page.getByLabel("Actions for this message").first().click();
    await page.getByRole("button", { name: "Rewind to here" }).click();
    await expect(page.getByRole("button", { name: "Rewind to here" })).toBeEnabled();
    assert.equal(await exists(join(root, "made.txt")), true);

    // Files and conversation (button 1 of the confirmation).
    await answerDialog(app, 1);
    await page.getByRole("button", { name: "Rewind to here" }).click();
    await expect(page.getByText("Rewound. The message is back in the input box.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("textbox", { name: "Code request" })).toHaveValue("Make the file");
    assert.equal(await exists(join(root, "made.txt")), false, "the file the task created is gone");
    assert.equal(await readFile(join(root, "sum.js"), "utf8"), "export const sum = (a, b) => a - b;\n", "untouched files stay");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});

test("Code forks a finished task at a message into a new task and leaves the first one and the files alone", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({ script: fileScript }).start();
  const { directory, root, profile, app, page } = await launch("tomverse-desktop-fork-", gateway);
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("Make the file");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send(page).click()]);
    await press(approval, "Allow once");
    await expect(page.getByText("Made the file.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const sessions = async () => {
      const found: string[] = [];
      for (const space of await readdir(join(profile, "code")).catch(() => [] as string[])) {
        found.push(...await readdir(join(profile, "code", space, "sessions")).catch(() => [] as string[]));
      }
      return found;
    };
    const before = await sessions();
    assert.equal(before.length, 1);

    await answerDialog(app, 1);
    await page.getByLabel("Actions for this message").first().click();
    await page.getByRole("button", { name: "Fork from here" }).click();
    await expect.poll(async () => (await sessions()).length, { timeout: 15_000 }).toBe(2);
    assert.equal(await readFile(join(root, "made.txt"), "utf8"), "hello\n", "no file was touched");
    // The new task is open: it holds the conversation, and it has no change of the first one to undo.
    await expect(page.getByText("Make the file", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Made the file.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /made\.txt/ })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});
