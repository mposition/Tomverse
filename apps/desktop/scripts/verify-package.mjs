import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { extractFile } from "@electron/asar";
import {
  inspectAppArchive, inspectMacPayload, inspectPackagedFuses, inspectPortablePayload, inspectWindowsIntegrity, sha256File,
} from "./package-payload.mjs";

const name = "Tomverse Desktop";
const { values } = parseArgs({
  options: { out: { type: "string" }, previous: { type: "string" }, target: { type: "string" }, "cli-path-cases": { type: "string" },
    "cli-protocol-cases": { type: "string" }, "cli-protocol-enabled": { type: "boolean" }, "startup-recovery": { type: "boolean" },
    "auth-enabled": { type: "boolean" } },
});
if (values["cli-path-cases"] && !values.previous) throw new Error("The CLI upgrade test requires the previous portable package.");
if (values["startup-recovery"] && !values.previous) throw new Error("Startup recovery requires a previous Windows portable package.");
const host = `${process.platform}-${process.arch}`;
const target = values.target ?? host;
if (!["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"].includes(target)) throw new Error("Unsupported package target.");
const [platform, arch] = target.split("-");
const nativeWindowSmoke = target === host && platform === "win32";
if (nativeWindowSmoke && values["cli-protocol-enabled"] && !values["cli-protocol-cases"]) {
  throw new Error("Pass the verified CLI paths for the protocol check.");
}
if ((values.previous || values["cli-path-cases"] || values["cli-protocol-cases"] || values["auth-enabled"]) && !nativeWindowSmoke) {
  throw new Error("The portable upgrade and CLI smoke tests require Windows.");
}
const bundle = resolve(values.out ?? "dist/package", `${name}-${target}`);
const appBundle = join(bundle, name + ".app");
const binary = platform === "darwin" ? join(appBundle, "Contents", "MacOS", name)
  : platform === "win32" ? join(bundle, name + ".exe") : join(bundle, name);
const archive = platform === "darwin" ? join(appBundle, "Contents", "Resources", "app.asar")
  : join(bundle, "resources", "app.asar");
const macPayload = platform === "darwin" ? await inspectMacPayload(appBundle, name, arch) : undefined;
await inspectPackagedFuses(platform === "darwin" ? appBundle : binary, platform);
if (platform === "win32") await inspectWindowsIntegrity(binary, archive);
const { manifest, entries: archiveEntries } = inspectAppArchive(archive, { cliProtocolCheck: values["cli-protocol-enabled"] });
const portableFiles = platform === "darwin" ? undefined : await inspectPortablePayload(bundle, platform);
if (platform === "linux") assert.equal(manifest.desktopName, "app.tomverse.desktop.desktop");
const licenses = platform === "darwin" ? dirname(archive) : bundle;
assert.match(await readFile(join(licenses, "LICENSE"), "utf8"), /Copyright.*Electron/i);
assert.match(await readFile(join(licenses, "LICENSES.chromium.html"), "utf8"), /Chromium/);
const notices = await readFile(join(dirname(archive), "THIRD_PARTY_NOTICES.txt"), "utf8");
assert.match(notices, /\bzod@[^\n]+\(MIT\)/);
assert.match(notices, /^## react - .+\(MIT\)$/m);
assert.match(notices, /^## lucide-react - .+\(ISC\)$/m);
assert.match(notices, /Roboto wordmark font[\s\S]*SIL OPEN FONT LICENSE/);
const runner = extractFile(archive, normalize("dist/host/runner-process.cjs"));
assert.ok(runner.includes("Tomverse Code"));
const main = extractFile(archive, normalize("dist/host/main.cjs"));
const fixtureCommand = /start-(?:codex|claude)-fixture/;
const fixtureProfile = /tomverse-(?:codex|claude)-fixture-/;
assert.ok(!fixtureCommand.test(main.toString()) && !fixtureCommand.test(runner.toString()) && !fixtureProfile.test(runner.toString()),
  "Packaged hosts must exclude the development CLI launch paths.");
const icon = extractFile(archive, join("dist", "host", "tomverse-icon.png"));
assert.deepEqual(icon, await readFile("../../public/tomverse-logo.png"));
const windowsIcon = join(dirname(archive), "tomverse-icon.ico");
if (platform === "win32") {
  assert.deepEqual(await readFile(windowsIcon), await readFile("../../app/favicon.ico"));
}
assert.match(extractFile(archive, join("dist", "renderer", "index.html")).toString("utf8"), /<title>Tomverse Desktop<\/title>/);

async function readCliCases(path) {
  const cases = JSON.parse(await readFile(path, "utf8"));
  assert.ok(Array.isArray(cases) && cases.length > 0);
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  for (const entry of cases) {
    assert.ok(/^[a-z]+$/.test(entry.id) && entry.name && isAbsolute(entry.path) && entry.version && entry.pathLabel && entry.verifiedLabel);
    assert.ok(entry.protocolStatus === undefined || entry.protocolStatus === "networkBlocked");
  }
  return cases;
}

async function verifyWindows() {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-package-smoke-"));
  const run = promisify(execFile);
  let child;
  let exited;
  const standaloneEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
  const powershell = (command) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 3_000 });
  const accessibility = ["--force-renderer-accessibility", "--enable-features=UiaProvider"];
  const findWindow = (...args) => run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", resolve("scripts", "find-test-window.ps1"),
    "-ProcessId", String(child.pid), "-Title", name, ...args,
  ], { timeout: 5_000, windowsHide: true });

  async function startShortcutHash() {
    const { stdout } = await powershell("[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Programs')");
    try { return await sha256File(join(stdout.trim(), `${name}.lnk`)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  function launch(executable, args) {
    child = spawn(executable, [`--user-data-dir=${profile}`, ...args], {
      env: { ...standaloneEnv, PATH: profile, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", windowsHide: true,
    });
    exited = once(child, "exit");
    void exited.catch(() => {});
  }

  async function waitForWindow(duration) {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline && child.exitCode === null && child.pid) {
      const { stdout } = await findWindow();
      const handle = stdout.trim();
      if (/^[0-9a-f]+$/i.test(handle) && handle !== "0") return handle;
      await setTimeout(150);
    }
  }

  async function windowHandle() {
    const handle = await waitForWindow(25_000);
    assert.ok(handle, `Packaged application exited early or never showed its window (exit code ${child.exitCode}).`);
    return handle;
  }

  async function expectExit(code) {
    assert.equal(await Promise.race([exited.then(([status]) => status), setTimeout(6_000, "timeout", { ref: false })]), code);
  }

  async function close() {
    await findWindow("-Close");
    await expectExit(0);
  }

  async function readControls(handle, labels) {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
      resolve("tests", "windows-accessibility.ps1"), "-WindowHandle", handle], {
      env: { ...process.env, TOMVERSE_UIA_TEST_LABELS: JSON.stringify(labels) }, timeout: 9_000,
    });
    return JSON.parse(stdout);
  }

  async function verifySavedLanguage(executable) {
    launch(executable, accessibility);
    const controls = await readControls(await windowHandle(), ["Arbeitsbereiche", "Mit Apple fortfahren"]);
    assert.ok(controls.Arbeitsbereiche || controls["Mit Apple fortfahren"], "The saved German profile must reach the Windows accessibility tree.");
    await close();
  }

  async function verifyStartupRecovery(previousBinary) {
    const candidate = join(profile, "damaged-candidate");
    const savedLanguage = join(profile, "language.txt");
    const savedBounds = join(profile, "window-bounds.json");
    const [language, bounds] = await Promise.all([readFile(savedLanguage, "utf8"), readFile(savedBounds, "utf8")]);
    await cp(bundle, candidate, { recursive: true });
    await writeFile(join(candidate, "resources", "app.asar"), "Damaged candidate archive");
    launch(join(candidate, name + ".exe"), []);
    assert.equal(await waitForWindow(5_000), undefined, "A damaged candidate must fail before showing the Desktop window.");
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    assert.equal(await readFile(savedLanguage, "utf8"), language);
    assert.equal(await readFile(savedBounds, "utf8"), bounds);
    await verifySavedLanguage(previousBinary);
    assert.equal(await readFile(savedBounds, "utf8"), bounds);
    return { damagedArchiveRejected: true, previousVersionRelaunched: true, profilePreserved: true };
  }

  async function verifyCliPathUpgrade(previous) {
    const cases = await readCliCases(values["cli-path-cases"]);
    const codex = cases.find(({ id }) => id === "openai");
    if (codex) {
      const isolatedFile = join(profile, "CLI path with spaces", "codex.exe");
      await mkdir(dirname(isolatedFile));
      await copyFile(codex.path, isolatedFile);
      codex.path = isolatedFile;
    }
    const stored = join(profile, "provider-cli-paths.json");
    const expected = Object.fromEntries(cases.map(({ id, path }) => [id, path]));
    const assertSavedPaths = async () => assert.deepEqual(JSON.parse(await readFile(stored, "utf8")), expected);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(profile, "code-execution-preference.txt"), "provider_cli");
    launch(previous, accessibility);
    await inspectCliSettings("Save", cases);
    await assertSavedPaths();
    await close();
    launch(binary, accessibility);
    await inspectCliSettings("Upgrade", cases);
    if (codex) {
      await copyFile(process.execPath, codex.path);
      await inspectCliSettings("Recheck", [codex]);
    }
    await assertSavedPaths();
    await close();
    return {
      verifiedPaths: Object.fromEntries(cases.map(({ id, version }) => [id, version])),
      pathsPreserved: true, verificationResetOnUpgrade: true, replacementUnverified: Boolean(codex),
    };
  }

  async function inspectCliSettings(stage, cases, timeout = 120_000) {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
      resolve("tests", "windows-cli-setup.ps1"), "-WindowHandle", await windowHandle(), "-Stage", stage], {
      env: { ...process.env, TOMVERSE_TEST_CLI_PATH_CASES: JSON.stringify(cases) }, timeout, windowsHide: true,
    });
  }

  async function verifyCliProtocol() {
    const cases = await readCliCases(values["cli-protocol-cases"]);
    const enabled = values["cli-protocol-enabled"] === true;
    const codex = cases.find(({ id }) => id === "openai");
    if (enabled && codex) {
      const isolatedFile = join(profile, "CLI protocol check", "codex.exe");
      await mkdir(dirname(isolatedFile));
      await copyFile(codex.path, isolatedFile);
      codex.path = isolatedFile;
    }
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(profile, "code-execution-preference.txt"), "provider_cli");
    await writeFile(join(profile, "provider-cli-paths.json"), JSON.stringify(Object.fromEntries(cases.map(({ id, path }) => [id, path]))));
    launch(binary, accessibility);
    await inspectCliSettings(enabled ? "Protocol" : "ProtocolUnavailable", cases, 100_000 * cases.length + 20_000);
    if (enabled && codex) {
      await copyFile(process.execPath, codex.path);
      await inspectCliSettings("ProtocolRecheck", [codex]);
    }
    await close();
    return { enabled, providers: Object.fromEntries(cases.map(({ id, protocolStatus }) =>
      [id, enabled ? protocolStatus ?? "verified" : "unavailable"])), replacementRejected: enabled && Boolean(codex) };
  }

  try {
    const previousShortcutHash = await startShortcutHash();
    await writeFile(join(profile, "language.txt"), "en");
    launch(binary, [...accessibility, "--desktop-fixture", join(profile, "must-not-be-opened.json")]);
    const handle = await windowHandle();
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive",
      "-File", resolve("scripts", "read-windows-taskbar.ps1"), "-WindowHandle", handle, "-Executable", binary,
      "-ReferenceIcon", resolve("../../app/favicon.ico")], { timeout: 12_000 });
    const taskbar = JSON.parse(stdout);
    assert.equal(taskbar.appId, "app.tomverse.desktop");
    assert.equal(taskbar.name, name);
    assert.equal(taskbar.command, `"${binary}"`);
    assert.equal(taskbar.icon.replace(/,0$/, ""), windowsIcon);
    assert.equal(taskbar.iconMatches, true, "Both Windows shell icon sizes must match the Tomverse icon.");
    assert.equal(taskbar.windowIconMatches, true, "The live window must use the same Tomverse icon at both Windows sizes.");
    assert.equal(taskbar.executableIconMatches, true, "The Windows executable must also embed the Tomverse icon.");
    const runtime = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Where-Object { $_.CommandLine -match 'utility-sub-type=node\\.mojom\\.NodeService' }).Name`],
    { timeout: 8_000 });
    assert.match(runtime.stdout, /Tomverse Desktop\.exe/i, "The packaged executable must start its bundled Code worker with an empty PATH.");
    const loginControls = ["Continue with Apple", "Continue with Google", "Continue with Microsoft", "Continue with email", "Quit Tomverse Desktop"];
    const controls = await readControls(handle, ["Help", "Workspaces", ...loginControls]);
    if (values["auth-enabled"]) {
      for (const label of loginControls) assert.equal(controls[label], "ControlType.Button");
      assert.equal(controls.Help, null);
      assert.equal(controls.Workspaces, null);
    } else {
      assert.equal(controls.Help, "ControlType.Button");
    }
    await close();
    assert.equal(await startShortcutHash(), previousShortcutHash,
      "Starting the app with notifications off must leave the Start menu shortcut untouched.");
    launch(binary, ["--remote-debugging-port=0"]);
    await expectExit(64);

    let portableUpgrade;
    let previousBinary = binary;
    if (values.previous) {
      const previous = resolve(values.previous);
      const previousArchive = join(previous, "resources", "app.asar");
      const prior = JSON.parse(extractFile(previousArchive, "package.json").toString("utf8"));
      assert.equal(prior.productName, manifest.productName);
      assert.equal(prior.name, manifest.name);
      assert.ok(manifest.version.localeCompare(prior.version, "en", { numeric: true }) > 0);
      previousBinary = join(previous, name + ".exe");
      await writeFile(join(profile, "language.txt"), "de");
      await writeFile(join(profile, "window-bounds.json"), JSON.stringify({ x: 40, y: 40, width: 860, height: 640 }));
      await verifySavedLanguage(previousBinary);
      const before = await readFile(join(profile, "window-bounds.json"), "utf8");
      await verifySavedLanguage(binary);
      assert.equal(await readFile(join(profile, "language.txt"), "utf8"), "de");
      assert.equal(await readFile(join(profile, "window-bounds.json"), "utf8"), before);
      await verifySavedLanguage(previousBinary);
      portableUpgrade = { from: prior.version, to: manifest.version, languageAndWindowRestored: true, rollbackRelaunched: true };
    }
    const cliPathUpgrade = values["cli-path-cases"] ? await verifyCliPathUpgrade(previousBinary) : undefined;
    const cliProtocol = values["cli-protocol-cases"] ? await verifyCliProtocol() : undefined;
    const startupRecovery = values["startup-recovery"] ? await verifyStartupRecovery(previousBinary) : undefined;
    return { portableUpgrade, cliPathUpgrade, cliProtocol, startupRecovery };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited?.catch(() => {});
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const { portableUpgrade, cliPathUpgrade, cliProtocol, startupRecovery } = nativeWindowSmoke ? await verifyWindows() : {};

console.log(JSON.stringify({
  platform, arch, fixtureExcluded: true, title: name, verifiedFuses: true,
  nativeWindowSmoke, iconSha256: createHash("sha256").update(icon).digest("hex"),
  nativeTaskbarIcon: nativeWindowSmoke,
  nativeHelpEntry: nativeWindowSmoke && values["auth-enabled"] !== true,
  nativeSignInWindow: values["auth-enabled"] === true,
  nativeStartShortcutPreserved: nativeWindowSmoke,
  standaloneCodeWorker: nativeWindowSmoke,
  archiveEntries,
  macPayload,
  portablePayloadFiles: portableFiles?.length,
  archiveSha256: await sha256File(archive),
  thirdPartyNotices: true,
  portableUpgrade,
  startupRecovery,
  cliPathUpgrade,
  cliProtocol,
  executableSha256: await sha256File(binary),
  frameworkSha256: platform === "darwin"
    ? await sha256File(join(appBundle, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"))
    : undefined,
}));
