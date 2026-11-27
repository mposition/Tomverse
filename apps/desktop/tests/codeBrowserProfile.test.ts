import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { browserCommand, classifyBrowserAddress, isLoopbackHost, pinnedNavigationUrl, pinnedOriginUrl, pinnedSubresourceUrl, privateNetworkUrl } from "../src/browser-contract";
import { isPrivateNetworkAddress } from "../src/internal-address";
import {
  admitTypedAddress, browserProfile, checkPermission, createPermissionMemory, decidePermission, downloadPlan, permissionKey, permissionVerdict,
  popupAddressAllowed, popupMode, safeDownloadName, MAX_REMEMBERED_PERMISSIONS, PERMISSIONS_ALLOWED, PERMISSIONS_ASKED, PERMISSIONS_REFUSED,
  type PermissionMemory, type PermissionRequest,
} from "../src/host/code-browser-policy";
import { createResolvedHostGate, gatedRequestFilter } from "../src/host/resolved-host-gate";
import { allowsSubresource, linkViewUrl } from "../src/web-view-contract";

const hostDir = fileURLToPath(new URL("../src/host/", import.meta.url));

// ---- profile -------------------------------------------------------------------------------------------------------------------

test("the saved browser data is one partition for each account and each project, and no other session can name it", () => {
  const a = browserProfile("account-1", "H:\\Project\\Shop", "win32");
  assert.equal(a.partition.startsWith("persist:tomverse-code-browser-"), true, "persistent, and not the app's own partition");
  assert.deepEqual(browserProfile("account-1", "H:/Project/Shop/", "win32"), a, "the same folder written another way is the same project");
  // Case is never folded: the folder is the canonical path the app opened, and a volume may tell /work/App from /work/app.
  for (const platform of ["win32", "darwin", "linux"] as const) {
    assert.notEqual(browserProfile("account-1", "/work/App", platform).partition, browserProfile("account-1", "/work/app", platform).partition, platform);
  }
  assert.deepEqual(browserProfile("account-1", "/work/App/", "linux"), browserProfile("account-1", "/work/App", "linux"));
  assert.notEqual(browserProfile("account-2", "H:\\Project\\Shop", "win32").partition, a.partition, "another account has its own data");
  assert.notEqual(browserProfile("account-1", "H:\\Project\\Blog", "win32").partition, a.partition, "another project has its own data");
  assert.notEqual(browserProfile(null, "H:\\Project\\Shop", "win32").partition, a.partition, "a browser with no one signed in has its own data");
  assert.notEqual(browserProfile("account-1", null, "win32").partition, a.partition, "a browser with no project (Chat) has its own data");
  assert.match(browserProfile("account-1", null, "win32").partition, /^persist:tomverse-code-browser-[0-9a-f]{16}-none$/);
  assert.match(a.partition, /^persist:tomverse-code-browser-[0-9a-f]{16}-[0-9a-f]{16}$/);
  assert.equal(a.partition.includes("account-1") || a.partition.toLowerCase().includes("shop"), false, "the name does not carry the account or the folder");
  // An account id and a folder that spell the same text still make different keys.
  assert.notEqual(browserProfile("x", "x", "linux").id.split("-")[0], browserProfile("x", "x", "linux").id.split("-")[1]);
  // The link viewers, the checkout window and the sign-in windows use in-memory partitions of their own names: none can equal a profile.
  assert.equal(/^persist:/.test("tomverse-code-browser-abc"), false);
});

// ---- addresses -----------------------------------------------------------------------------------------------------------------

const resolver = (table: Record<string, string[] | "fail">) => async (host: string) => {
  const answer = table[host];
  if (!answer || answer === "fail") throw new Error("no answer for " + host);
  return { endpoints: answer.map((address) => ({ address })) };
};
const typed = (text: string) => classifyBrowserAddress(text)!;

test("an address a person types on their own network opens and is pinned; a public one over http is refused", async () => {
  const dns = resolver({
    "app.test": ["10.1.2.3"], "wiki.corp.example.com": ["192.168.4.7"], "nas": ["fd00::7"], "mixed.example.com": ["93.184.216.34", "10.0.0.9"],
    "plain.example.com": ["93.184.216.34"], "site.example.com": ["93.184.216.34"], "intranet.example.com": ["10.20.30.40"],
    "reserved.test": ["192.0.2.5"], "down.test": "fail", "public.test": ["93.184.216.34"],
  });
  const kindOf = async (text: string) => (await admitTypedAddress(typed(text), dns))?.kind ?? null;
  // Literals: no lookup, judged as they are.
  assert.equal(await kindOf("http://192.168.0.5:3000/"), "private");
  assert.equal(await kindOf("https://[fd00::5]:8443/"), "private");
  assert.equal(await kindOf("http://127.0.0.2:3000/"), "private");
  assert.equal(await kindOf("https://localhost:3443/"), "private", "a loopback name over https needs no lookup");
  assert.equal(await kindOf("http://localhost:3000/"), "local");
  // Names: every answer must be on the person's network.
  assert.equal(await kindOf("http://app.test:3000/"), "private");
  assert.equal(await kindOf("http://wiki.corp.example.com/"), "private");
  assert.equal(await kindOf("http://nas/"), "private");
  assert.equal(await kindOf("https://intranet.example.com/"), "private", "a public-looking name that answers privately is a private page, pinned to its origin");
  assert.equal(await kindOf("http://plain.example.com/"), null, "plain http to a public address is not opened");
  assert.equal(await kindOf("http://public.test/"), null, "a private-looking name that answers a public address is not opened");
  assert.equal(await kindOf("http://mixed.example.com/"), null);
  assert.equal(await kindOf("https://mixed.example.com/"), null, "a name that answers public and private addresses is refused");
  assert.equal(await kindOf("http://reserved.test/"), null, "a reserved range is not a place a page is served from");
  assert.equal(await kindOf("http://down.test/"), null, "no answer means no page");
  // A public https site stays a web page (also when its lookup fails: the address gate refuses its requests).
  assert.equal(await kindOf("https://site.example.com/"), "web");
  assert.equal(await kindOf("https://unknown.example.org/"), "web");
  assert.equal((await admitTypedAddress(typed("https://intranet.example.com/"), dns))?.url.origin, "https://intranet.example.com");
});

test("the pinned origin of a local or private tab is exact: its own host and port, over its scheme or the WebSocket twin", () => {
  for (const origin of ["http://192.168.0.5:3000", "http://app.test:5173", "https://nas:8443"]) {
    const base = new URL(origin);
    const twin = base.protocol === "https:" ? "wss:" : "ws:";
    assert.ok(pinnedOriginUrl(origin + "/a?b=1", origin), origin);
    assert.ok(pinnedOriginUrl(twin + "//" + base.host + "/hmr", origin), origin + " hot reload");
    assert.equal(pinnedNavigationUrl(twin + "//" + base.host + "/hmr", origin), null, "a page never navigates to the socket scheme");
    for (const other of [base.protocol + "//" + base.hostname + ":9999/", base.protocol + "//other.test:" + (base.port || "80") + "/", "http://127.0.0.1:3000/",
      "https://example.com/", (base.protocol === "https:" ? "http:" : "https:") + "//" + base.host + "/", "data:text/html,x", "file:///etc/hosts",
      base.protocol + "//user:pw@" + base.host + "/"]) {
      assert.equal(pinnedOriginUrl(other, origin), null, origin + " must not reach " + other);
    }
  }
});

test("a local tab's page reaches any port of this computer, a private tab's page other ports of its own host, and the main frame stays on the origin", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.0.0.2", "127.255.255.254", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["128.0.0.1", "127.0.0", "127.0.0.1.evil.test", "localhost.evil.test", "10.0.0.1", "192.168.0.5", "[fd00::1]", "example.com", "127.0.0.256"]) assert.equal(isLoopbackHost(host), false, host);
  const local = "http://127.0.0.1:3000";
  for (const ok of [local + "/a", "http://127.0.0.1:4000/api", "https://localhost:4443/x", "ws://127.0.0.1:5173/hmr", "wss://[::1]:8443/s", "http://127.0.0.2:9000/", "http://localhost/"]) {
    assert.ok(pinnedSubresourceUrl(ok, local, "local"), ok);
  }
  for (const bad of ["http://192.168.0.5:3000/", "http://10.0.0.1/", "https://example.com/", "http://example.com:3000/", "http://user:pw@127.0.0.1:4000/", "ftp://127.0.0.1:21/", "file:///etc/hosts",
    "data:text/html,x", "javascript:alert(1)", "http://127.0.0.1.evil.test:4000/", "http://[fd00::1]:3000/"]) {
    assert.equal(pinnedSubresourceUrl(bad, local, "local"), null, bad);
  }
  const lan = "http://192.168.0.5:3000";
  for (const ok of [lan + "/a", "http://192.168.0.5:4000/api", "https://192.168.0.5:4443/x", "ws://192.168.0.5:5173/hmr", "wss://192.168.0.5:8443/s"]) assert.ok(pinnedSubresourceUrl(ok, lan, "private"), ok);
  for (const bad of ["http://192.168.0.6:3000/", "http://127.0.0.1:4000/", "http://localhost:4000/", "https://example.com/", "http://user:pw@192.168.0.5:4000/", "ftp://192.168.0.5/"]) {
    assert.equal(pinnedSubresourceUrl(bad, lan, "private"), null, bad);
  }
  const named = "https://app.test";
  assert.ok(pinnedSubresourceUrl("https://app.test:8443/api", named, "private"));
  assert.equal(pinnedSubresourceUrl("https://other.test/api", named, "private"), null);
  // A public tab has no such rule, and the main frame of a pinned tab never moves to another port.
  assert.equal(pinnedSubresourceUrl("http://127.0.0.1:4000/", "https://example.com", "web"), null);
  assert.equal(pinnedNavigationUrl("http://127.0.0.1:4000/", local), null);
  assert.equal(pinnedNavigationUrl("http://127.0.0.2:3000/", local), null);
  assert.equal(pinnedNavigationUrl("ws://127.0.0.1:3000/", local), null);
  assert.equal(pinnedNavigationUrl("http://192.168.0.5:4000/", lan), null);
});

test("a public tab cannot reach the person's network: the name rule, the scheme rule and the resolved address all refuse", async () => {
  for (const request of ["http://127.0.0.2:3000/", "http://192.168.0.5/", "https://192.168.0.5/", "https://10.0.0.1:8443/", "https://localhost:3000/", "https://[::1]:3000/",
    "https://nas/", "https://printer.local/", "https://app.test/", "ws://192.168.0.5:3000/", "wss://10.0.0.1/", "http://example.com/", "ws://example.com/"]) {
    assert.equal(allowsSubresource(request), false, request);
  }
  assert.equal(linkViewUrl("https://192.168.0.5/"), null);
  // A public-looking name that a private DNS answers is cancelled by the address check, for the page and for everything it loads.
  const gate = createResolvedHostGate(async () => ({ endpoints: [{ address: "10.0.0.5" }] }));
  const filter = gatedRequestFilter(gate, (request) => allowsSubresource(request.url) || request.resourceType === "mainFrame");
  for (const [url, resourceType] of [["https://intranet.example.com/", "mainFrame"], ["https://intranet.example.com/api", "xhr"], ["https://cdn.example.com/a.js", "script"]]) {
    const answer = await new Promise<{ cancel: boolean }>((resolve) => filter({ url, resourceType }, resolve));
    assert.deepEqual(answer, { cancel: true }, url);
  }
});

test("the addresses of the person's own network are the private, link-local, loopback and CGNAT ranges, and nothing broader", () => {
  for (const address of ["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.1", "192.168.1.1", "127.0.0.1", "127.0.0.2", "169.254.1.1", "100.64.0.1", "100.127.255.1",
    "::1", "fd00::1", "fc00::1", "fe80::1", "::ffff:192.168.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  for (const address of ["0.0.0.0", "8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "100.63.0.1", "100.128.0.1", "192.0.2.5", "224.0.0.1", "255.255.255.255",
    "::", "2001:db8::1", "2606:4700::1", "ff02::1", "::ffff:8.8.8.8", "fe80::1%eth0", "not an address", ""]) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
  }
  assert.equal(privateNetworkUrl("http://192.168.0.5/")?.href, "http://192.168.0.5/");
  assert.equal(privateNetworkUrl("http://8.8.8.8/"), null);
  assert.equal(privateNetworkUrl("ftp://192.168.0.5/"), null);
});

// ---- permissions ---------------------------------------------------------------------------------------------------------------

function memory(initial: string | null = null) {
  const written: string[] = [];
  let content = initial;
  const value: PermissionMemory = createPermissionMemory({
    read: () => content,
    write: (text) => { content = text; written.push(text); },
    remove: () => { content = null; },
  });
  return { value, written, content: () => content };
}
const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest =>
  ({ permission: "geolocation", origin: "http://127.0.0.1:3000", mainFrame: true, agentHolds: false, ...overrides });

test("a permission a page asks for is put to the person, once, and remembered for the project only when they say so", async () => {
  const store = memory();
  const asked: Array<{ origin: string; permission: string; mediaTypes: readonly string[] }> = [];
  let answer = { allow: true, remember: false };
  const deps = { memory: store.value, ask: async (question: (typeof asked)[number]) => (asked.push(question), answer) };
  assert.equal(await decidePermission(request(), deps), true);
  assert.deepEqual(asked, [{ origin: "http://127.0.0.1:3000", permission: "geolocation", mediaTypes: [] }]);
  assert.equal(await decidePermission(request(), deps), true);
  assert.equal(asked.length, 2, "an answer that was not remembered is asked again");
  assert.deepEqual(store.written, []);
  // Remembered allow: no question, and the answer is kept with the profile.
  answer = { allow: true, remember: true };
  assert.equal(await decidePermission(request(), deps), true);
  assert.equal(asked.length, 3);
  assert.equal(await decidePermission(request(), deps), true);
  assert.equal(asked.length, 3, "a remembered answer is not asked again");
  assert.deepEqual(JSON.parse(store.content()!), { [permissionKey("http://127.0.0.1:3000", "geolocation")]: "allow" });
  assert.equal(checkPermission(request(), store.value), true, "the page\'s own query hears the remembered answer");
  assert.equal(checkPermission(request({ origin: "http://127.0.0.1:3001" }), store.value), false, "another origin (another port) is another site");
  // Another permission and another origin still ask.
  assert.equal(await decidePermission(request({ permission: "notifications" }), deps), true);
  assert.equal(await decidePermission(request({ origin: "https://example.com" }), deps), true);
  assert.equal(asked.length, 5);
  // A remembered refusal is final.
  answer = { allow: false, remember: true };
  assert.equal(await decidePermission(request({ permission: "clipboard-read" }), deps), false);
  assert.equal(await decidePermission(request({ permission: "clipboard-read" }), { ...deps, ask: async () => { throw new Error("asked again"); } }), false);
  assert.equal(checkPermission(request({ permission: "clipboard-read" }), store.value), false);
});

test("clearing the profile's data while a question is open keeps its answer out of the profile and grants nothing", async () => {
  const store = memory();
  let answer!: (value: { allow: boolean; remember: boolean }) => void;
  const pending = decidePermission(request(), { memory: store.value, ask: () => new Promise((resolve) => { answer = resolve; }) });
  store.value.clear();
  answer({ allow: true, remember: true });
  assert.equal(await pending, false);
  assert.equal(store.value.size(), 0);
  assert.equal(store.content(), null, "nothing was written back after the clear");
  // A question asked after the clear works as before.
  assert.equal(await decidePermission(request(), { memory: store.value, ask: async () => ({ allow: true, remember: true }) }), true);
  assert.equal(store.value.size(), 1);
});

test("camera and microphone are asked and remembered by kind, and one refusal wins", async () => {
  const store = memory();
  const questions: string[][] = [];
  const deps = { memory: store.value, ask: async (question: { mediaTypes: readonly string[] }) => (questions.push([...question.mediaTypes]), { allow: true, remember: true }) };
  const media = (mediaTypes?: string[]) => request({ permission: "media", mediaTypes });
  assert.equal(await decidePermission(media(["video"]), deps), true);
  assert.equal(await decidePermission(media(["video"]), deps), true);
  assert.deepEqual(questions, [["video"]]);
  assert.equal(await decidePermission(media(["audio", "video"]), deps), true, "the microphone was not allowed yet, so the person is asked");
  assert.deepEqual(questions.at(-1), ["audio", "video"]);
  assert.equal(await decidePermission(media(), deps), true, "no type named means both, already remembered");
  assert.equal(questions.length, 2);
  store.value.set(permissionKey("http://127.0.0.1:3000", "media", "audio"), "deny");
  assert.equal(await decidePermission(media(["audio", "video"]), deps), false);
  assert.equal(await decidePermission(media(["video"]), deps), true);
  assert.equal(checkPermission(media(["audio"]), store.value), false);
  assert.equal(checkPermission(media(["video"]), store.value), true);
});

test("while the agent holds the tab nothing is asked, nothing remembered is used, and nothing is granted", async () => {
  const store = memory();
  store.value.set(permissionKey("http://127.0.0.1:3000", "geolocation"), "allow");
  const ask = async () => { throw new Error("the person must not be asked about the agent\'s tab"); };
  for (const permission of [...PERMISSIONS_ASKED, ...PERMISSIONS_ALLOWED]) {
    assert.equal(await decidePermission(request({ permission, agentHolds: true }), { memory: store.value, ask }), false, permission);
    assert.equal(checkPermission(request({ permission, agentHolds: true }), store.value), false, permission);
  }
  assert.equal(await decidePermission(request(), { memory: store.value, ask }), true, "the same page, once the person has the tab, uses what they remembered");
});

test("screen sharing, devices, system-exclusive MIDI, other programs and every unknown permission are refused and never asked", async () => {
  for (const name of ["display-capture", "usb", "serial", "hid", "midiSysex", "openExternal"]) {
    assert.ok((PERMISSIONS_REFUSED as readonly string[]).includes(name), name + " is named in the refused list");
  }
  const store = memory();
  const ask = async () => { throw new Error("a refused permission is never put to the person"); };
  for (const permission of [...PERMISSIONS_REFUSED, "future-permission", "", "GEOLOCATION"]) {
    assert.equal(permissionVerdict(permission), "refuse", permission);
    assert.equal(await decidePermission(request({ permission }), { memory: store.value, ask }), false, permission);
    store.value.set(permissionKey("http://127.0.0.1:3000", permission), "allow");
    assert.equal(await decidePermission(request({ permission }), { memory: store.value, ask }), false, permission + " is refused even when an allowance was written");
    assert.equal(checkPermission(request({ permission }), store.value), false, permission);
  }
  assert.deepEqual([...PERMISSIONS_ASKED].map(permissionVerdict), PERMISSIONS_ASKED.map(() => "ask"));
  assert.deepEqual([...PERMISSIONS_ALLOWED].map(permissionVerdict), PERMISSIONS_ALLOWED.map(() => "allow"));
  assert.equal(PERMISSIONS_ASKED.some((name) => (PERMISSIONS_REFUSED as readonly string[]).includes(name)), false);
  // A page inside a frame, or with no web origin, is not asked on behalf of the tab.
  const fresh = memory();
  assert.equal(await decidePermission(request({ mainFrame: false }), { memory: fresh.value, ask }), false);
  assert.equal(await decidePermission(request({ origin: "" }), { memory: fresh.value, ask }), false);
  assert.equal(await decidePermission(request({ origin: "file://" }), { memory: fresh.value, ask }), false);
  assert.equal(checkPermission(request({ mainFrame: false }), fresh.value), false);
  // Copying out of the page is allowed without a question.
  assert.equal(await decidePermission(request({ permission: "clipboard-sanitized-write" }), { memory: fresh.value, ask }), true);
});

test("what the person asked to remember belongs to the profile: it is read back, capped, cleared with the data, and bad files are forgotten", () => {
  const first = memory();
  first.value.set(permissionKey("https://a.example.com", "notifications"), "deny");
  first.value.set(permissionKey("https://a.example.com", "geolocation"), "allow");
  const again = memory(first.content());
  assert.equal(again.value.get(permissionKey("https://a.example.com", "notifications")), "deny");
  assert.equal(again.value.size(), 2);
  again.value.clear();
  assert.equal(again.content(), null, "clearing the profile\'s data removes the file");
  assert.equal(again.value.size(), 0);
  for (const broken of ["not json", "[]", "null", "{\"k\":\"maybe\"}", "{\"k\":1}", ""]) assert.equal(memory(broken).value.size(), 0, broken);
  const crowded = memory();
  for (let index = 0; index < MAX_REMEMBERED_PERMISSIONS + 30; index += 1) crowded.value.set(permissionKey("https://site" + index + ".example.com", "geolocation"), "allow");
  assert.equal(crowded.value.size(), MAX_REMEMBERED_PERMISSIONS);
  assert.equal(crowded.value.get(permissionKey("https://site0.example.com", "geolocation")), undefined, "the oldest answer goes first");
  assert.equal(crowded.value.get(permissionKey("https://site" + (MAX_REMEMBERED_PERMISSIONS + 29) + ".example.com", "geolocation")), "allow");
  // A disk that refuses the write does not fail the answer.
  const readonly = createPermissionMemory({ read: () => null, write: () => { throw new Error("EROFS"); }, remove: () => { throw new Error("EROFS"); } });
  readonly.set("k", "allow");
  assert.equal(readonly.get("k"), "allow");
  readonly.clear();
});

// ---- downloads -----------------------------------------------------------------------------------------------------------------

test("a download is named safely and asks the system's save dialog, starting in the download folder, whoever's tab it came from", () => {
  const plan = downloadPlan({ filename: "report.pdf", downloads: join("C:", "Users", "dev", "Downloads"), agentHolds: false });
  assert.equal(plan.name, "report.pdf");
  assert.equal(plan.defaultPath, join("C:", "Users", "dev", "Downloads", "report.pdf"));
  assert.equal(plan.savePath, null, "no path is chosen for the person: the dialog asks");
  assert.equal(plan.from, "person");
  assert.equal(downloadPlan({ filename: "a.zip", downloads: "/home/dev/Downloads", agentHolds: true }).from, "agent", "the dialog says it is the agent\'s tab");
  assert.equal(downloadPlan({ filename: "a.zip", downloads: "/home/dev/Downloads", agentHolds: true }).savePath, null, "the agent\'s tab gets no way around the dialog");
  assert.equal(downloadPlan({ filename: "a.zip", downloads: "/d", agentHolds: false, testDirectory: "/tmp/test-downloads" }).savePath, join("/tmp/test-downloads", "a.zip"));
  for (const [raw, expected] of [["../../etc/passwd", "passwd"], ["C:\\Windows\\system32\\evil.exe", "evil.exe"], ["a<b>c:d\"e|f?g*.txt", "a_b_c_d_e_f_g_.txt"],
    ["name.txt. . ", "name.txt"], [".hidden", "hidden"], ["", "download"], ["...", "download"], ["con", "download-con"], ["NUL.txt", "download-NUL.txt"],
    ["line\nbreak\u0000.txt", "line_break_.txt"]]) {
    assert.equal(safeDownloadName(raw), expected, JSON.stringify(raw));
  }
  const long = safeDownloadName("x".repeat(400) + ".tar.gz");
  assert.ok(long.length <= 150 && long.endsWith(".gz"), "a long name keeps its extension");
});

test("nothing a page downloads is opened or run by the host, and no panel file reaches for the system shell", () => {
  for (const name of ["code-browser-view.ts", "code-browser-profile.ts"]) {
    const source = readFileSync(join(hostDir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\bshell\b|openPath|openExternal|showItemInFolder|child_process|execFile|spawn\(/, name);
  }
  assert.doesNotMatch(readFileSync(join(hostDir, "code-browser-policy.ts"), "utf8"), /from "electron"/, "the decisions need no Electron");
});

// ---- popups --------------------------------------------------------------------------------------------------------------------

test("a page's new tab follows its opener's rules, and a real child window is only for a popup that keeps its opener", () => {
  const link = { disposition: "foreground-tab", features: "" };
  assert.equal(popupMode(link, false), "tab", "target=_blank is a tab of the panel");
  assert.equal(popupMode({ disposition: "new-window", features: "width=500,height=600" }, false), "window", "a sign-in popup that answers through window.opener");
  assert.equal(popupMode({ disposition: "new-window", features: "width=500,noopener" }, false), "tab", "a popup that cut its opener does not need one");
  assert.equal(popupMode({ disposition: "new-window", features: "" }, false), "tab");
  assert.equal(popupMode({ disposition: "background-tab", features: "" }, false), "tab");
  for (const details of [link, { disposition: "new-window", features: "width=500" }]) assert.equal(popupMode(details, true), "same-tab", "the agent keeps the one tab it works in");
  const pinned = { kind: "private" as const, origin: "http://192.168.0.5:3000" };
  assert.equal(popupAddressAllowed(pinned, "http://192.168.0.5:3000/other"), true);
  for (const bad of ["http://192.168.0.5:3001/", "http://192.168.0.6:3000/", "https://192.168.0.5:3000/", "https://example.com/", "http://127.0.0.1:3000/", "ws://192.168.0.5:3000/", "javascript:alert(1)", "about:blank"]) {
    assert.equal(popupAddressAllowed(pinned, bad), false, bad);
  }
  const local = { kind: "local" as const, origin: "http://127.0.0.1:5173" };
  assert.equal(popupAddressAllowed(local, "http://127.0.0.1:5173/popup"), true);
  assert.equal(popupAddressAllowed(local, "http://localhost:5173/popup"), false);
  const web = { kind: "web" as const, origin: "" };
  assert.equal(popupAddressAllowed(web, "https://example.com/oauth"), true);
  for (const bad of ["http://example.com/", "https://192.168.0.5/", "https://localhost:3000/", "https://nas/", "file:///etc/hosts", "javascript:alert(1)"]) {
    assert.equal(popupAddressAllowed(web, bad), false, bad);
  }
});

test("the panel's DevTools and clear-data commands are typed, and nothing else rides along", () => {
  const tab = "11111111-1111-4111-8111-111111111111";
  for (const command of [{ type: "devtools", tab }, { type: "clear-data" }, { type: "clear-data", tab }]) {
    assert.equal(browserCommand.safeParse(command).success, true, JSON.stringify(command));
  }
  for (const command of [{ type: "devtools" }, { type: "devtools", tab: "x" }, { type: "devtools", tab, url: "devtools://x" }, { type: "clear-data", tab: "x" },
    { type: "clear-data", profile: "other" }, { type: "clear-data", tab, all: true }]) {
    assert.equal(browserCommand.safeParse(command).success, false, JSON.stringify(command));
  }
});
