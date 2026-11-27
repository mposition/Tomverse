import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return "http://127.0.0.1:" + address.port;
}

test("Code opens a native browser panel for the selected loopback site and disposes it when leaving Code", { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-code-browser-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  // Another port of this computer: what a local page loads from it is allowed, but the page itself never moves there.
  const otherPaths: string[] = [];
  const blockedServer = createServer((req, reply) => { otherPaths.push(new URL(req.url!, "http://x").pathname); reply.end("Other port"); });
  const blockedOrigin = await listen(blockedServer);
  const requestPaths: string[] = [];
  const site = createServer((req, reply) => {
    const url = new URL(req.url!, "http://localhost");
    requestPaths.push(url.pathname);
    if (url.pathname === "/drop") { req.socket.destroy(); return; }
    if (url.pathname === "/redirect") { reply.writeHead(302, { Location: blockedOrigin + "/redirected" }); reply.end(); return; }
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.end(url.pathname === "/" ? "<title>Local project</title><main><form action='/result'>" +
      "<label>Search <input name='q'></label><button>Search</button></form><a target='_blank' href='/popup'>Popup</a>" +
      "<img src='" + blockedOrigin + "/asset'></main>" : "<title>Search results</title><h1>Fixture result</h1>");
  });
  const origin = await listen(site);
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    // Inside the application only: the name lookup of the browser panel answers a public address at once (no test depends on the network).
    await app.evaluate(({ app: electronApp }) => {
      electronApp.on("session-created", (created) => { created.resolveHost = async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }); });
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const address = page.getByRole("textbox", { name: "Address" });
    await address.fill("http://example.com/");
    await address.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Enter a public https address, or an address on this computer or your network." })).toBeVisible();
    await address.fill(origin + "/");
    await address.press("Enter");
    await expect.poll(() => app!.evaluate(({ webContents }, origin) =>
      webContents.getAllWebContents().find((contents) => contents.getURL() === origin + "/")?.getTitle(), origin)).toBe("Local project");
    const features = await app.evaluate(async ({ webContents }, origin) => {
      const contents = webContents.getAllWebContents().find((contents) => contents.getURL() === origin + "/");
      assertContents(contents);
      return contents.executeJavaScript("[typeof window.desktop, typeof require, typeof process]");
      function assertContents(value: unknown): asserts value {
        if (!value) throw new Error("Missing local browser renderer");
      }
    }, origin);
    assert.deepEqual(features, ["undefined", "undefined", "undefined"]);
    const panel = app.context().pages().find((candidate) => candidate.url() === origin + "/");
    assert.ok(panel);
    // A link that opens a new window opens a tab of the panel, on the same origin: nothing else is reachable through it.
    // The image of the page came from another port of this computer; an address on another machine is cancelled at once.
    await expect.poll(() => otherPaths.includes("/asset")).toBe(true);
    assert.equal(await panel.evaluate(() => Promise.race([
      fetch("http://10.255.255.1:81/lan", { mode: "no-cors" }).then(() => "reached", () => "blocked"), new Promise((resolve) => setTimeout(() => resolve("hung"), 4000))])), "blocked");
    await panel.getByText("Popup", { exact: true }).click();
    await expect(page.getByRole("tab", { name: "Tabs 2" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => requestPaths.includes("/popup")).toBe(true);
    await expect(address).toHaveValue(origin + "/popup");
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Tabs 1" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Tabs 2" })).toHaveCount(0);
    await panel.getByLabel("Search").fill("ordering");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Fixture result" })).toBeVisible();
    await expect(address).toHaveValue(origin + "/result?q=ordering");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(panel.getByText("Popup", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Fixture result" })).toBeVisible();
    const reloadCount = requestPaths.filter((path) => path === "/result").length;
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => requestPaths.filter((path) => path === "/result").length).toBeGreaterThan(reloadCount);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Tabs 2" })).toHaveAttribute("aria-selected", "true");
    await expect(address).toHaveValue("");
    await address.fill(origin + "/second");
    await address.press("Enter");
    await expect.poll(() => app!.context().pages().some((candidate) => candidate.url() === origin + "/second")).toBe(true);
    await page.getByRole("tab", { name: "Tabs 2" }).press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Tabs 1" })).toHaveAttribute("aria-selected", "true");
    await expect(address).toHaveValue(origin + "/result?q=ordering");
    await page.getByRole("tab", { name: "Tabs 2" }).click();
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    await expect.poll(() => app!.context().pages().some((candidate) => candidate.url() === origin + "/second")).toBe(false);
    await expect(address).toHaveValue(origin + "/result?q=ordering");
    const resize = page.getByRole("separator", { name: "Browser", exact: true });
    await resize.press("ArrowLeft");
    await expect(resize).toHaveAttribute("aria-valuenow", "48");
    await address.fill(origin + "/redirect");
    await address.press("Enter");
    await expect.poll(() => requestPaths.includes("/redirect")).toBe(true);
    assert.equal(otherPaths.includes("/redirected"), false, "a redirect of the page to another port is not followed");
    await address.fill(origin + "/drop");
    await address.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "The page could not load." })).toBeVisible();
    // The panel belongs to the person, not to Code: it stays when they move to Chat, and ends when they close it.
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Browser", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select element" })).toHaveCount(0);
    assert.equal(await app!.evaluate(({ webContents }, origin) =>
      webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(origin)), origin), true);
    await page.getByRole("complementary", { name: "Browser", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => app!.evaluate(({ webContents }, origin) =>
      webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(origin)), origin)).toBe(false);
    await expect(page.getByRole("complementary", { name: "Browser", exact: true })).toHaveCount(0);
    assert.equal(otherPaths.includes("/redirected"), false);
  } finally {
    await app?.close();
    site.close();
    blockedServer.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
