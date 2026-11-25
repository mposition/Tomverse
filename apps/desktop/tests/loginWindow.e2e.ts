import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { removeNativeFixtureDirectory } from "./launch-native-fixture";

const origin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const enabled = process.env.TOMVERSE_DESKTOP_LOGIN_FIXTURE === "true";

test("the compact Desktop window routes providers and completes email code sign-in in the app", {
  timeout: 60_000, skip: !origin || !enabled,
}, async () => {
  assert.ok(origin);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-compact-login-"));
  const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    app = await electron.launch({ args: [desktop, `--user-data-dir=${profile}`], timeout: 20_000 });
    await app.evaluate(({ app: electronApp, session, shell }, targetOrigin) => {
      const host = globalThis as typeof globalThis & { loginTargets: string[]; emailActions: string[]; releaseLogout?: () => void };
      host.loginTargets = [];
      host.emailActions = [];
      electronApp.on("web-contents-created", (_event, contents) => {
        if (contents.session === session.defaultSession) return;
        contents.session.protocol.handle("http", (request) => {
          const url = new URL(request.url);
          if (url.origin !== targetOrigin || url.pathname !== "/auth/desktop/email-proof") return new Response(null, { status: 403 });
          return new Response("<!doctype html><html><body>Verification fixture</body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        });
      });
      shell.openExternal = async (url) => { host.loginTargets.push(url); };
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        if (target.origin !== targetOrigin) throw new Error("Unexpected Desktop request.");
        if (target.pathname === "/api/auth/desktop/email") {
          const body = JSON.parse(String(options?.body));
          if (options?.method !== "POST" || body.email !== "desktop@example.test") return Response.json({}, { status: 400 });
          host.emailActions.push(body.action);
          if (body.action === "request") {
            if (host.emailActions.length === 1) return Response.json({ code: "INVALID_REQUEST_ORIGIN" }, { status: 403 });
            if (host.emailActions.length === 2) return Response.json({ code: "TURNSTILE_REQUIRED" }, { status: 403 });
            if (host.emailActions.length === 3 && body.turnstileToken !== "fixture-proof") {
              return Response.json({ code: "TURNSTILE_FAILED" }, { status: 403 });
            }
            return Response.json({ ok: true });
          }
          if (body.action === "verify" && body.code === "482917") {
            return Response.json({ ok: true, accessToken: "login-fixture-access", refreshToken: "login-fixture-refresh", expiresIn: 600 });
          }
          return Response.json({ code: "EMAIL_CODE_INVALID" }, { status: 401 });
        }
        if (target.pathname === "/api/auth/desktop/session") return Response.json({
          ok: true, account: { id: "compact-login-fixture", email: "desktop@example.test", name: "Fixture" },
        });
        if (target.pathname === "/api/auth/desktop/logout") {
          await new Promise<void>((resolve) => { host.releaseLogout = resolve; });
          return new Response(null, { status: 204 });
        }
        return Response.json({}, { status: 404 });
      };
    }, origin);
    const login = await app.firstWindow();
    await expect(login).toHaveURL("tomverse://desktop/login");
    const info = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      return { size: window!.getSize(), resize: window!.isResizable(), windows: BrowserWindow.getAllWindows().length };
    });
    assert.deepEqual(info, { size: [470, 504], resize: false, windows: 1 });
    await expect(login.locator(".desktop-login")).toHaveCSS("background-color", "rgb(21, 29, 48)");
    await expect(login.locator(".desktop-login")).toHaveCSS("border-radius", "20px");
    await expect(login.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const providerIcons = login.locator(".login-option img");
    await expect(providerIcons).toHaveCount(2);
    await expect.poll(() => providerIcons.evaluateAll(images => images.every(element => {
      const icon = element as HTMLImageElement;
      return icon.naturalWidth > 0 && icon.src.startsWith("tomverse://desktop/assets/");
    }))).toBe(true);
    await expect(login.getByRole("navigation", { name: "Workspaces" })).toHaveCount(0);
    await expect(login.getByRole("button", { name: "Help", exact: true })).toHaveCount(0);
    assert.equal(await login.evaluate(() => typeof window.desktop), "undefined");
    await expect(login.getByRole("button", { name: "Quit Tomverse Desktop", exact: true })).toBeVisible();
    for (const [name, provider] of [["Apple", "apple"], ["Google", "google"], ["Microsoft", "azure-ad"]]) {
      await login.getByRole("button", { name: `Continue with ${name}`, exact: true }).click();
      await expect(login.getByText("Continue sign-in in your browser.", { exact: true })).toBeVisible();
      const url: string | undefined = await app.evaluate(() => (globalThis as typeof globalThis & { loginTargets: string[] }).loginTargets.at(-1));
      assert.ok(url);
      const request: URL = new URL(url);
      assert.equal(request.pathname, "/auth/desktop");
      assert.equal(request.searchParams.get("provider"), provider);
      await login.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
      await expect(login.getByRole("button", { name: "Continue with email", exact: true })).toBeVisible();
    }
    await login.getByRole("button", { name: "Continue with email", exact: true }).click();
    await login.getByLabel("Email address", { exact: true }).fill("desktop@example.test");
    await login.getByRole("button", { name: "Get a sign-in code", exact: true }).click();
    await expect(login.getByRole("alert")).toHaveText("Email sign-in is currently unavailable.");
    await expect(login.getByLabel("Six-digit code", { exact: true })).toHaveCount(0);
    await login.getByRole("button", { name: "Get a sign-in code", exact: true }).click();
    const confirmChallenge = () => app!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const [window] = BrowserWindow.getAllWindows();
      const view = window?.contentView.children.find((child): child is Electron.WebContentsView =>
        child instanceof WebContentsView && child.webContents.getURL().includes("/auth/desktop/email-proof"));
      if (!view || view.webContents.isLoadingMainFrame()) return false;
      const current = new URL(view.webContents.getURL());
      const state = new URLSearchParams(current.hash.slice(1)).get("state");
      if (!state) return false;
      void view.webContents.executeJavaScript(`location.hash = ${JSON.stringify("state=" + state + "&token=fixture-proof")}`).catch(() => {});
      return true;
    });
    await expect.poll(confirmChallenge, { timeout: 16_000 }).toBe(true);
    const code = login.getByLabel("Six-digit code", { exact: true });
    await code.fill("123456");
    await login.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(login.getByRole("alert")).toHaveText("Check the code and try again.");
    await login.getByRole("button", { name: "Send another code", exact: true }).click();
    await expect(code).toHaveValue("");
    await code.fill("482917");
    const workspace = app.waitForEvent("window");
    await login.getByRole("button", { name: "Sign in", exact: true }).click();
    const page = await workspace;
    await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.desktop.state().then((state) => state.account.stage))).toBe("connected");
    const activity = await app.evaluate(() => {
      const host = globalThis as typeof globalThis & { loginTargets: string[]; emailActions: string[] };
      return { browserLaunches: host.loginTargets.length, emailActions: host.emailActions };
    });
    assert.deepEqual(activity, { browserLaunches: 3, emailActions: ["request", "request", "request", "verify", "request", "verify"] });
    const signedOut = app.waitForEvent("window");
    void signedOut.catch(() => {});
    await page.getByRole("button", { name: "Tomverse account", exact: true }).click();
    await page.getByRole("button", { name: "Sign out of Desktop", exact: true }).click();
    await expect.poll(() => app!.evaluate(() =>
      typeof (globalThis as typeof globalThis & { releaseLogout?: () => void }).releaseLogout)).toBe("function");
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some((window) => window.webContents.getURL() === "tomverse://desktop/login")), false);
    await app.evaluate(() => (globalThis as typeof globalThis & { releaseLogout?: () => void }).releaseLogout?.());
    const fresh = await signedOut;
    await expect(fresh.getByRole("button", { name: "Continue with email", exact: true })).toBeVisible();
    const desktopProcess = app.process();
    const exited = app.waitForEvent("close");
    await fresh.getByRole("button", { name: "Quit Tomverse Desktop", exact: true }).click().catch((error: unknown) => {
      if (!fresh.isClosed()) throw error;
    });
    await exited;
    await expect.poll(() => desktopProcess.exitCode).toBe(0);
    app = undefined;
  } finally {
    await app?.close();
    await removeNativeFixtureDirectory(profile);
  }
});
