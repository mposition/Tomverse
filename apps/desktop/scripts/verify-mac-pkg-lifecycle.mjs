import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { inspectAppArchive, inspectMacPayload, inspectPackagedFuses, sha256File } from "./package-payload.mjs";

const { values } = parseArgs({ options: {
  previous: { type: "string" }, update: { type: "string" }, disposable: { type: "boolean" },
} });
assert.ok(process.platform === "darwin" && ["x64", "arm64"].includes(process.arch),
  "Run on an Intel or Apple Silicon Mac.");
assert.ok(values.disposable && values.previous && values.update && process.getuid() !== 0,
  "From a disposable Mac user session, provide --disposable --previous and --update .pkg files without sudo.");

const name = "Tomverse Desktop";
const id = "app.tomverse.desktop";
const bundleName = name + ".app";
const application = join("/Applications", bundleName);
const executableInBundle = join("Contents", "MacOS", name);
const asarInBundle = join("Contents", "Resources", "app.asar");
const exec = promisify(execFile);
const run = (file, args, timeout = 30_000) => exec(file, args, { timeout });
const admin = (file, ...args) => run("/usr/bin/sudo", ["-n", file, ...args], 120_000);
const pkgutil = (...args) => run("/usr/sbin/pkgutil", args, 120_000);
const codesign = (bundle) => run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], 120_000);

async function hasPath(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function hasReceipt() {
  const { stdout } = await pkgutil("--pkgs");
  return stdout.split(/\r?\n/).includes(id);
}

if (process.arch === "x64") {
  const { stdout: translated } = await run("/usr/bin/arch", ["-x86_64", "/usr/sbin/sysctl", "-in", "sysctl.proc_translated"]);
  assert.notEqual(translated.trim(), "1", "Use an Intel test Mac for the x64 package.");
}
assert.ok(!await hasPath(application) && !await hasReceipt(),
  "Use a disposable Mac with no existing Tomverse Desktop install or receipt.");
assert.ok(!await hasPath(join(homedir(), "Library", "Application Support", name)),
  "Use a disposable Mac user with no existing Tomverse Desktop profile.");

const scratch = await mkdtemp(join(tmpdir(), "tomverse-mac-lifecycle-"));
console.error(`Lifecycle evidence directory: ${scratch}`);
const profile = join(scratch, "profile");
await mkdir(profile);
const language = join(profile, "language.txt");
const bounds = join(profile, "window-bounds.json");
await writeFile(language, "de");

async function readCandidate(input, label) {
  const source = resolve(input);
  assert.ok(extname(source) === ".pkg" && (await lstat(source)).isFile(), "Provide a local Desktop component .pkg.");
  const filename = join(scratch, `${label}.pkg`);
  await copyFile(source, filename);
  const sha256 = await sha256File(filename);
  const expanded = join(scratch, label);
  await pkgutil("--expand-full", filename, expanded);
  const metadata = join(expanded, "PackageInfo");
  assert.ok((await lstat(metadata)).isFile(), "The installer must have a regular PackageInfo file.");
  const xpath = async (expression) =>
    (await run("/usr/bin/xmllint", ["--nonet", "--xpath", expression, metadata])).stdout.trim();
  assert.equal(await xpath("string(/pkg-info/@identifier)"), id);
  assert.equal(await xpath("string(/pkg-info/@install-location)"), "/Applications");
  assert.equal(await xpath("count(/pkg-info/scripts/*)"), "0", "The component package must not run installer scripts.");
  assert.ok(!await hasPath(join(expanded, "Scripts")), "Unexpected installer scripts.");
  const payload = join(expanded, "Payload");
  assert.ok((await lstat(payload)).isDirectory(), "The installer must contain a single app payload directory.");
  assert.deepEqual(await readdir(payload), [bundleName], "The package may only install the Tomverse app bundle.");
  const bundle = join(payload, bundleName);
  await inspectMacPayload(bundle, name, process.arch);
  await inspectPackagedFuses(bundle, "darwin");
  await codesign(bundle);
  const archive = join(bundle, asarInBundle);
  const { manifest } = inspectAppArchive(archive);
  const version = await xpath("string(/pkg-info/@version)");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(version, manifest.version);
  return { filename, version, sha256, asarSha256: await sha256File(archive),
    executableSha256: await sha256File(join(bundle, executableInBundle)) };
}

async function assertInstalled(candidate) {
  assert.ok((await lstat(application)).isDirectory(), "Installer did not create the expected app.");
  const { stdout } = await pkgutil("--pkg-info", id);
  assert.ok(stdout.split(/\r?\n/).includes(`version: ${candidate.version}`), "Unexpected installer receipt version.");
  assert.equal(await sha256File(join(application, asarInBundle)), candidate.asarSha256, "Installed ASAR differs from the package.");
  assert.equal(await sha256File(join(application, executableInBundle)), candidate.executableSha256,
    "Installed executable differs from the package.");
  await codesign(application);
}

async function install(candidate) {
  assert.equal(await sha256File(candidate.filename), candidate.sha256, "The package changed after inspection.");
  await admin("/usr/sbin/installer", "-pkg", candidate.filename, "-target", "/");
  await assertInstalled(candidate);
}

async function removeInstalled(candidate, label) {
  await assertInstalled(candidate);
  await admin("/bin/mv", application, join(scratch, `${label}.app`));
  await admin("/usr/sbin/pkgutil", "--forget", id);
  assert.ok(!await hasPath(application) && !await hasReceipt(), "The application or receipt remains after removal.");
}

async function launchInstalled() {
  const previousBounds = await hasPath(bounds) ? await lstat(bounds) : null;
  const child = spawn(join(application, executableInBundle), [`--user-data-dir=${profile}`], { stdio: "ignore" });
  const exited = once(child, "exit");
  void exited.catch(() => {});
  try {
    await once(child, "spawn");
    const deadline = Date.now() + 45_000;
    let shown = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
        ObjC.import('CoreGraphics');
        const windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(
          $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)) || [];
        windows.some(w => w.kCGWindowOwnerPID === ${child.pid} && w.kCGWindowLayer === 0);
      `], 5_000);
      if (stdout.trim() === "true") { shown = true; break; }
      await setTimeout(500);
    }
    assert.ok(shown, "The installed app did not open a visible window.");
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
      ObjC.import('AppKit');
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid});
      app.terminate;
    `], 5_000);
    assert.equal(stdout.trim(), "true", "The installed app did not accept a normal quit request.");
    const result = await Promise.race([exited, setTimeout(10_000, "timeout", { ref: false })]);
    assert.deepEqual(result, [0, null], "The installed app did not quit cleanly.");
    const nextBounds = await lstat(bounds);
    assert.ok(!previousBounds || nextBounds.ino !== previousBounds.ino || nextBounds.mtimeMs > previousBounds.mtimeMs,
      "The installed app did not save window bounds in the disposable profile.");
    const saved = JSON.parse(await readFile(bounds, "utf8"));
    assert.ok(saved.width > 0 && saved.height > 0, "The app wrote invalid window bounds.");
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited.catch(() => {});
    }
  }
}

async function profileHashes() {
  assert.equal(await readFile(language, "utf8"), "de");
  return { windowBounds: await sha256File(bounds), language: await sha256File(language) };
}

const previous = await readCandidate(values.previous, "previous");
const update = await readCandidate(values.update, "update");
assert.ok(update.version.localeCompare(previous.version, "en", { numeric: true }) > 0,
  "Provide two ascending versions of the Desktop package.");
const [{ stdout: macOS }, { stdout: build }] = await Promise.all([
  run("/usr/bin/sw_vers", ["-productVersion"]), run("/usr/bin/sw_vers", ["-buildVersion"]),
]);
await admin("/usr/bin/true");
await install(previous);
await launchInstalled();
const beforeUpdate = await profileHashes();
await install(update);
assert.deepEqual(await profileHashes(), beforeUpdate, "The update changed the existing user profile.");
await launchInstalled();
const beforeReinstall = await profileHashes();
await removeInstalled(update, "removed-before-reinstall");
assert.deepEqual(await profileHashes(), beforeReinstall, "Package removal changed the existing user profile.");
await install(update);
assert.deepEqual(await profileHashes(), beforeReinstall, "Reinstalling changed the existing user profile.");
await launchInstalled();
await removeInstalled(update, "removed-after-test");
const result = { macOS: macOS.trim(), build: build.trim(), kernel: release(), architecture: process.arch, previous, update,
  cleanInstallLaunched: true, updatePreservedProfile: true, uninstallVerified: true, reinstallLaunched: true };
await writeFile(join(scratch, "validation-results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
