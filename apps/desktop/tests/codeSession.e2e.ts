import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";

/**
 * Desktop Code on the signed-in Desktop session (owner decision 2026-11-27): with a server that names
 * desktopCodeSession there is no Code key step; the engine's coding API calls carry the session's access token and
 * the Desktop origin, follow each renewal, and stop at sign-out. A server that does not name it keeps the Code key
 * step. The account routes are faked in the main process; the coding API is a fake gateway on the build's test
 * account origin, which is where the Code runtime sends its requests.
 */
const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const ACCOUNT = "session-account";
const TOKENS = ["session-access-1", "session-access-2"];

type Host = typeof globalThis & { codeSession: boolean; calls: string[]; codeTokens: number; codeTokenAuth: string[] };

async function launch(profile: string, codeSession: boolean, firstExpiresIn: number) {
  const app = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
  await app.evaluate(async ({ shell }, { origin, codeSession, firstExpiresIn, tokens, account }) => {
    const host = globalThis as Host;
    host.codeSession = codeSession;
    host.calls = [];
    host.codeTokens = 0;
    host.codeTokenAuth = [];
    const realFetch = globalThis.fetch;
    shell.openExternal = async (href) => {
      const target = new URL(href);
      const callback = new URL(target.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
      if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
    };
    globalThis.fetch = async (url, options) => {
      const target = new URL(String(url));
      if (target.origin !== origin) return realFetch(url, options);
      host.calls.push(target.pathname);
      if (target.pathname === "/api/auth/desktop/exchange") {
        return Response.json({ ok: true, accessToken: tokens[0], refreshToken: "session-refresh-1", expiresIn: firstExpiresIn });
      }
      if (target.pathname === "/api/auth/desktop/refresh") {
        return Response.json({ ok: true, accessToken: tokens[1], refreshToken: "session-refresh-2", expiresIn: 600 });
      }
      if (target.pathname === "/api/auth/desktop/session") {
        return Response.json({ ok: true, account: { id: account, name: "Session Fixture", email: null } });
      }
      if (target.pathname === "/api/auth/desktop/logout") return Response.json({ ok: true });
      if (target.pathname === "/api/auth/desktop/code-token") {
        // Minted with the session token in force; the runtimes get only this.
        host.codeTokenAuth.push(new Headers(options?.headers).get("authorization") ?? "");
        return Response.json({ ok: true, accessToken: "code-token-" + ++host.codeTokens, expiresIn: 600 });
      }
      if (target.pathname === "/api/products/chat/capabilities") {
        return Response.json({ autoSelection: { offered: false }, ...(host.codeSession ? { desktopCodeSession: true } : {}) });
      }
      return Response.json({}, { status: 404 });
    };
  }, { origin: authOrigin!, codeSession, firstExpiresIn, tokens: TOKENS, account: ACCOUNT });
  return app;
}

test("Code runs on the signed-in Desktop session: no key step, the session's token follows renewal and stops at sign-out", {
  timeout: 180_000, skip: !authOrigin ? "Requires a Desktop build with TOMVERSE_DESKTOP_AUTH_TEST_ORIGIN" : false,
}, async () => {
  assert.ok(authOrigin);
  let hang = false;
  const gateway = await new FakeGateway({
    port: Number(new URL(authOrigin).port),
    // Signed in: a Code token, from the Desktop origin. Neither a Code key nor the Desktop session token is accepted here.
    authorize: (headers) => headers.origin === "tomverse://desktop" && /^Bearer code-token-\d+$/.test(String(headers.authorization)),
    script: () => (hang ? { fault: "hang" } : { text: "Done on the session." }),
  }).start();
  const directory = await mkdtemp(join(tmpdir(), "tomverse-code-session-"));
  const profile = join(directory, "profile");
  const project = join(directory, "project");
  await Promise.all([mkdir(profile), mkdir(project)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(join(project, "notes.txt"), "Session notes\n");
  // A Code key stored by an earlier version: removed once Code runs on the session (the key stays valid on the server).
  const storedKey = join(profile, "code-key-" + createHash("sha256").update(ACCOUNT).digest("hex") + ".dat");
  await writeFile(storedKey, "stored by an earlier version");
  let app: ElectronApplication | undefined;
  try {
    // The first token runs out in 40 seconds, so Desktop renews it during the test.
    app = await launch(profile, true, 40);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog;
    }, project);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(async () => (await state()).account.stage).toBe("connected");
    await expect.poll(async () => (await state()).codeKey.stage).toBe("account");
    await expect.poll(async () => (await state()).models.length).toBeGreaterThan(0);
    await expect.poll(() => existsSync(storedKey)).toBe(false);

    // No key step anywhere: the Developer settings say Code uses the account, and offer no key button.
    await page.getByTestId("desktop-settings-developer").click();
    await expect(page.getByTestId("desktop-code-account")).toContainText("Code uses your signed-in Tomverse account. No Code key is needed.");
    await expect(page.getByRole("button", { name: "Connect copied key" })).toHaveCount(0);
    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect a Code key" })).toHaveCount(0);
    await expect(page.getByText("Connect a Tomverse Code key to send requests.")).toHaveCount(0);
    // The model list came with the first Code token, minted with the first session token, and the Desktop origin.
    const models = gateway.requests.find((request) => request.url.startsWith("/api/code/v1/models"));
    assert.equal(models?.headers.authorization, "Bearer code-token-1");
    assert.equal(models?.headers.origin, "tomverse://desktop");
    assert.equal((await app.evaluate(() => (globalThis as Host).codeTokenAuth))[0], `Bearer ${TOKENS[0]}`);

    // Desktop renews the token by itself; the next request carries the new one.
    await expect.poll(async () => (await app!.evaluate(() => (globalThis as Host).calls)).includes("/api/auth/desktop/refresh"),
      { timeout: 60_000 }).toBe(true);
    await openCodeProject(page);
    await expect.poll(async () => (await state()).root).toBeTruthy();
    await selectCodeMode(page, "ask");
    await page.getByRole("textbox", { name: "Code request" }).fill("Summarize notes.txt");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("Done on the session.").first()).toBeVisible({ timeout: 30_000 });
    // The renewal minted a new Code token with the renewed session token, and the next request carried it.
    const minted = await app.evaluate(() => (globalThis as Host).codeTokenAuth);
    assert.ok(minted.includes(`Bearer ${TOKENS[1]}`), "a Code token minted with the renewed session token");
    const first = gateway.completions[0];
    assert.notEqual(first?.headers.authorization, "Bearer code-token-1", "the renewed Code token");
    assert.match(String(first?.headers.authorization), /^Bearer code-token-\d+$/);
    assert.equal(first?.headers.origin, "tomverse://desktop");

    // Sign-out while a request is open: the task stops and nothing more reaches the coding API.
    hang = true;
    await page.getByRole("textbox", { name: "Code request" }).fill("A second request");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length, { timeout: 30_000 }).toBeGreaterThan(1);
    const sent = gateway.requests.length;
    await page.evaluate(() => window.desktop.signOut());
    await expect.poll(async () => (await state()).account.stage).toBe("idle");
    const after = await state();
    assert.equal(after.codeKey.stage, "missing");
    assert.equal(after.busy, false);
    await new Promise((settle) => setTimeout(settle, 3_000));
    assert.equal(gateway.requests.length, sent, "no request after sign-out");

    // Nothing carried a Code key or the Desktop session token, and the Code key route was never called.
    assert.ok(gateway.requests.every((request) => request.headers.authorization !== `Bearer ${TEST_KEY}` &&
      !TOKENS.some((token) => request.headers.authorization === `Bearer ${token}`)));
    assert.ok(!(await app.evaluate(() => (globalThis as Host).calls)).includes("/api/auth/desktop/code-key"));
    const shown = JSON.stringify(await state());
    assert.ok(!shown.includes(TOKENS[1]) && !shown.includes("code-token-"), "no token reaches the window");
  } finally {
    await app?.close().catch(() => undefined);
    await gateway.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a server that does not run Code on the session keeps the Code key step", {
  timeout: 90_000, skip: !authOrigin ? "Requires a Desktop build with TOMVERSE_DESKTOP_AUTH_TEST_ORIGIN" : false,
}, async () => {
  assert.ok(authOrigin);
  const gateway = await new FakeGateway({ port: Number(new URL(authOrigin).port), script: () => ({ text: "unused" }) }).start();
  const profile = await mkdtemp(join(tmpdir(), "tomverse-code-key-"));
  await writeFile(join(profile, "language.txt"), "en");
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile, false, 600);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(async () => (await state()).account.stage).toBe("connected");
    await expect.poll(async () => (await state()).capabilities?.autoSelection).toBe(false);
    assert.equal((await state()).codeKey.stage, "missing");
    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect a Code key" })).toBeVisible();
    await expect(page.getByText("Connect a Tomverse Code key to send requests.")).toBeVisible();
    await page.getByRole("button", { name: "Connect a Code key" }).click();
    await expect(page.getByRole("button", { name: "Connect copied key" })).toBeVisible();
    await expect(page.getByTestId("desktop-code-account")).toHaveCount(0);
    assert.equal(gateway.requests.length, 0, "no coding API call without a key");
  } finally {
    await app?.close().catch(() => undefined);
    await gateway.stop();
    await rm(profile, { recursive: true, force: true });
  }
});

test("an account below Pro is told Code is Pro and above, with no key step", {
  timeout: 90_000, skip: !authOrigin ? "Requires a Desktop build with TOMVERSE_DESKTOP_AUTH_TEST_ORIGIN" : false,
}, async () => {
  assert.ok(authOrigin);
  // The coding API's own refusal of the plan (lib/externalApiAccess.ts), as the server answers it to a session or a key alike.
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.url));
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "The Tomverse API needs a paid plan.", code: "plan_not_eligible", type: "permission_error" } }));
  });
  await new Promise<void>((listening) => server.listen(Number(new URL(authOrigin).port), "127.0.0.1", listening));
  const profile = await mkdtemp(join(tmpdir(), "tomverse-code-plan-"));
  await writeFile(join(profile, "language.txt"), "en");
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile, true, 600);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(async () => (await state()).codeCatalog).toBe("planRequired");
    assert.equal((await state()).codeKey.stage, "account");
    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByText("Code is available on Pro and above.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect a Code key" })).toHaveCount(0);
    assert.ok(seen.some((url) => url.startsWith("/api/code/v1/models")));
  } finally {
    await app?.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((closed) => server.close(() => closed()));
    await rm(profile, { recursive: true, force: true });
  }
});
