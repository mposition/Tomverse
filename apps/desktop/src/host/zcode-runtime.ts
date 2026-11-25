import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readlink, realpath, symlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const zCodeVersion = "0.17.1";
const windows = process.platform === "win32";

// Keep the generated Unix socket name within the platform's path limit.
export async function zCodeRuntimeTemp(fallback: string) {
  return windows ? fallback : realpath("/tmp");
}

const mac = process.platform === "darwin";
const linux = process.platform === "linux" && process.arch === "x64";
const macReleases = {
  arm64: { bytes: 265_507_977, digest: "4adce3f8cd5a75d87fa11ad9a0ba76d6adf66d4e9f6abb14fccf9c179a7489d3", snapshot: "arm64" },
  x64: { bytes: 272_165_323, digest: "6a6f78910c4375e1ce9489e27f84d56dd03d79eddeb772d4ae8359c366221204", snapshot: "x86_64" },
};
const macRelease = mac && (process.arch === "arm64" || process.arch === "x64") ? macReleases[process.arch] : undefined;
export const zCodeRuntimeSupported = Boolean(macRelease) || linux || (windows && process.arch === "x64");
const cliEntry = "resources/glm/zcode.cjs";
const providerConfig = "resources/config/provider/zcode-builtin.json";
const macEntry = "Contents/Resources/glm/zcode.cjs";
const macConfig = "Contents/Resources/config/provider/zcode-builtin.json";
const macHelper = "Contents/Frameworks/ZCode Helper.app/Contents";
const macExecutable = `${macHelper}/MacOS/ZCode Helper`;
const framework = "Contents/Frameworks/Electron Framework.framework";
const frameworkVersion = `${framework}/Versions/A`;
const frameworkLinks = {
  "Electron Framework": "Versions/Current/Electron Framework",
  Helpers: "Versions/Current/Helpers",
  Libraries: "Versions/Current/Libraries",
  Resources: "Versions/Current/Resources",
  "Versions/Current": "A",
};
const frameworkLocales = ["en", "en_FEMININE", "en_GB", "en_GB_FEMININE", "en_GB_MASCULINE", "en_GB_NEUTER",
  "en_MASCULINE", "en_NEUTER", "zh_CN", "zh_CN_FEMININE", "zh_CN_MASCULINE", "zh_CN_NEUTER"];

// Files extracted from the publisher's checksum-verified ZCode 3.18.2 Windows x64 release.
const windowsRuntimeFiles = [
  ["ZCode.exe", 246_332_312, "c94539a947f41ad9535763f44c4b21ae84c0b253f602eb450782d7fca3fd26ec"],
  ["ffmpeg.dll", 3_125_656, "da610de6269c3a5877d2aee39bcf8c8c4500fc3cb8b8449d17f51fd29614eb5e"],
  ["icudtl.dat", 10_875_024, "da53f0b69843aaa43315f0f210a67e4a874b0be338f3dae08ff57b8afe76ab0d"],
  ["snapshot_blob.bin", 368_768, "ec901619d6c0d2589d30e94cb60c313b49dd9c2e4334b6deeb454ac97a67ce21"],
  ["v8_context_snapshot.bin", 742_200, "883f08309bf436fb442d1903452a69c03747ed77c5f502e88667d9aa1b706556"],
  [cliEntry, 15_634_742, "c6942c037a4c86df7d4ca3b195c2dc3c594cc490fbde0b77ee835c881651aadb"],
  [providerConfig, 261_659, "ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69"],
] as const;

// Files extracted from the publisher's ZCode 3.18.2 Linux x64 Debian package.
const linuxRuntimeFiles = [
  ["zcode", 228_605_256, "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564"],
  ["libffmpeg.so", 2_801_752, "c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638"],
  ["icudtl.dat", 10_875_024, "da53f0b69843aaa43315f0f210a67e4a874b0be338f3dae08ff57b8afe76ab0d"],
  ["snapshot_blob.bin", 368_768, "318358a565b6799c7cd42f4647a68d07c326aea80171d5b451af8f14d1bc345f"],
  ["v8_context_snapshot.bin", 742_200, "f7ce43b3433a5c36621b09b24fb1b49823dcad925c089ebe60f09aa780941aa1"],
  [cliEntry, 15_675_386, "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c"],
  [providerConfig, 253_163, "2af7b0cac658e9507413f5b1f5f9754e17c18fd29745522592d8b6ae699030ab"],
] as const;
const portableExecutable = linux ? "zcode" : "ZCode.exe";

async function copyRuntimeFile(source: string, limit: number, output: string | undefined, executable: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const canonical = await realpath(source);
  if (windows ? canonical.toLowerCase() !== source.toLowerCase() : canonical !== source) {
    throw new Error("The ZCode runtime contains a linked path.");
  }
  const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let staged: FileHandle | undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || (executable && !(stat.mode & 0o111))) {
      throw new Error("The ZCode runtime file size or permissions are invalid.");
    }
    if (output) {
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      staged = await open(output, "wx", executable ? 0o700 : 0o600);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ start: 0, end: stat.size - 1, autoClose: false })) {
      signal?.throwIfAborted();
      hash.update(chunk);
      await staged?.writeFile(chunk, { signal });
      bytes += chunk.length;
    }
    if (bytes !== stat.size || (await file.stat()).size !== bytes || (staged && (await staged.stat()).size !== bytes)) {
      throw new Error("The ZCode runtime file changed during verification.");
    }
    return { bytes, digest: hash.digest("hex") };
  } finally {
    await Promise.all([file.close(), staged?.close()]);
  }
}

async function verifyMacRuntime(root: string, destination: string | undefined, release: typeof macReleases.arm64, signal?: AbortSignal) {
  const requiredExecutables = new Set([
    `${frameworkVersion}/Electron Framework`, `${frameworkVersion}/Helpers/chrome_crashpad_handler`,
    `${frameworkVersion}/Libraries/libffmpeg.dylib`, `${frameworkVersion}/Libraries/libvk_swiftshader.dylib`, macExecutable, macEntry,
  ]);
  // Preserve the signed helper and framework layout from the publisher's 3.18.2 app bundles.
  const names = [
    ...requiredExecutables,
    `${frameworkVersion}/Libraries/vk_swiftshader_icd.json`,
    `${frameworkVersion}/_CodeSignature/CodeResources`,
    ...["Info.plist", "MainMenu.nib", "chrome_100_percent.pak", "chrome_200_percent.pak", "icudtl.dat", "resources.pak",
      `v8_context_snapshot.${release.snapshot}.bin`, ...frameworkLocales.map((locale) => `${locale}.lproj/locale.pak`)]
      .map((name) => `${frameworkVersion}/Resources/${name}`),
    `${macHelper}/Info.plist`, `${macHelper}/PkgInfo`, `${macHelper}/_CodeSignature/CodeResources`, "Contents/Info.plist", macConfig,
  ].sort();
  for (const [name, target] of Object.entries(frameworkLinks)) {
    if (await readlink(join(root, framework, name)) !== target) throw new Error("The ZCode framework link changed.");
  }
  const hash = createHash("sha256");
  let remaining = release.bytes;
  for (const name of names) {
    const executable = requiredExecutables.has(name);
    const output = destination && join(destination, name);
    const { bytes, digest } = await copyRuntimeFile(join(root, name), remaining, output, executable, signal);
    remaining -= bytes;
    hash.update(JSON.stringify([name, bytes, digest, executable]) + "\n");
  }
  if (remaining || hash.digest("hex") !== release.digest) throw new Error("The ZCode runtime did not match its release.");
  if (destination) for (const [name, target] of Object.entries(frameworkLinks)) {
    await symlink(target, join(destination, framework, name));
  }
}

export async function verifyZCodeRuntime(root: string, options: { destination?: string; signal?: AbortSignal } = {}) {
  if (!zCodeRuntimeSupported) throw new Error("No verified ZCode runtime for this platform.");
  const { destination, signal } = options;
  if (destination) await mkdir(destination, { mode: 0o700 });
  if (macRelease) return verifyMacRuntime(root, destination, macRelease, signal);
  for (const [name, size, digest] of linux ? linuxRuntimeFiles : windowsRuntimeFiles) {
    const output = destination && join(destination, basename(name));
    const executable = linux && (name === portableExecutable || name === "libffmpeg.so");
    const verified = await copyRuntimeFile(join(root, name), size, output, executable, signal);
    if (verified.bytes !== size || verified.digest !== digest) throw new Error("The ZCode runtime file did not match its release.");
  }
}

export async function stageZCodeRuntime(root: string, destination: string, signal: AbortSignal) {
  const app = macRelease ? join(destination, "ZCode.app") : destination;
  if (macRelease) await mkdir(destination, { mode: 0o700 });
  await verifyZCodeRuntime(root, { destination: app, signal });
  if (macRelease) return { executable: join(app, macExecutable), entry: join(app, macEntry), config: join(app, macConfig) };
  return { executable: join(destination, portableExecutable), entry: join(destination, basename(cliEntry)),
    config: join(destination, basename(providerConfig)) };
}
