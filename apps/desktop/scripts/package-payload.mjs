import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractFile, getRawHeader, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { NtExecutable, NtExecutableResource } from "resedit";
import { localDevPackage } from "./local-dev-package.mjs";

const appEntries = new Set([
  "package.json", "dist", "dist/host", "dist/host/main.cjs", "dist/host/preload.cjs",
  "dist/host/runner-process.cjs", "dist/host/tomverse-icon.ico", "dist/host/tomverse-icon.png",
  "dist/renderer", "dist/renderer/index.html", "dist/renderer/assets",
]);
const commonRuntime = [
  "chrome_100_percent.pak", "chrome_200_percent.pak", "icudtl.dat", "LICENSE", "LICENSES.chromium.html",
  "resources.pak", "snapshot_blob.bin", "v8_context_snapshot.bin", "version", "vk_swiftshader_icd.json",
];
const runtimeByTarget = {
  win32: ["Tomverse Desktop.exe", "d3dcompiler_47.dll", "dxcompiler.dll", "electron_wer.dll",
    "ffmpeg.dll", "vk_swiftshader.dll", "vulkan-1.dll"],
  linux: ["Tomverse Desktop", "chrome_crashpad_handler", "chrome-sandbox",
    "libffmpeg.so", "libvk_swiftshader.so", "libvulkan.so.1"],
};

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectPackagedFuses(executable, platform) {
  const fuses = await getCurrentFuseWire(executable);
  for (const option of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments]) {
    assert.equal(fuses[option], FuseState.DISABLE, `Unexpected Electron fuse: ${FuseV1Options[option]}.`);
  }
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
  assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    platform === "linux" ? FuseState.DISABLE : FuseState.ENABLE);
}

export async function inspectWindowsIntegrity(executable, archive) {
  const pe = NtExecutable.from(await readFile(executable), { ignoreCert: true });
  assert.equal(pe.newHeader.fileHeader.machine, 0x8664, "The Windows executable must target x64.");
  const resources = NtExecutableResource.from(pe).entries;
  const integrity = resources.filter(({ type, id }) => type === "INTEGRITY" && id === "ELECTRONASAR");
  assert.equal(integrity.length, 1, "Missing or ambiguous Windows executable ASAR integrity resource.");
  const { headerString } = getRawHeader(archive);
  const value = createHash("sha256").update(headerString).digest("hex");
  assert.deepEqual(JSON.parse(Buffer.from(integrity[0].bin).toString("utf8")),
    [{ file: "resources\\app.asar", alg: "SHA256", value }],
    "The Windows executable does not match the packaged app.asar.");
}

export function inspectAppArchive(archive, { cliProtocolCheck = false, localDev = false } = {}) {
  const entries = listPackage(archive).map((entry) => entry.replaceAll("\\", "/").slice(1));
  const actual = new Set(entries);
  for (const entry of appEntries) assert.ok(actual.has(entry), `Missing packaged entry ${entry}.`);
  for (const entry of actual) {
    assert.ok(appEntries.has(entry) ||
      /^dist\/renderer\/assets\/[\w-]+-[\w-]+\.(js|css|png|svg|woff2)$/.test(entry), `Unexpected packaged entry ${entry}.`);
  }
  const manifest = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  assert.equal(manifest.name, localDev ? localDevPackage.packageName : "tomverse-desktop");
  assert.equal(manifest.productName, localDev ? localDevPackage.name : "Tomverse Desktop");
  assert.equal(manifest.main, "dist/host/main.cjs");
  const main = extractFile(archive, join("dist", "host", "main.cjs"));
  assert.equal(main.includes("--desktop-fixture"), false, "The packaged app contains the development fixture launcher.");
  assert.equal(main.includes("tomverse-claude-account-"), false, "The packaged app contains the isolated CLI authentication launcher.");
  assert.equal(main.includes("tomverse-cli-protocol-"), cliProtocolCheck, "The packaged CLI protocol launcher does not match the expected build.");
  return { manifest, entries: entries.length };
}

export async function inspectPortablePayload(bundle, platform, { localDev = false } = {}) {
  const runtime = runtimeByTarget[platform];
  assert.ok(runtime, `Unsupported portable payload platform ${platform}.`);
  const expected = new Set([...commonRuntime, ...runtime]);
  if (localDev && platform === "win32") {
    expected.delete("Tomverse Desktop.exe");
    expected.add(localDevPackage.name + ".exe");
  }
  const directories = new Set(["resources", "locales"]);
  const files = [];
  for (const entry of await readdir(bundle, { withFileTypes: true })) {
    if (entry.isFile() && expected.delete(entry.name)) {
      files.push(entry.name);
    } else {
      assert.ok(entry.isDirectory() && directories.delete(entry.name), `Unexpected portable bundle entry ${entry.name}.`);
    }
  }
  assert.equal(expected.size + directories.size, 0, `Missing portable bundle entries: ${[...expected, ...directories].join(", ")}.`);

  const resources = new Set(["app.asar", "THIRD_PARTY_NOTICES.txt"]);
  if (platform === "win32") resources.add("tomverse-icon.ico");
  for (const entry of await readdir(join(bundle, "resources"), { withFileTypes: true })) {
    assert.ok(entry.isFile() && resources.delete(entry.name), `Unexpected portable bundle entry resources/${entry.name}.`);
    files.push(join("resources", entry.name));
  }
  assert.equal(resources.size, 0, `Missing portable resources: ${[...resources].join(", ")}.`);

  const locales = await readdir(join(bundle, "locales"), { withFileTypes: true });
  assert.ok(locales.some((entry) => entry.name === "en-US.pak"), "Missing Electron en-US locale.");
  for (const entry of locales) {
    assert.ok(entry.isFile() && /^[a-z]{2,3}(?:-(?:[A-Z]{2}|[0-9]{3}))?\.pak$/.test(entry.name),
      `Unexpected portable bundle entry locales/${entry.name}.`);
    files.push(join("locales", entry.name));
  }
  return files.sort();
}

const machCpu = { x64: 0x01000007, arm64: 0x0100000c };
const macLocale = /^[a-z]{2,3}(?:_(?:[A-Z]{2}|\d{3}))?(?:_(?:FEMININE|MASCULINE|NEUTER))?\.lproj$/;

export async function inspectMacPayload(application, name, arch) {
  assert.ok(Object.hasOwn(machCpu, arch), `Unsupported macOS architecture ${arch}.`);
  assert.ok((await lstat(application)).isDirectory(), "The macOS app must be a directory.");

  const frameworks = "Contents/Frameworks";
  const version = framework => `${frameworks}/${framework}.framework/Versions/A`;
  const electron = version("Electron Framework");
  const resources = `${electron}/Resources`;
  const codeBundles = ["Contents", ...["", " (GPU)", " (Plugin)", " (Renderer)"].map(suffix =>
    `${frameworks}/${name} Helper${suffix}.app/Contents`)];
  const frameworkNames = ["Electron Framework", "Mantle", "ReactiveObjC", "Squirrel"];
  const snapshots = arch === "x64" ? "x86_64" : arch;
  const requiredBinaries = [
    `Contents/MacOS/${name}`,
    ...codeBundles.slice(1).map(contents =>
      `${contents}/MacOS/${posix.basename(posix.dirname(contents), ".app")}`),
    ...frameworkNames.map(framework => `${version(framework)}/${framework}`),
    `${electron}/Helpers/app_shim_loader`, `${electron}/Helpers/chrome_crashpad_handler`,
    `${electron}/Libraries/libffmpeg.dylib`, `${electron}/Libraries/libvk_swiftshader.dylib`,
    `${version("Squirrel")}/Resources/ShipIt`,
  ];
  const files = new Set([
    ...requiredBinaries,
    ...codeBundles.flatMap(contents => [`${contents}/Info.plist`, `${contents}/PkgInfo`]),
    ...frameworkNames.map(framework => `${version(framework)}/Resources/Info.plist`),
    ...["app.asar", "electron.icns", "LICENSE", "LICENSES.chromium.html", "THIRD_PARTY_NOTICES.txt"]
      .map(file => `Contents/Resources/${file}`),
    ...["chrome_100_percent.pak", "chrome_200_percent.pak", "icudtl.dat", "MainMenu.nib", "resources.pak",
      `v8_context_snapshot.${snapshots}.bin`, "en.lproj/locale.pak"].map(file => `${resources}/${file}`),
    `${electron}/Libraries/vk_swiftshader_icd.json`,
  ]);
  const signatures = new Set([
    ...[...codeBundles, ...frameworkNames.map(version)].map(contents => `${contents}/_CodeSignature/CodeResources`),
    "Contents/CodeResources",
  ]);
  const links = new Map();
  for (const framework of frameworkNames) {
    const path = `${frameworks}/${framework}.framework`;
    links.set(`${path}/Versions/Current`, "A");
    const items = framework === "Electron Framework" ? ["Resources", "Helpers", "Libraries"] : ["Resources"];
    for (const item of [framework, ...items]) links.set(`${path}/${item}`, `Versions/Current/${item}`);
  }
  const directories = new Set();
  for (const entry of [...files, ...links.keys(), ...signatures]) {
    for (let parent = posix.dirname(entry); parent !== "."; parent = posix.dirname(parent)) directories.add(parent);
  }

  const linkCount = links.size;
  let fileCount = 0;
  async function visit(directory = "") {
    for (const entry of await readdir(join(application, directory), { withFileTypes: true })) {
      const relative = posix.join(directory, entry.name);
      const destination = join(application, relative);
      if (links.has(relative)) {
        assert.ok(entry.isSymbolicLink() && await readlink(destination) === links.get(relative),
          `Invalid macOS bundle link: ${relative}.`);
        links.delete(relative);
      } else if (entry.isDirectory()) {
        const isLocale = macLocale.test(entry.name);
        assert.ok(directories.has(relative) || (isLocale && [resources, "Contents/Resources"].includes(directory)),
          `Unexpected macOS bundle directory: ${relative}.`);
        if (isLocale && directory === resources) files.add(`${relative}/locale.pak`);
        await visit(relative);
      } else {
        assert.ok(entry.isFile() && (files.delete(relative) || signatures.has(relative)),
          `Unexpected macOS bundle entry: ${relative}.`);
        fileCount++;
      }
    }
  }
  await visit();
  assert.equal(files.size + links.size, 0, `Missing macOS bundle entries: ${[...files, ...links.keys()].join(", ")}.`);

  await Promise.all(requiredBinaries.map(async relative => {
    const binary = await open(join(application, relative), "r");
    try {
      const header = Buffer.alloc(8);
      const { bytesRead } = await binary.read(header, 0, header.length, 0);
      assert.ok(bytesRead === header.length && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === machCpu[arch],
        `Invalid macOS ${arch} executable: ${relative}.`);
      if (process.platform !== "win32") {
        assert.ok((await binary.stat()).mode & 0o111, `Missing executable permissions: ${relative}.`);
      }
    } finally {
      await binary.close();
    }
  }));
  return { files: fileCount, symlinks: linkCount, binaries: requiredBinaries.length };
}
