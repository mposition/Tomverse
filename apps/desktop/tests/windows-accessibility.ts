import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type ElectronApplication, type Page } from "@playwright/test";

const script = fileURLToPath(new URL("./windows-accessibility.ps1", import.meta.url));
const read = promisify(execFile);
const powershell = ["-NoProfile", "-NonInteractive", "-File", script];

export async function expectWindowsAccessibleNames(application: ElectronApplication, page: Page, expected: Record<string, string>) {
  if (process.platform !== "win32") return;
  await application.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
  const window = await application.browserWindow(page);
  const handle = await window.evaluate((current) => current.getNativeWindowHandle().reverse().toString("hex"));
  await expect.poll(async () => {
    const { stdout } = await read("powershell.exe", [...powershell, "-WindowHandle", handle], {
      env: { ...process.env, TOMVERSE_UIA_TEST_LABELS: JSON.stringify(Object.keys(expected)) }, timeout: 10_000,
    });
    return JSON.parse(stdout);
  }, { timeout: 12_000 }).toEqual(expected);
}

export async function cancelWindowsDialog(application: ElectronApplication, title: string, cancel: string) {
  const pid = await application.evaluate(() => process.pid);
  await read("powershell.exe", [...powershell, "-ProcessId", String(pid), "-Title", title, "-CancelName", cancel],
    { timeout: 12_000 });
}
