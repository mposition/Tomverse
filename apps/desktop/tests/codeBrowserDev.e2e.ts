import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

/**
 * The browser panel as a development preview: the person's own sites on this computer and network, a sign-in that outlasts the tab
 * and the app (one profile for each project), site permissions asked in a dialog, downloads, popups and DevTools. No test leaves the
 * machine. The "network" is two local http servers (127.0.0.1 and 127.0.0.2), and a name only this test's lookup answers privately.
 */

type Seen = { host: string; path: string; cookie: string };
type Site = { server: Server; origin: string; seen: Seen[]; port: number };

async function listen(host: string, handler: RequestListener): Promise<Site> {
  const seen: Seen[] = [];
  const server = createServer((request, reply) => {
    seen.push({ host: request.headers.host ?? "", path: new URL(request.url!, "http://x").pathname, cookie: request.headers.cookie ?? "" });
    handler(request, reply);
  });
  // A WebSocket handshake and nothing more: the page learns that the connection opened.
  server.on("upgrade", (request, socket) => {
    seen.push({ host: request.headers.host ?? "", path: new URL(request.url!, "http://x").pathname, cookie: "" });
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: " + accept, "", ""].join("\r\n"));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, host, resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return { server, origin: `http://${host}:${address.port}`, seen, port: address.port };
}

const html = (reply: ServerResponse, body: string) => {
  reply.setHeader("Content-Type", "text/html; charset=utf-8");
  reply.end(body);
};

/** The development site on this computer: pages, a sign-in cookie with no expiry, a download and a sign-in popup. */
function devSite(host: string, other?: () => string) {
  return listen(host, (request, reply) => {
    const url = new URL(request.url!, "http://x");
    if (url.pathname === "/login") {
      reply.setHeader("Set-Cookie", "dev_session=signed-in; Path=/; HttpOnly");
      return html(reply, "<title>Signed in</title><h1>Signed in</h1>");
    }
    if (url.pathname === "/whoami") return html(reply, "<title>Who</title><pre id='cookie'>cookie=[" + (request.headers.cookie ?? "") + "]</pre>");
    if (url.pathname === "/report.txt") {
      reply.setHeader("Content-Type", "application/octet-stream");
      reply.setHeader("Content-Disposition", 'attachment; filename="report.txt"');
      return void reply.end("downloaded text");
    }
    if (url.pathname === "/tool.exe") {
      reply.setHeader("Content-Type", "application/octet-stream");
      reply.setHeader("Content-Disposition", 'attachment; filename="tool.exe"');
      return void reply.end("MZ not a program");
    }
    if (url.pathname === "/oauth-popup") {
      return html(reply, "<title>Popup</title><script>window.opener && window.opener.postMessage('popup-done', location.origin);" +
        "document.title = 'popup ' + typeof window.desktop + ' ' + typeof require + ' ' + typeof process + ' ' + (window.opener !== null);</script>");
    }
    if (url.pathname === "/app") {
      // A front end that talks to an API on another port: a request, a WebSocket and a frame. The title tells what got through.
      return html(reply, "<title>app pending</title><script>" +
        "const params = new URLSearchParams(location.search); const api = params.get('api'); const tag = params.get('tag');" +
        "const state = { fetch: 'wait', ws: 'wait' };" +
        "const show = () => { document.title = 'app ws:' + state.ws + ' fetch:' + state.fetch; };" +
        "fetch(api + '/api/data-' + tag, { mode: 'no-cors' }).then(() => { state.fetch = 'ok'; show(); }, () => { state.fetch = 'fail'; show(); });" +
        "const socket = new WebSocket(api.replace('http', 'ws') + '/socket-' + tag);" +
        "socket.onopen = () => { state.ws = 'open'; show(); socket.close(); }; socket.onerror = () => { state.ws = 'error'; show(); };" +
        "const frame = document.createElement('iframe'); frame.src = api + '/frame-' + tag; document.documentElement.append(frame);" +
        "</script>");
    }
    if (url.pathname === "/opener") {
      return html(reply, "<title>Opener</title><button id='open' onclick=\"window.open('/oauth-popup', 'oauth', 'width=420,height=320')\">Sign in</button>" +
        "<script>window.addEventListener('message', (event) => { if (event.origin === location.origin) document.title = 'message ' + event.data; });</script>");
    }
    html(reply, "<title>Dev " + host + "</title><h1>Dev " + host + "</h1><a id='file' href='/report.txt'>Report</a> <a id='exe' href='/tool.exe'>Tool</a>" +
      " <a id='other' href='" + (other?.() ?? "/") + "'>Other site</a> <a id='blank' target='_blank' href='/blank'>Blank</a>");
  });
}

async function certificate(directory: string, subject: string) {
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  await promisify(execFile)(process.env.TOMVERSE_DESKTOP_TEST_OPENSSL || "openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1", "-subj", "/CN=" + subject,
    "-addext", "subjectAltName=DNS:*." + subject, "-keyout", key, "-out", cert,
  ]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

type Launched = { app: ElectronApplication; page: Page; folder: string; root: string; profile: string; descriptor: string };

/** A project folder and a profile folder, kept for a restart. `stand` gives names the lookup answers (the rest answer a public address). */
async function launch(gateway: FakeGateway, options: { folder?: string; extra?: object; args?: string[]; names?: Record<string, string> } = {}): Promise<Launched> {
  const folder = options.folder ?? await mkdtemp(join(tmpdir(), "tomverse-browser-dev-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(profile, { recursive: true })]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, ...options.extra }));
  const app = await launchNativeFixture(descriptor, 30_000, options.args ?? []);
  // Inside the application only: the lookup of the browser panel answers what the test says, and a self-signed certificate is accepted.
  await app.evaluate(({ app: electronApp }, names) => {
    electronApp.on("session-created", (created) => {
      created.resolveHost = async (host: string) => ({ endpoints: [{ address: names[host] ?? "93.184.216.34", family: "ipv4" }] });
      created.setCertificateVerifyProc((_request, callback) => callback(0));
    });
  }, options.names ?? {});
  return { app, page: await app.firstWindow(), folder, root, profile, descriptor };
}

/** The system's own dialogs are native; the test answers the one the host asks and keeps what it was asked. */
async function answerDialogs(app: ElectronApplication, answer: { response: number; checkboxChecked: boolean }) {
  await app.evaluate(({ dialog }, next) => {
    const state = globalThis as unknown as { __dialogs?: unknown[]; __answer?: unknown };
    state.__dialogs ??= [];
    state.__answer = next;
    dialog.showMessageBox = (async (...args: unknown[]) => { state.__dialogs!.push(args.at(-1)); return state.__answer; }) as never;
  }, answer);
}
const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __dialogs?: Array<Record<string, unknown>> }).__dialogs ?? []);

const panelPage = (app: ElectronApplication, prefix: string) => app.context().pages().find((candidate) => candidate.url().startsWith(prefix));

async function openPanel(page: Page) {
  const panel = page.getByRole("complementary", { name: "Browser", exact: true });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(panel).toBeVisible();
  return { panel, address: page.getByRole("textbox", { name: "Address" }) };
}

async function visit(page: Page, app: ElectronApplication, target: string, title: string) {
  const { address } = await openPanel(page);
  await address.fill(target);
  await address.press("Enter");
  await expect.poll(() => panelPage(app, target)?.title(), { timeout: 15_000 }).toBe(title);
  return panelPage(app, target)!;
}

async function finish(runs: Array<Launched | undefined>, sites: Array<Site | undefined>, gateway: FakeGateway) {
  for (const run of runs) await run?.app.close().catch(() => {});
  for (const site of sites) site?.server.close();
  await gateway.stop();
  for (const run of runs) if (run) await removeNativeFixtureDirectory(run.folder).catch(() => {});
}

test("a page on the person's own network opens over http, stays on its origin, and its notice is gone; a public page cannot reach it", { timeout: 120_000 }, async () => {
  const a = await devSite("127.0.0.1", () => b.origin + "/");
  const b = await devSite("127.0.0.2", () => a.origin + "/");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  const certDirectory = await mkdtemp(join(tmpdir(), "tomverse-browser-dev-cert-"));
  const publicSeen: Seen[] = [];
  const publicSite = createTlsServer(await certificate(certDirectory, "fixture-web.com"), (request, reply) => {
    publicSeen.push({ host: request.headers.host ?? "", path: request.url ?? "", cookie: "" });
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.setHeader("Connection", "close");
    reply.end("<title>Public</title><h1>Public site</h1>");
  });
  await new Promise<void>((resolve, reject) => publicSite.listen(0, "127.0.0.1", resolve).once("error", reject));
  const publicPort = (publicSite.address() as { port: number }).port;
  let run: Launched | undefined;
  try {
    run = await launch(gateway, {
      args: [`--host-resolver-rules=MAP *.fixture-web.com 127.0.0.1:${publicPort}, MAP lan-app.test 127.0.0.1`],
      names: { "lan-app.test": "10.20.30.40" },
    });
    const { app, page } = run;
    const { address, panel } = await openPanel(page);
    // The LAN stand-in on 127.0.0.2: plain http, no port rule, no Tomverse notice. The page is the person's own.
    const second = await visit(page, app, b.origin + "/", "Dev 127.0.0.2");
    await expect(panel.getByText("outside Tomverse", { exact: false })).toHaveCount(0);
    await expect(panel.getByTestId("code-browser-account-notice")).toHaveCount(0);
    assert.deepEqual(await second.evaluate(() => [typeof (window as { desktop?: unknown }).desktop, typeof (globalThis as { require?: unknown }).require]), ["undefined", "undefined"]);
    // It stays on that origin: a link to another origin does nothing, and the page cannot send a request there either.
    await second.locator("#other").click({ noWaitAfter: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(a.seen.length, 0, "nothing reached the other server through a link");
    assert.equal(await second.evaluate((target) => fetch(target, { mode: "no-cors" }).then(() => "reached", () => "blocked"), a.origin + "/probe"), "blocked");
    assert.equal(a.seen.length, 0, "nothing reached the other server through a request");
    await expect(address).toHaveValue(b.origin + "/");
    // To leave the origin the person types the address again; that replaces the page, and the pin moves with it.
    const first = await visit(page, app, a.origin + "/", "Dev 127.0.0.1");
    assert.ok(first);
    assert.equal(b.seen.filter((entry) => entry.path === "/probe").length, 0);
    // A name that only a private lookup answers (`.test`, answered 10.20.30.40 here) opens as a private page, over http, with its port.
    const named = `http://lan-app.test:${a.port}/`;
    await address.fill(named);
    await address.press("Enter");
    await expect.poll(() => panelPage(app, named)?.title(), { timeout: 15_000 }).toBe("Dev 127.0.0.1");
    assert.ok(a.seen.some((entry) => entry.host === `lan-app.test:${a.port}`), "the request went out under the private name");
    // The same name over plain http that answers a public address is refused, and nothing is requested.
    const before = a.seen.length;
    await address.fill("http://public-name.example.com/");
    await address.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Enter a public https address, or an address on this computer or your network." })).toBeVisible();
    assert.equal(a.seen.length, before);
    // A public page (https) cannot reach either address: not by name, not by IP, not through a link or a form.
    const publicUrl = `https://site.fixture-web.com:${publicPort}/`;
    const publicTab = await visit(page, app, publicUrl, "Public");
    for (const target of [a.origin + "/from-public", b.origin + "/from-public", `http://lan-app.test:${a.port}/from-public`, `https://127.0.0.2:${b.port}/from-public`]) {
      assert.equal(await publicTab.evaluate((url) => fetch(url, { mode: "no-cors" }).then(() => "reached", () => "blocked"), target), "blocked", target);
    }
    assert.equal([...a.seen, ...b.seen].some((entry) => entry.path === "/from-public"), false, "no request from the public page reached a private address");
    await expect(panel.getByText("outside Tomverse", { exact: false })).toHaveCount(0);
  } finally {
    publicSite.close();
    await finish([run], [a, b], gateway);
    await rm(certDirectory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a local page reaches other ports of this computer, a private page other ports of its own host only, and the page itself stays put", { timeout: 120_000 }, async () => {
  const front = await devSite("127.0.0.1");
  const api = await devSite("127.0.0.1");
  const lanFront = await devSite("127.0.0.2");
  const lanApi = await devSite("127.0.0.2");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  let run: Launched | undefined;
  const hit = (site: Site, path: string) => site.seen.some((entry) => entry.path === path);
  const app = (origin: string, apiOrigin: string, tag: string) => origin + "/app?api=" + encodeURIComponent(apiOrigin) + "&tag=" + tag;
  try {
    run = await launch(gateway);
    const { page } = run;
    const { app: electron } = { app: run.app };
    // A local tab: its front end calls the API, opens a WebSocket and a frame on another port of this computer (and on 127.0.0.2).
    await visit(page, electron, app(front.origin, api.origin, "a"), "app ws:open fetch:ok");
    assert.ok(hit(api, "/api/data-a") && hit(api, "/socket-a"), "request and socket reached the other port");
    await expect.poll(() => hit(api, "/frame-a"), { message: "the frame reached the other port" }).toBe(true);
    await visit(page, electron, app(front.origin, lanApi.origin, "b"), "app ws:open fetch:ok");
    assert.ok(hit(lanApi, "/api/data-b"), "any loopback address is the person's own computer");
    // The page itself does not move there: a link to the other port does nothing, and a redirect would not be followed.
    const home = await visit(page, electron, front.origin + "/", "Dev 127.0.0.1");
    await home.evaluate((target) => { (document.getElementById("other") as HTMLAnchorElement).href = target; }, api.origin + "/navigated");
    await home.locator("#other").click({ noWaitAfter: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(hit(api, "/navigated"), false, "the main frame stays on the origin it was opened with");
    assert.equal(await home.evaluate(() => Promise.race([fetch("http://10.255.255.1:81/lan", { mode: "no-cors" }).then(() => "reached", () => "blocked"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 4000))])), "blocked", "another machine is out of reach");
    // A private tab (127.0.0.2 is a private address here, typed as such): other ports of the same host only.
    const other = await visit(page, electron, app(lanFront.origin, lanApi.origin, "c"), "app ws:open fetch:ok");
    assert.ok(other);
    assert.ok(hit(lanApi, "/api/data-c") && hit(lanApi, "/socket-c"), "the same host, another port");
    await expect.poll(() => hit(lanApi, "/frame-c")).toBe(true);
    await visit(page, electron, app(lanFront.origin, api.origin, "d"), "app ws:error fetch:fail");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal([...api.seen].some((entry) => entry.path.endsWith("-d")), false, "another host is not reached: no request, no socket, no frame");
  } finally {
    await finish([run], [front, api, lanFront, lanApi], gateway);
  }
});

test("a sign-in outlasts the tab, the panel and the app, belongs to the project, stays out of the Tomverse session, and is cleared on request", { timeout: 180_000 }, async () => {
  const site = await devSite("127.0.0.1");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  let run: Launched | undefined;
  let other: Launched | undefined;
  let again: Launched | undefined;
  try {
    run = await launch(gateway);
    const { app, page } = run;
    await page.getByRole("button", { name: "Open local folder" }).click();
    const who = site.origin + "/whoami";
    await visit(page, app, site.origin + "/login", "Signed in");
    // The same tab, another tab, and a tab opened after the first one was closed all hold the sign-in.
    await expect.poll(async () => (await visit(page, app, who, "Who")).locator("#cookie").textContent()).toBe("cookie=[dev_session=signed-in]");
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect.poll(async () => (await visit(page, app, site.origin + "/whoami?second", "Who")).locator("#cookie").textContent()).toBe("cookie=[dev_session=signed-in]");
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Browser", exact: true });
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await visit(page, app, site.origin + "/whoami?third", "Who")).locator("#cookie").textContent()).toBe("cookie=[dev_session=signed-in]");
    // Not in the window's own session, and held by a partition that lives on disk.
    const where = await app.evaluate(async ({ session, webContents }, prefix) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(prefix));
      return {
        inApp: (await session.defaultSession.cookies.get({ name: "dev_session" })).length,
        inPanel: contents ? (await contents.session.cookies.get({ name: "dev_session" })).length : -1,
        persistent: contents ? contents.session.isPersistent() : false,
        // The site gave the cookie no expiry; the profile keeps it, as a sign-in that lasts.
        promoted: contents ? (await contents.session.cookies.get({ name: "dev_session" })).every((cookie) => !cookie.session && (cookie.expirationDate ?? 0) > Date.now() / 1000) : false,
        sameAsApp: contents ? contents.session === session.defaultSession : true,
      };
    }, site.origin + "/whoami?third");
    assert.deepEqual(where, { inApp: 0, inPanel: 1, persistent: true, promoted: true, sameAsApp: false });
    // Another project (another folder) has a profile of its own.
    await app.close();
    other = await launch(gateway, { folder: await mkdtemp(join(tmpdir(), "tomverse-browser-dev-other-")) });
    await other.page.getByRole("button", { name: "Open local folder" }).click();
    await expect.poll(async () => (await visit(other!.page, other!.app, who, "Who")).locator("#cookie").textContent()).toBe("cookie=[]");
    await other.app.close();
    // The app restarted on the same project: the sign-in, which the site gave no expiry, is still there.
    again = await launch(gateway, { folder: run.folder });
    await again.page.getByRole("button", { name: "Open local folder" }).click();
    await expect.poll(async () => (await visit(again!.page, again!.app, who + "?restart", "Who")).locator("#cookie").textContent()).toBe("cookie=[dev_session=signed-in]");
    // Clear browser data: a confirmation dialog first (cancelling keeps everything), then the profile is empty and the page signed out.
    await answerDialogs(again.app, { response: 0, checkboxChecked: false });
    await again.page.getByRole("button", { name: "Clear browser data", exact: true }).click();
    await expect.poll(async () => (await asked(again!.app)).length).toBe(1);
    const dialog = (await asked(again.app))[0]!;
    assert.equal(dialog.message, "Clear the browser data of this project?");
    assert.deepEqual(dialog.buttons, ["Cancel", "Clear data"]);
    await expect(panelPage(again.app, who + "?restart")!.locator("#cookie")).toHaveText("cookie=[dev_session=signed-in]");
    await answerDialogs(again.app, { response: 1, checkboxChecked: false });
    await again.page.getByRole("button", { name: "Clear browser data", exact: true }).click();
    await expect.poll(async () => (await again!.app.evaluate(async ({ webContents }, prefix) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(prefix));
      return contents ? (await contents.session.cookies.get({ name: "dev_session" })).length : -1;
    }, who))).toBe(0);
    await expect.poll(async () => panelPage(again!.app, who + "?restart")?.locator("#cookie").textContent()).toBe("cookie=[]");
  } finally {
    await finish([run, other, again], [site], gateway);
  }
});

test("a window.open popup that answers through window.opener is a child window under the same rules; a link opens a tab of the panel", { timeout: 120_000 }, async () => {
  const site = await devSite("127.0.0.1");
  const elsewhere = await devSite("127.0.0.2");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  let run: Launched | undefined;
  try {
    run = await launch(gateway);
    const { app, page } = run;
    const opener = await visit(page, app, site.origin + "/opener", "Opener");
    await opener.locator("#open").click({ noWaitAfter: true });
    await expect.poll(() => panelPage(app, site.origin + "/oauth-popup")?.title(), { timeout: 15_000 }).toBe("popup undefined undefined undefined true");
    // The page that opened it hears the answer: window.opener and postMessage work.
    await expect.poll(() => opener.title()).toBe("message popup-done");
    const popup = panelPage(app, site.origin + "/oauth-popup")!;
    // The window is in the profile's session, not the application's, and is pinned like the tab: it reaches nothing outside the origin.
    const kept = await app.evaluate(({ session, webContents }, prefix) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(prefix));
      return { persistent: contents?.session.isPersistent() ?? false, sameAsApp: contents ? contents.session === session.defaultSession : true };
    }, site.origin + "/oauth-popup");
    assert.deepEqual(kept, { persistent: true, sameAsApp: false });
    // It follows the same rules as its tab: another loopback address is reachable for what it loads, another machine is not.
    assert.equal(await popup.evaluate((target) => fetch(target, { mode: "no-cors" }).then(() => "reached", () => "blocked"), elsewhere.origin + "/from-popup"), "reached");
    assert.equal(await popup.evaluate(() => Promise.race([fetch("http://10.255.255.1:81/lan", { mode: "no-cors" }).then(() => "reached", () => "blocked"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 4000))])), "blocked");
    elsewhere.seen.length = 0;
    const nested = await popup.evaluate((target) => { const child = window.open(target, "x", "width=200,height=200"); return child === null ? "none" : "opened"; }, elsewhere.origin + "/nested");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(elsewhere.seen.length, 0, "a popup of the popup cannot go to another origin either (" + nested + ")");
    // A link with target=_blank is a tab of the panel, and the panel shows it.
    await page.bringToFront();
    await opener.evaluate(() => { history.back(); });
    const tabs = page.getByRole("tab", { name: /^Tabs/ });
    const count = await tabs.count();
    await visit(page, app, site.origin + "/", "Dev 127.0.0.1");
    await panelPage(app, site.origin + "/")!.locator("#blank").click({ noWaitAfter: true });
    await expect(tabs).toHaveCount(count + 1);
    await expect.poll(() => site.seen.some((entry) => entry.path === "/blank")).toBe(true);
  } finally {
    await finish([run], [site, elsewhere], gateway);
  }
});

test("a download asks where to save (the system's save dialog; a test names a folder), shows its progress in the panel, and nothing is run", { timeout: 120_000 }, async () => {
  const site = await devSite("127.0.0.1");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  const downloads = await mkdtemp(join(tmpdir(), "tomverse-browser-dev-downloads-"));
  let run: Launched | undefined;
  try {
    run = await launch(gateway, { extra: { browserDownloads: downloads } });
    const { app, page } = run;
    const home = await visit(page, app, site.origin + "/", "Dev 127.0.0.1");
    await home.locator("#file").click({ noWaitAfter: true });
    await expect(page.getByText("Downloaded report.txt", { exact: true })).toBeVisible({ timeout: 15_000 });
    assert.equal(await readFile(join(downloads, "report.txt"), "utf8"), "downloaded text");
    await home.locator("#exe").click({ noWaitAfter: true });
    await expect(page.getByText("Downloaded tool.exe", { exact: true })).toBeVisible({ timeout: 15_000 });
    assert.deepEqual((await readdir(downloads)).sort(), ["report.txt", "tool.exe"], "the files are only saved; nothing else came of them");
    // Nothing was opened or run: the page is still the same one, and no process was started by the panel.
    await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(site.origin + "/");
    // Moving to another page ends the notice.
    await page.getByRole("textbox", { name: "Address" }).fill(site.origin + "/whoami");
    await page.getByRole("textbox", { name: "Address" }).press("Enter");
    await expect(page.getByText("Downloaded tool.exe", { exact: true })).toHaveCount(0);
  } finally {
    await finish([run], [site], gateway);
    await rm(downloads, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a site's permission request is asked in a dialog with its origin, remembered per project when the person says so, and the dangerous ones are refused without asking", { timeout: 150_000 }, async () => {
  const site = await devSite("127.0.0.1");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  let run: Launched | undefined;
  try {
    run = await launch(gateway);
    const { app, page } = run;
    const dev = await visit(page, app, site.origin + "/", "Dev 127.0.0.1");
    const ask = () => dev.evaluate(() => Notification.requestPermission());
    // Denied once, not remembered: asked again next time.
    await answerDialogs(app, { response: 0, checkboxChecked: false });
    assert.equal(await ask(), "denied");
    let dialogs = await asked(app);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0]!.message, `${site.origin} is asking for permission: notifications`);
    assert.equal(dialogs[0]!.checkboxLabel, "Remember for this project");
    assert.deepEqual(dialogs[0]!.buttons, ["Deny", "Allow"]);
    // Allowed and remembered: granted, and the page is not asked again, also after a reload.
    await answerDialogs(app, { response: 1, checkboxChecked: true });
    assert.equal(await ask(), "granted");
    assert.equal((await asked(app)).length, 2);
    assert.equal(await ask(), "granted");
    assert.equal((await asked(app)).length, 2, "a remembered answer is not asked again");
    const loads = site.seen.filter((entry) => entry.path === "/").length;
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => site.seen.filter((entry) => entry.path === "/").length).toBeGreaterThan(loads);
    await expect.poll(() => dev.evaluate(() => Notification.permission).catch(() => "reloading")).toBe("granted");
    // Screen sharing and devices are refused with no dialog at all.
    const refused = await dev.evaluate(`(async () => {
      const outcome = (run) => run().then(() => "granted", (error) => error.name);
      return {
        screen: await outcome(() => navigator.mediaDevices.getDisplayMedia({ video: true })),
        usb: await outcome(() => navigator.usb.requestDevice({ filters: [] })),
        serial: await outcome(() => navigator.serial.requestPort()),
      };
    })()`) as Record<string, string>;
    for (const [name, outcome] of Object.entries(refused)) assert.notEqual(outcome, "granted", name);
    assert.equal((await asked(app)).length, 2, "none of them reached the person");
    // Clearing the profile's data forgets the answer.
    await answerDialogs(app, { response: 1, checkboxChecked: false });
    await page.getByRole("button", { name: "Clear browser data", exact: true }).click();
    await expect.poll(async () => (await asked(app)).length).toBe(3);
    await expect.poll(async () => (await dev.evaluate(() => Notification.permission)) !== "granted").toBe(true);
    dialogs = await asked(app);
    assert.equal(dialogs.at(-1)!.message, "Clear the browser data of this project?");
  } finally {
    await finish([run], [site], gateway);
  }
});

test("the page's DevTools open in a window of their own from the panel's button, and a Tomverse origin gets the account notice", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  const certDirectory = await mkdtemp(join(tmpdir(), "tomverse-browser-dev-cert-"));
  const seen: string[] = [];
  const tomverse = createTlsServer(await certificate(certDirectory, "tomverse.app"), (request, reply) => {
    seen.push(request.headers.host ?? "");
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.setHeader("Connection", "close");
    reply.end("<title>Tomverse stand-in</title><h1>Not the real site</h1>");
  });
  await new Promise<void>((resolve, reject) => tomverse.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = (tomverse.address() as { port: number }).port;
  const site = await devSite("127.0.0.1");
  let run: Launched | undefined;
  try {
    run = await launch(gateway, { args: [`--host-resolver-rules=MAP *.tomverse.app 127.0.0.1:${port}`] });
    const { app, page } = run;
    const dev = await visit(page, app, site.origin + "/", "Dev 127.0.0.1");
    assert.ok(dev);
    const devtools = page.getByRole("button", { name: "Open DevTools", exact: true });
    await expect(devtools).toBeEnabled();
    await devtools.click();
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith("devtools://"))), { timeout: 15_000 }).toBe(true);
    // The window belongs to the page of the tab (not to the application's own window), and the page is the person's development site.
    await expect.poll(() => app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(prefix))?.devToolsWebContents?.getURL().startsWith("devtools://") === true,
      site.origin + "/")).toBe(true);
    assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("tomverse://")).some((contents) => contents.devToolsWebContents !== null), undefined), false,
      "the application's own window has no DevTools");
    // A page of Tomverse's own origin says the Tomverse account is not signed in here; no other page does.
    const { address, panel } = await openPanel(page);
    const home = `https://qa.tomverse.app:${port}/`;
    await address.fill(home);
    await address.press("Enter");
    await expect.poll(() => panelPage(app, home)?.title(), { timeout: 15_000 }).toBe("Tomverse stand-in");
    await expect(panel.getByTestId("code-browser-account-notice")).toHaveText("You are not signed in to your Tomverse account here.");
    await address.fill(site.origin + "/");
    await address.press("Enter");
    await expect(panel.getByTestId("code-browser-account-notice")).toHaveCount(0);
  } finally {
    tomverse.close();
    await finish([run], [site], gateway);
    await rm(certDirectory, { recursive: true, force: true, maxRetries: 5 });
  }
});
