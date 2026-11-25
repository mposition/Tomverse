import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { packager } from "@electron/packager";
import { localDevPackage } from "./local-dev-package.mjs";

const { values } = parseArgs({
  options: { platform: { type: "string" }, arch: { type: "string" }, out: { type: "string" }, version: { type: "string" },
    "task-qa": { type: "boolean" }, "dev-local": { type: "boolean" } },
});
const taskQa = values["task-qa"] === true;
const localDev = values["dev-local"] === true;
if (localDev !== (!taskQa && process.env.TOMVERSE_DESKTOP_LOCAL_DEV_UPDATE === "true")) {
  throw new Error("Build and package Local Dev with the same channel.");
}
const name = taskQa ? "Tomverse Desktop Task QA" : localDev ? localDevPackage.name : "Tomverse Desktop";
const packageName = taskQa ? "tomverse-desktop-task-qa" : localDev ? localDevPackage.packageName : "tomverse-desktop";
const appId = taskQa ? "app.tomverse.desktop.task-qa" : localDev ? "app.tomverse.desktop.local-dev" : "app.tomverse.desktop";
const host = taskQa ? "dist/host-task-qa" : "dist/host";
const platform = values.platform ?? process.platform;
const arch = values.arch ?? process.arch;
if (localDev && (platform !== "win32" || arch !== "x64")) throw new Error("Local Dev updates require Windows x64.");
if (!["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"].includes(`${platform}-${arch}`)) {
  throw new Error("Choose Windows x64, macOS x64/arm64, or Linux x64.");
}
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const require = createRequire(import.meta.url);
const electronVersion = manifest.devDependencies.electron;
const checksums = JSON.parse(await readFile(require.resolve("electron/checksums.json"), "utf8"));
const version = values.version ?? manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Use a numeric x.y.z Desktop package version.");
const out = resolve(values.out ?? (taskQa ? "dist/task-qa-package" : localDev ? "dist/local-dev-package" : "dist/package"));
await mkdir(out, { recursive: true });
const windowsStaging = platform === "win32" && process.platform === "win32";
// Keep native Windows staging with the output so the bundle inherits its access rules.
const stage = await mkdtemp(join(windowsStaging ? out : tmpdir(), "tomverse-desktop-package-"));
try {
  const app = join(stage, "app");
  await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({
    name: packageName, productName: name, version, main: manifest.main,
    desktopName: platform === "linux" ? `${appId}.desktop` : undefined,
  }));
  await cp(host, join(app, "dist", "host"), { recursive: true });
  await cp("dist/renderer", join(app, "dist", "renderer"), {
    recursive: true, filter: (path) => basename(path) !== "renderer-notices.md",
  });
  const notices = join(stage, "THIRD_PARTY_NOTICES.txt");
  await writeFile(notices, [
    "Third-party software bundled in Tomverse Desktop.",
    "Desktop host and Code runtime",
    await readFile(`${host}-notices.txt`, "utf8"),
    "Desktop interface",
    await readFile("dist/renderer/renderer-notices.md", "utf8"),
    "Roboto wordmark font",
    await readFile("../../packages/ui-tokens/src/fonts/OFL.txt", "utf8"),
    "Apple brand icon by Fonticons, Inc. (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Source: https://authjs.dev/img/providers/apple.svg.",
  ].join("\n\n"));
  const targetIcon = join(stage, "tomverse-icon.icns");
  const windowsIcon = resolve(host, "tomverse-icon.ico");
  if (platform === "darwin") {
    const image = await readFile("../../public/pwa/icon-512.png");
    const header = Buffer.alloc(16);
    header.write("icns");
    header.writeUInt32BE(header.length + image.length, 4);
    header.write("ic09", 8);
    header.writeUInt32BE(8 + image.length, 12);
    await writeFile(targetIcon, Buffer.concat([header, image]));
  }
  const bundles = await packager({
    dir: app, out, platform, arch, asar: true, prune: false, name,
    appBundleId: appId, executableName: name,
    electronVersion,
    tmpdir: windowsStaging ? stage : undefined,
    download: { checksums },
    icon: platform === "win32" ? windowsIcon : platform === "darwin" ? targetIcon : undefined,
    extendInfo: platform === "darwin" ? { ElectronSquirrelPreventDowngrades: true } : undefined,
    win32metadata: { CompanyName: "Tomverse", ProductName: name },
    osxSign: platform === "darwin" && process.platform === "darwin"
      ? { identity: "-", identityValidation: false, preAutoEntitlements: false, continueOnError: false }
      : undefined,
    extraResource: platform === "win32" ? [notices, windowsIcon] : [notices],
    afterExtract: [async ({ buildPath, platform: target }) => {
      const executable = target === "darwin" ? "Electron.app" : target === "win32" ? "electron.exe" : "electron";
      if (target === "darwin") {
        // pkgbuild installs the .app component without its neighboring files.
        const resources = join(buildPath, executable, "Contents", "Resources");
        await Promise.all(["LICENSE", "LICENSES.chromium.html"].map((file) =>
          copyFile(join(buildPath, file), join(resources, file))));
      }
      // Packager writes the archive integrity metadata and restores the macOS signature after extraction.
      await flipFuses(join(buildPath, executable), {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: taskQa,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: target !== "linux",
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      });
    }],
  });
  if (bundles.length !== 1) throw new Error(`No fresh package was produced for ${platform}-${arch}. Use a supported host and a fresh output folder.`);
  console.log(bundles[0]);
} finally {
  await rm(stage, { recursive: true, force: true });
}
