import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, win32, posix } from "node:path";
import { isLocalPath, localReadFlags } from "./provider-cli-path";

/**
 * MiniMax Code as the person installed it (not the pinned runtime the fixtures stage): a folder such as `~/.minimax-code`
 * holding a launcher (`mcode.cmd` or `mcode`), a `current` file with the version, and the package under
 * `releases/<version>/node_modules/@minimax-ai/code/cli.js`; or one `releases/<version>` folder itself. The launcher is a
 * script that starts an external Node, so a task starts `cli.js` with a Node executable instead (nodeExecutable below).
 * The entry file is what the person trusts; its dependencies in the same folder are not hashed.
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
export async function resolveMiniMaxInstall(folder: string): Promise<{ root: string; entry: string } | null> {
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
    return { root, entry };
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
      if (!(await regularFile(candidate))) continue;
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
