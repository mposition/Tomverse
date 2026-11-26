import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

type Body = { messages?: Array<{ role: string; content?: unknown }> };
const userTexts = (body: Body) => (body.messages ?? []).filter(({ role }) => role === "user").map(({ content }) => String(content));
const exists = (path: string) => access(path).then(() => true, () => false);

test("a plugin installed from a folder shows what it holds before it is installed, its skill joins the / list, and its hook waits for approval and runs only after it", { timeout: 180_000 }, async () => {
  const gateway = await new FakeGateway({ script: () => ({ text: "Understood." }) }).start();
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-plugins-"));
  const [root, profile, claudeDir, tomverse, plugin] = ["project", "profile", "claude", "tomverse", "demo-plugin"].map((name) => join(directory, name)) as [string, string, string, string, string];
  await Promise.all([root, profile, claudeDir, tomverse, join(plugin, ".claude-plugin"), join(plugin, "skills", "greet"), join(plugin, "hooks"), join(plugin, "scripts")]
    .map((path) => mkdir(path, { recursive: true })));
  const marker = join(directory, "hook-ran.txt");
  const node = process.execPath;
  const hookCommand = `${process.platform === "win32" ? "& " : ""}"${node}" "\${CLAUDE_PLUGIN_ROOT}/scripts/mark.mjs"`;
  await Promise.all([
    writeFile(join(profile, "language.txt"), "en"),
    writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-tools", version: "1.2.0", description: "Greeting tools for the demo" })),
    writeFile(join(plugin, "skills", "greet", "SKILL.md"), "---\ndescription: Greet someone from the demo plugin\nargument-hint: \"[who]\"\n---\nGreet $ARGUMENTS warmly.\n"),
    writeFile(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }] } })),
    writeFile(join(plugin, "scripts", "mark.mjs"), `import { readFileSync, writeFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`),
  ]);
  const descriptor = join(directory, "fixture.json");
  // pluginFolder stands in for the folder dialog, which this test cannot click.
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, pluginFolder: plugin }));
  const app = await electron.launch({
    executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, TOMVERSE_HOME: tomverse },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();

    // Install from a folder: a preview first, with the counts and the hook's command in full. Nothing is installed yet.
    const panel = page.getByTestId("plugins");
    await expect(panel.getByTestId("plugin-row")).toHaveCount(0);
    await panel.getByTestId("plugin-install-folder").click();
    const preview = panel.getByTestId("plugin-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("heading", { name: "Install demo-tools?" })).toBeVisible();
    await expect(preview.getByTestId("plugin-preview-counts")).toHaveText("1 skills, 0 commands, 0 agents, 1 hooks, 0 MCP servers");
    await expect(preview).toContainText("demo-tools:greet");
    await expect(preview.getByTestId("plugin-preview-hook")).toContainText("SessionStart");
    await expect(preview.getByTestId("plugin-preview-hook")).toContainText("${CLAUDE_PLUGIN_ROOT}/scripts/mark.mjs");
    await expect(preview).toContainText("Nothing runs before that.");
    await expect(panel.getByTestId("plugin-row")).toHaveCount(0);
    assert.equal(await exists(join(tomverse, "plugins", "installed", "demo-tools")), false, "nothing is installed before the confirmation");

    // Cancel leaves nothing; asking again and confirming installs it.
    await preview.getByTestId("plugin-cancel").click();
    await expect(preview).toHaveCount(0);
    assert.equal(await exists(join(tomverse, "plugins", "installed", "demo-tools")), false);
    await panel.getByTestId("plugin-install-folder").click();
    await panel.getByTestId("plugin-confirm").click();
    const row = panel.getByTestId("plugin-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("demo-tools 1.2.0");
    await expect(row.getByTestId("plugin-contents")).toHaveText("1 skills, 0 commands, 0 agents, 1 hooks, 0 MCP servers");
    await expect(row.getByTestId("plugin-pending")).toHaveText("1 waiting for your approval");
    assert.equal(await exists(join(tomverse, "plugins", "installed", "demo-tools", "skills", "greet", "SKILL.md")), true);

    // The hook is listed with its origin and waits; nothing has run it.
    const hook = page.getByTestId("local-extensions").getByTestId("local-hook").filter({ hasText: "SessionStart" });
    await expect(hook).toBeVisible();
    await expect(hook).toContainText("Plugin demo-tools");
    await expect(hook.getByRole("status")).toHaveText("Waiting for your approval");

    // Back in Code: the plugin's skill is in the / list under its plugin name, and runs.
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByLabel("Code mode").selectOption("ask");
    const composer = page.getByRole("textbox", { name: "Code request" });
    await composer.fill("/demo");
    const menu = page.getByTestId("slash-menu");
    await expect(menu.getByRole("option", { name: /\/demo-tools:greet \[who\]\s*skill/ })).toBeVisible();
    await composer.fill("/demo-tools:greet Ada");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("Understood.", { exact: true })).toBeVisible({ timeout: 20_000 });
    const asked = userTexts(gateway.completions[0]!.body as Body).at(-1)!;
    assert.match(asked, /The user ran the skill demo-tools:greet with: Ada/);
    assert.match(asked, /Greet Ada warmly\./);
    assert.equal(await exists(marker), false, "the plugin's hook did not run: it was not approved");

    // Approve the hook in Settings; the next task runs it.
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const approving = page.getByTestId("local-extensions").getByTestId("local-hook").filter({ hasText: "SessionStart" });
    await approving.getByRole("button", { name: /^Approve/ }).click();
    await expect(approving.getByRole("status")).toHaveText("On");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Code mode").selectOption("ask");
    await composer.fill("Say hi");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length, { timeout: 20_000 }).toBe(2);
    await expect.poll(() => exists(marker), { timeout: 20_000 }).toBe(true);
    assert.equal(await readFile(marker, "utf8"), "ran");

    // Remove: only the plugin's own folder goes, and its skill leaves the list.
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await panel.getByRole("button", { name: "Remove: demo-tools" }).click();
    await panel.getByRole("button", { name: "Remove: demo-tools" }).click();
    await expect(panel.getByTestId("plugin-row")).toHaveCount(0);
    assert.equal(await exists(join(tomverse, "plugins", "installed", "demo-tools")), false);
    assert.equal(await exists(join(tomverse, "plugins", "state.json")), true);
  } finally {
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
