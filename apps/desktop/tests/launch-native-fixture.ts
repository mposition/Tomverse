import assert from "node:assert/strict";
import { chmod, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";

const qaExecutable = process.env.TOMVERSE_DESKTOP_TASK_QA_EXECUTABLE;
const electronPath: string = qaExecutable ?? process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? createRequire(import.meta.url)("electron");
const desktop = resolve(fileURLToPath(new URL("../", import.meta.url)));

export async function decideNativePatch(page: Page, name: "Allow once" | "Deny" = "Allow once") {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

export async function launchNativeFixture(descriptor: string, timeout = 20_000, additionalArgs: string[] = []) {
  const fixtureArgs = ["--desktop-fixture", descriptor, ...additionalArgs];
  const application = await electron.launch({
    executablePath: electronPath,
    args: qaExecutable ? fixtureArgs : [desktop, ...fixtureArgs],
    chromiumSandbox: !!qaExecutable,
    timeout,
  });
  if (qaExecutable) {
    try {
      assert.deepEqual(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, name: app.getName() })),
        { packaged: true, name: "Tomverse Desktop Task QA" });
    } catch (error) {
      await application.close();
      throw error;
    }
  }
  return application;
}

export async function removeNativeFixtureDirectory(directory: string) {
  if (process.platform !== "win32") {
    // Vibe leaves read-only plugin directories in its disposable profile.
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => chmod(join(entry.parentPath, entry.name), 0o700)));
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}
