import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tarOf, zipOf } from "../../tomverse-cli/tests/archiveBuilders";
import { createPluginsHost } from "../src/host/plugins-host";
import { githubGitAuth } from "../src/host/plugin-github-auth";
import type { GhRunner } from "../src/host/github-cli";
import type { PluginsCommand } from "../src/plugins-contract";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `tvdesk-${name}-`));
const json = (value: unknown) => JSON.stringify(value);
const pluginItems = (prefix: string, version: string) => [
  { name: `${prefix}.claude-plugin/plugin.json`, data: json({ name: "demo", version }) },
  { name: `${prefix}skills/greet/SKILL.md`, data: "---\ndescription: Greet\n---\nHello\n" },
  { name: `${prefix}hooks/hooks.json`, data: json({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }) },
];

type Setup = { sources?: boolean; zip?: string | null; confirm?: boolean };

/** A host over a temporary Tomverse folder, with the network replaced by what each test serves. */
function setup(options: Setup = {}) {
  const home = temp("plugin-home");
  const asked: Array<{ address: string; kind: string }> = [];
  const requested: string[] = [];
  const serve = new Map<string, () => Response>();
  let sources = options.sources ?? true;
  const host = createPluginsHost({
    home: () => home,
    pickFolder: async () => null,
    pickZip: async () => options.zip ?? null,
    confirmFetch: async (address, kind) => { asked.push({ address, kind }); return options.confirm ?? true; },
    sources: () => sources,
    fetchImpl: async (url) => {
      requested.push(url);
      const route = [...serve].find(([prefix]) => url.startsWith(prefix));
      return route ? route[1]() : new Response("missing", { status: 404 });
    },
  });
  const reply = (command: PluginsCommand) => host.reply(command, null);
  return { home, host, reply, asked, requested, serve, setSources: (on: boolean) => { sources = on; } };
}

test("with the server's switch off, the new sources and the official marketplace are refused and nothing is downloaded or added", async () => {
  const { reply, requested, asked, home } = setup({ sources: false, zip: "C:/x/demo.zip" });
  const listed = await reply({ type: "list" });
  assert.equal(listed.sources, false);
  assert.equal(listed.official, undefined);
  assert.deepEqual(listed.marketplaces, [], "the official marketplace is not added");
  for (const command of [{ type: "preview-zip" }, { type: "preview-zip-url", url: "https://files.example.com/a.zip" }, { type: "preview-npm", package: "demo" }, { type: "set-official-marketplace", enabled: true }] as const) {
    const view = await reply(command);
    assert.match(view.error ?? "", /not available/, command.type);
    assert.equal(view.preview, undefined);
  }
  assert.deepEqual([requested, asked], [[], []]);
  assert.equal(existsSync(join(home, "plugins", "builtin")), false);
});

test("the official marketplace is added once the switch is on, can be turned off and stays off, and a marketplace of the same name from elsewhere is not taken for it", async () => {
  const { reply, setSources, home } = setup();
  const first = await reply({ type: "list" });
  assert.equal(first.sources, true);
  assert.deepEqual(first.official, { enabled: true });
  assert.deepEqual(first.marketplaces.map((market) => [market.name, market.official, market.entries.length]), [["tomverse", true, 0]]);
  assert.equal(JSON.parse(readFileSync(join(home, "plugins", "builtin", "tomverse", ".claude-plugin", "marketplace.json"), "utf8")).name, "tomverse");

  const off = await reply({ type: "set-official-marketplace", enabled: false });
  assert.deepEqual([off.official, off.marketplaces], [{ enabled: false }, []]);
  assert.deepEqual((await reply({ type: "list" })).marketplaces, [], "it is not added again");
  const on = await reply({ type: "set-official-marketplace", enabled: true });
  assert.deepEqual(on.marketplaces.map((market) => market.name), ["tomverse"]);
  // Removing it with the ordinary button is the same as turning it off.
  const removed = await reply({ type: "marketplace-remove", name: "tomverse" });
  assert.deepEqual([removed.official, removed.marketplaces], [{ enabled: false }, []]);
  assert.deepEqual((await reply({ type: "list" })).marketplaces, []);

  // The switch going off later hides the choice, and nothing is added.
  await reply({ type: "set-official-marketplace", enabled: true });
  setSources(false);
  assert.equal((await reply({ type: "list" })).official, undefined);
});

test("a marketplace the person added under the official name keeps its place and is not marked official", async () => {
  const folder = temp("own-marketplace");
  mkdirSync(join(folder, ".claude-plugin"), { recursive: true });
  writeFileSync(join(folder, ".claude-plugin", "marketplace.json"), json({ name: "tomverse", plugins: [{ name: "mine", source: "./mine" }] }));
  const home = temp("own-home");
  const host = createPluginsHost({ home: () => home, pickFolder: async () => folder, pickZip: async () => null, confirmFetch: async () => true, sources: () => true });
  const added = await host.reply({ type: "marketplace-add-folder" }, null);
  assert.deepEqual(added.marketplaces.map((market) => [market.name, market.official ?? false, market.entries.length]), [["tomverse", false, 1]]);
  const listed = await host.reply({ type: "list" }, null);
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.marketplaces.map((market) => [market.name, market.official ?? false]), [["tomverse", false]]);
});

test("a zip file the person picked is shown with its SHA-256 and the digest being confirmed, and is installed only after the confirmation", async () => {
  const bytes = zipOf(pluginItems("demo-main/", "1.0.0"));
  const zip = join(temp("zip"), "demo.zip");
  writeFileSync(zip, bytes);
  const { reply, home, asked } = setup({ zip });
  const view = await reply({ type: "preview-zip" });
  assert.equal(view.error, undefined);
  assert.equal(view.preview?.name, "demo");
  assert.deepEqual(view.preview?.origin, { kind: "zip", value: createHash("sha256").update(bytes).digest("hex") });
  assert.match(view.preview?.approval ?? "", /^[0-9a-f]{16}$/);
  assert.equal(view.preview?.hooks.length, 1);
  assert.deepEqual(asked, [], "a file on this computer is not a download");
  assert.equal(existsSync(join(home, "plugins", "installed", "demo")), false);
  assert.match((await reply({ type: "confirm", id: "0".repeat(16) })).error ?? "", /no longer current/);
  const done = await reply({ type: "confirm", id: view.preview!.id });
  assert.equal(done.notice?.code, "installed");
  assert.deepEqual(done.plugins.map((plugin) => [plugin.name, plugin.from.kind, plugin.pending]), [["demo", "zip", 1]], "its hook waits for approval");
});

test("a zip address and an npm package are named to the person before any download; refusing downloads nothing", async () => {
  const { reply, requested, asked, setSources } = setup({ confirm: false });
  const zip = await reply({ type: "preview-zip-url", url: "https://files.example.com/demo.zip?token=SECRET" });
  assert.equal(zip.notice?.code, "cancelled");
  const npm = await reply({ type: "preview-npm", package: "@acme/demo-plugin", version: "1.0.0" });
  assert.equal(npm.notice?.code, "cancelled");
  assert.deepEqual(asked, [{ address: "https://files.example.com/demo.zip", kind: "zip" }, { address: "https://registry.npmjs.org/@acme/demo-plugin", kind: "npm" }]);
  assert.deepEqual(requested, []);
  assert.doesNotMatch(JSON.stringify(asked), /SECRET/, "a signature in the query is not shown");
  setSources(true);
});

test("an npm package is looked up, checked against its integrity and shown with it; the confirmation installs the files and nothing runs", async () => {
  const tarball = tarOf(pluginItems("package/", "1.2.0").map((item) => ({ name: item.name, data: item.data })));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const { reply, serve, requested, asked, home } = setup();
  serve.set("https://registry.npmjs.org/@acme%2Fdemo-plugin/1.2.0", () => Response.json({ name: "@acme/demo-plugin", version: "1.2.0", dist: { integrity, tarball: "https://registry.npmjs.org/@acme/demo-plugin/-/demo-plugin-1.2.0.tgz" } }));
  serve.set("https://registry.npmjs.org/@acme/demo-plugin/-/", () => new Response(tarball, { status: 200 }));
  const view = await reply({ type: "preview-npm", package: "@acme/demo-plugin", version: "1.2.0" });
  assert.equal(view.error, undefined);
  assert.deepEqual(asked, [{ address: "https://registry.npmjs.org/@acme/demo-plugin", kind: "npm" }]);
  assert.equal(view.preview?.from, "npm:@acme/demo-plugin@1.2.0");
  assert.deepEqual(view.preview?.origin, { kind: "npm", value: integrity, detail: "@acme/demo-plugin@1.2.0" });
  assert.equal(view.preview?.version, "1.2.0");
  assert.equal(requested.length, 2);
  const done = await reply({ type: "confirm", id: view.preview!.id });
  assert.deepEqual(done.plugins.map((plugin) => [plugin.name, plugin.from]), [["demo", { kind: "npm", package: "@acme/demo-plugin" }]]);
  assert.equal(existsSync(join(home, "plugins", "installed", "demo", "hooks", "hooks.json")), true);
});

test("a package with the wrong integrity is not installed, and the refusal is shown in plain words", async () => {
  const tarball = tarOf(pluginItems("package/", "1.0.0").map((item) => ({ name: item.name, data: item.data })));
  const { reply, serve, home } = setup();
  serve.set("https://registry.npmjs.org/demo/1.0.0", () => Response.json({ name: "demo", version: "1.0.0", dist: { integrity: `sha512-${createHash("sha512").update("other").digest("base64")}`, tarball: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz" } }));
  serve.set("https://registry.npmjs.org/demo/-/", () => new Response(tarball, { status: 200 }));
  const view = await reply({ type: "preview-npm", package: "demo", version: "1.0.0" });
  assert.match(view.error ?? "", /does not match its integrity/);
  assert.equal(view.preview, undefined);
  assert.equal(existsSync(join(home, "plugins", "installed")), false);
});

test("the window cannot ask for a range, a tag or a name that is not an npm package name", () => {
  // The contract is checked by the host's IPC parser; it is imported here so a loosened rule fails this test.
  return import("../src/plugins-contract").then(({ pluginsCommand }) => {
    assert.ok(pluginsCommand.safeParse({ type: "preview-npm", package: "demo", version: "1.2.3" }).success);
    for (const version of ["^1.2.3", "latest", "1.x", ">=1"]) assert.equal(pluginsCommand.safeParse({ type: "preview-npm", package: "demo", version }).success, false, version);
    for (const name of ["../x", "Demo", "a b", "", "https://x.test/p"]) assert.equal(pluginsCommand.safeParse({ type: "preview-npm", package: name }).success, false, name);
    assert.equal(pluginsCommand.safeParse({ type: "preview-zip", path: "C:/x.zip" }).success, false, "a path never comes from the window");
  });
});

/* ------------------------------------------------------------------ the GitHub sign-in */

const runner = (code: number | null): GhRunner => async () => ({ code, stdout: "", stderr: "" });

test("a private repository is read with the GitHub CLI's own sign-in: the command names gh, and no token is ever in it", async () => {
  const auth = await githubGitAuth({ run: runner(0), program: "C:\\Program Files\\GitHub CLI\\gh.exe", env: { GH_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", GH_CONFIG_DIR: "C:/cfg", SECRET_OTHER: "x", PATH: "/bin" } });
  assert.equal(auth.credentialHelper, "!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential");
  assert.doesNotMatch(JSON.stringify(auth.credentialHelper), /ghp_/);
  assert.deepEqual(Object.keys(auth.env).sort(), ["GH_CONFIG_DIR", "GH_TOKEN"], "only the settings gh itself reads are passed along");
  await assert.rejects(() => githubGitAuth({ run: runner(1), program: "/usr/bin/gh" }), /not signed in to GitHub/);
  await assert.rejects(() => githubGitAuth({ run: runner(null), program: "/usr/bin/gh" }), /not installed/);
  await assert.rejects(() => githubGitAuth({ run: null, program: null }), /not installed/);
  await assert.rejects(() => githubGitAuth({ run: runner(0), program: "/home/o'brien/bin/gh" }), /cannot use for sign-in/);
});
