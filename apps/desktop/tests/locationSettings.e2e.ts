import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const origin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as typeof globalThis & { settingsOpened: string[] }).settingsOpened);

/**
 * A signed-in Chat that offers the device position. The operating system's answer is the fixture's: the build only reads
 * TOMVERSE_DESKTOP_OS_LOCATION_FIXTURE in a test build, and the window's own position read is replaced by a failing one.
 */
async function launch(osStatus: "off" | "on" | "unknown") {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-location-"));
  await writeFile(join(profile, "language.txt"), "en");
  const app = await electron.launch({ executablePath, args: [desktopDir, "--user-data-dir=" + profile], timeout: 20_000,
    env: { ...process.env, TOMVERSE_DESKTOP_OS_LOCATION_FIXTURE: osStatus } as Record<string, string> });
  await app.evaluate(({ shell }, fixtureOrigin) => {
    const host = globalThis as typeof globalThis & { settingsOpened: string[] };
    host.settingsOpened = [];
    const realFetch = globalThis.fetch;
    shell.openExternal = async (href) => {
      if (href.startsWith("ms-settings:")) { host.settingsOpened.push(href); return; }
      const target = new URL(href);
      if (target.origin !== fixtureOrigin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
      const callback = new URL(target.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
      if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the fixture account.");
    };
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin !== fixtureOrigin) return new Response(null, { status: 404 });
      if (url.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
      if (url.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "location-fixture", name: "Location Fixture", email: "location@example.test" } });
      if (url.pathname === "/api/products/chat/capabilities") return Response.json({ autoSelection: { offered: false }, desktopWrite: true, desktopComposerTools: true, desktopTurnLocation: true });
      if (url.pathname === "/api/models/catalog") {
        return Response.json({ models: [{ id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", publiclyListed: true, status: "enabled", enabled: true }] });
      }
      if (url.pathname === "/api/conversations") return Response.json([]);
      return new Response(null, { status: 404 });
    };
  }, origin);
  const desktop = await app.firstWindow();
  await desktop.getByRole("button", { name: "Settings", exact: true }).click();
  await desktop.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
  await expect.poll(() => desktop.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected" });
  await desktop.getByRole("button", { name: "Chat", exact: true }).click();
  // The window's own position read fails, as it does when Windows has location off.
  await desktop.evaluate(`Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
    configurable: true, value: (_success, failure) => failure({ code: 2 }),
  })`);
  return { app, desktop, profile };
}

async function failedRead(desktop: Awaited<ReturnType<typeof launch>>["desktop"]) {
  await desktop.locator(".composer-tools summary").click();
  await desktop.getByRole("switch", { name: "Current location", exact: true }).click();
  await desktop.keyboard.press("Escape");
  return desktop.getByTestId("chat-location-status");
}

test("When the read fails and Windows location is off, the message says so and a button opens the one Windows settings page", { timeout: 120_000, skip: !origin }, async () => {
  const { app, desktop, profile } = await launch("off");
  try {
    const status = await failedRead(desktop);
    await expect(status).toContainText("Windows location is off, so your current location cannot be read. You can enter a place instead.");
    await expect(status).not.toContainText("Current location is unavailable");
    const button = status.getByTestId("chat-location-open-windows-settings");
    await expect(button).toHaveText("Open Windows location settings");
    assert.deepEqual(await opened(app), []);
    await button.click();
    if (process.platform === "win32") {
      await expect.poll(() => opened(app)).toEqual(["ms-settings:privacy-location"]);
    } else {
      // The host opens nothing outside Windows, and what the renderer asks is never an address.
      await desktop.waitForTimeout(500);
      assert.deepEqual(await opened(app), []);
    }
    assert.deepEqual(await opened(app), process.platform === "win32" ? ["ms-settings:privacy-location"] : []);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("When the operating system's state is on or unknown, the read failure keeps its usual message and has no settings button", { timeout: 120_000, skip: !origin }, async () => {
  for (const osStatus of ["on", "unknown"] as const) {
    const { app, desktop, profile } = await launch(osStatus);
    try {
      const status = await failedRead(desktop);
      await expect(status).toContainText("Current location is unavailable. This message will continue without it. You can enter a place instead.");
      await expect(status.getByTestId("chat-location-open-windows-settings")).toHaveCount(0);
      assert.deepEqual(await opened(app), []);
    } finally {
      await app.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
