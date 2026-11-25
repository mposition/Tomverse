import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

async function launch(prefix: string, gateway: FakeGateway) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Open local folder" }).click();
  return { directory, profile, app, page };
}

/** The approval window closes as the click lands, so a closed page after the click is the expected end. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

const send = (page: Page) => page.getByRole("button", { name: "Send Code request" });

test("Code shows a background command in its approval, lists it with its output, and Stop ends its process", { timeout: 90_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const server = "console.log('pid ' + process.pid); setInterval(() => console.log('tick'), 200);";
  const gateway = await new FakeGateway({
    async script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", server], background: true } }] };
      if (results === 1) await held;
      return { text: "The server ran and was stopped." };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-background-", gateway);
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("Start the dev server");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send(page).click()]);
    await expect(approval.getByText("keeps running in the background after you allow it", { exact: false })).toBeVisible();
    await expect(approval.getByText("No time limit (background)", { exact: true })).toBeVisible();
    await press(approval, "Allow once");

    const panel = page.getByRole("region", { name: "Background commands" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("status")).toHaveText("Running");
    await panel.getByText("Output", { exact: true }).click();
    await expect(panel.locator("pre")).toContainText(/pid \d+/);
    const pid = Number(/pid (\d+)/.exec(await panel.locator("pre").innerText())![1]);
    assert.ok(alive(pid), "the process runs while the task waits");

    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Stopped");
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
    release();
    await expect(page.getByText("The server ran and was stopped.", { exact: true })).toBeVisible();
  } finally {
    release();
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});

test("Code ends a background command when the task ends", { timeout: 90_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", "console.log('pid ' + process.pid); setInterval(() => {}, 1000)"], background: true } }] };
      return { text: "Done, leaving the server running." };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-background-end-", gateway);
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("Start it and finish");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send(page).click()]);
    await press(approval, "Allow once");
    await expect(page.getByText("Done, leaving the server running.", { exact: true })).toBeVisible({ timeout: 20_000 });
    const panel = page.getByRole("region", { name: "Background commands" });
    await expect(panel.getByRole("status")).toHaveText("Stopped");
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await panel.getByText("Output", { exact: true }).click();
    const pid = Number(/pid (\d+)/.exec(await panel.locator("pre").innerText())![1]);
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});

test("Code asks about a web page with its site and address, and a refusal reads nothing", { timeout: 90_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "web_fetch", args: { url: "https://docs.example.com/guide?page=2#top" } }] };
      return { text: `Read nothing: ${JSON.stringify(fixtureOperationResults(body).at(-1)?.content).slice(0, 80)}` };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-web-", gateway);
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("Read the guide");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send(page).click()]);
    await expect(approval.getByRole("heading", { name: "Read a web page" })).toBeVisible();
    await expect(approval.getByText("docs.example.com", { exact: true })).toBeVisible();
    await expect(approval.getByText("https://docs.example.com/guide?page=2", { exact: true })).toBeVisible();
    await expect(approval.getByRole("button", { name: "Allow for this run", exact: true })).toBeVisible();
    await press(approval, "Deny");
    await expect(page.getByText(/Read nothing: .*The user declined/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});

test("Code keeps a note without asking, shows it in settings, and deletes it; off reads and writes nothing", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "remember_fact", args: { fact: "Integration tests need the docker daemon." } }] };
      return { text: "Noted for later." };
    },
  }).start();
  const { directory, profile, app, page } = await launch("tomverse-desktop-memory-", gateway);
  const noteFiles = async () => (await readdir(join(profile, "code-memory")).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && name !== "settings.json");
  try {
    await page.getByRole("textbox", { name: "Code request" }).fill("Learn the project");
    await send(page).click();
    await expect(page.getByText("Noted for later.", { exact: true })).toBeVisible({ timeout: 20_000 });
    assert.equal((await noteFiles()).length, 1);
    assert.match(await readFile(join(profile, "code-memory", (await noteFiles())[0]!), "utf8"), /Integration tests need the docker daemon\./);
    // The next request carries the notes after the first task: check the model saw them on a new task.
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Code request" }).fill("Another task");
    await send(page).click();
    await expect.poll(() => gateway.completions.some((c) => JSON.stringify(c.body.messages[0]?.content).includes("<project-memory>"))).toBe(true);

    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const memory = page.getByLabel("Project memory", { exact: true });
    await expect(memory).toHaveValue("on");
    await expect(page.getByText("1 note(s) kept for this project.")).toBeVisible();
    await page.getByRole("button", { name: "View", exact: true }).click();
    await expect(page.getByText("Integration tests need the docker daemon.")).toBeVisible();
    await page.getByRole("button", { name: "Delete this note" }).click();
    await expect(page.getByText("Nothing is remembered for this project yet.")).toBeVisible();

    // Off: a new task is given no notes and no remember_fact tool.
    await memory.selectOption("off");
    await expect(memory).toHaveValue("off");
    const before = gateway.completions.length;
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Code request" }).fill("A task with memory off");
    await send(page).click();
    await expect.poll(() => gateway.completions.length).toBeGreaterThan(before);
    const first = gateway.completions[before]!.body;
    assert.ok(!JSON.stringify(first.messages[0].content).includes("project-memory"));
    assert.ok(!first.tools.some((tool: { function: { name: string } }) => tool.function.name === "remember_fact"));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});
