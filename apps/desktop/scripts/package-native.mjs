import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { extractFile } from "@electron/asar";
import { inspectAppArchive, inspectMacPayload, inspectPortablePayload, sha256File } from "./package-payload.mjs";

const name = "Tomverse Desktop";
const packageName = "tomverse-desktop";
const appId = "app.tomverse.desktop";
const run = promisify(execFile);
const { values } = parseArgs({ options: { out: { type: "string" }, "update-origin": { type: "string" } } });
const out = resolve(values.out ?? "dist/package");
const platform = `${process.platform}-${process.arch}`;
if (!["darwin-x64", "darwin-arm64", "linux-x64"].includes(platform)) {
  throw new Error("Build on macOS x64/arm64 or Debian x64. Use desktop:package:msix for Windows.");
}
if (values["update-origin"] !== undefined && process.platform !== "darwin") {
  throw new Error("Prepare a signed macOS update on a Mac.");
}

const bundle = join(out, `${name}-${platform}`);
const application = join(bundle, `${name}.app`);
const archive = process.platform === "darwin" ? join(application, "Contents", "Resources", "app.asar")
  : join(bundle, "resources", "app.asar");
if (process.platform === "darwin") await inspectMacPayload(application, name, process.arch);
const { manifest } = inspectAppArchive(archive);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Build the matching Tomverse Desktop bundle before packaging an installer.");
}

if (values["update-origin"] !== undefined) {
  const origin = new URL(values["update-origin"]);
  if (origin.protocol !== "https:" || origin.port || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Use the HTTPS update origin without a port or path.");
  const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", join(application, "Contents", "Info.plist")]);
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== appId || info.CFBundleShortVersionString !== manifest.version ||
      info.ElectronSquirrelPreventDowngrades !== true || !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(manifest.version)) {
    throw new Error("Build a matching macOS bundle with native downgrade protection before preparing an update.");
  }
  await run("codesign", ["--verify", "--deep", "--strict", application]);
  const signature = await run("codesign", ["--display", "--verbose=4", application]);
  if (!/^Authority=Developer ID Application: /m.test(signature.stderr)) throw new Error("A Developer ID Application signature is required.");
  await run("xcrun", ["stapler", "validate", application]);
  const release = `Tomverse-Desktop-${manifest.version}-${platform}`;
  const stage = await mkdtemp(join(out, ".mac-update-"));
  const destination = join(out, `${release}-update`);
  try {
    const zip = `${release}.zip`;
    const path = join(stage, zip);
    await run("ditto", ["-c", "-k", "--keepParent", application, path], { timeout: 180_000 });
    const [{ size }, sha256] = await Promise.all([stat(path), sha256File(path)]);
    if (!size || size > 512 * 1024 * 1024) throw new Error("The signed macOS update ZIP is outside the supported size.");
    const updateTo = {
      version: manifest.version, size, sha256,
      url: new URL(`/desktop/updates/artifacts/darwin/${process.arch}/${zip}`, origin).href,
    };
    await writeFile(join(stage, "releases.json"), JSON.stringify({
      channel: "stable", platform: "darwin", arch: process.arch, currentRelease: manifest.version,
      releases: [{ version: manifest.version, updateTo }],
    }, null, 2) + "\n", { flag: "wx" });
    await rename(stage, destination);
    console.log(destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
} else if (process.platform === "darwin") {
  const installer = join(out, `Tomverse-Desktop-${manifest.version}-${platform}.pkg`);
  await run("codesign", ["--verify", "--deep", "--strict", application]);
  await run("pkgbuild", ["--component", application, "--identifier", appId, "--version", manifest.version,
    "--install-location", "/Applications", installer]);
  console.log(installer);
} else {
  const portableFiles = await inspectPortablePayload(bundle, "linux");
  const installer = join(out, `tomverse-desktop_${manifest.version}_amd64.deb`);
  const scratch = await mkdtemp(join(tmpdir(), "tomverse-deb-"));
  const root = join(scratch, "root");
  const executables = new Set([name, "chrome_crashpad_handler", "chrome-sandbox"]);
  const originalUmask = process.umask(0o022);
  try {
    const appRoot = join(root, "usr", "lib", packageName);
    const bin = join(root, "usr", "bin");
    const applications = join(root, "usr", "share", "applications");
    const icons = join(root, "usr", "share", "icons", "hicolor", "192x192", "apps");
    const doc = join(root, "usr", "share", "doc", packageName);
    const control = join(root, "DEBIAN");
    await Promise.all([bin, applications, icons, doc, control, join(appRoot, "locales"), join(appRoot, "resources")]
      .map((dir) => mkdir(dir, { recursive: true })));
    await chmod(root, 0o755);
    await Promise.all(portableFiles.map(async (file) => {
      const destination = join(appRoot, file);
      await copyFile(join(bundle, file), destination);
      await chmod(destination, executables.has(file) ? 0o755 : 0o644);
    }));
    await symlink(`../lib/${packageName}/${name}`, join(bin, packageName));
    await writeFile(join(applications, `${appId}.desktop`), [
      "[Desktop Entry]", "Type=Application", `Name=${name}`, `Exec=${packageName}`,
      `Icon=${appId}`, "Terminal=false", "Categories=Utility;", "",
    ].join("\n"));
    await writeFile(join(control, "control"), [
      `Package: ${packageName}`, `Version: ${manifest.version}`, "Architecture: amd64",
      "Maintainer: Tomverse <support@tomverse.app>", "Homepage: https://tomverse.app",
      "Priority: optional", "Section: utils",
      "Depends: libasound2, libatk-bridge2.0-0, libcups2, libdrm2, libgbm1, libgtk-3-0, libnotify4, libnss3, libx11-xcb1, libxss1, libxtst6, libsecret-1-0, xdg-utils",
      "Description: Tomverse Chat, Review and Code desktop workspaces", "",
    ].join("\n"));
    await writeFile(join(icons, `${appId}.png`), extractFile(archive, join("dist", "host", "tomverse-icon.png")));
    const copyright = join(doc, "copyright");
    await copyFile(join(bundle, "LICENSE"), copyright);
    await chmod(copyright, 0o644);
    await symlink(`../../../lib/${packageName}/resources/THIRD_PARTY_NOTICES.txt`, join(doc, "THIRD_PARTY_NOTICES.txt"));
    await run("dpkg-deb", ["--root-owner-group", "--build", root, installer], { timeout: 120_000 });
    console.log(installer);
  } finally {
    process.umask(originalUmask);
    await rm(scratch, { recursive: true, force: true });
  }
}
