import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";

const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const windows = process.platform === "win32";
const exe = (name: string) => (windows ? name + ".exe" : name);

const codexCmd = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "node"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`;

async function hash(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

// A stand-in CLI is a copy of the Node.js program. `node login status` runs the script named "login" in the working
// folder, which is how the stand-in answers the sign-in status command the way the real CLI does.
async function layout(root: string) {
  const home = join(root, "home");
  const temp = join(root, "temp");
  const npm = join(root, "npm");
  const local = join(root, "local");
  const wrapperOnly = join(root, "wrapper-only");
  const codexPackage = join(npm, "node_modules", "@openai", "codex");
  const vendor = join(codexPackage, "node_modules", "@openai", "codex-" + (windows ? "win32" : process.platform) + "-" + process.arch,
    "vendor", windows ? "x86_64-pc-windows-msvc" : process.platform === "darwin" ? "x86_64-apple-darwin" : "x86_64-unknown-linux-musl", "bin");
  await Promise.all([home, temp, local, wrapperOnly, join(codexPackage, "bin"), vendor, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")].map((folder) => mkdir(folder, { recursive: true })));
  const codex = join(vendor, exe("codex"));
  const claude = join(local, exe("claude"));
  await Promise.all([copyFile(process.execPath, codex), copyFile(process.execPath, claude)]);
  await Promise.all([chmod(codex, 0o755), chmod(claude, 0o755)]);
  await writeFile(join(codexPackage, "bin", "codex.js"), "#!/usr/bin/env node\n");
  await writeFile(join(temp, "login"), "console.log('Not logged in'); process.exit(1);\n");
  await writeFile(join(temp, "auth"), "console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(1);\n");
  const wrapper = windows ? join(npm, "codex.cmd") : join(npm, "codex");
  if (windows) await writeFile(wrapper, codexCmd);
  else await symlink(join(codexPackage, "bin", "codex.js"), wrapper);
  // A command wrapper for another provider, which names no program this app can start.
  await writeFile(join(wrapperOnly, windows ? "grok.cmd" : "grok"), windows ? "@ECHO off\r\ncall other.cmd %*\r\n" : "#!/bin/sh\nexec other \"$@\"\n");
  if (!windows) await chmod(join(wrapperOnly, "grok"), 0o755);
  return { home, temp, npm, local, wrapperOnly, codex, claude };
}

function launch(profile: string, files: Awaited<ReturnType<typeof layout>>, release: string): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const name of ["NVM_HOME", "NVM_SYMLINK", "NVM_DIR", "NVM_BIN"]) delete env[name];
  Object.assign(env, {
    PATH: [files.npm, files.local, files.wrapperOnly].join(delimiter) + (windows ? delimiter + join(process.env.SystemRoot ?? "C:\\Windows", "System32") : delimiter + "/usr/bin" + delimiter + "/bin"),
    HOME: files.home, USERPROFILE: files.home, APPDATA: join(files.home, "AppData", "Roaming"), LOCALAPPDATA: join(files.home, "AppData", "Local"),
    TEMP: files.temp, TMP: files.temp, TMPDIR: files.temp, TOMVERSE_DESKTOP_CLI_RELEASE_FIXTURE: release,
  });
  return electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], env, timeout: 30_000 });
}

async function openClis(page: Page) {
  await page.getByRole("button", { name: "Desktop settings", exact: true }).click();
  const clis = page.getByRole("button", { name: "Development CLIs", exact: true });
  if (await clis.isDisabled()) {
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByLabel("Preferred execution mode").selectOption("provider_cli");
  }
  await clis.click();
  await expect(page.getByText("Looking for installed CLIs…")).toHaveCount(0, { timeout: 60_000 });
}

test("The CLI scan finds a wrapper's program, offers it once, trusts an exact file and asks again when it changes", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-desktop-cli-scan-"));
  const profile = join(root, "profile");
  let app: ElectronApplication | undefined;
  try {
    await mkdir(profile);
    await writeFile(join(profile, "language.txt"), "en");
    const files = await layout(root);
    // The Codex stand-in is registered as a pinned release; the Claude stand-in matches no release.
    const release = JSON.stringify({ openai: { version: "9.9.9", bytes: (await stat(files.codex)).size, sha256: await hash(files.codex) } });
    const pathsFile = join(profile, "provider-cli-paths.json");
    const stored = async () => JSON.parse(await readFile(pathsFile, "utf8"));

    app = await launch(profile, files, release);
    let page = await app.firstWindow();
    await openClis(page);
    const found = (name: string) => page.getByRole("group", { name: `${name} · Found on this computer` });

    // The wrapper is read, not run: the verified program behind it is listed with the wrapper it came from.
    const codex = found("Codex");
    await expect(codex).toContainText("Found · 9.9.9");
    await expect(codex).toContainText(files.codex);
    await expect(codex).toContainText(windows ? "codex.cmd" : "codex");
    await expect(codex).toContainText("Sign-in required");
    await expect(found("Claude Code")).toContainText(files.claude);
    await expect(found("Claude Code")).toContainText("does not match a release Tomverse can verify");
    await expect(found("Grok Build")).toContainText("could not be determined");
    await expect(found("Antigravity")).toContainText("Not found on this computer");
    // Release archives and installation folders are chosen by hand, so they are not scanned.
    await expect(page.getByRole("group", { name: /Qwen Code · Found/ })).toHaveCount(0);
    await expect(page.locator(".provider-cli-list li")).toHaveCount(10);

    // The sign-in command is typed into a task terminal. With the terminal off, the screen says what to do instead.
    await page.getByRole("button", { name: "Codex · Sign in" }).click();
    await expect(page.getByText(/Turn on the terminal in the Code settings/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Claude Code · Sign in" })).toHaveCount(0);

    // The first run offers the verified CLI once, and saves nothing until the person answers.
    await expect(page.getByText("Use the CLIs we found?")).toBeVisible();
    await assert.rejects(readFile(pathsFile, "utf8"), { code: "ENOENT" });
    await page.getByRole("button", { name: "Use found CLIs" }).click();
    await expect(page.getByText("Use the CLIs we found?")).toHaveCount(0);
    await expect(codex).toContainText("In use");
    assert.deepEqual(await stored(), { openai: files.codex });
    await page.getByRole("button", { name: "Scan again" }).click();
    await expect(page.getByText("Use the CLIs we found?")).toHaveCount(0);

    // A file that is not a pinned release is used only after the person trusts that exact file.
    // The app asks the person itself. Declining leaves everything as it was.
    const answer = (response: number) => app!.evaluate(({ dialog }, value) => {
      const check = globalThis as typeof globalThis & { trustDialog?: { message: string; detail?: string }[] };
      check.trustDialog = [];
      dialog.showMessageBox = (async (_window: unknown, options: Electron.MessageBoxOptions) => {
        check.trustDialog?.push({ message: options.message, detail: options.detail });
        return { response: value, checkboxChecked: false };
      }) as never;
    }, response);
    await answer(1);
    await page.getByRole("button", { name: "Claude Code · Trust this file and use" }).click();
    await expect(page.getByRole("button", { name: "Claude Code · Trust this file and use" })).toBeEnabled();
    assert.deepEqual(await stored(), { openai: files.codex });
    assert.deepEqual(await app.evaluate(() => (globalThis as typeof globalThis & { trustDialog?: unknown[] }).trustDialog), [
      { message: "This file does not match a release Tomverse can verify. Trust it only if you installed it yourself.", detail: files.claude },
    ]);
    await answer(0);
    await page.getByRole("button", { name: "Claude Code · Trust this file and use" }).click();
    await expect(found("Claude Code")).toContainText("In use");
    assert.deepEqual(await stored(), { openai: files.codex, anthropic: files.claude });
    await expect(page.locator(".provider-cli-list li").filter({ hasText: "Claude Code" })).toContainText("Trusted file");

    // A new session checks the saved paths again: the trusted file is still the trusted file.
    await app.close();
    app = await launch(profile, files, release);
    page = await app.firstWindow();
    await openClis(page);
    await expect(page.getByText("Check required", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Use the CLIs we found?")).toHaveCount(0);
    await page.getByRole("button", { name: "Claude Code · Change path" }).click();
    await page.getByRole("button", { name: "Check and save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Trusted file" })).toBeVisible();
    await page.getByRole("button", { name: "Development CLIs", exact: true }).last().click();
    await expect(page.getByText("Looking for installed CLIs…")).toHaveCount(0, { timeout: 60_000 });

    // Changing the file ends the trust, and the person is asked again.
    await appendFile(files.claude, "\u0000");
    await page.getByRole("button", { name: "Scan again" }).click();
    await expect(page.getByRole("button", { name: "Claude Code · Trust this file and use" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".provider-cli-list li").filter({ hasText: "Claude Code" })).not.toContainText("Trusted file");
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
