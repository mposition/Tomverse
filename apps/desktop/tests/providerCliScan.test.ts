import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliProvider } from "../src/code-execution";
import {
  cliScanDirectories, expandScanDirectories, resolveFoundFile, scanCliProviders, SCAN_LIMITS, wrapperTarget, type ScanDirectory, type ScanFileSystem,
} from "../src/host/provider-cli-scan";

const windows = process.platform === "win32";

// Wrapper files exactly as npm writes them (npm 11, cmd-shim 8), for the commands this machine has installed.
const codexCmd = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`;
const codexPs1 = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if (Test-Path "$basedir/node$exe") {
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  }
} else {
  & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
}
`;
const codexSh = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"
else
  exec node  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"
fi
`;
const claudeCmd = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
`;

test("The scan looks in fixed places only, for each platform and environment", () => {
  const win = cliScanDirectories("win32", {
    Path: String.raw`C:\Windows\system32;"C:\Program Files\Git\cmd";relative\bin;\\server\share\bin;C:\tools`,
    APPDATA: String.raw`C:\Users\Ada\AppData\Roaming`, LOCALAPPDATA: String.raw`C:\Users\Ada\AppData\Local`,
    NVM_HOME: String.raw`C:\Users\Ada\AppData\Local\nvm`, NVM_SYMLINK: String.raw`C:\nvm4w\nodejs`, ProgramFiles: String.raw`C:\Program Files`,
  }, String.raw`C:\Users\Ada`);
  const directories = win.map(({ directory }) => directory);
  assert.deepEqual(directories.slice(0, 3), [String.raw`C:\Windows\system32`, String.raw`C:\Program Files\Git\cmd`, String.raw`C:\tools`]);
  for (const expected of [
    String.raw`C:\Users\Ada\AppData\Roaming\npm`, String.raw`C:\nvm4w\nodejs`, String.raw`C:\Users\Ada\AppData\Local\nvm`,
    String.raw`C:\Users\Ada\.local\bin`, String.raw`C:\Users\Ada\.npm-global`, String.raw`C:\Users\Ada\.npm-global\bin`,
    String.raw`C:\Users\Ada\AppData\Local\Programs`, String.raw`C:\Users\Ada\AppData\Local\Microsoft\WinGet\Links`,
    String.raw`C:\Program Files\WinGet\Links`, String.raw`C:\Users\Ada\AppData\Local\Microsoft\WinGet\Packages`,
  ]) assert.ok(directories.includes(expected), expected);
  assert.ok(!directories.some((directory) => directory.startsWith("\\\\") || directory.startsWith("relative")));
  assert.equal(win.find(({ directory }) => directory.endsWith("\\nvm"))?.children?.pattern?.test("v22.22.2"), true);
  assert.equal(win.find(({ directory }) => directory.endsWith("\\nvm"))?.children?.pattern?.test("v22.22.2\\..\\x"), false);

  // Without the Windows variables the folders come from the home folder.
  const bare = cliScanDirectories("win32", {}, String.raw`C:\Users\Bo`).map(({ directory }) => directory);
  assert.ok(bare.includes(String.raw`C:\Users\Bo\AppData\Roaming\npm`));
  assert.ok(bare.includes(String.raw`C:\Users\Bo\AppData\Local\Programs`));
  assert.ok(!bare.some((directory) => directory.includes("WinGet\\Links") && directory.startsWith("C:\\Program Files")));

  const mac = cliScanDirectories("darwin", { PATH: "/usr/bin:/bin:relative:/opt/homebrew/bin", NVM_DIR: "/Users/ada/.nvm" }, "/Users/ada");
  const macDirectories = mac.map(({ directory }) => directory);
  assert.deepEqual(macDirectories.slice(0, 3), ["/usr/bin", "/bin", "/opt/homebrew/bin"]);
  for (const expected of ["/usr/local/bin", "/Users/ada/.local/bin", "/Users/ada/.npm-global/bin", "/Users/ada/.nvm/versions/node"]) {
    assert.ok(macDirectories.includes(expected), expected);
  }
  assert.ok(!macDirectories.includes("/home/linuxbrew/.linuxbrew/bin"));
  assert.deepEqual(mac.find(({ directory }) => directory.endsWith("versions/node"))?.children?.subpaths, ["bin"]);

  const linux = cliScanDirectories("linux", { PATH: "/usr/bin", NVM_BIN: "/home/ada/.nvm/versions/node/v22.1.0/bin" }, "/home/ada").map(({ directory }) => directory);
  assert.ok(linux.includes("/home/linuxbrew/.linuxbrew/bin"));
  assert.ok(linux.includes("/home/ada/.nvm/versions/node/v22.1.0/bin"));
  assert.ok(linux.includes("/home/ada/.nvm/versions/node"));

  const many = cliScanDirectories("linux", { PATH: Array.from({ length: 500 }, (_, index) => "/p" + index).join(":") }, "/home/ada");
  assert.ok(many.filter(({ directory }) => directory.startsWith("/p")).length <= SCAN_LIMITS.pathEntries);
});

test("Subfolders are expanded within their limits and duplicates are dropped", async () => {
  const folders: Record<string, string[]> = {
    "C:\\nvm": ["v18.0.0", "v22.22.2", "notes", "settings.txt", ...Array.from({ length: 40 }, (_, index) => "v20.0." + index)],
    "C:\\Apps": ["One", "Two"],
  };
  const read = async (directory: string) => {
    const names = folders[directory];
    if (!names) throw new Error("missing");
    return names.map((name) => ({ name, directory: !name.endsWith(".txt") }));
  };
  const list: ScanDirectory[] = [
    { directory: "C:\\nvm", children: { pattern: /^v?\d+\.\d+\.\d+$/, max: SCAN_LIMITS.versionFolders, subpaths: [""] } },
    { directory: "c:\\NVM\\" },
    { directory: "C:\\Apps", children: { max: 5, subpaths: ["", "bin"] } },
    { directory: "C:\\Missing", children: { max: 5, subpaths: [""] } },
  ];
  const expanded = await expandScanDirectories(list, "win32", read);
  assert.equal(expanded.filter((directory) => directory.startsWith("C:\\nvm\\v")).length, SCAN_LIMITS.versionFolders);
  assert.ok(!expanded.some((directory) => directory.includes("notes") || directory.endsWith(".txt")));
  assert.equal(expanded.filter((directory) => directory.toLowerCase() === "c:\\nvm").length, 1);
  assert.deepEqual(expanded.filter((directory) => directory.startsWith("C:\\Apps")), ["C:\\Apps", "C:\\Apps\\One", "C:\\Apps\\One\\bin", "C:\\Apps\\Two", "C:\\Apps\\Two\\bin"]);
});

test("A wrapper names its native target only through the fixed npm patterns", () => {
  assert.equal(wrapperTarget(codexCmd), "node_modules/@openai/codex/bin/codex.js");
  assert.equal(wrapperTarget(codexPs1), "node_modules/@openai/codex/bin/codex.js");
  assert.equal(wrapperTarget(codexSh), "node_modules/@openai/codex/bin/codex.js");
  assert.equal(wrapperTarget(claudeCmd), "node_modules/@anthropic-ai/claude-code/bin/claude.exe");

  const forged = (target: string) => String.raw`@ECHO off` + "\r\n" + `"%dp0%\\${target}" %*`;
  for (const target of [
    String.raw`node_modules\@openai\codex\bin\..\..\..\..\evil.exe`, // leaves the folder
    String.raw`node_modules\..\..\Windows\System32\cmd.exe`,
    String.raw`..\evil.exe`,
    String.raw`\\server\share\codex.exe`,
    String.raw`node_modules\\server\share\codex.exe`,
    String.raw`node_modules\@openai\codex\bin\codex.js & calc`,
    String.raw`node_modules\@openai\%COMSPEC%`,
    String.raw`C:\Windows\System32\cmd.exe`,
    String.raw`node_modules`,
  ]) assert.equal(wrapperTarget(forged(target)), null, target);
  assert.equal(wrapperTarget("echo no target"), null);
  // Two different targets are ambiguous, so neither is used.
  assert.equal(wrapperTarget(codexCmd + String.raw`"%dp0%\node_modules\@openai\codex\bin\other.js" %*`), null);
  assert.equal(wrapperTarget(codexSh.replace("exec node", `exec node "$basedir/../elsewhere/codex.js" `) + `"$basedir/node_modules/x/../../y"`), null);
});

type Entry = { link?: string; header?: number[]; text?: string };
// A small file system for the Unix layouts, so they run on any machine.
function virtualFiles(entries: Record<string, Entry>): ScanFileSystem {
  const exists = (path: string) => path in entries || Object.keys(entries).some((key) => key.startsWith(path + "/"));
  function resolve(path: string, depth = 0): string {
    if (depth > 8) throw new Error("loop");
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length; index += 1) {
      current += "/" + parts[index];
      const link = entries[current]?.link;
      if (link) return resolve(link + (index + 1 < parts.length ? "/" + parts.slice(index + 1).join("/") : ""), depth + 1);
    }
    if (!exists(current)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return current;
  }
  return {
    lstat: (async (path: string) => {
      const entry = entries[path];
      if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => !entry.link, isDirectory: () => false };
    }) as never,
    realpath: (async (path: string) => resolve(path)) as never,
    header: async (file, bytes) => Buffer.from(entries[resolve(file)]?.header ?? [...Buffer.from(entries[resolve(file)]?.text ?? "")]).subarray(0, bytes),
    text: async (file) => entries[resolve(file)]?.text ?? null,
  };
}
const elf = [0x7f, 0x45, 0x4c, 0x46];
const lib = "/usr/local/lib/node_modules";
const codexNative = `${lib}/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`;

test("A Unix npm link to the package entry resolves to the native executable inside the same node_modules folder", async () => {
  const files = virtualFiles({
    "/usr/local/bin/codex": { link: `${lib}/@openai/codex/bin/codex.js` },
    [`${lib}/@openai/codex/bin/codex.js`]: { text: "#!/usr/bin/env node\n" },
    [codexNative]: { header: elf },
    "/usr/local/bin/claude": { link: `${lib}/@anthropic-ai/claude-code/bin/claude.exe` },
    [`${lib}/@anthropic-ai/claude-code/bin/claude.exe`]: { header: elf },
  });
  assert.deepEqual(await resolveFoundFile("openai", "/usr/local/bin/codex", "linux", "x64", files), { path: codexNative, via: "/usr/local/bin/codex" });
  // A native file behind a link is used under the link's own name, which is the name the release check expects.
  assert.deepEqual(await resolveFoundFile("anthropic", "/usr/local/bin/claude", "linux", "x64", files), { path: "/usr/local/bin/claude" });
  // The package's JavaScript entry alone is not enough.
  const jsOnly = virtualFiles({
    "/usr/local/bin/codex": { link: `${lib}/@openai/codex/bin/codex.js` },
    [`${lib}/@openai/codex/bin/codex.js`]: { text: "#!/usr/bin/env node\n" },
  });
  assert.deepEqual(await resolveFoundFile("openai", "/usr/local/bin/codex", "linux", "x64", jsOnly), { unresolved: "/usr/local/bin/codex" });
  // A link to another package's file, or to a file that only looks like an entry, is refused.
  const other = virtualFiles({
    "/usr/local/bin/codex": { link: "/opt/evil/node_modules/@openai/codex/bin/other.js" },
    "/opt/evil/node_modules/@openai/codex/bin/other.js": { text: "#!/usr/bin/env node\n" },
    "/usr/local/bin/claude": { link: "/opt/evil/node_modules/left-pad/bin/codex.js" },
    "/opt/evil/node_modules/left-pad/bin/codex.js": { text: "x" },
  });
  assert.deepEqual(await resolveFoundFile("openai", "/usr/local/bin/codex", "linux", "x64", other), { unresolved: "/usr/local/bin/codex" });
  assert.deepEqual(await resolveFoundFile("openai", "/usr/local/bin/claude", "linux", "x64", other), { unresolved: "/usr/local/bin/claude" });
  // A native file that a link inside the package carries out of the node_modules folder is refused.
  const escape = virtualFiles({
    "/usr/local/bin/codex": { link: `${lib}/@openai/codex/bin/codex.js` },
    [`${lib}/@openai/codex/bin/codex.js`]: { text: "x" },
    [`${lib}/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin`]: { link: "/tmp/elsewhere" },
    "/tmp/elsewhere/codex": { header: elf },
  });
  assert.deepEqual(await resolveFoundFile("openai", "/usr/local/bin/codex", "linux", "x64", escape), { unresolved: "/usr/local/bin/codex" });
});

test("A shell wrapper is read as text and never offered as an executable", async () => {
  const sh = virtualFiles({
    "/home/ada/.local/bin/codex": { text: codexSh },
    [`/home/ada/.local/bin/node_modules/@openai/codex/bin/codex.js`]: { text: "x" },
    "/home/ada/.local/bin/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex": { header: [0xcf, 0xfa, 0xed, 0xfe] },
    "/home/ada/.local/bin/grok": { text: "#!/bin/sh\necho hello\n" },
    "/home/ada/.local/bin/kimi": { text: "plain text" },
  });
  const resolved = await resolveFoundFile("openai", "/home/ada/.local/bin/codex", "darwin", "arm64", sh);
  assert.deepEqual(resolved, {
    path: "/home/ada/.local/bin/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    via: "/home/ada/.local/bin/codex",
  });
  assert.deepEqual(await resolveFoundFile("xai", "/home/ada/.local/bin/grok", "linux", "x64", sh), { unresolved: "/home/ada/.local/bin/grok" });
  assert.deepEqual(await resolveFoundFile("moonshot", "/home/ada/.local/bin/kimi", "linux", "x64", sh), { unresolved: "/home/ada/.local/bin/kimi" });
  // Only the two providers with a known package layout have a wrapper pattern.
  const codexText = virtualFiles({ "/x/codex": { text: codexSh }, "/x/node_modules/@openai/codex/bin/codex.js": { text: "x" } });
  assert.deepEqual(await resolveFoundFile("google", "/x/codex", "linux", "x64", codexText), { unresolved: "/x/codex" });
});

test("A Windows npm wrapper resolves to the native executable it starts and a forged one does not", { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-cli-wrapper-"));
  try {
    const bin = join(root, "npm");
    const codexPackage = join(bin, "node_modules", "@openai", "codex");
    const vendor = join(codexPackage, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
    await mkdir(vendor, { recursive: true });
    await mkdir(join(codexPackage, "bin"), { recursive: true });
    await writeFile(join(codexPackage, "bin", "codex.js"), "#!/usr/bin/env node\n");
    await writeFile(join(vendor, "codex.exe"), "native stand-in");
    for (const [name, text] of [["codex.cmd", codexCmd], ["codex.ps1", codexPs1], ["codex", codexSh]] as const) await writeFile(join(bin, name), text);
    const expected = join(vendor, "codex.exe");
    for (const name of ["codex.cmd", "codex.ps1", "codex"]) {
      assert.deepEqual(await resolveFoundFile("openai", join(bin, name), "win32", "x64"), { path: expected, via: join(bin, name) }, name);
    }
    // The same package under another command name is not this provider's.
    assert.deepEqual(await resolveFoundFile("anthropic", join(bin, "codex.cmd"), "win32", "x64"), { unresolved: join(bin, "codex.cmd") });

    const claudePackage = join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(claudePackage, { recursive: true });
    await writeFile(join(claudePackage, "claude.exe"), "native stand-in");
    await writeFile(join(bin, "claude.cmd"), claudeCmd);
    assert.deepEqual(await resolveFoundFile("anthropic", join(bin, "claude.cmd"), "win32", "x64"), { path: join(claudePackage, "claude.exe"), via: join(bin, "claude.cmd") });

    // A forged wrapper cannot point outside its node_modules folder, even through a junction.
    const outside = join(root, "outside");
    await mkdir(join(outside, "vendor", "x86_64-pc-windows-msvc", "bin"), { recursive: true });
    await writeFile(join(outside, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), "native stand-in");
    const forgedBin = join(root, "forged");
    const forgedPackage = join(forgedBin, "node_modules", "@openai", "codex");
    await mkdir(join(forgedPackage, "bin"), { recursive: true });
    await writeFile(join(forgedPackage, "bin", "codex.js"), "x");
    await mkdir(join(forgedPackage, "node_modules", "@openai"), { recursive: true });
    await symlink(outside, join(forgedPackage, "node_modules", "@openai", "codex-win32-x64"), "junction");
    await writeFile(join(forgedBin, "codex.cmd"), codexCmd);
    assert.deepEqual(await resolveFoundFile("openai", join(forgedBin, "codex.cmd"), "win32", "x64"), { unresolved: join(forgedBin, "codex.cmd") });
    await writeFile(join(forgedBin, "claude.cmd"), String.raw`"%dp0%\node_modules\..\..\outside\codex.exe" %*`);
    assert.deepEqual(await resolveFoundFile("anthropic", join(forgedBin, "claude.cmd"), "win32", "x64"), { unresolved: join(forgedBin, "claude.cmd") });
    // A wrapper that is itself a native file, or too large to be a wrapper, is not read.
    await writeFile(join(forgedBin, "codex.ps1"), "x".repeat(SCAN_LIMITS.wrapperBytes + 1));
    assert.deepEqual(await resolveFoundFile("openai", join(forgedBin, "codex.ps1"), "win32", "x64"), { unresolved: join(forgedBin, "codex.ps1") });
    // An .exe is taken as it is: the release check decides about it.
    assert.deepEqual(await resolveFoundFile("openai", join(root, "codex.exe"), "win32", "x64"), { path: join(root, "codex.exe") });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---- Scan -------------------------------------------------------------------------------------------------------

type Inspection = Awaited<ReturnType<NonNullable<Parameters<typeof scanCliProviders>[0]>["inspect"] & {}>>;

test("Only a file that matched its pinned release is started, and only for its sign-in state", async () => {
  const files = virtualFiles({
    "/a/bin/codex": { header: elf }, "/b/bin/codex": { header: elf }, "/c/bin/codex": { header: elf }, "/d/bin/codex": { header: elf },
    "/a/bin/claude": { header: elf }, "/b/bin/claude": { header: elf },
  });
  const read = async (directory: string) => {
    const names: Record<string, string[]> = { "/a/bin": ["codex", "claude"], "/b/bin": ["codex", "claude"], "/c/bin": ["codex"], "/d/bin": ["codex", "notes.txt"] };
    if (!names[directory]) throw new Error("missing");
    return names[directory].map((name) => ({ name, directory: false }));
  };
  const started: string[] = [];
  const inspected: string[] = [];
  const statuses: Record<string, Inspection> = {
    "/a/bin/codex": { status: "pathVerified", version: "1.2.3", file: "/a/bin/codex" },
    "/b/bin/codex": { status: "versionUnverified" },
    "/c/bin/codex": { status: "wrongFile" },
    "/d/bin/codex": { status: "windowsShim" },
    "/a/bin/claude": { status: "versionUnverified" },
    "/b/bin/claude": { status: "fileMissing" },
  };
  const result = await scanCliProviders({
    platform: "linux", arch: "x64", env: { PATH: "/a/bin:/b/bin:/c/bin:/d/bin" }, home: "/home/ada", providers: ["openai", "anthropic", "xai"], files, read,
    inspect: async (provider, path) => { inspected.push(provider + " " + path); return statuses[path]; },
    stillMatches: async () => true,
    readLogin: async (provider, file) => { started.push(provider + " " + file); return "loginRequired"; },
    isTrusted: async (_provider, file) => file === "/b/bin/codex",
  });
  const codex = result.find(({ provider }) => provider === "openai");
  assert.deepEqual(codex?.candidates, [
    { path: "/a/bin/codex", status: "pathVerified", version: "1.2.3", login: "loginRequired", trusted: false },
    { path: "/b/bin/codex", status: "versionUnverified", login: "unknown", trusted: true },
  ]);
  assert.deepEqual(result.find(({ provider }) => provider === "anthropic")?.candidates, [
    { path: "/a/bin/claude", status: "versionUnverified", login: "unknown", trusted: false },
  ]);
  assert.deepEqual(result.find(({ provider }) => provider === "xai")?.candidates, []);
  // The program is started for the verified file alone, never for an unverified, wrong or missing one.
  assert.deepEqual(started, ["openai /a/bin/codex"]);
  assert.equal(inspected.length, 6);
});

test("A file replaced while its sign-in state was read is dropped, and a failing read leaves the state unknown", async () => {
  const files = virtualFiles({ "/a/codex": { header: elf }, "/b/codex": { header: elf } });
  const read = async (directory: string) => {
    if (directory !== "/a" && directory !== "/b") throw new Error("missing");
    return [{ name: "codex", directory: false }];
  };
  const result = await scanCliProviders({
    platform: "linux", arch: "x64", env: { PATH: "/a:/b" }, home: "/home/ada", providers: ["openai"], files, read,
    inspect: async (_provider, path) => ({ status: "pathVerified", version: "1", file: path, fileStamp: "stamp" }),
    stillMatches: async (_provider, _selected, checked) => checked.file !== "/a/codex",
    readLogin: async (_provider, file) => { if (file === "/b/codex") throw new Error("failed"); return "loggedIn"; },
  });
  // The replaced file is dropped; the one whose read failed stays, with an unknown state.
  assert.deepEqual(result[0].candidates, [{ path: "/b/codex", status: "pathVerified", version: "1", login: "unknown", trusted: false }]);
});

test("The scan keeps one entry for each executable, counts wrappers it cannot resolve and honours its limits", async () => {
  const entries: Record<string, Entry> = {};
  const names: Record<string, string[]> = { "/bin1": ["codex", "grok"], "/bin2": ["codex", "kimi"] };
  names["/bin3"] = ["claude"];
  entries["/bin1/codex"] = { header: elf };
  entries["/bin2/codex"] = { link: "/bin1/codex" };
  entries["/bin1/grok"] = { text: "#!/bin/sh\nexit 0\n" };
  entries["/bin2/kimi"] = { text: "#!/bin/sh\nexit 0\n" };
  const files = virtualFiles(entries);
  const result = await scanCliProviders({
    platform: "linux", arch: "x64", env: { PATH: "/bin1:/bin2:/bin1/" }, home: "/home/ada", files,
    // npm on Unix links the command, so a link entry is what a scan normally meets; a folder of the same name is skipped.
    read: async (directory) => { if (!names[directory]) throw new Error("missing"); return names[directory].map((name) => ({ name, directory: name === "codex" && directory === "/bin2", link: name === "codex" && directory === "/bin2" })); },
    inspect: async (_provider, path) => ({ status: "versionUnverified" as const, path }) as never,
  });
  const byProvider = Object.fromEntries(result.map((entry) => [entry.provider, entry]));
  assert.deepEqual(byProvider.openai.candidates.map(({ path }) => path), ["/bin1/codex"]);
  assert.equal(byProvider.xai.unresolvedShims, 1);
  assert.equal(byProvider.moonshot.unresolvedShims, 1);
  assert.equal(byProvider.openai.unresolvedShims, 0);
  assert.deepEqual(result.map(({ provider }) => provider).sort(), ["anthropic", "google", "moonshot", "openai", "xai"]);

  const crowded: Record<string, string[]> = {};
  const crowdedEntries: Record<string, Entry> = {};
  const directories = Array.from({ length: 20 }, (_, index) => "/dir" + index);
  for (const directory of directories) { crowded[directory] = ["codex"]; crowdedEntries[directory + "/codex"] = { header: elf }; }
  const limited = await scanCliProviders({
    platform: "linux", arch: "x64", env: { PATH: directories.join(":") }, home: "/home/ada", providers: ["openai"], files: virtualFiles(crowdedEntries),
    read: async (directory) => { if (!crowded[directory]) throw new Error("missing"); return crowded[directory].map((name) => ({ name, directory: false })); },
    inspect: async () => ({ status: "versionUnverified" }),
  });
  assert.equal(limited[0].candidates.length, SCAN_LIMITS.candidatesPerProvider);

  // An aborted scan stops instead of reading the rest.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanCliProviders({ platform: "linux", arch: "x64", env: { PATH: "/bin1" }, home: "/home/ada", files, signal: controller.signal,
    read: async () => [{ name: "codex", directory: false }] }));
});

test("The scan covers a Windows layout on disk: a native file, a wrapper pair and a provider that is not installed", { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-cli-scan-"));
  try {
    const home = join(root, "home");
    const local = join(home, ".local", "bin");
    const npm = join(home, "AppData", "Roaming", "npm");
    const vendor = join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
    await Promise.all([mkdir(local, { recursive: true }), mkdir(vendor, { recursive: true }), mkdir(join(npm, "node_modules", "@openai", "codex", "bin"), { recursive: true })]);
    await copyFile(process.execPath, join(local, "claude.exe"));
    await copyFile(process.execPath, join(vendor, "codex.exe"));
    await writeFile(join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"), "x");
    for (const [name, text] of [["codex.cmd", codexCmd], ["codex.ps1", codexPs1], ["codex", codexSh]] as const) await writeFile(join(npm, name), text);
    const seen: Array<[CliProvider, string]> = [];
    const result = await scanCliProviders({
      platform: "win32", arch: "x64", home, env: { PATH: [npm, local, join(root, "empty")].join(";"), USERPROFILE: home },
      inspect: async (provider, path) => { seen.push([provider, path]); return { status: "versionUnverified" }; },
    });
    const byProvider = Object.fromEntries(result.map((entry) => [entry.provider, entry]));
    assert.deepEqual(byProvider.openai.candidates.map(({ path, via }) => [path, via]), [[join(vendor, "codex.exe"), join(npm, "codex.cmd")]]);
    assert.deepEqual(byProvider.anthropic.candidates.map(({ path }) => path), [join(local, "claude.exe")]);
    assert.deepEqual(byProvider.google.candidates, []);
    assert.equal(byProvider.openai.unresolvedShims, 0);
    assert.equal(seen.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
