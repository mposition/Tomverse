import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { cliScanProviders, type CliLogin, type CliPathCheck, type CliProvider, type CliScanCandidate, type CliScanEntry } from "../code-execution";
import { cliExecutableNames, cliPathStillMatches, inspectCliPath, localReadFlags } from "./provider-cli-path";

// The scan only reads names, small wrapper files and file headers. It never starts a program: a wrapper is read as text
// and mapped to the native executable it starts by fixed patterns, and every candidate then goes through the same pinned
// release check as a file the person picked by hand.

type PathModule = typeof posix;
const pathFor = (platform: NodeJS.Platform): PathModule => platform === "win32" ? win32 : posix;

export const SCAN_LIMITS = {
  pathEntries: 64, versionFolders: 24, programFolders: 80, packageFolders: 200, directories: 400,
  directoryEntries: 20_000, wrapperBytes: 32_768, candidatesPerProvider: 6,
} as const;

export type ScanDirectory = {
  directory: string;
  /** Immediate subfolders to look in as well, each with the optional trailing folders appended. */
  children?: { pattern?: RegExp; max: number; subpaths: readonly string[] };
};

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== "win32") return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function isLocalAbsolute(path: string, platform: NodeJS.Platform) {
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  if (platform === "win32") return /^[a-z]:[\\/]/i.test(path) && !path.slice(2).includes(":") && !path.startsWith("\\\\");
  return path.startsWith("/");
}

export function scanHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const configured = platform === "win32" ? envValue(env, "USERPROFILE", platform) : envValue(env, "HOME", platform);
  return configured && isLocalAbsolute(configured, platform) ? configured : homedir();
}

/** The fixed places a provider CLI is installed to, in search order. Pure: it reads nothing from the disk. */
export function cliScanDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home = scanHome(env, platform)): ScanDirectory[] {
  const path = pathFor(platform);
  const list: ScanDirectory[] = [];
  const add = (directory: string | undefined, children?: ScanDirectory["children"]) => {
    if (directory && isLocalAbsolute(directory, platform)) list.push({ directory: path.normalize(directory), ...(children ? { children } : {}) });
  };
  const variable = (name: string) => envValue(env, name, platform);
  const separator = platform === "win32" ? ";" : ":";
  for (const entry of (variable("PATH") ?? "").split(separator).slice(0, SCAN_LIMITS.pathEntries * 2)) {
    if (list.length >= SCAN_LIMITS.pathEntries) break;
    add(entry.trim().replace(/^"(.*)"$/, "$1"));
  }
  const versionFolder = /^v?\d+\.\d+\.\d+$/;
  if (platform === "win32") {
    const appData = variable("APPDATA") ?? path.join(home, "AppData", "Roaming");
    const localAppData = variable("LOCALAPPDATA") ?? path.join(home, "AppData", "Local");
    add(path.join(appData, "npm"));
    add(variable("NVM_SYMLINK"));
    const nvmHome = variable("NVM_HOME");
    add(nvmHome, nvmHome ? { pattern: versionFolder, max: SCAN_LIMITS.versionFolders, subpaths: [""] } : undefined);
    add(path.join(home, ".local", "bin"));
    // The installers of Qwen Code (a folder named for the program), Grok Build and Kimi Code put a single executable under their own home folder.
    add(path.join(home, ".qwen", "bin"));
    add(path.join(home, ".qwen", "bin", "qwen"));
    add(path.join(home, ".grok", "bin"));
    add(path.join(home, ".kimi-code", "bin"));
    add(path.join(home, ".npm-global"));
    add(path.join(home, ".npm-global", "bin"));
    add(path.join(localAppData, "agy", "bin"));
    add(path.join(localAppData, "Programs"), { max: SCAN_LIMITS.programFolders, subpaths: ["", "bin"] });
    add(path.join(localAppData, "Microsoft", "WinGet", "Links"));
    const programFiles = variable("ProgramFiles");
    if (programFiles) add(path.join(programFiles, "WinGet", "Links"));
    add(path.join(localAppData, "Microsoft", "WinGet", "Packages"), { max: SCAN_LIMITS.packageFolders, subpaths: [""] });
  } else {
    add(variable("NVM_BIN"));
    add("/opt/homebrew/bin");
    add("/usr/local/bin");
    if (platform === "linux") add("/home/linuxbrew/.linuxbrew/bin");
    add(path.join(home, ".local", "bin"));
    add(path.join(home, ".qwen", "bin"));
    add(path.join(home, ".qwen", "bin", "qwen"));
    add(path.join(home, ".grok", "bin"));
    add(path.join(home, ".kimi-code", "bin"));
    add(path.join(home, ".npm-global", "bin"));
    const nvm = variable("NVM_DIR");
    add(path.join(nvm && isLocalAbsolute(nvm, platform) ? nvm : path.join(home, ".nvm"), "versions", "node"),
      { pattern: versionFolder, max: SCAN_LIMITS.versionFolders, subpaths: ["bin"] });
  }
  return list;
}

/** A folder entry. `directory` is true for a folder or a link that may lead to one; `link` marks links. */
type DirectoryReader = (directory: string) => Promise<Array<{ name: string; directory: boolean; link?: boolean }>>;
const readDirectory: DirectoryReader = async (directory) =>
  (await readdir(directory, { withFileTypes: true })).slice(0, SCAN_LIMITS.directoryEntries)
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() || entry.isSymbolicLink(), link: entry.isSymbolicLink() }));

/** Expands the subfolders, drops duplicates and anything that is not a local absolute path. */
export async function expandScanDirectories(list: readonly ScanDirectory[], platform: NodeJS.Platform, read: DirectoryReader = readDirectory) {
  const path = pathFor(platform);
  const seen = new Set<string>();
  const result: string[] = [];
  const key = (directory: string) => platform === "win32" ? directory.toLowerCase().replace(/[\\/]+$/, "") : directory.replace(/\/+$/, "");
  const push = (directory: string) => {
    if (result.length >= SCAN_LIMITS.directories || !isLocalAbsolute(directory, platform) || seen.has(key(directory))) return;
    seen.add(key(directory));
    result.push(directory);
  };
  for (const { directory, children } of list) {
    push(directory);
    if (!children) continue;
    let names: Awaited<ReturnType<DirectoryReader>>;
    try { names = await read(directory); } catch { continue; }
    const folders = names.filter((entry) => entry.directory && (!children.pattern || children.pattern.test(entry.name)))
      .map((entry) => entry.name).sort().slice(0, children.max);
    for (const name of folders) for (const subpath of children.subpaths) push(subpath ? path.join(directory, name, subpath) : path.join(directory, name));
  }
  return result;
}

// ---- Command wrappers -------------------------------------------------------------------------------------------

type PackageSpec = {
  /** The npm package that ships the command, as a folder path under node_modules. */
  name: string;
  /** Files of that package a wrapper may start, relative to the package folder. */
  entries: readonly string[];
  /** Where the package's native executable can be, nearest first. */
  natives(root: { package: string; modules: string }, platform: NodeJS.Platform, arch: string): string[];
};

const nativeSuffix = (platform: NodeJS.Platform, arch: string) => `${platform}-${arch}`;
const openAiTriples: Partial<Record<NodeJS.Platform, Record<string, string>>> = {
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
};

const packageSpecs: Partial<Record<CliProvider, PackageSpec>> = {
  openai: {
    name: "@openai/codex", entries: ["bin/codex.js"],
    natives({ package: root, modules }, platform, arch) {
      const path = pathFor(platform);
      const triple = openAiTriples[platform]?.[arch];
      if (!triple) return [];
      const exe = platform === "win32" ? "codex.exe" : "codex";
      const platformPackage = "@openai/codex-" + nativeSuffix(platform, arch);
      // The platform package is nested under the command's package, or hoisted next to it; older releases kept the vendor folder inside it.
      return [path.join(root, "node_modules", platformPackage), path.join(modules, platformPackage), root]
        .flatMap((base) => [path.join(base, "vendor", triple, "bin", exe), path.join(base, "vendor", triple, "codex", exe)]);
    },
  },
  anthropic: {
    name: "@anthropic-ai/claude-code", entries: ["bin/claude.exe", "cli.js"],
    natives({ package: root, modules }, platform, arch) {
      const path = pathFor(platform);
      const exe = platform === "win32" ? "claude.exe" : "claude";
      const platformPackage = "@anthropic-ai/claude-code-" + nativeSuffix(platform, arch);
      return [path.join(root, "bin", "claude.exe"), path.join(root, "node_modules", platformPackage, exe), path.join(modules, platformPackage, exe)];
    },
  },
};

const wrapperSegment = /^[A-Za-z0-9@._~+-]+$/;

/** The one relative `node_modules/...` file a npm wrapper starts, or null when it names none or several. */
export function wrapperTarget(text: string): string | null {
  const targets = new Set<string>();
  const patterns = [
    /"%~?dp0%?[\\/]+(node_modules[\\/][^"%\r\n]+)"/gi, // npm .cmd wrapper
    /"\$basedir[\\/](node_modules\/[^"$\r\n]+)"/g, // npm .ps1 and sh wrapper
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) targets.add(match[1].replaceAll("\\", "/"));
  if (targets.size !== 1) return null;
  const [target] = targets;
  const segments = target.split("/");
  // Only plain names: no parent folders, drive letters, shares, variables or empty segments.
  return segments.length >= 3 && segments.every((segment) => wrapperSegment.test(segment) && segment !== "." && segment !== "..") ? target : null;
}

/** Splits `node_modules/<package>/<entry>` for the provider's package; null when it is some other package or file. */
function packageEntry(provider: CliProvider, relative: string) {
  const spec = packageSpecs[provider];
  if (!spec) return null;
  const prefix = "node_modules/" + spec.name + "/";
  if (!relative.startsWith(prefix)) return null;
  const entry = relative.slice(prefix.length);
  return spec.entries.includes(entry) ? { spec, entry } : null;
}

const within = (child: string, parent: string, platform: NodeJS.Platform) => {
  const path = pathFor(platform);
  const lower = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(lower(parent), lower(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

type Resolution = { path: string; via?: string } | { unresolved: string };
export type ScanFileSystem = {
  lstat: typeof lstat; realpath: typeof realpath; header(file: string, bytes: number): Promise<Buffer>; text(file: string): Promise<string | null>;
};
const diskFileSystem: ScanFileSystem = {
  lstat, realpath,
  async header(file, bytes) {
    const handle = await open(file, localReadFlags);
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  },
  async text(file) {
    const handle = await open(file, localReadFlags);
    try {
      const { size } = await handle.stat();
      if (size > SCAN_LIMITS.wrapperBytes) return null;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  },
};

const isNativeHeader = (header: Buffer) => {
  const word = header.length >= 4 ? header.readUInt32BE(0) : 0;
  return header.toString("ascii", 0, 2) === "MZ" || word === 0x7f454c46 || word === 0xfeedfacf || word === 0xcffaedfe ||
    word === 0xcafebabe || word === 0xbebafeca;
};

async function regularFile(files: ScanFileSystem, file: string) {
  try { return (await files.lstat(file)).isFile(); } catch { return false; }
}

async function nativeFor(provider: CliProvider, packageRoot: string, modules: string, platform: NodeJS.Platform, arch: string, files: ScanFileSystem) {
  const spec = packageSpecs[provider];
  if (!spec) return null;
  let modulesReal: string;
  try { modulesReal = await files.realpath(modules); } catch { return null; }
  for (const candidate of spec.natives({ package: packageRoot, modules }, platform, arch)) {
    if (!await regularFile(files, candidate)) continue;
    try {
      // The native file must stay inside the node_modules folder the wrapper belongs to, wherever its links lead.
      if (!within(await files.realpath(candidate), modulesReal, platform)) continue;
      return candidate;
    } catch { /* A candidate that vanished is skipped. */ }
  }
  return null;
}

/** Maps a wrapper that sits next to a node_modules folder to the native executable it starts. */
async function resolveWrapper(provider: CliProvider, wrapper: string, text: string, platform: NodeJS.Platform, arch: string, files: ScanFileSystem): Promise<Resolution> {
  const path = pathFor(platform);
  const relative = wrapperTarget(text);
  const target = relative && packageEntry(provider, relative);
  if (!relative || !target) return { unresolved: wrapper };
  const modules = path.join(path.dirname(wrapper), "node_modules");
  const packageRoot = path.join(path.dirname(wrapper), "node_modules", ...target.spec.name.split("/"));
  const native = await nativeFor(provider, packageRoot, modules, platform, arch, files);
  return native ? { path: native, via: wrapper } : { unresolved: wrapper };
}

/** A link whose target is the provider package's JavaScript entry, the way Unix npm installs the command. */
async function resolveEntryLink(provider: CliProvider, link: string, real: string, platform: NodeJS.Platform, arch: string, files: ScanFileSystem): Promise<Resolution> {
  const spec = packageSpecs[provider];
  const path = pathFor(platform);
  const normalized = real.replaceAll("\\", "/");
  const entry = spec?.entries.find((candidate) => normalized.endsWith("/node_modules/" + spec.name + "/" + candidate));
  if (!spec || !entry) return { unresolved: link };
  const packageRoot = path.normalize(real.slice(0, real.length - entry.length - 1));
  const modules = path.dirname(spec.name.includes("/") ? path.dirname(packageRoot) : packageRoot);
  const native = await nativeFor(provider, packageRoot, modules, platform, arch, files);
  return native ? { path: native, via: link } : { unresolved: link };
}

export async function resolveFoundFile(provider: CliProvider, file: string, platform: NodeJS.Platform, arch: string, files: ScanFileSystem = diskFileSystem): Promise<Resolution> {
  const path = pathFor(platform);
  try {
    if (platform === "win32") {
      const extension = path.extname(file).toLowerCase();
      if (extension === ".exe") return { path: file };
      const header = await files.header(file, 4);
      if (isNativeHeader(header)) return { unresolved: file };
      const text = await files.text(file);
      return text === null ? { unresolved: file } : await resolveWrapper(provider, file, text, platform, arch, files);
    }
    const real = await files.realpath(file);
    if (!isLocalAbsolute(real, platform)) return { unresolved: file };
    const header = await files.header(real, 4);
    if (isNativeHeader(header)) return { path: file };
    // npm links the command to the package's JavaScript entry; other tools write a small shell wrapper.
    if (real.endsWith(".js")) return await resolveEntryLink(provider, file, real, platform, arch, files);
    if (header.toString("ascii", 0, 2) === "#!") {
      const text = await files.text(real);
      if (text === null) return { unresolved: file };
      const result = await resolveWrapper(provider, real, text, platform, arch, files);
      return "path" in result ? { path: result.path, via: file } : { unresolved: file };
    }
    return { unresolved: file };
  } catch {
    return { unresolved: file };
  }
}

// ---- Scan -------------------------------------------------------------------------------------------------------

export type ScanOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  providers?: readonly CliProvider[];
  signal?: AbortSignal;
  inspect?: (provider: CliProvider, path: string, signal?: AbortSignal) => ReturnType<typeof inspectCliPath>;
  /** Reads a sign-in state with a read-only command. Called only for a file the pinned release check verified. */
  readLogin?: (provider: CliProvider, file: string, signal: AbortSignal) => Promise<CliLogin>;
  /** Checks that a verified file is still the one that was verified. Replaced in tests. */
  stillMatches?: typeof cliPathStillMatches;
  /** Whether the person trusted exactly this unverified file. */
  isTrusted?: (provider: CliProvider, file: string, signal: AbortSignal) => Promise<boolean>;
  read?: DirectoryReader;
  files?: ScanFileSystem;
};

type Found = { provider: CliProvider; file: string };

async function findFiles(directories: readonly string[], providers: readonly CliProvider[], platform: NodeJS.Platform, read: DirectoryReader, signal?: AbortSignal) {
  const path = pathFor(platform);
  const wanted = new Map<string, CliProvider[]>();
  for (const provider of providers) {
    for (const name of cliExecutableNames(provider)) {
      for (const variant of platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""]) {
        const key = platform === "win32" ? (name + variant).toLowerCase() : name + variant;
        wanted.set(key, [...(wanted.get(key) ?? []), provider]);
      }
    }
  }
  const found: Found[] = [];
  const rank = (name: string) => {
    const index = [".exe", ".cmd", ".ps1"].indexOf(path.extname(name).toLowerCase());
    return platform === "win32" && index === -1 ? 3 : Math.max(index, 0);
  };
  for (const directory of directories) {
    signal?.throwIfAborted();
    let entries: Awaited<ReturnType<DirectoryReader>>;
    try { entries = await read(directory); } catch { continue; }
    // Within one folder the native file comes before its wrappers, and wrappers before the bare shell script.
    entries = [...entries].sort((a, b) => rank(a.name) - rank(b.name));
    for (const entry of entries) {
      // A link is looked at even when it leads to a folder: the wrapper check refuses what is not a file.
      if (entry.directory && !entry.link && platform !== "win32") continue;
      for (const provider of wanted.get(platform === "win32" ? entry.name.toLowerCase() : entry.name) ?? []) {
        found.push({ provider, file: path.join(directory, entry.name) });
      }
    }
  }
  return found;
}

export async function scanCliProviders(options: ScanOptions = {}): Promise<CliScanEntry[]> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const providers = options.providers ?? cliScanProviders;
  const files = options.files ?? diskFileSystem;
  const inspect = options.inspect ?? inspectCliPath;
  const signal = options.signal ?? new AbortController().signal;
  const path = pathFor(platform);
  const directories = await expandScanDirectories(cliScanDirectories(platform, env, options.home ?? scanHome(env, platform)), platform, options.read);
  const found = await findFiles(directories, providers, platform, options.read ?? readDirectory, signal);
  return Promise.all(providers.map(async (provider): Promise<CliScanEntry> => {
    const entry: CliScanEntry = { provider, candidates: [], unresolvedShims: 0 };
    const unresolved = new Set<string>();
    const seen = new Set<string>();
    for (const { file } of found.filter((candidate) => candidate.provider === provider)) {
      signal.throwIfAborted();
      if (entry.candidates.length >= SCAN_LIMITS.candidatesPerProvider) break;
      const resolved = await resolveFoundFile(provider, file, platform, arch, files);
      if ("unresolved" in resolved) {
        unresolved.add(path.join(path.dirname(file), path.basename(file, path.extname(file))).toLowerCase());
        continue;
      }
      let identity: string;
      try { identity = await files.realpath(resolved.path); } catch { continue; }
      const key = platform === "win32" ? identity.toLowerCase() : identity;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = await inspectCandidate(provider, resolved, options, inspect, signal);
      if (candidate) entry.candidates.push(candidate);
    }
    // A wrapper whose native executable was found through another wrapper is resolved, not unresolved.
    entry.unresolvedShims = [...unresolved].filter((wrapper) => !entry.candidates.some((candidate) => candidate.via &&
      path.join(path.dirname(candidate.via), path.basename(candidate.via, path.extname(candidate.via))).toLowerCase() === wrapper)).length;
    return entry;
  }));
}

async function inspectCandidate(provider: CliProvider, resolved: { path: string; via?: string }, options: ScanOptions,
    inspect: NonNullable<ScanOptions["inspect"]>, signal: AbortSignal): Promise<CliScanCandidate | null> {
  let inspection: Awaited<ReturnType<typeof inspectCliPath>> | CliPathCheck;
  try { inspection = await inspect(provider, resolved.path, signal); } catch { return null; }
  const base = { path: resolved.path, ...(resolved.via ? { via: resolved.via } : {}) };
  if (inspection.status === "pathVerified") {
    let login: CliLogin = "unknown";
    // Only a file that matches the pinned release is started, and only with the fixed read-only sign-in command.
    if (options.readLogin && "file" in inspection) {
      try {
        const read = await options.readLogin(provider, inspection.file, signal);
        // A file replaced while it ran says nothing about the sign-in.
        if (await (options.stillMatches ?? cliPathStillMatches)(provider, resolved.path, inspection, signal)) login = read;
        else return null;
      } catch { login = "unknown"; }
    }
    return { ...base, status: "pathVerified", version: inspection.version, login, trusted: false };
  }
  if (inspection.status === "versionUnverified") {
    let trusted = false;
    try { trusted = (await options.isTrusted?.(provider, resolved.path, signal)) === true; } catch { trusted = false; }
    return { ...base, status: "versionUnverified", login: "unknown", trusted };
  }
  return null;
}
