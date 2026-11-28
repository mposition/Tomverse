import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

type Body = { messages?: Array<{ role: string; content?: unknown }> };
const userTexts = (body: Body) => (body.messages ?? []).filter(({ role }) => role === "user").map(({ content }) => String(content));

test("a command typed as a follow-up or a queued message is expanded like one that starts a task, and /review is listed only where it works", { timeout: 120_000 }, async () => {
  let releaseReply!: () => void;
  const heldReply = new Promise<void>((release) => { releaseReply = release; });
  const gateway = await new FakeGateway({
    async script(_body, index) {
      if (index === 0) return { toolCalls: [{ name: "read_file", args: { path: "first.txt" } }] };
      if (index === 1) await heldReply;
      return { text: `reply ${index}` };
    },
  }).start();
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-slash-follow-up-"));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(join(root, ".claude", "commands"), { recursive: true }), mkdir(profile)]);
  await Promise.all([
    writeFile(join(profile, "language.txt"), "en"),
    writeFile(join(root, "first.txt"), "Existing search behavior\n"),
    writeFile(join(root, ".claude", "commands", "greet.md"), "---\ndescription: Greet someone\nargument-hint: [name]\n---\nSay hello to $ARGUMENTS in one line.\n"),
  ]);
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  try {
    const page = await app.firstWindow();
    await openCodeProject(page);
    await selectCodeMode(page, "ask");
    const composer = page.getByRole("textbox", { name: "Code request" });
    const menu = page.getByTestId("slash-menu");

    // Before any task there is nothing to review: the app's own command is not offered.
    await composer.fill("/rev");
    await expect(page.getByRole("option", { name: /\/review/ })).toHaveCount(0);
    await composer.fill("first");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length).toBe(2);

    // With a saved task on screen the list has it, marked as built in, next to the project's own command.
    await composer.fill("/rev");
    await expect(menu.getByRole("option", { name: /\/review \[turn\|branch\]\s*built in/ })).toBeVisible();
    await composer.fill("/gree");
    await expect(menu.getByRole("option", { name: /\/greet \[name\]\s*command/ })).toBeVisible();

    // A follow-up and a queued message: the model gets the command's text, the task shows what was typed.
    await composer.fill("/greet Ada");
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    await composer.fill("/greet Grace");
    await composer.press("Enter");
    await expect(page.locator(".code-queue li").filter({ hasText: "/greet Grace" })).toBeVisible();
    releaseReply();
    await expect(page.getByText("reply 3", { exact: true })).toBeVisible({ timeout: 30_000 });

    const sent = gateway.completions.map(({ body }) => userTexts(body as Body));
    assert.ok(sent.some((texts) => texts.includes("Say hello to Ada in one line.")), "the follow-up reached the model as the command's text");
    assert.deepEqual(sent.at(-1)!.slice(-2), ["Say hello to Ada in one line.", "Say hello to Grace in one line."], "the queued message too, after it");
    assert.ok(sent.every((texts) => !texts.includes("/greet Ada") && !texts.includes("/greet Grace")), "the model never saw the bare command");
    await expect(page.getByText("/greet Ada", { exact: true })).toHaveCount(1);
    await expect(page.getByText("/greet Grace", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/^Running command \/greet \(\.claude\/commands\/greet\.md\)/).first()).toBeVisible();
    const notices = (await page.evaluate(() => window.desktop.state())).task!.entries.filter((entry) => entry.role === "event" && /^Running command \/greet/.test(entry.text));
    assert.equal(notices.length, 2, "one note in the task for each command that ran");
  } finally {
    releaseReply();
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
