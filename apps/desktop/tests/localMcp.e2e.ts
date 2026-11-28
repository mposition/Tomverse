import assert from "node:assert/strict";
import { openCodeProject } from "./code-project-fixture";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURE_SERVER = fileURLToPath(new URL("../../tomverse-cli/tests/fixtures/mcp-server.mjs", import.meta.url));

/** The approval window closes as the click lands, so a closed page after the click is the expected end. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

test("a project's .mcp.json server waits for approval, and once approved the model calls its tool after the person allows it", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body);
      if (results.length === 0) return { toolCalls: [{ name: "mcp__repo__echo", args: { text: "hello from the fixture" } }] };
      return { text: `The server said: ${JSON.stringify(results.at(-1)?.content).slice(0, 400)}` };
    },
  }).start();
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-localmcp-"));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  const home = join(directory, "tomverse-home");
  const claudeDir = join(directory, "claude");
  await Promise.all([mkdir(root), mkdir(profile), mkdir(home), mkdir(claudeDir)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: process.execPath, args: [FIXTURE_SERVER] } } }));
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({
    executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000,
    env: { ...process.env, TOMVERSE_HOME: home, CLAUDE_CONFIG_DIR: claudeDir } as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await openCodeProject(page);
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();

    // The repository's own server is listed, and waits: nothing has started it.
    const panel = page.getByTestId("local-extensions");
    const row = panel.getByTestId("local-mcp-server").filter({ hasText: "repo" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("status")).toHaveText("Waiting for your approval");
    await expect(row).toContainText("This project");

    // Nothing was sent to the model, and the server has not been started; approve it in Settings.
    assert.equal(gateway.completions.length, 0);
    await panel.getByRole("button", { name: "Approve: repo" }).click();
    await expect(row.getByRole("status").first()).toHaveText("Ready");

    // The task: the model calls the tool, the person is asked with the server, tool and arguments.
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("textbox", { name: "Code request" }).fill("Call the project's echo tool");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 15_000 }), page.getByRole("button", { name: "Send Code request" }).click()]);
    await expect(approval.getByRole("heading", { name: "Call an MCP tool" })).toBeVisible();
    await expect(approval.getByText("repo", { exact: true })).toBeVisible();
    await expect(approval.getByText("echo", { exact: true })).toBeVisible();
    await expect(approval.getByText("hello from the fixture")).toBeVisible();
    await expect(approval.getByText("From this project's .mcp.json (approved by you)")).toBeVisible();
    await press(approval, "Allow once");
    await expect(page.getByText(/The server said: .*hello from the fixture/)).toBeVisible({ timeout: 30_000 });
    assert.ok(gateway.completions.some((c) => JSON.stringify(c.body.tools).includes("mcp__repo__echo")), "the model was offered the approved server's tool");
    assert.match(JSON.stringify(fixtureOperationResults(gateway.completions.at(-1)!.body).at(-1)), /untrusted/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});
