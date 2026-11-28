import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

type Host = typeof globalThis & {
  providers: Array<Record<string, unknown>>;
  servers: Array<Record<string, unknown>>;
  etag: string;
  catalogCalls: Array<{ ifNoneMatch: string | null; status: number; authorization: string | null; origin: string | null; cookie: boolean }>;
  logoCalls: Array<{ path: string; authorization: boolean; cookie: boolean }>;
  webView: Array<Record<string, unknown>>;
};

/** Starts the app with a fake account server. `catalog` plays a server that names the platform catalogue; without it, an older server. */
async function launch(profile: string, catalog: boolean) {
  assert.ok(authOrigin);
  await writeFile(join(profile, "language.txt"), "en");
  const application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
  await application.evaluate(async ({ shell, ipcMain }, { origin, catalog }) => {
    const host = globalThis as Host;
    const realFetch = globalThis.fetch;
    // The server's order is not the screen's: the featured platform sorts first, remote before local.
    host.providers = ([
      ["aikido", "Aikido", { category: "security", kind: "local", logo: null, origins: [] }],
      ["airtable", "Airtable", { category: "productivity" }],
      ["github", "GitHub", { sources: ["openai", "claude"], aliases: ["github", "gh"] }],
    ] as Array<[string, string, Record<string, unknown>]>).map(([id, name, extra]) => ({
      id, name, category: "development", logo: `/plugins/providers/${id}.png`, docs: `https://docs.example.org/${id}`,
      sources: ["claude"], profiles: [id], kind: "remote", aliases: [id], logoOwner: name, origins: [`https://mcp.example.org/${id}`], ...extra,
    }));
    host.servers = [];
    host.etag = "\"catalog-v1\"";
    host.catalogCalls = [];
    host.logoCalls = [];
    host.webView = [];
    // The viewer would open a real page; the test records what it was asked to open.
    ipcMain.removeHandler("desktop:web-view");
    ipcMain.handle("desktop:web-view", (_event, command: Record<string, unknown>) => { host.webView.push(command); });
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    shell.openExternal = async (href) => {
      const target = new URL(href);
      if (target.origin !== origin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
      const callback = new URL(target.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
      if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
    };
    globalThis.fetch = async (url, options) => {
      const target = new URL(String(url));
      if (target.origin !== origin) return realFetch(url, options);
      const headers = new Headers(options?.headers);
      if (target.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
      if (target.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "catalog-fixture", name: "Catalog Fixture", email: null } });
      if (target.pathname === "/api/auth/desktop/logout") return Response.json({ ok: true });
      if (target.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: "fixture..settings.web.session", expiresAt: Date.now() + 300_000 });
      if (target.pathname === "/api/products/chat/capabilities") return Response.json({
        autoSelection: { offered: false }, desktopWrite: true, desktopPlugins: true, desktopChatPlugin: true, ...(catalog ? { desktopPluginCatalog: true } : {}),
      });
      if (target.pathname === "/api/mcp/providers") {
        const ifNoneMatch = headers.get("if-none-match");
        const reply = ifNoneMatch === host.etag ? new Response(null, { status: 304, headers: { ETag: host.etag, "Cache-Control": "private, max-age=600, must-revalidate" } })
          : new Response(JSON.stringify({ observedAt: "2026-11-27", providers: host.providers }), { headers: {
            ETag: host.etag, "Cache-Control": "private, max-age=600, must-revalidate", "Content-Type": "application/json" } });
        host.catalogCalls.push({ ifNoneMatch, status: reply.status, authorization: headers.get("authorization"), origin: headers.get("origin"), cookie: headers.has("cookie") });
        return reply;
      }
      if (target.pathname.startsWith("/plugins/providers/")) {
        host.logoCalls.push({ path: target.pathname, authorization: headers.has("authorization"), cookie: headers.has("cookie") });
        return new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) } });
      }
      if (target.pathname === "/api/mcp/connections") {
        if (headers.get("cookie") !== "next-auth.session-token=fixture..settings.web.session" || headers.has("authorization")) throw new Error("Invalid connector credential transport");
        return Response.json({ enabled: true, customEnabled: true, servers: host.servers, connections: [], invocations: [] });
      }
      if (target.pathname === "/api/conversations") return Response.json([]);
      return Response.json({}, { status: 404 });
    };
  }, { origin: authOrigin, catalog });
  const page = await application.firstWindow();
  const rail = page.getByRole("navigation", { name: "Workspaces" });
  await rail.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected", label: "Catalog Fixture" });
  await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).capabilities?.pluginCatalog)).toBe(catalog);
  return { application, page, rail };
}

test("Plugins lists the web's catalogue from the server, keeps it per its cache headers, and shows a platform added on the server after a refresh",
  { timeout: 90_000, skip: !authOrigin }, async () => {
    assert.ok(authOrigin);
    const profile = await mkdtemp(join(tmpdir(), "tomverse-plugin-catalog-"));
    let application: ElectronApplication | undefined;
    try {
      const started = await launch(profile, true);
      application = started.application;
      const { page, rail } = started;
      await rail.getByRole("button", { name: "Plugins", exact: true }).click();
      const plugins = page.getByRole("region", { name: "Plugins", exact: true });
      const list = plugins.locator(".desktop-plugin-list > li");
      const names = () => list.locator("strong").allTextContents();
      // Same order as the web: "Custom MCP server" next to the connectable servers, then featured, remote, local.
      await expect.poll(names).toEqual(["Custom MCP server", "GitHub", "Airtable", "Aikido"]);
      await expect(plugins.getByTestId("desktop-connector-provider")).toHaveCount(3);
      await expect(plugins.getByTestId("desktop-connector-custom")).toHaveCount(1);
      // The list came from the server. A logo the app carries is shown from the app (a gated dev server answers its public files
      // with a sign-in page); only a platform the app does not carry has its logo fetched.
      const github = plugins.locator("[data-testid=desktop-connector-provider][data-provider=github]");
      await expect.poll(() => github.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      assert.ok(!(await github.locator("img").getAttribute("src"))?.startsWith("tomverse://desktop/plugin-logo/"), "the app's own GitHub logo");
      await expect(plugins.locator("[data-provider=aikido] img")).toHaveCount(0);
      const catalogCalls = () => application!.evaluate(() => (globalThis as Host).catalogCalls);
      const logoCalls = () => application!.evaluate(() => (globalThis as Host).logoCalls);
      // The viewer also asks to sync its state when it mounts; only the request to open a page matters here.
      const webViewCommands = () => application!.evaluate(() => (globalThis as Host).webView.filter((command) => command.type === "open-link"));
      assert.deepEqual(await catalogCalls(), [{ ifNoneMatch: null, status: 200, authorization: "Bearer fixture-access", origin: "tomverse://desktop", cookie: false }]);
      // Every logo here is one the app carries, so none is fetched.
      assert.deepEqual(await logoCalls(), []);

      // Search matches an alias; the category and directory filters use the platform's own fields.
      const search = plugins.getByRole("searchbox", { name: "Search plugins" });
      await search.fill("gh");
      await expect.poll(names).toEqual(["GitHub"]);
      await search.fill("air");
      await expect.poll(names).toEqual(["Airtable"]);
      await search.fill("");
      await plugins.getByRole("combobox", { name: "Category" }).selectOption({ label: "Development" });
      await expect.poll(names).toEqual(["GitHub"]);
      await plugins.getByRole("combobox", { name: "Category" }).selectOption({ label: "Security" });
      await expect.poll(names).toEqual(["Aikido"]);
      await plugins.getByRole("combobox", { name: "Category" }).selectOption({ label: "All categories" });
      await plugins.getByRole("combobox", { name: "Directory" }).selectOption({ label: "Codex" });
      await expect.poll(names).toEqual(["GitHub"]);
      await plugins.getByRole("combobox", { name: "Directory" }).selectOption({ label: "All directories" });
      await expect.poll(names).toHaveLength(4);

      // A platform with no server here shows what it is and its documentation in a drawer on the right, which opens the link view.
      // The list shrinks beside the drawer only in a window wide enough for both (see connector-workspace.css).
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1200);
      const detailsOf = (card: typeof github) => card.getByRole("button", { name: "Details", exact: true });
      await detailsOf(github).click();
      const drawer = page.getByRole("dialog", { name: "GitHub", exact: true });
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute("aria-modal", "true");
      // The drawer sits at the right edge of the window.
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      // The slide-in takes a moment; the box settles at the right edge.
      await expect.poll(async () => { const box = await drawer.boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBe(viewportWidth);
      const drawerWidth = (await drawer.boundingBox())!.width;
      assert.ok(drawerWidth >= 420 && drawerWidth <= 480, `drawer width ${drawerWidth}`);
      // The list gives way to it: every card ends to the left of the drawer, so each card's own buttons stay reachable.
      const rightEdges = () => plugins.locator(".desktop-plugin-list > li").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().right));
      await expect.poll(async () => Math.max(...await rightEdges())).toBeLessThanOrEqual((await drawer.boundingBox())!.x);
      // Focus starts inside the drawer, on its first control.
      await expect(drawer.getByTestId("desktop-plugin-drawer-close")).toBeFocused();
      const detail = drawer.getByTestId("desktop-provider-detail");
      await expect(detail).toContainText("GitHub");
      await expect(detail).toContainText("https://mcp.example.org/github");
      // Tab and Shift+Tab cycle inside the drawer.
      const controls = await drawer.locator("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])").count();
      const insideDrawer = () => drawer.evaluate((element) => element.contains(document.activeElement));
      for (let step = 0; step < controls; step += 1) {
        await page.keyboard.press("Tab");
        assert.equal(await insideDrawer(), true, `Tab ${step + 1} stays in the drawer`);
      }
      await expect(drawer.getByTestId("desktop-plugin-drawer-close")).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(drawer.getByTestId("desktop-provider-docs")).toBeFocused();
      await detail.getByTestId("desktop-provider-docs").click();
      await expect.poll(webViewCommands).toEqual([{ type: "open-link", url: "https://docs.example.org/github" }]);
      // Esc closes it and puts focus back on the card's Details button.
      await drawer.getByTestId("desktop-plugin-drawer-close").focus();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(detailsOf(github)).toBeFocused();
      // The close button does the same, and a card's Details pressed while the drawer is open swaps its content.
      await detailsOf(github).click();
      await drawer.getByRole("button", { name: "Close details", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(detailsOf(github)).toBeFocused();
      const airtable = plugins.locator("[data-testid=desktop-connector-provider][data-provider=airtable]");
      await detailsOf(airtable).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(page.getByRole("dialog", { name: "Airtable", exact: true })).toBeVisible();
      await detailsOf(github).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId("desktop-plugin-drawer-close")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(detailsOf(github)).toBeFocused();
      // The custom connection form uses the same drawer.
      const add = plugins.getByTestId("desktop-connector-add");
      await add.click();
      const form = page.getByRole("dialog", { name: "Custom MCP server", exact: true });
      await expect(form.getByTestId("desktop-connector-url")).toBeFocused();
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(add).toBeFocused();

      // Leaving and coming back within the lifetime the server named asks for nothing.
      await rail.getByRole("button", { name: "Chat", exact: true }).click();
      await rail.getByRole("button", { name: "Plugins", exact: true }).click();
      await expect.poll(names).toHaveLength(4);
      assert.equal((await catalogCalls()).length, 1);

      // A fourth platform on the server appears after a refresh, with no new app: the second read sends the ETag and gets the new list.
      await application.evaluate(() => {
        const host = globalThis as Host;
        host.providers.push({ id: "zeta-tools", name: "Zeta Tools", category: "data", logo: "/plugins/providers/zeta-tools.png", docs: "https://docs.example.org/zeta",
          sources: ["openai"], profiles: [], kind: "remote", aliases: ["zeta"], origins: ["https://mcp.example.org/zeta"], futureField: { anything: true } });
        host.etag = "\"catalog-v2\"";
      });
      await plugins.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(names).toEqual(["Custom MCP server", "GitHub", "Airtable", "Zeta Tools", "Aikido"]);
      await expect(plugins.getByTestId("desktop-connector-provider")).toHaveCount(4);
      assert.deepEqual((await catalogCalls()).map((call) => [call.ifNoneMatch, call.status]), [[null, 200], ["\"catalog-v1\"", 200]]);
      // A platform the app does not carry has its logo fetched: a public read of the account origin, no token and no cookie.
      await expect.poll(async () => (await logoCalls()).map((call) => call.path)).toEqual(["/plugins/providers/zeta-tools.png"]);
      assert.ok((await logoCalls()).every((call) => !call.authorization && !call.cookie));
      await search.fill("zeta");
      await expect.poll(names).toEqual(["Zeta Tools"]);
      await search.fill("");
      // Nothing changed on the server: the next refresh is answered "not modified" and the list stays.
      await plugins.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(async () => (await catalogCalls()).length).toBe(3);
      assert.deepEqual((await catalogCalls()).at(-1), { ifNoneMatch: "\"catalog-v2\"", status: 304, authorization: "Bearer fixture-access", origin: "tomverse://desktop", cookie: false });
      await expect.poll(names).toHaveLength(5);

      // A platform that gets a server on this deployment is that server's card, listed once.
      await application.evaluate(() => {
        (globalThis as Host).servers = [{ id: "github", name: "GitHub", auth: "oauth", origin: "https://api.githubcopilot.com" },
          { id: "google-drive", name: "Google Drive", auth: "oauth", origin: "https://drivemcp.googleapis.com" }];
      });
      await plugins.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(plugins.getByTestId("desktop-connector-row")).toHaveCount(2);
      await expect(plugins.locator("[data-testid=desktop-connector-provider][data-provider=github]")).toHaveCount(0);
      await expect.poll(names).toEqual(["GitHub", "Google Drive", "Custom MCP server", "Airtable", "Zeta Tools", "Aikido"]);
      await expect(plugins.locator("[data-testid=desktop-connector-row][data-provider=github] img")).toHaveCount(1);
      // A sign-in the app window cannot run says so on the card, before the person tries it.
      await expect(plugins.getByTestId("desktop-connector-unavailable")).toContainText("drivemcp.googleapis.com");
      await expect(plugins.locator("[data-provider=github]").getByTestId("desktop-connector-unavailable")).toHaveCount(0);
    } finally {
      await application?.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  });

test("Plugins on a server that does not name the catalogue lists that server's own connectors, as before", { timeout: 90_000, skip: !authOrigin }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-plugin-catalog-old-"));
  let application: ElectronApplication | undefined;
  try {
    const started = await launch(profile, false);
    application = started.application;
    await application.evaluate(() => {
      (globalThis as Host).servers = [{ id: "github", name: "GitHub", auth: "oauth", origin: "https://api.githubcopilot.com" },
        { id: "custom-1", name: "Custom GitHub", auth: "bearer", origin: "https://mcp.example.com", custom: true },
        { id: "google-drive", name: "Google Drive", auth: "oauth", origin: "https://drivemcp.googleapis.com" }];
    });
    await started.rail.getByRole("button", { name: "Plugins", exact: true }).click();
    const plugins = started.page.getByRole("region", { name: "Plugins", exact: true });
    const names = () => plugins.locator(".desktop-plugin-list > li strong").allTextContents();
    await expect.poll(names).toEqual(["GitHub", "Custom GitHub", "Google Drive", "Custom MCP server"]);
    await expect(plugins.getByTestId("desktop-connector-provider")).toHaveCount(0);
    // The labels come from the catalogue the app was built with: category filter, logo of a known service, none for a user-entered server.
    await expect.poll(() => plugins.locator("[data-provider=github] img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(plugins.getByRole("listitem").filter({ hasText: "Custom GitHub" }).locator("img")).toHaveCount(0);
    await plugins.getByRole("combobox", { name: "Category" }).selectOption({ label: "Development" });
    await expect.poll(names).toEqual(["GitHub"]);
    await expect(plugins.getByRole("combobox", { name: "Directory" })).toHaveCount(0);
    assert.deepEqual(await application.evaluate(() => ({ catalog: (globalThis as Host).catalogCalls, logos: (globalThis as Host).logoCalls })), { catalog: [], logos: [] });
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
