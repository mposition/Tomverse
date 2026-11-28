import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, win32, posix } from "node:path";
import { isLocalPath, localReadFlags } from "./provider-cli-path";

/**
 * MiniMax Code as the person installed it (not the pinned runtime the fixtures stage): a folder such as `~/.minimax-code`
 * holding a launcher (`mcode.cmd` or `mcode`), a `current` file with the version, and the package under
 * `releases/<version>/node_modules/@minimax-ai/code/cli.js`; or one `releases/<version>` folder itself. The launcher is a
 * script that starts an external Node, so a task starts `cli.js` with a Node executable instead (nodeExecutable below).
 * What the person trusts is the release folder as a whole (installManifest): every file the entry file can load, with the entry file
 * and the Node that runs it.
 */

const versionName = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const packageFolder = join("node_modules", "@minimax-ai", "code");

const windows = process.platform === "win32";
const fold = (value: string) => (windows ? value.toLowerCase() : value);
const within = (child: string, parent: string) => {
  const rel = relative(fold(parent), fold(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

async function regularFile(path: string) {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

/** The text of a small file (at most 64 bytes), or null. */
async function smallText(path: string) {
  try {
    const file = await open(path, localReadFlags);
    try {
      const { size } = await file.stat();
      if (size === 0 || size > 64) return null;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8").trim();
    } finally { await file.close(); }
  } catch { return null; }
}

/**
 * The install a folder holds: its real path and the real path of the entry file, which must stay inside the folder after
 * every link is resolved. Null when the folder is not a MiniMax Code install.
 */
export async function resolveMiniMaxInstall(folder: string): Promise<{ root: string; entry: string; release: string } | null> {
  try {
    if (!isLocalPath(folder)) return null;
    const root = await realpath(folder);
    if (!isLocalPath(root) || !(await lstat(root)).isDirectory()) return null;
    let release: string | null = null;
    const version = await smallText(join(root, "current"));
    if (version && versionName.test(version) && await regularFile(join(root, "releases", version, packageFolder, "cli.js"))) release = join(root, "releases", version);
    else if (await regularFile(join(root, packageFolder, "cli.js"))) release = root;
    if (!release) return null;
    const entry = await realpath(join(release, packageFolder, "cli.js"));
    if (!isLocalPath(entry) || !within(entry, root) || !(await lstat(entry)).isFile()) return null;
    return { root, entry, release };
  } catch { return null; }
}

/** What an install's release folder holds, as one digest: sorted relative path, size and SHA-256 of every file. */
export type InstallManifest = { sha256: string; files: number; bytes: number };
// Fields and lines of the manifest are told apart by characters no file name holds.
const SEPARATOR = String.fromCharCode(0);
const LINE = String.fromCharCode(10);
export const MANIFEST_LIMITS = { files: 100_000, bytes: 4 * 1024 ** 3, depth: 40 } as const;

/**
 * The digest of a MiniMax Code release folder: every file under it, by sorted relative path, size and SHA-256. Nothing is followed:
 * a link or junction anywhere in the folder (or the folder itself), anything that is neither a folder nor a regular file, a file
 * that changes while it is read, or more than the limits, makes it null, so the install is not trusted. Files are read several at a
 * time. It is read-only and starts nothing.
 */
export async function installManifest(release: string, options: { signal?: AbortSignal; concurrency?: number } = {}): Promise<InstallManifest | null> {
  const { signal, concurrency = 8 } = options;
  try {
    if (!isLocalPath(release) || (await lstat(release)).isSymbolicLink() || fold(await realpath(release)) !== fold(release)) return null;
    const found: Array<{ relative: string; absolute: string }> = [];
    const pending = [{ absolute: release, relative: "", depth: 0 }];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const { absolute, relative: prefix, depth } = pending.pop()!;
      if (depth > MANIFEST_LIMITS.depth) return null;
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const childPath = join(absolute, entry.name);
        const childRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) return null;
        if (entry.isDirectory()) {
          // A junction can look like a folder: it is asked for what it is.
          const stat = await lstat(childPath);
          if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
          pending.push({ absolute: childPath, relative: childRelative, depth: depth + 1 });
        } else if (entry.isFile()) {
          found.push({ relative: childRelative, absolute: childPath });
          if (found.length > MANIFEST_LIMITS.files) return null;
        } else return null;
      }
    }
    const lines: string[] = new Array(found.length);
    let bytes = 0;
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed) {
        signal?.throwIfAborted();
        const index = next++;
        const item = found[index];
        if (!item) return;
        const file = await open(item.absolute, localReadFlags);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) { failed = true; return; }
          const hash = createHash("sha256");
          let read = 0;
          if (stat.size > 0) for await (const chunk of file.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }) as AsyncIterable<Buffer>) { hash.update(chunk); read += chunk.length; }
          // A file that changed while it was read is not read.
          if (read !== stat.size || (await file.stat()).size !== stat.size) { failed = true; return; }
          bytes += stat.size;
          if (bytes > MANIFEST_LIMITS.bytes) { failed = true; return; }
          lines[index] = [item.relative, String(stat.size), hash.digest("hex")].join(SEPARATOR);
        } finally { await file.close(); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 32)) }, worker));
    if (failed) return null;
    const sorted = lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { sha256: createHash("sha256").update(sorted.join(LINE)).digest("hex"), files: sorted.length, bytes };
  } catch { return null; }
}

const isNativeHeader = (header: Buffer) => {
  const word = header.length >= 4 ? header.readUInt32BE(0) : 0;
  return header.toString("ascii", 0, 2) === "MZ" || word === 0x7f454c46 || word === 0xfeedfacf || word === 0xcffaedfe || word === 0xcafebabe || word === 0xbebafeca;
};

/**
 * The Node executable that runs the entry file. Electron cannot be that Node in a release build (its RunAsNode fuse is off),
 * so it is the person's own: a `node` inside the install folder, else the first real `node` executable in the folders the
 * CLI scan already looks in (never a script, never taken from the request).
 */
export async function nodeExecutable(directories: readonly string[], root: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const path = platform === "win32" ? win32 : posix;
  const name = platform === "win32" ? "node.exe" : "node";
  for (const directory of [root, ...directories]) {
    const candidate = path.join(directory, name);
    try {
      // A link is resolved first (Homebrew installs node as a link); the real file is what is checked and run.
      const real = await realpath(candidate);
      if (!isLocalPath(real) || !(await regularFile(real))) continue;
      const file = await open(real, localReadFlags);
      try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await file.read(header, 0, 4, 0);
        if (isNativeHeader(header.subarray(0, bytesRead))) return real;
      } finally { await file.close(); }
    } catch { /* A folder that cannot be read has no Node. */ }
  }
  return null;
}

/** Whether a folder is where MiniMax Code's launcher lives (used by the scan to map `mcode.cmd` to its install folder). */
export async function miniMaxInstallAt(folder: string) {
  try { await readdir(folder); } catch { return null; }
  return (await resolveMiniMaxInstall(folder)) ? folder : null;
}
