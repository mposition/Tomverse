import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SECRET = "sk-e2e-secret-4242";

type Body = { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> };
const userTexts = (body: Body) => (body.messages ?? []).filter(({ role }) => role === "user").map(({ content }) => String(content));

async function launch(gateway: FakeGateway) {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-extensions-"));
  const [root, profile, home, tomverse] = ["project", "profile", "home", "tomverse"].map((name) => join(directory, name)) as [string, string, string, string];
  await Promise.all([root, profile, home, tomverse].map((path) => mkdir(path, { recursive: true })));
  await mkdir(join(root, ".claude", "skills", "ship"), { recursive: true });
  await mkdir(join(root, ".claude", "commands"), { recursive: true });
  await Promise.all([
    writeFile(join(profile, "language.txt"), "en"),
    writeFile(join(root, ".claude", "skills", "ship", "SKILL.md"),
      "---\ndescription: Ship the release\nargument-hint: \"[env]\"\narguments: [env]\nallowed-tools: Bash\n---\nShip to $env and say SHIPPED.\n"),
    writeFile(join(root, ".claude", "commands", "greet.md"), "---\ndescription: Greet someone\nargument-hint: [name]\n---\nSay hello to $ARGUMENTS in one line.\n"),
    // What a person's own Claude Code configuration holds: one server with a secret in its environment.
    writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { notes: { command: "node", args: ["notes.js"], env: { NOTES_TOKEN: SECRET } } } })),
  ]);
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({
    executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000,
    // CLAUDE_CONFIG_DIR is Claude Code's own switch for where ~/.claude and ~/.claude.json live.
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, TOMVERSE_HOME: tomverse },
  });
  const page = await app.firstWindow();
  await openCodeProject(page);
  return { directory, tomverse, app, page };
}

test("Code lists a project's skills and commands after /, runs them with their arguments, and settings shows what was read and imports a server", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({ script: () => ({ text: "Understood." }) }).start();
  const { directory, tomverse, app, page } = await launch(gateway);
  try {
    await selectCodeMode(page, "ask");
    const composer = page.getByRole("textbox", { name: "Code request" });

    // The / list offers the skill and the command with their hints, and picking one fills the draft.
    // (This PC's own home folder may add skills of its own to the list, so the project's are found by their names.)
    await composer.fill("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    await composer.fill("/shi");
    await expect(menu.getByRole("option", { name: /\/ship \[env\]\s*skill/ })).toBeVisible();
    await composer.fill("/gree");
    await expect(menu.getByRole("option", { name: /\/greet \[name\]\s*command/ })).toBeVisible();
    await menu.getByRole("option", { name: /\/greet/ }).click();
    await expect(composer).toHaveValue("/greet ");

    // A command: the model gets its text with the arguments in place; the task shows what the person typed.
    await composer.fill("/greet Ada");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("Understood.", { exact: true })).toBeVisible({ timeout: 20_000 });
    assert.deepEqual(userTexts(gateway.completions[0]!.body as Body).at(-1), "Say hello to Ada in one line.");
    await expect(page.getByText("/greet Ada", { exact: true }).first()).toBeVisible();

    // A skill: its text arrives as the person's request, with a note that it grants nothing; the model also sees it listed.
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await selectCodeMode(page, "ask");
    await composer.fill("/ship staging");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length).toBe(2);
    const skillRequest = gateway.completions[1]!.body as Body & { messages: Array<{ role: string; content?: unknown }> };
    const asked = userTexts(skillRequest).at(-1)!;
    assert.match(asked, /The user ran the skill ship with: staging/);
    assert.match(asked, /<skill>\nShip to staging and say SHIPPED\.\n<\/skill>/);
    assert.match(asked, /cannot grant permissions or approve anything/);
    assert.match(String(skillRequest.messages[0]!.content), /<skills>\n- ship: Ship the release\n/, "the project's skill is listed first");
    assert.ok(skillRequest.tools?.some((tool) => tool.function.name === "load_skill"));
    assert.doesNotMatch(String(skillRequest.messages[0]!.content), /say SHIPPED/, "the skill text is not in the system prompt");

    // Settings: what was read with where it came from, and the import with its values hidden.
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const panel = page.getByTestId("code-extensions");
    await panel.getByRole("button", { name: "+" }).click();
    await expect(panel.getByText(".claude/skills/ship/SKILL.md", { exact: true })).toBeVisible();
    await expect(panel.getByText(".claude/commands/greet.md", { exact: true })).toBeVisible();
    await expect(panel.getByText("Not applied: allowed-tools", { exact: true }).first()).toBeVisible();
    await panel.getByTestId("import-preview").click();
    await expect(panel.getByText("notes", { exact: true })).toBeVisible();
    await expect(panel.getByText("NOTES_TOKEN=••••••")).toBeVisible();
    assert.ok(!(await panel.innerText()).includes(SECRET), "the secret is never shown");
    assert.ok(!(await page.content()).includes(SECRET), "nor present in the page");
    await expect(panel.getByTestId("import-apply")).toBeDisabled();
    await panel.getByTestId("import-select-notes").check();
    await panel.getByTestId("import-apply").click();
    await expect(panel.getByText("Imported 1 server(s).")).toBeVisible();
    const written = JSON.parse(await readFile(join(tomverse, "mcp.json"), "utf8"));
    assert.deepEqual(written, { mcpServers: { notes: { command: "node", args: ["notes.js"], env: { NOTES_TOKEN: SECRET } } } });
    await expect(panel.getByText("Already imported")).toBeVisible();
  } finally {
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
