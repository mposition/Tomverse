import assert from "node:assert/strict";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { nodeExecutable, resolveMiniMaxInstall } from "../src/host/minimax-install";
import { createProviderCliHost } from "../src/host/provider-cli-host";
import { cliPathStillMatches, supportsCliPath } from "../src/host/provider-cli-path";

const windows = process.platform === "win32";
const nodeName = windows ? "node.exe" : "node";

/** MiniMax Code as its installer lays it out: a launcher, the `current` version file, and the package under releases/<version>. */
async function install(root: string, version = "0.8.0") {
  const pkg = join(root, "releases", version, "node_modules", "@minimax-ai", "code");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "cli.js"), "// the entry file\n");
  await writeFile(join(root, "current"), version);
  await writeFile(join(root, "mcode.cmd"), "@echo off\r\nnode cli.js %*\r\n");
  await writeFile(join(root, "mcode"), "#!/bin/sh\nexec node cli.js \"$@\"\n");
  return { root, entry: join(pkg, "cli.js") };
}

async function copyNode(directory: string) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, nodeName);
  await copyFile(process.execPath, file);
  if (!windows) await chmod(file, 0o755);
  return file;
}

async function world() {
  const base = await mkdtemp(join(tmpdir(), "tomverse-minimax-"));
  const home = join(base, "home");
  const bin = join(base, "bin");
  await mkdir(home, { recursive: true });
  return { base, home, bin, root: join(home, ".minimax-code") };
}

test("An install folder is found from its root or from one release, and only when its entry file stays inside it", async () => {
  const w = await world();
  try {
    const { root, entry } = await install(w.root);
    const found = await resolveMiniMaxInstall(root);
    assert.deepEqual(found, { root: await realpath(root), entry: await realpath(entry) });
    assert.deepEqual(await resolveMiniMaxInstall(join(root, "releases", "0.8.0")), { root: await realpath(join(root, "releases", "0.8.0")), entry: await realpath(entry) });
    // Not an install: an empty folder, a file, a missing path, a `current` file that names no version or a release that is not there.
    const empty = join(w.base, "empty");
    await mkdir(empty);
    assert.equal(await resolveMiniMaxInstall(empty), null);
    assert.equal(await resolveMiniMaxInstall(entry), null);
    assert.equal(await resolveMiniMaxInstall(join(w.base, "missing")), null);
    await writeFile(join(root, "current"), "../../escape");
    assert.equal(await resolveMiniMaxInstall(root), null);
    await writeFile(join(root, "current"), "9.9.9");
    assert.equal(await resolveMiniMaxInstall(root), null);
    await writeFile(join(root, "current"), "x".repeat(200));
    assert.equal(await resolveMiniMaxInstall(root), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A package folder that is a link leading out of the install folder is not an install", async (t) => {
  const w = await world();
  try {
    const { root, entry } = await install(w.root);
    const outside = join(w.base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "cli.js"), "// elsewhere" + String.fromCharCode(10));
    const pkg = dirname(entry);
    await rm(pkg, { recursive: true, force: true });
    try { await symlink(outside, pkg, windows ? "junction" : "dir"); } catch { t.skip("This system does not allow links."); return; }
    assert.equal(await resolveMiniMaxInstall(root), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("Node is a real executable from the install folder or the folders the scan looks in, never a script", async () => {
  const w = await world();
  try {
    const bin = await copyNode(w.bin);
    const platform = process.platform;
    assert.equal(await nodeExecutable([w.bin], w.root, platform), await realpath(bin));
    // The install's own Node comes first.
    const own = await copyNode(w.root);
    assert.equal(await nodeExecutable([w.bin], w.root, platform), await realpath(own));
    // A script named node is not Node.
    const scripts = join(w.base, "scripts");
    await mkdir(scripts);
    await writeFile(join(scripts, nodeName), "#!/bin/sh\necho hi\n");
    assert.equal(await nodeExecutable([scripts], join(w.base, "none"), platform), null);
    assert.equal(await nodeExecutable([join(w.base, "missing")], join(w.base, "none"), platform), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("The scan offers the install folder, trusting it records its entry file, and the saved folder runs that file with the person's Node", { timeout: 90_000, skip: !supportsCliPath("minimax") }, async () => {
  const w = await world();
  try {
    const { root, entry } = await install(w.root);
    const node = await copyNode(w.bin);
    const host = createProviderCliHost({
      trustPath: () => join(w.base, "trust.json"), writeTrust: (path, text) => writeFileSync(path, text), hasSaved: () => true,
      typeIntoTerminal: () => "opened", shell: () => (windows ? "powershell" : "posix"),
      scan: { env: { PATH: w.bin, HOME: w.home, USERPROFILE: w.home, SystemRoot: process.env.SystemRoot }, home: w.home },
      run: async () => ({ code: 1, output: "", timedOut: false }),
    });
    const candidates = async () => (await host.scan()).providers.find(({ provider }) => provider === "minimax")?.candidates ?? [];
    const [offered] = await candidates();
    assert.ok(offered, "the install folder is offered");
    assert.equal(await realpath(offered.path), await realpath(root));
    assert.equal(offered.status, "versionUnverified");
    assert.equal(offered.trusted, false);
    assert.equal(await host.resolveSaved("minimax", { path: root, status: "userTrusted" }), null, "a folder nobody trusted does not run");

    // Trusting is by the entry file; an empty folder cannot be trusted.
    assert.equal(await host.trust("minimax", root), "stored");
    assert.deepEqual(await host.trust("minimax", w.bin), { status: "checkFailed" });
    assert.equal((await candidates())[0]!.trusted, true);
    const trusted = await host.trustedFile("minimax", root);
    assert.equal(trusted?.file, await realpath(entry));
    assert.equal(await cliPathStillMatches("minimax", root, trusted!), true);
    const resolved = await host.resolveSaved("minimax", { path: root, status: "userTrusted" });
    assert.deepEqual(resolved, { file: await realpath(node), version: null, basis: "person", args: [await realpath(entry)] });

    // Changing the entry file ends the trust.
    await appendFile(entry, "// changed\n");
    assert.equal(await host.resolveSaved("minimax", { path: root, status: "userTrusted" }), null);
    assert.equal(await cliPathStillMatches("minimax", root, trusted!), false);
    assert.equal((await candidates())[0]!.trusted, false);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A trusted MiniMax Code install with no Node to run it does not start", { timeout: 90_000, skip: !supportsCliPath("minimax") || !windows }, async () => {
  const w = await world();
  try {
    const { root } = await install(w.root);
    await mkdir(w.bin, { recursive: true });
    const host = createProviderCliHost({
      trustPath: () => join(w.base, "trust.json"), writeTrust: (path, text) => writeFileSync(path, text), hasSaved: () => true,
      typeIntoTerminal: () => "opened", shell: () => "posix", scan: { env: { PATH: w.bin, HOME: w.home, USERPROFILE: w.home }, home: w.home },
      run: async () => ({ code: 1, output: "", timedOut: false }),
    });
    assert.equal(await host.trust("minimax", root), "stored");
    assert.equal(await host.resolveSaved("minimax", { path: root, status: "userTrusted" }), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
