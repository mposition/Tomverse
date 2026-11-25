import { createHash } from "node:crypto";
import { constants, createWriteStream, watch, type FSWatcher, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize } from "node:path";
import { pipeline } from "node:stream/promises";
import type { CliPathCheck, CliProvider } from "../code-execution";
import { miniMaxRuntimeSupported, miniMaxVersion, verifyMiniMaxRuntime } from "./minimax-runtime";
import { zCodeRuntimeSupported, zCodeVersion, verifyZCodeRuntime } from "./zcode-runtime";

const executableNames = {
  openai: "codex", anthropic: "claude", google: "agy", xai: "grok", qwen: "qwen", moonshot: "kimi",
  mistral: "vibe-acp", minimax: "mcode", deepseek: "dsh", zhipu: "zcode",
} satisfies Record<CliProvider, string>;

type CliRelease = { version: string; bytes: number; sha256: string; archive?: string; aliases?: readonly string[] };
// Upstream release files verified against the publishers' release artifacts.
const x64Releases: Partial<Record<NodeJS.Platform, Partial<Record<CliProvider, CliRelease>>>> = {
  win32: {
    openai: { version: "0.171.0-alpha.13", bytes: 407428400, sha256: "180cc98d8be7b3edc1d881875692444d8462cdc00a8209c6093bc499f0918d30" },
    anthropic: { version: "2.1.278", bytes: 237232800, sha256: "006ea5c8638f67f10a5ae66bb232fd267c9f6af294e3f03f4cfcf1fd3f2cced8" },
    google: { version: "1.5.14", bytes: 238615704, sha256: "34352ef15084b2d6c71bcc6e95a232425203223245e5cae82343d69495c3bd42" },
    xai: { version: "1.0.92", bytes: 187417232, sha256: "060e51f93743b540e59c5cf9c81c0ce7b48b61c263f09235d981a6ababb1c9d7" },
    qwen: { version: "0.28.4", bytes: 75594158, sha256: "81234b13006160d5bd6b9ab2d5a072964d38796c83e23ee3395c626cb141458a", archive: "qwen-code-win-x64.zip" },
    moonshot: { version: "2.7.2", bytes: 162408736, sha256: "d976d17f1ef722fb7cc04532a4ec32dd26eabce1cc27cc77900d783312ed8a04" },
    mistral: { version: "3.1.4", bytes: 95639517, sha256: "4f8681d6e0496a258ba62acf57188961ebdfdc5799f26fe218adb43c637c7b79", archive: "vibe-acp-windows-x86_64-3.1.4.zip" },
    deepseek: { version: "0.2.2-rc.2", bytes: 86959936, sha256: "a791af95a97be205a73354c6819e95b5fe2ff40a57ef8a78d53c188ee33e9aea",
      archive: "deepseek_harness_runtime_bin-0.2.2rc2-py3-none-win_amd64.whl" },
  },
  linux: {
    openai: { version: "0.171.0-alpha.13", bytes: 315250104, sha256: "63279cf1860a285495fa0bad3c40f5eb38c3487f7425adb603bcbd49175fcaf8" },
    anthropic: { version: "2.1.278", bytes: 234119480, sha256: "5c4735937844e84f8a93306e841a5b0e12252909b07870f789b190468da147ab" },
    google: { version: "1.5.14", bytes: 273240776, sha256: "37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94" },
    xai: { version: "1.0.92", bytes: 208487936, sha256: "add4d201dbf2c0bd6077a36feb55a76939de30bae48dbb06f16b2307d38ceacb",
      aliases: ["grok-linux-x86_64", "grok-1.0.92-linux-x86_64"] },
    qwen: { version: "0.28.4", bytes: 94092856, sha256: "15d471ca7f08eed7898ec9c3dcf2e66dc8c29b61a943d0daece6cb19f48da3e7", archive: "qwen-code-linux-x64.tar.gz" },
    moonshot: { version: "2.7.2", bytes: 193596608, sha256: "7f82148d26467874400d19ee8d23ead13cece9cd0c17648a5622cae480a5a596" },
    mistral: { version: "3.1.4", bytes: 143787163, sha256: "934a79356755821a31e6ce1aee7f7f1eacb6b1e6c78901acf1eb7fc4650aece7", archive: "vibe-acp-linux-x86_64-3.1.4.tar.gz" },
    deepseek: { version: "0.2.2-rc.2", bytes: 97364370, sha256: "3c8f15a7a92b12857032995ec5dbcc105f192c36218e9b6bb2c5b54b4ee7db17",
      archive: "deepseek_harness_runtime_bin-0.2.2rc2-py3-none-manylinux_2_28_x86_64.whl" },
  },
  darwin: {
    openai: { version: "0.171.0-alpha.13", bytes: 321344960, sha256: "1f038c1894253c1f6683151ff90cce6cae598660ab97ccd7cefbb7e2ef13ddde" },
    anthropic: { version: "2.1.278", bytes: 226521952, sha256: "c522425e3d42275d2ac2238757ef8ba7f80d165a934044ec5a7a5fd7d7b9950b", aliases: ["2.1.278"] },
    google: { version: "1.5.15", bytes: 239426624, sha256: "1a45164a87a4c4de58c2dfbc149258f54c23feb0ce88fb8226065ec1fae64c3d", aliases: ["antigravity"] },
    xai: { version: "1.0.92", bytes: 205385984, sha256: "66b7a3ef1d647280ac649b68d89b5a3d4800b1ae9df76707c011e2d400858ea9",
      aliases: ["grok-macos-x86_64", "grok-1.0.92-macos-x86_64"] },
    qwen: { version: "0.28.4", bytes: 88262161, sha256: "153a84eb5d2b00fa17725845f092cf59823f4baa0db3dfa9bc0dcff91caabcf6", archive: "qwen-code-darwin-x64.tar.gz" },
    moonshot: { version: "2.7.2", bytes: 193337344, sha256: "b69233ea5ab212dd0ef9e8253dc665736b6b8f8915a0da753cb110bd4304ff45" },
    mistral: { version: "3.1.4", bytes: 97780703, sha256: "a5e2fac0ec4ea09c7c8fd218ae2acbb9b830ecd071668fe7f4293e793a104940", archive: "vibe-acp-darwin-x86_64-3.1.4.tar.gz" },
    deepseek: { version: "0.2.2-rc.2", bytes: 94953513, sha256: "3abb396390e34fc699119060302531d71ec0df6a79adf070572d77715ba1f395",
      archive: "deepseek_harness_runtime_bin-0.2.2rc2-py3-none-macosx_14_0_x86_64.whl" },
  },
};
const appleSiliconReleases: Partial<Record<CliProvider, CliRelease>> = {
  openai: { version: "0.171.0-alpha.13", bytes: 298723264, sha256: "be5f903f68732bb9ee8157b8a346d964cee0f67748ecac11e413b26cb2c77c84" },
  anthropic: { version: "2.1.278", bytes: 217695408, sha256: "bd245662fb8a0e321b3bf133e930371d6563c387527885f30b2613aef3ba14d6", aliases: ["2.1.278"] },
  google: { version: "1.5.15", bytes: 229617904, sha256: "8097b24de18aba93324ee24d0d3f060906c58ba58562f4f1bd66f380906056a2", aliases: ["antigravity"] },
  xai: { version: "1.0.92", bytes: 190640272, sha256: "8b5f67b24f2cc9a4341d8e2eb7f67e3228d7d647ed04752a4f932f7133e5ab08",
    aliases: ["grok-macos-aarch64", "grok-1.0.92-macos-aarch64"] },
  qwen: { version: "0.28.4", bytes: 86969906, sha256: "993c10208cca5f3018f14b19d6791b88fa4f5f3f401388217a1cbf517d028f55", archive: "qwen-code-darwin-arm64.tar.gz" },
  moonshot: { version: "2.7.2", bytes: 190995520, sha256: "f97206f936eda7d446fcb4fb67d8029da0efe7f8b5f2bee404ed6577eaac604c" },
  mistral: { version: "3.1.4", bytes: 94170394, sha256: "4492735d66b615cb321e19e762199df957744ff9f8e7cccaf39fbebd55cad8a0", archive: "vibe-acp-darwin-aarch64-3.1.4.tar.gz" },
  deepseek: { version: "0.2.2-rc.2", bytes: 91559131, sha256: "76ac8fe84e6999e14a2229e20cbcaa819dc22b5bfaa40abb0fe810db8a31abc7",
    archive: "deepseek_harness_runtime_bin-0.2.2rc2-py3-none-macosx_14_0_arm64.whl" },
};

type VerifiedCliPathInspection = { status: "pathVerified"; version: string; file: string; fileStamp?: string };
type CliPathInspection = Exclude<CliPathCheck, { status: "pathVerified" }> | VerifiedCliPathInspection;

const windows = process.platform === "win32";
const windowsShim = /\.(?:cmd|bat|com|ps1|js|vbs|lnk)$/i;
const localReadFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const releases = process.arch === "x64" ? x64Releases[process.platform]
  : process.platform === "darwin" && process.arch === "arm64" ? appleSiliconReleases : undefined;
export const releaseArchiveName = (provider: CliProvider) => releases?.[provider]?.archive;

export function supportsCliPath(provider: CliProvider): boolean {
  if (provider === "minimax") return miniMaxRuntimeSupported;
  if (provider === "zhipu") return zCodeRuntimeSupported;
  return Boolean(releases?.[provider]);
}

function isLocalPath(path: string) {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !windows || (/^[a-z]:[\\/]/i.test(path) && !path.slice(2).includes(":"));
}

function fileStamp({ dev, ino, size, mode, mtimeMs, ctimeMs }: Stats) {
  return JSON.stringify([dev, ino, size, mode, mtimeMs, ctimeMs]);
}

async function matchesFileFormat(file: FileHandle, size: number, nodeBundle: boolean, archive?: string) {
  const header = Buffer.alloc(64);
  const { bytesRead } = await file.read(header, 0, header.length, 0);
  if (archive) return archive.endsWith(".tar.gz") ? header.toString("hex", 0, 2) === "1f8b" : header.toString("hex", 0, 4) === "504b0304";
  if (nodeBundle) return /^#![^\r\n]*\bnode\b/.test(header.toString("utf8"));
  if (windows) {
    if (bytesRead < header.length || header.toString("ascii", 0, 2) !== "MZ") return false;
    const offset = header.readUInt32LE(60);
    const pe = Buffer.alloc(24);
    if (offset < header.length || offset > size - pe.length) return false;
    await file.read(pe, 0, pe.length, offset);
    const flags = pe.readUInt16LE(22);
    return pe.toString("ascii", 0, 4) === "PE\0\0" && (flags & 0x0002) !== 0 && (flags & 0x2000) === 0;
  }
  if (process.platform === "darwin") {
    const cpuType = process.arch === "arm64" ? 0x0100000c : 0x01000007;
    // Pinned macOS builds are thin, little-endian 64-bit Mach-O executables.
    return bytesRead >= 32 && header.readUInt32LE(0) === 0xfeedfacf &&
      header.readUInt32LE(4) === cpuType && header.readUInt32LE(12) === 2;
  }
  return process.platform === "linux" &&
    (header.toString("ascii", 0, 2) === "#!" || header.toString("hex", 0, 4) === "7f454c46");
}

export async function inspectCliPath(provider: CliProvider, selectedPath: string, signal?: AbortSignal): Promise<CliPathInspection> {
  if (!isLocalPath(selectedPath)) return { status: "invalidPath" };
  if (!supportsCliPath(provider)) return { status: "unsupportedPlatform" };
  if (windows && windowsShim.test(selectedPath)) return { status: "windowsShim" };
  const zcodeBundle = provider === "zhipu" && basename(selectedPath).toLowerCase() === "zcode.cjs";
  if (provider === "minimax" || (provider === "zhipu" && !zcodeBundle)) {
    try {
      const root = await realpath(selectedPath);
      if (!isLocalPath(root)) return { status: "invalidPath" };
      if (!(await lstat(root)).isDirectory()) return { status: "wrongFile" };
      try {
        if (provider === "minimax") await verifyMiniMaxRuntime(root, { signal });
        else await verifyZCodeRuntime(root, { signal });
        return { status: "pathVerified", version: provider === "minimax" ? miniMaxVersion : zCodeVersion, file: root };
      } catch {
        return { status: "versionUnverified" };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { status: code === "ENOENT" || code === "ENOTDIR" ? "fileMissing" : "checkFailed" };
    }
  }
  const filename = basename(selectedPath);
  const name = windows ? basename(filename, extname(filename)).toLowerCase() : filename;
  const release = releases?.[provider];
  const archive = filename.toLowerCase() === release?.archive ? release.archive : undefined;
  const codexReleaseName = provider === "openai" && /^codex-(?:x86_64|aarch64)-(?:pc-windows-msvc|apple-darwin|unknown-linux-(?:gnu|musl))$/.test(name);
  const executableName = name === executableNames[provider] || codexReleaseName || release?.aliases?.includes(name);
  if (!zcodeBundle && !archive && (!executableName || (windows && extname(filename).toLowerCase() !== ".exe"))) {
    return { status: "wrongFile" };
  }
  try {
    const target = await realpath(selectedPath);
    if (!isLocalPath(target)) return { status: "invalidPath" };
    if (windows && extname(target).toLowerCase() !== extname(filename).toLowerCase()) return { status: "windowsShim" };
    const before = await lstat(target);
    if (!before.isFile() || (!windows && !zcodeBundle && !archive && !(before.mode & 0o111))) return { status: "wrongFile" };
    const file = await open(target, localReadFlags);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || !await matchesFileFormat(file, opened.size, zcodeBundle, archive)) {
        return { status: "wrongFile" };
      }
      if (!release || (release.archive && !archive) || opened.size !== release.bytes) return { status: "versionUnverified" };
      const hash = createHash("sha256");
      // Read only the selected build's declared length, even if the file grows during inspection.
      for await (const chunk of file.createReadStream({ start: 0, end: opened.size - 1, autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
      const stamp = fileStamp(opened);
      if (fileStamp(await lstat(target)) !== stamp ||
          await realpath(selectedPath) !== target) return { status: "checkFailed" };
      return hash.digest("hex") === release.sha256
        ? { status: "pathVerified", version: release.version, file: target, fileStamp: stamp } : { status: "versionUnverified" };
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" || code === "ENOTDIR" ? "fileMissing" : "checkFailed" };
  }
}

export async function cliPathStillMatches(provider: CliProvider, selected: string, checked: VerifiedCliPathInspection, signal?: AbortSignal) {
  try {
    if (checked.fileStamp !== undefined) {
      return await realpath(selected) === checked.file && fileStamp(await lstat(checked.file)) === checked.fileStamp;
    }
    // Verify a multi-file installation once more with its watcher already active.
    const current = await inspectCliPath(provider, selected, signal);
    return current.status === "pathVerified" && current.file === checked.file && current.version === checked.version;
  } catch {
    return false;
  }
}

export function watchVerifiedCliPath(provider: CliProvider, selected: string, target: string, onChange: () => void) {
  const watchers: FSWatcher[] = [];
  const key = (path: string) => windows ? normalize(path).toLowerCase() : normalize(path);
  function close() {
    for (const watcher of watchers.splice(0)) watcher.close();
  }
  function invalidate() {
    if (!watchers.length) return;
    close();
    onChange();
  }
  function attach(path: string, recursive: boolean, name?: string) {
    const watcher = watch(path, { persistent: false, recursive }, (_event, changed) => {
      if (!name || !changed || key(changed) === key(name)) invalidate();
    });
    watcher.on("error", invalidate);
    watchers.push(watcher);
  }
  try {
    // The parent reports replacements even when an update swaps the file's inode.
    attach(dirname(target), false, basename(target));
    if (key(selected) !== key(target)) attach(dirname(selected), false, basename(selected));
    if (provider === "minimax" || (provider === "zhipu" && basename(selected).toLowerCase() !== "zcode.cjs")) {
      attach(target, true);
    }
    return close;
  } catch {
    // Re-checking an installation before using it is still required if the filesystem cannot watch it.
    close();
    return undefined;
  }
}

export async function stageCliArchive(provider: CliProvider, source: string, destination: string, version: string, signal: AbortSignal) {
  const release = releases?.[provider];
  if (!release?.archive || release.version !== version || basename(destination) !== release.archive) {
    throw new Error("The CLI release archive could not be verified.");
  }
  await stageCliRelease(provider, release, source, destination, signal);
}

export async function stageCliExecutable(provider: CliProvider, source: string, directory: string, version: string, signal: AbortSignal) {
  const release = releases?.[provider];
  if (!release || release.archive || release.version !== version) throw new Error("The CLI executable release could not be verified.");
  const filename = windows ? executableNames[provider] + ".exe" : executableNames[provider];
  const destination = join(directory, filename);
  await stageCliRelease(provider, release, source, destination, signal);
  return destination;
}

async function stageCliRelease(provider: CliProvider, release: CliRelease, source: string, destination: string, signal: AbortSignal) {
  const asset = release.archive ? "archive" : "executable";
  const file = await open(source, localReadFlags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== release.bytes) throw new Error(`The CLI ${asset} changed before staging.`);
    await pipeline(file.createReadStream({ start: 0, end: release.bytes - 1, autoClose: false }),
      createWriteStream(destination, { flags: "wx", mode: release.archive ? 0o600 : 0o700 }), { signal });
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
  const staged = await inspectCliPath(provider, destination, signal);
  if (staged.status !== "pathVerified" || staged.version !== release.version) throw new Error(`The staged CLI ${asset} did not match its release.`);
}
