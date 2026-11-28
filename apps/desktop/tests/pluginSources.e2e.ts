import assert from "node:assert/strict";
import { openCodeProject } from "./code-project-fixture";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { zipOf } from "../../tomverse-cli/tests/archiveBuilders.js";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const exists = (path: string) => access(path).then(() => true, () => false);

const pluginItems = [
  { name: "demo-main/.claude-plugin/plugin.json", data: JSON.stringify({ name: "zip-tools", version: "2.0.0", description: "Installed from a zip file" }) },
  { name: "demo-main/skills/greet/SKILL.md", data: "---\ndescription: Greet someone from the zip plugin\n---\nGreet warmly.\n" },
  { name: "demo-main/hooks/hooks.json", data: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node mark.mjs" }] }] } }) },
  { name: "demo-main/mark.mjs", data: "console.log('should not run');\n" },
];

async function launch(zip: Buffer, sources: boolean) {
  const gateway = await new FakeGateway({ script: () => ({ text: "Understood." }) }).start();
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-plugin-sources-"));
  const [root, profile, claudeDir, tomverse] = ["project", "profile", "claude", "tomverse"].map((name) => join(directory, name)) as [string, string, string, string];
  await Promise.all([root, profile, claudeDir, tomverse].map((path) => mkdir(path, { recursive: true })));
  const archive = join(directory, "demo.zip");
  await Promise.all([writeFile(join(profile, "language.txt"), "en"), writeFile(archive, zip)]);
  const descriptor = join(directory, "fixture.json");
  // pluginZip stands in for the file dialog; pluginSources stands in for the server's switch.
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, pluginZip: archive, pluginSources: sources }));
  const app = await electron.launch({
    executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, TOMVERSE_HOME: tomverse },
  });
  const page = await app.firstWindow();
  await openCodeProject(page);
  await page.getByRole("button", { name: "Desktop settings" }).click();
  await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
  return { app, page, tomverse, panel: page.getByTestId("plugins"), close: async () => {
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } };
}

test("with the sources on: the official marketplace is shown and can be turned off for good, and a zip file is previewed with its SHA-256 before it is installed", { timeout: 180_000 }, async () => {
  const { page, panel, tomverse, close } = await launch(zipOf(pluginItems), true);
  try {
    // The marketplace Tomverse carries is there by default, lists nothing yet, and says it is official.
    const market = panel.getByTestId("plugin-marketplace");
    await expect(market).toHaveCount(1);
    await expect(market).toContainText("tomverse · Official");
    await market.getByRole("button", { name: "Browse: tomverse" }).click();
    await expect(market).toContainText("This marketplace lists no plugins.");
    await expect(panel.getByTestId("plugin-official").getByRole("checkbox")).toBeChecked();

    // A zip file: the preview names its SHA-256 and the digest being confirmed; nothing is installed until the confirmation.
    await panel.getByTestId("plugin-install-zip").click();
    const preview = panel.getByTestId("plugin-preview");
    await expect(preview.getByRole("heading", { name: "Install zip-tools?" })).toBeVisible();
    await expect(preview.getByTestId("plugin-preview-origin")).toContainText(/SHA-256: [0-9a-f]{64}/);
    await expect(preview.getByTestId("plugin-preview-approval")).toContainText(/Digest you are confirming: [0-9a-f]{16}/);
    await expect(preview.getByTestId("plugin-preview-counts")).toHaveText("1 skills, 0 commands, 0 agents, 1 hooks, 0 MCP servers");
    await expect(preview.getByTestId("plugin-preview-hook")).toContainText("node mark.mjs");
    assert.equal(await exists(join(tomverse, "plugins", "installed", "zip-tools")), false);
    await preview.getByTestId("plugin-confirm").click();
    const row = panel.getByTestId("plugin-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("zip-tools 2.0.0");
    await expect(row).toContainText("From a zip file");
    await expect(row.getByTestId("plugin-pending")).toHaveText("1 waiting for your approval");
    assert.equal(await exists(join(tomverse, "plugins", "installed", "zip-tools", "skills", "greet", "SKILL.md")), true);

    // Turned off, the marketplace goes and is not added again when the screen is opened again.
    await panel.getByTestId("plugin-official").getByRole("checkbox").uncheck();
    await expect(market).toHaveCount(0);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await expect(panel.getByTestId("plugin-official").getByRole("checkbox")).not.toBeChecked();
    await expect(panel.getByTestId("plugin-marketplace")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("a zip file whose entry climbs out of its folder installs nothing and says so", { timeout: 180_000 }, async () => {
  const { panel, tomverse, close } = await launch(zipOf([...pluginItems, { name: "demo-main/../../escape.txt", data: "x" }]), true);
  try {
    await panel.getByTestId("plugin-install-zip").click();
    await expect(panel.getByTestId("plugins-error")).toContainText("climbs out of its folder");
    await expect(panel.getByTestId("plugin-preview")).toHaveCount(0);
    assert.equal(await exists(join(tomverse, "plugins", "installed")), false);
  } finally {
    await close();
  }
});

test("with the switch off, none of it is offered: no zip button, no address or npm box, no official marketplace", { timeout: 180_000 }, async () => {
  const { panel, close } = await launch(zipOf(pluginItems), false);
  try {
    await expect(panel.getByTestId("plugin-install-folder")).toBeVisible();
    await expect(panel.getByTestId("plugin-install-zip")).toHaveCount(0);
    await expect(panel.getByTestId("plugin-zip-url")).toHaveCount(0);
    await expect(panel.getByTestId("plugin-npm")).toHaveCount(0);
    await expect(panel.getByTestId("plugin-official")).toHaveCount(0);
    await expect(panel.getByTestId("plugin-marketplace")).toHaveCount(0);
  } finally {
    await close();
  }
});
