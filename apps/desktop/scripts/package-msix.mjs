import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { extractFile } from "@electron/asar";
import sharp from "sharp";
import { localDevPackage } from "./local-dev-package.mjs";
import {
  inspectAppArchive, inspectPackagedFuses, inspectPortablePayload, inspectWindowsIntegrity, sha256File,
} from "./package-payload.mjs";

const { values } = parseArgs({
  options: { publisher: { type: "string" }, makeappx: { type: "string" }, out: { type: "string" }, "dev-local": { type: "boolean" } },
});
if (process.platform !== "win32" || !values.publisher?.trim()) {
  throw new Error("Use Windows and specify the matching signing certificate subject with --publisher.");
}

const localDev = values["dev-local"] === true;
if (localDev && values.publisher !== localDevPackage.publisher) throw new Error("Use the Local Dev signing certificate.");
const name = localDev ? localDevPackage.name : "Tomverse Desktop";
const identity = localDev ? localDevPackage.identity : "Tomverse.Desktop";
const out = resolve(values.out ?? (localDev ? "dist/local-dev-package" : "dist/package"));
const bundle = join(out, `${name}-win32-x64`);
const archive = join(bundle, "resources", "app.asar");
const executable = join(bundle, `${name}.exe`);
const { manifest } = inspectAppArchive(archive, { localDev });
const portableFiles = await inspectPortablePayload(bundle, "win32", { localDev });
await inspectPackagedFuses(executable, "win32");
await inspectWindowsIntegrity(executable, archive);
const versionParts = /^\d+\.\d+\.\d+$/.test(manifest.version) ? manifest.version.split(".").map(Number) : [];
if (versionParts.length !== 3 || versionParts.some((part) => part > 65535)) {
  throw new Error("Build the Windows x64 Desktop bundle with a numeric x.y.z version before making the MSIX.");
}
const version = [...versionParts, 0].join(".");
const publisher = values.publisher.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const destination = join(out, `${name.replaceAll(" ", "-")}-${version}-x64.msix`);
const stage = await mkdtemp(join(out, ".tomverse-msix-"));
const logos = [["StoreLogo.png", 50], ["Square44x44.png", 44], ["Square150x150.png", 150]];
const runMakeAppx = (args) => promisify(execFile)(values.makeappx ?? "makeappx.exe", args,
  { windowsHide: true, timeout: 120_000 });
try {
  const manifestPath = join(stage, "AppxManifest.xml");
  await writeFile(manifestPath, String.raw`<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${identity}" Publisher="${publisher}" Version="${version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${name}</DisplayName>
    <PublisherDisplayName>Tomverse</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.19045.0" />
  </Dependencies>
  <Resources><Resource Language="en" /></Resources>
  <Applications>
    <Application Id="Desktop" Executable="${name}.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${name}" Description="${name}" BackgroundColor="transparent"
        Square150x150Logo="Assets\Square150x150.png" Square44x44Logo="Assets\Square44x44.png" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`);

  const icon = extractFile(archive, join("dist", "host", "tomverse-icon.png"));
  await Promise.all(logos.map(([file, size]) =>
    sharp(icon).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toFile(join(stage, file))));

  const mappings = [[manifestPath, "AppxManifest.xml"], ...logos.map(([file]) => [join(stage, file), join("Assets", file)])];
  mappings.push(...portableFiles.map((file) => [join(bundle, file), file]));
  const mapFile = join(stage, "mapping.txt");
  await writeFile(mapFile, `[Files]\r\n${mappings.map(([source, target]) => `"${source}" "${target}"`).join("\r\n")}\r\n`);
  const pending = join(stage, "build.msix");
  const unpacked = join(stage, "unpacked");
  const { stdout } = await runMakeAppx(["pack", "/no", "/h", "SHA256", "/f", mapFile, "/p", pending]);
  await runMakeAppx(["unpack", "/no", "/p", pending, "/d", unpacked]);
  const entries = await readdir(unpacked, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => !entry.isDirectory()).map(entry => {
    assert.ok(entry.isFile(), `Unexpected MSIX entry type: ${entry.name}.`);
    return relative(unpacked, join(entry.parentPath, entry.name));
  });
  assert.deepEqual(files.sort(), ["AppxBlockMap.xml", ...mappings.map(([, path]) => path)].sort(),
    "MSIX payload differs from the package manifest and runtime file list.");
  for (const [source, target] of mappings) {
    assert.equal(await sha256File(join(unpacked, target)), await sha256File(source), `MSIX payload changed: ${target}.`);
  }
  const hash = await sha256File(pending);
  await rename(pending, destination);
  console.log(stdout.trim());
  console.log(`MSIX SHA-256: ${hash}`);
  console.log(destination);
} finally {
  await rm(stage, { recursive: true, force: true });
}
