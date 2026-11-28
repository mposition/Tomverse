import assert from "node:assert/strict";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { installManifest, modulesAbove, nodeExecutable, resolveMiniMaxInstall } from "../src/host/minimax-install";
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
    assert.deepEqual(found, { root: await realpath(root), entry: await realpath(entry), release: await realpath(join(root, "releases", "0.8.0")) });
    assert.deepEqual(await resolveMiniMaxInstall(join(root, "releases", "0.8.0")), { root: await realpath(join(root, "releases", "0.8.0")), entry: await realpath(entry), release: await realpath(join(root, "releases", "0.8.0")) });
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

    // A launcher or the entry file picked directly is not an install: it is refused, so it never reaches the model list.
    for (const file of [join(root, "mcode.cmd"), join(root, "mcode"), entry, join(w.base, "missing")]) {
      // A Windows launcher is refused as a shim before it is looked at; the others as a file that is not an install folder.
      const refused = await host.trust("minimax", file);
      assert.ok(typeof refused === "object" && (refused.status === "wrongFile" || refused.status === "windowsShim" || refused.status === "fileMissing"), `${file}: ${JSON.stringify(refused)}`);
      assert.equal(await host.trustedFile("minimax", file), null, file);
      assert.equal(await host.resolveSaved("minimax", { path: file, status: "userTrusted" }), null, file);
    }

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
    // With no Node to run it there is nothing to trust: the install is not trusted, and it does not start.
    assert.deepEqual(await host.trust("minimax", root), { status: "checkFailed" });
    assert.equal(await host.trustedFile("minimax", root), null);
    assert.equal(await host.resolveSaved("minimax", { path: root, status: "userTrusted" }), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A Node installed as a link (Homebrew) is found through the link and run as its real file", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "mm-node-link-"));
  try {
    const name = process.platform === "win32" ? "node.exe" : "node";
    await mkdir(join(base, "cellar"), { recursive: true });
    await mkdir(join(base, "bin"), { recursive: true });
    const real = join(base, "cellar", name);
    await writeFile(real, Buffer.from(process.platform === "win32" ? "MZ\0\0" : "\x7fELF"));
    try { await symlink(real, join(base, "bin", name), "file"); } catch { t.skip("this system cannot create a file link"); return; }
    assert.equal(await nodeExecutable([join(base, "bin")], join(base, "missing-root")), await realpath(real));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("The Node that runs a MiniMax Code install is trusted with it: another Node, or the same one changed, does not run", { timeout: 90_000, skip: !supportsCliPath("minimax") }, async () => {
  const w = await world();
  try {
    const { root, entry } = await install(w.root);
    const node = await copyNode(w.bin);
    const trustPath = join(w.base, "trust.json");
    const hostFor = (path: string) => createProviderCliHost({
      trustPath: () => trustPath, writeTrust: (file, text) => writeFileSync(file, text), hasSaved: () => true, typeIntoTerminal: () => "opened",
      shell: () => (windows ? "powershell" : "posix"), scan: { env: { PATH: path, HOME: w.home, USERPROFILE: w.home, SystemRoot: process.env.SystemRoot }, home: w.home },
      run: async () => ({ code: 1, output: "", timedOut: false }),
    });
    const saved = { path: root, status: "userTrusted" } as const;
    const host = hostFor(w.bin);
    assert.equal(await host.trust("minimax", root), "stored");
    const record = JSON.parse(readFileSync(trustPath, "utf8")).trusted.minimax as { path: string; node?: { path: string; size: number; sha256: string } };
    assert.equal(record.path, await realpath(entry));
    assert.equal(record.node?.path, await realpath(node));
    assert.match(record.node?.sha256 ?? "", /^[0-9a-f]{64}$/);
    const runs = async (h: typeof host) => (await h.resolveSaved("minimax", saved))?.file ?? null;
    assert.equal(await runs(host), await realpath(node));

    // Another Node first in the folders that are looked in (the PATH changed): not the one that was trusted.
    const other = await copyNode(join(w.base, "other-bin"));
    const reordered = hostFor([join(w.base, "other-bin"), w.bin].join(delimiter));
    assert.equal(await runs(reordered), null);
    assert.equal(await reordered.trustedFile("minimax", root), null);
    assert.equal((await reordered.scan()).providers.find(({ provider }) => provider === "minimax")?.candidates[0]?.trusted, false);
    // Trusting again binds the new one; the first is then the one that is refused.
    assert.equal(await reordered.trust("minimax", root), "stored");
    assert.equal(await runs(reordered), await realpath(other));
    assert.equal(await runs(host), null);
    assert.equal(await host.trust("minimax", root), "stored");
    assert.equal(await runs(host), await realpath(node));

    // The same Node with other bytes is not the one that was trusted either.
    await appendFile(node, "x");
    assert.equal(await runs(host), null);
    assert.equal((await host.scan()).providers.find(({ provider }) => provider === "minimax")?.candidates[0]?.trusted, false);

    // A Node inside the install folder comes first, and is bound the same way.
    const own = await copyNode(root);
    assert.equal(await host.trust("minimax", root), "stored");
    assert.equal(await runs(host), await realpath(own));
    await appendFile(own, "y");
    assert.equal(await runs(host), null);
    // A record from before (the entry file only, no Node) does not run.
    const { path, size, sha256 } = JSON.parse(readFileSync(trustPath, "utf8")).trusted.minimax as { path: string; size: number; sha256: string };
    writeFileSync(trustPath, JSON.stringify({ trusted: { minimax: { path, size, sha256 } } }));
    assert.equal(await runs(host), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("The release folder's digest covers every file, and a link, a change or a missing folder makes it unusable", async (t) => {
  const w = await world();
  try {
    const { root, entry } = await install(w.root);
    const release = (await resolveMiniMaxInstall(root))!.release;
    const dependency = join(release, "node_modules", "left-pad", "index.js");
    await mkdir(dirname(dependency), { recursive: true });
    await writeFile(dependency, "module.exports = 1;");
    await writeFile(join(release, "empty.bin"), "");
    const first = await installManifest(release);
    assert.ok(first);
    assert.equal(first.files, 3);
    assert.equal(first.bytes, (await readFile(entry)).length + "module.exports = 1;".length);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    // The same files read one at a time or many at a time, and again, give the same digest.
    assert.deepEqual(await installManifest(release, { concurrency: 1 }), first);
    assert.deepEqual(await installManifest(release, { concurrency: 32 }), first);
    // Any change to what the entry file can load changes it: a dependency's bytes, a new file, a removed file, a renamed file.
    await appendFile(dependency, " ");
    assert.notEqual((await installManifest(release))?.sha256, first.sha256);
    await writeFile(dependency, "module.exports = 1;");
    assert.deepEqual(await installManifest(release), first);
    await writeFile(join(release, "added.js"), "x");
    assert.notEqual((await installManifest(release))?.sha256, first.sha256);
    await rm(join(release, "added.js"));
    await rm(join(release, "empty.bin"));
    assert.notEqual((await installManifest(release))?.sha256, first.sha256);
    await writeFile(join(release, "empty.bin"), "");
    assert.deepEqual(await installManifest(release), first);
    await rename(dependency, join(dirname(dependency), "other.js"));
    assert.notEqual((await installManifest(release))?.sha256, first.sha256);
    await rename(join(dirname(dependency), "other.js"), dependency);
    // Not a folder that can be read whole: missing, a file, relative.
    assert.equal(await installManifest(join(w.base, "missing")), null);
    assert.equal(await installManifest(entry), null);
    assert.equal(await installManifest("releases/0.8.0"), null);
    // A link or junction anywhere in it is refused whole, whatever it leads to; so is the folder reached through one.
    const outside = join(w.base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "x.js"), "x");
    try { await symlink(outside, join(release, "node_modules", "linked"), windows ? "junction" : "dir"); } catch { t.skip("This system does not allow links."); return; }
    assert.equal(await installManifest(release), null);
    await rm(join(release, "node_modules", "linked"), { recursive: false, force: true });
    assert.deepEqual(await installManifest(release), first);
    const through = join(w.base, "through");
    await symlink(release, through, windows ? "junction" : "dir");
    assert.equal(await installManifest(through), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A MiniMax Code install is trusted as a whole: a change anywhere in its release folder means it is trusted again", { timeout: 90_000, skip: !supportsCliPath("minimax") }, async () => {
  const w = await world();
  try {
    const { root, entry } = await install(w.root);
    const release = (await resolveMiniMaxInstall(root))!.release;
    const dependency = join(release, "node_modules", "left-pad", "index.js");
    await mkdir(dirname(dependency), { recursive: true });
    await writeFile(dependency, "module.exports = 1;");
    await copyNode(w.bin);
    const trustPath = join(w.base, "trust.json");
    const host = createProviderCliHost({
      trustPath: () => trustPath, writeTrust: (file, text) => writeFileSync(file, text), hasSaved: () => true, typeIntoTerminal: () => "opened",
      shell: () => (windows ? "powershell" : "posix"), scan: { env: { PATH: w.bin, HOME: w.home, USERPROFILE: w.home, SystemRoot: process.env.SystemRoot }, home: w.home },
      run: async () => ({ code: 1, output: "", timedOut: false }),
    });
    const saved = { path: root, status: "userTrusted" } as const;
    const candidate = async () => (await host.scan()).providers.find(({ provider }) => provider === "minimax")?.candidates[0];
    const recorded = () => JSON.parse(readFileSync(trustPath, "utf8")).trusted.minimax as Record<string, unknown> & { install?: { sha256: string; files: number; bytes: number } };
    assert.equal(await host.trust("minimax", root), "stored");
    assert.deepEqual(recorded().install, await installManifest(release));
    assert.equal(recorded().install?.files, 2);
    assert.ok(await host.resolveSaved("minimax", saved));
    assert.equal((await candidate())?.trusted, true);

    // A dependency of the entry file changes, a file is added, a file is removed: not what was trusted.
    await appendFile(dependency, "// changed");
    assert.equal(await host.resolveSaved("minimax", saved), null);
    assert.equal(await host.trustedFile("minimax", root), null);
    assert.equal((await candidate())?.trusted, false);
    await writeFile(dependency, "module.exports = 1;");
    assert.ok(await host.resolveSaved("minimax", saved), "the same bytes again are the trusted ones");
    await writeFile(join(release, "node_modules", "left-pad", "extra.js"), "x");
    assert.equal(await host.resolveSaved("minimax", saved), null);
    await rm(join(release, "node_modules", "left-pad", "extra.js"));
    await rm(dependency);
    assert.equal(await host.resolveSaved("minimax", saved), null);
    // Trusting again records the folder as it is now.
    await writeFile(dependency, "module.exports = 2;");
    assert.equal(await host.trust("minimax", root), "stored");
    assert.ok(await host.resolveSaved("minimax", saved));
    // The entry file itself, as before.
    await appendFile(entry, "// changed");
    assert.equal(await host.resolveSaved("minimax", saved), null);
    // A record from before this check (no digest of the folder) does not run.
    assert.equal(await host.trust("minimax", root), "stored");
    const { install: digest, ...withoutDigest } = recorded();
    assert.ok(digest);
    writeFileSync(trustPath, JSON.stringify({ trusted: { minimax: withoutDigest } }));
    assert.equal(await host.resolveSaved("minimax", saved), null);
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A node_modules above the release folder, of any kind, is found; so are the user module folders of the home folder", async (t) => {
  const w = await world();
  try {
    const { root } = await install(w.root);
    const release = (await resolveMiniMaxInstall(root))!.release;
    assert.equal(await modulesAbove(release), null);
    assert.equal(await modulesAbove(release, w.home), null);
    // A folder, a file and a link at each level between the release and the root of the drive count.
    const levels = [join(root, "releases"), root, w.home, w.base];
    for (const level of levels) {
      const folder = join(level, "node_modules");
      await mkdir(folder);
      assert.equal(await modulesAbove(release), folder, level);
      await rm(folder, { recursive: true });
      await writeFile(folder, "not a folder");
      assert.equal(await modulesAbove(release), folder, level);
      await rm(folder);
      assert.equal(await modulesAbove(release), null, level);
    }
    const target = join(w.base, "somewhere");
    await mkdir(target);
    try {
      await symlink(target, join(root, "node_modules"), windows ? "junction" : "dir");
      assert.equal(await modulesAbove(release), join(root, "node_modules"));
      await rm(join(root, "node_modules"), { recursive: false, force: true });
    } catch { t.diagnostic("This system does not allow links."); }
    // Inside the release folder is covered by its digest, not a reason of its own.
    await mkdir(join(release, "node_modules", "x"), { recursive: true });
    assert.equal(await modulesAbove(release), null);
    // The per-user module folders of the home folder, when the home folder is given.
    for (const name of [".node_modules", ".node_libraries"]) {
      await mkdir(join(w.home, name));
      assert.equal(await modulesAbove(release, w.home), join(w.home, name));
      assert.equal(await modulesAbove(release), null);
      await rm(join(w.home, name), { recursive: true });
    }
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A MiniMax Code install with modules above its release folder is not trusted, and one trusted before stops running", { timeout: 90_000, skip: !supportsCliPath("minimax") }, async () => {
  const w = await world();
  try {
    const { root } = await install(w.root);
    await copyNode(w.bin);
    const trustPath = join(w.base, "trust.json");
    const host = createProviderCliHost({
      trustPath: () => trustPath, writeTrust: (file, text) => writeFileSync(file, text), hasSaved: () => true, typeIntoTerminal: () => "opened",
      shell: () => (windows ? "powershell" : "posix"), scan: { env: { PATH: w.bin, HOME: w.home, USERPROFILE: w.home, SystemRoot: process.env.SystemRoot }, home: w.home },
      run: async () => ({ code: 1, output: "", timedOut: false }),
    });
    const saved = { path: root, status: "userTrusted" } as const;
    const candidate = async () => (await host.scan()).providers.find(({ provider }) => provider === "minimax")?.candidates[0];
    // Not trusted while a node_modules is above the release: the person is told why, and nothing is recorded.
    for (const above of [join(root, "releases", "node_modules"), join(w.home, "node_modules"), join(w.base, "node_modules")]) {
      await mkdir(above);
      assert.deepEqual(await host.trust("minimax", root), { status: "modulesAbove" }, above);
      assert.equal(await host.trustedFile("minimax", root), null);
      await rm(above, { recursive: true });
    }
    await mkdir(join(w.home, ".node_modules"));
    assert.deepEqual(await host.trust("minimax", root), { status: "modulesAbove" });
    await rm(join(w.home, ".node_modules"), { recursive: true });
    assert.throws(() => readFileSync(trustPath, "utf8"), { code: "ENOENT" });

    // Trusted when there is none; one that appears later stops the install from running, and trust is offered again when it is gone.
    assert.equal(await host.trust("minimax", root), "stored");
    assert.ok(await host.resolveSaved("minimax", saved));
    assert.equal((await candidate())?.trusted, true);
    await mkdir(join(w.home, "node_modules"));
    assert.equal(await host.resolveSaved("minimax", saved), null);
    assert.equal(await host.trustedFile("minimax", root), null);
    assert.equal((await candidate())?.trusted, false);
    await rm(join(w.home, "node_modules"), { recursive: true });
    assert.ok(await host.resolveSaved("minimax", saved));
  } finally { await rm(w.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
