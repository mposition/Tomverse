import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

function gate() {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

const state = (page: Page) => page.evaluate(() => window.desktop.state());

test("Code opens a terminal for the task, runs a command in it, and reads its output through read_terminal", { timeout: 120_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-terminal-"));
  const descriptor = join(folder, "fixture.json");
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const ready = gate();
  const hidden = gate();
  const gateway = await new FakeGateway({
    async script(_body, index) {
      if (index === 0) { await ready.wait; return { toolCalls: [{ name: "read_terminal", args: { lines: 20 } }] }; }
      if (index === 1) { await hidden.wait; return { toolCalls: [{ name: "read_terminal", args: {} }] }; }
      return { text: "Terminal inspection complete." };
    },
  }).start();
  const probe = process.env.TOMVERSE_LEAK_PROBE;
  // A Tomverse variable in the app's own environment must not reach the shell.
  process.env.TOMVERSE_LEAK_PROBE = "must-not-reach-the-shell";
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    application = await launchNativeFixture(descriptor);
    const page = await application.firstWindow();
        await page.getByRole("button", { name: "Open local folder" }).click();

    // The terminal is off until the person turns it on, and it is turned on before the task so the agent gets read_terminal.
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const panel = page.getByTestId("terminal-panel");
    await expect(panel.getByText("The terminal is off")).toBeVisible();
    await panel.getByRole("button", { name: "Turn on terminal" }).click();
    await expect(panel.getByText("Start a task to open a terminal in its folder.")).toBeVisible();
    await expect.poll(async () => (await state(page)).codeTerminal?.enabled).toBe(true);

    await page.getByLabel("Code mode").selectOption("ask");
    await page.getByRole("textbox", { name: "Code request" }).fill("Read my terminal.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(async () => (await state(page)).task?.status).toBe("running");
    await expect.poll(async () => Boolean((await state(page)).task?.id)).toBe(true);
    const taskId = (await state(page)).task!.id!;

    // The terminal opens by itself for the running task and shows the shell.
    await expect(panel.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
    const listing = () => page.evaluate((task) => window.desktop.codeTerminal({ type: "list", task }), taskId) as Promise<{ terminals: Array<{ id: string; shared: boolean }> }>;
    await expect.poll(async () => (await listing()).terminals.length).toBe(1);
    const terminalId = (await listing()).terminals[0]!.id;
    await expect.poll(async () => {
      const replay = await page.evaluate((id) => window.desktop.codeTerminal({ type: "attach", terminal: id }), terminalId) as { data: string } | null;
      return (replay?.data.length ?? 0) > 0;
    }, { timeout: 30_000 }).toBe(true);

    // Run a command. Only the output holds "tv42/absent": the typed line does not.
    const screen = panel.getByTestId("terminal-screen");
    await screen.click();
    await page.keyboard.type("node -p \"'tv' + (6*7) + '/' + (process.env.TOMVERSE_LEAK_PROBE ?? 'absent')\"");
    await page.keyboard.press("Enter");
    await expect(screen).toContainText("tv42/absent", { timeout: 30_000 });
    // The content policy blocks inline styles; xterm's styles arrive through the CSSOM instead.
    assert.ok(await page.evaluate(() => document.adoptedStyleSheets.length > 0), "xterm styles reach the page through constructed style sheets.");
    await page.screenshot({ path: process.env.TOMVERSE_TERMINAL_SCREENSHOT ?? join(folder, "terminal.png") });

    // The agent reads what the person sees, and the result is marked as untrusted data.
    ready.release();
    await expect.poll(() => gateway.completions.length).toBe(2);
    const toolReplies = (index: number) => (gateway.completions[index]?.body.messages as Array<{ role: string; content: unknown }>)
      .filter(({ role }) => role === "tool").map(({ content }) => JSON.stringify(content));
    const observed = toolReplies(1).at(-1)!;
    assert.match(observed, /tv42\/absent/);
    assert.match(observed, /untrusted/i);
    assert.match(observed, /\\"terminal\\":1/);

    // Selecting output and adding it to the next instruction.
    await screen.locator(".xterm-rows > div", { hasText: "tv42/absent" }).last().click({ clickCount: 3, force: true });
    await panel.getByRole("button", { name: "Add to prompt" }).click();
    await expect(page.getByRole("textbox", { name: "Code request" })).toHaveValue(/Terminal output:[\s\S]*tv42\/absent/);

    // The person can hide the terminal from Code; the next read then finds nothing shared.
    await panel.getByRole("button", { name: "Code can read" }).click();
    await expect.poll(async () => (await listing()).terminals[0]?.shared).toBe(false);
    hidden.release();
    await expect(page.getByText("Terminal inspection complete.", { exact: true })).toBeVisible();
    assert.match(toolReplies(2).at(-1)!, /No terminal is shared/);

    // Switching tasks keeps the shell and its scrollback.
    await expect.poll(async () => (await state(page)).busy).toBe(false);
    await page.evaluate(() => window.desktop.newTask());
    await expect.poll(async () => (await state(page)).task).toBeNull();
    await expect.poll(async () => (await state(page)).history.some((row) => row.id === taskId)).toBe(true);
    await page.evaluate((id) => window.desktop.openHistory(id), taskId);
    await expect.poll(async () => (await state(page)).task?.id).toBe(taskId);
    await expect(panel.getByTestId("terminal-screen")).toContainText("tv42/absent", { timeout: 30_000 });
    assert.equal((await listing()).terminals.length, 1, "Coming back reuses the same shell instead of opening another.");
  } finally {
    ready.release();
    hidden.release();
    if (probe === undefined) delete process.env.TOMVERSE_LEAK_PROBE; else process.env.TOMVERSE_LEAK_PROBE = probe;
    await application?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
