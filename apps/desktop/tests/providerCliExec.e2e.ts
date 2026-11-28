import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { openCodeProject } from "./code-project-fixture";
import { launchNativeFixture } from "./launch-native-fixture";
import type { Page } from "@playwright/test";
import { chooseCodeModel, codeModelControl } from "./code-model-picker";

/**
 * Code runs a task with the person's own Codex and Claude Code (the server's desktopProviderCliExec route). The CLIs are a
 * stand-in script run through a copy of the Node binary saved and trusted as the CLI file; the fake Tomverse coding API is a
 * tripwire that must see no request. Requires a build with TOMVERSE_DESKTOP_AUTH_TEST_ORIGIN and the Desktop auth switch.
 */
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-provider-cli.mjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The approval window closes on the answer, so the click may end with the page gone. */
async function decide(window: Page, name: "Allow once" | "Deny") {
  try { await window.getByRole("button", { name, exact: true }).click(); }
  catch (error) { if (!window.isClosed()) throw error; }
}
async function dead(pid: number) {
  for (let attempt = 0; attempt < 80 && alive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
}

test("Code runs a task with the person's own CLI: mapped permissions, approvals, history, Stop and quit, and no Tomverse API call", {
  timeout: 300_000, skip: !authOrigin ? "Requires a Desktop build with TOMVERSE_DESKTOP_AUTH_TEST_ORIGIN" : false,
}, async () => {
  assert.ok(authOrigin);
  const folder = await mkdtemp(join(tmpdir(), "tomverse-provider-cli-e2e-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const bin = join(folder, "bin");
  const record = join(folder, "record.json");
  const pidFile = join(folder, "pids.json");
  const descriptor = join(folder, "fixture.json");
  const exe = process.platform === "win32" ? ".exe" : "";
  const codex = join(bin, `codex${exe}`);
  const claude = join(bin, `claude${exe}`);
  // The Tomverse coding API is the tripwire: a provider CLI task must not reach it.
  const gateway = await new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) }).start();
  let app: ElectronApplication | undefined;
  let closed = false;
  try {
    await Promise.all([mkdir(root), mkdir(profile), mkdir(bin)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(root, "notes.txt"), "Project notes\n");
    for (const file of [codex, claude]) {
      await copyFile(process.execPath, file);
      await chmod(file, 0o755);
    }
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY,
      providerCliExec: { argsPrefix: [fake, JSON.stringify({ scenario: "auto", record, pidFile })] } }));
    app = await launchNativeFixture(descriptor, 30_000);
    await app.evaluate(({ shell, dialog }, origin) => {
      const realFetch = globalThis.fetch;
      // The person's own answer to "trust this file" is a native dialog; the test is that person.
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
      };
      globalThis.fetch = async (payload, options) => {
        const target = new URL(String(payload));
        if (target.origin !== origin) return realFetch(payload, options);
        if (target.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "cli-access", refreshToken: "cli-refresh", expiresIn: 600 });
        if (target.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "provider-cli-account", name: "CLI fixture", email: null } });
        if (target.pathname === "/api/products/chat/capabilities") return Response.json({ autoSelection: { offered: false }, desktopProviderCliExec: true });
        return Response.json({}, { status: 404 });
      };
    }, authOrigin);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(async () => (await state()).account.stage).toBe("connected");
    await expect.poll(async () => (await state()).capabilities?.providerCliExec).toBe(true);

    // With no saved CLI the route has nothing to run and says what to do; once the person trusts and saves the two files, both are offered.
    assert.deepEqual((await state()).providerCliExec, []);
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByText("Connect Codex / Claude Code to use this model.")).toBeVisible();
    for (const [provider, path] of [["openai", codex], ["anthropic", claude]] as const) {
      assert.deepEqual(await page.evaluate((input) => window.desktop.trustCliPath(input), { provider, path }), { status: "userTrusted" });
    }
    await expect.poll(async () => (await state()).providerCliExec).toEqual(["openai", "anthropic"]);
    await expect(page.getByText("Connect Codex / Claude Code to use this model.")).toHaveCount(0);
    await openCodeProject(page);
    await expect.poll(async () => (await state()).root).toBeTruthy();

    const picker = page.getByTestId("permission-picker");
    const setPermission = async (mode: "read_only" | "ask" | "auto_review") => {
      if ((await picker.getAttribute("data-mode")) === mode) return;
      await picker.click();
      await expect(page.getByTestId(`permission-item-${mode}`)).not.toHaveAttribute("aria-disabled", "true");
      await page.getByTestId(`permission-item-${mode}`).click();
      await expect(picker).toHaveAttribute("data-mode", mode);
    };
    const chooseCli = async (name: "Codex" | "Claude Code") => {
      await chooseCodeModel(page, { model: name === "Codex" ? "provider-cli:openai" : "provider-cli:anthropic" });
      await expect(codeModelControl(page)).toContainText(name);
    };
    const send = async (prompt: string) => {
      await page.getByRole("textbox", { name: "Code request" }).fill(prompt);
      await page.getByRole("button", { name: "Send Code request" }).click();
    };
    const seen = async () => JSON.parse(await readFile(record, "utf8")) as { args: string[]; env: string[]; prompt: string; response?: { response: { response: Record<string, unknown> } } };
    const sandbox = (args: string[]) => args[args.indexOf("--sandbox") + 1];

    // Codex, Read only: the sandbox is read-only, its messages, command and file changes show as the task, and it is saved to history.
    await expect(page.getByText("Codex · Runs on this computer with your own sign-in")).toBeVisible();
    await expect(page.getByTestId("permission-item-auto_review")).toHaveCount(0);
    await setPermission("read_only");
    await send("Read the project");
    await expect(page.getByText("done: Read the project", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("$ git status ✓", { exact: true })).toBeAttached();
    await expect(page.locator("code", { hasText: "src/a.ts" })).toBeAttached();
    await expect(page.locator(".task-status")).toContainText("Runs on this computer with your own sign-in");
    let run = await seen();
    assert.equal(sandbox(run.args), "read-only");
    assert.equal(run.prompt, "Read the project");
    assert.ok(run.env.every((name) => !/^TOMVERSE_|^ELECTRON|TOKEN|KEY/i.test(name)), "no Tomverse or secret variable reaches the CLI");
    // The task is saved when the run has ended, which includes the wait for the CLI's process tree to be gone.
    await expect.poll(async () => (await state()).history.map(({ title }) => title), { timeout: 30_000 }).toContain("Read the project");
    assert.equal((await state()).task?.liveCli, true);

    // Codex cannot ask, so Ask runs read-only and the task says so; Auto review is the CLI's own reviewer.
    await setPermission("ask");
    await send("Change the project");
    await expect(page.getByText("done: Change the project", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("summary", { hasText: "Codex cannot ask for approval here, so this task ran read-only." })).toBeAttached();
    assert.equal(sandbox((await seen()).args), "read-only");
    await setPermission("auto_review");
    await send("Change the project with review");
    await expect(page.getByText("done: Change the project with review", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("summary", { hasText: "Auto review runs in Codex's project sandbox" })).toBeAttached();
    // The write modes run in a permission profile (the project writable, its credential files read-only), not --sandbox.
    assert.ok(!(await seen()).args.includes("--sandbox") && (await seen()).args.includes('default_permissions="tomverse"'));
    assert.ok(!(await seen()).args.includes("--approve-for-me"), "Codex's own reviewer is never used");

    // A saved task reopens from history with its messages, and reads as a provider CLI task.
    await page.evaluate(() => window.desktop.newTask());
    await expect(page.getByText("done: Read the project", { exact: true })).toHaveCount(0);
    await page.getByRole("complementary", { name: "History" }).getByRole("button", { name: "Read the project", exact: true }).click();
    await expect(page.getByText("done: Read the project", { exact: true })).toBeVisible();
    await expect(page.locator(".task-status")).toContainText("Runs on this computer with your own sign-in");

    // Claude Code, Ask: each approval comes to the person's card; a denial reaches the CLI, an approval runs the tool.
    await setPermission("ask");
    await chooseCli("Claude Code");
    const [denyWindow] = await Promise.all([app.waitForEvent("window", { timeout: 30_000 }), send("Run the build")]);
    await expect(denyWindow.getByText("echo hi")).toBeVisible();
    await expect(denyWindow.getByRole("button", { name: "Allow always" })).toHaveCount(0);
    await decide(denyWindow, "Deny");
    await expect(page.getByText("denied: The person declined this action in Tomverse Desktop.")).toBeVisible({ timeout: 30_000 });
    run = await seen();
    assert.equal(run.response?.response.response.behavior, "deny");
    assert.ok(run.args.includes("--restricted") && run.args.includes("--no-session-persistence"));
    assert.equal(run.args[run.args.indexOf("--tools") + 1], "Read,Glob,Edit,Write,Bash,PowerShell".split(",").filter((tool) => tool !== "PowerShell" || process.platform === "win32").join(","));
    assert.ok(!run.args.includes("--allowedTools"));
    const [allowWindow] = await Promise.all([app.waitForEvent("window", { timeout: 30_000 }), send("Run the build again")]);
    await decide(allowWindow, "Allow once");
    await expect(page.getByText("ran it", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("code", { hasText: "docs/new.md" })).toBeAttached();
    assert.equal((await seen()).response?.response.response.behavior, "allow");

    // Claude Code, Read only: no tool but the three readers, and no approvals at all.
    await setPermission("read_only");
    await rm(record, { force: true });
    await send("Read the project with Claude");
    await expect.poll(async () => { try { return (await seen()).prompt; } catch { return ""; } }, { timeout: 30_000 }).toBe("Read the project with Claude");
    const readOnly = await seen();
    assert.equal(readOnly.args[readOnly.args.indexOf("--tools") + 1], "Read,Glob");
    assert.equal(readOnly.args[readOnly.args.indexOf("--permission-prompts") + 1], "none");
    // The fake still asks; with no approver and no prompts allowed, the answer is a denial.
    assert.equal(readOnly.response?.response.response.behavior, "deny");

    // Stop ends the CLI and its child.
    await expect.poll(async () => (await state()).busy, { timeout: 30_000 }).toBe(false);
    await chooseCli("Codex");
    await send("Wait for a long time [hang]");
    await expect.poll(async () => { try { return JSON.parse(await readFile(pidFile, "utf8")).child as number; } catch { return 0; } }, { timeout: 30_000 }).toBeGreaterThan(0);
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as { parent: number; child: number };
    assert.ok(alive(pids.parent) && alive(pids.child));
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect.poll(async () => (await state()).task?.status, { timeout: 60_000 }).toBe("stopped");
    assert.ok(await dead(pids.parent), "the CLI stopped");
    assert.ok(await dead(pids.child), "its child stopped");
    await rm(pidFile);

    // Closing the app while a task runs ends the CLI tree too.
    await expect.poll(async () => (await state()).busy, { timeout: 30_000 }).toBe(false);
    await send("Wait again [hang]");
    await expect.poll(async () => { try { return JSON.parse(await readFile(pidFile, "utf8")).child as number; } catch { return 0; } }, { timeout: 30_000 }).toBeGreaterThan(0);
    const open = JSON.parse(await readFile(pidFile, "utf8")) as { parent: number; child: number };
    assert.ok(alive(open.parent) && alive(open.child));
    await app.close().catch(() => undefined);
    closed = true;
    assert.ok(await dead(open.parent), "the CLI stopped with the app");
    assert.ok(await dead(open.child), "its child stopped with the app");

    // The tripwire: nothing but the model catalogue reached the Tomverse coding API, and nothing was charged.
    assert.equal(gateway.completions.length, 0);
    assert.deepEqual(gateway.requests.filter(({ url }) => !url.startsWith("/api/code/v1/models")).map(({ url }) => url), []);
  } finally {
    if (!closed) await app?.close().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }).catch(() => undefined);
  }
});

