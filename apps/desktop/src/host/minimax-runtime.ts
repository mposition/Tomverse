import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const miniMaxVersion = "0.7.9";
export const miniMaxRegion = "en";
const windows = process.platform === "win32";
const target = `${process.platform}-${process.arch}`;
type Release = { nodeBytes: number; nodeSha256: string; files: number; bytes: number; fileLimit: number; sha256: string };
const releases: Partial<Record<string, Release>> = {
  "win32-x64": { nodeBytes: 85_268_464, nodeSha256: "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362",
    files: 1206, bytes: 329_717_021, fileLimit: 37_296_160, sha256: "580114d495a96c8b9a9e5d4bc0739df2d6e5ba6664c19a884c8de868e2a9d721" },
  "linux-x64": { nodeBytes: 125_989_464, nodeSha256: "bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12",
    files: 1187, bytes: 300_386_011, fileLimit: 37_296_160, sha256: "9df6a0392f0d2e11e191f44b500a5813d773f14f45e26c60a35f16fc1d72880f" },
  "darwin-arm64": { nodeBytes: 121_306_800, nodeSha256: "27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1",
    files: 1200, bytes: 361_325_810, fileLimit: 55_331_968, sha256: "6d8be745a7738285af29c90bf49124623e9e40c71c921ce719d67ff3b1b4a106" },
  "darwin-x64": { nodeBytes: 123_666_640, nodeSha256: "1052eb9c7d6c60a79b968e09f75af55a73462b0f6dff0964336d63b5e13eb63c",
    files: 1200, bytes: 361_535_851, fileLimit: 55_331_968, sha256: "7699d4aac689d035427e3e6419c0e741b650325b71e3f9a663c157297654aa9f" },
};
const runtime = releases[target];
export const miniMaxRuntimeSupported = Boolean(runtime);
const nodeFilename = windows ? "node.exe" : "node";
const nodeDirectory = windows ? "node-v22.19.0-win-x64" : `node-v24.19.0-${target}`;
const packageLocation = join("node_modules", "@minimax-ai", "code");
const installedPackageLocation = windows ? packageLocation : join("lib", packageLocation);

async function requireUnlinkedPath(path: string) {
  const canonical = await realpath(path);
  if (windows ? canonical.toLowerCase() !== path.toLowerCase() : canonical !== path) {
    throw new Error("The MiniMax runtime contains a linked path.");
  }
}

async function readRuntimeFile(path: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await requireUnlinkedPath(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("The MiniMax runtime file size is invalid.");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("The MiniMax runtime file changed while being read.");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== stat.size) throw new Error("The MiniMax runtime file changed while being read.");
    return { bytes, executable: !windows && Boolean(stat.mode & 0o111) };
  } finally {
    await file.close();
  }
}

async function packageFiles(root: string, signal?: AbortSignal) {
  const files: string[] = [];
  let entryCount = 0;
  async function visit(directory: string, depth: number) {
    signal?.throwIfAborted();
    if (depth > 32) throw new Error("The MiniMax package directory is too deep.");
    await requireUnlinkedPath(directory);
    for await (const entry of await opendir(directory)) {
      if (++entryCount > 2400) throw new Error("The MiniMax package contains too many entries.");
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      // This npm installation receipt can contain paths specific to the installer.
      if (name === "node_modules/.package-lock.json") continue;
      // POSIX npm links entry points here. Only their pinned target files are staged.
      if (!windows && name === "node_modules/.bin") continue;
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile()) files.push(name);
      else throw new Error("The MiniMax package contains a linked or special file.");
    }
  }
  await visit(root, 0);
  return files.sort();
}

export async function verifyMiniMaxRuntime(root: string, options: { destination?: string; signal?: AbortSignal } = {}) {
  if (!runtime) throw new Error("No verified MiniMax runtime for this platform.");
  const { destination, signal } = options;
  const release = (await readRuntimeFile(join(root, "current"), 128, signal)).bytes.toString("utf8").trim();
  const releaseFormat = windows ? /^0\.7\.9(?:-repair-\d+-[0-9a-f]{32})?$/i : /^0\.7\.9(?:-repair-\d+-\d+)?$/;
  if (!releaseFormat.test(release)) throw new Error("Unknown MiniMax release.");
  const installedNode = join(root, "runtime", nodeDirectory);
  if (!windows && await realpath(join(root, "runtime", "node")) !== installedNode) {
    throw new Error("The MiniMax installation uses a different managed Node.js runtime.");
  }
  const sourcePackage = join(root, "releases", release, installedPackageLocation);
  const files = await packageFiles(sourcePackage, signal);
  if (files.length !== runtime.files) throw new Error("The MiniMax package file count did not match its release.");
  const nodePath = windows ? join(installedNode, nodeFilename) : join(installedNode, "bin", nodeFilename);
  const node = await readRuntimeFile(nodePath, runtime.nodeBytes, signal);
  if ((!windows && !node.executable) || node.bytes.length !== runtime.nodeBytes ||
      createHash("sha256").update(node.bytes).digest("hex") !== runtime.nodeSha256) {
    throw new Error("The MiniMax Node.js runtime did not match its release.");
  }
  const digest = createHash("sha256");
  let remaining = runtime.bytes;
  for (const name of files) {
    const { bytes: data, executable } = await readRuntimeFile(join(sourcePackage, name), Math.min(remaining, runtime.fileLimit), signal);
    remaining -= data.length;
    const item = [name, data.length, createHash("sha256").update(data).digest("hex")];
    digest.update(JSON.stringify(item) + "\n");
    if (destination) {
      const output = join(destination, packageLocation, name);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, data, { flag: "wx", mode: executable ? 0o700 : 0o600, signal });
      if ((await lstat(output)).size !== data.length) throw new Error("The staged MiniMax file could not be verified.");
    }
  }
  if (remaining !== 0 || digest.digest("hex") !== runtime.sha256) throw new Error("The MiniMax package did not match its release.");
  if (destination) {
    const executable = join(destination, nodeFilename);
    await writeFile(executable, node.bytes, { flag: "wx", mode: 0o700, signal });
    if ((await lstat(executable)).size !== node.bytes.length) throw new Error("The staged MiniMax Node.js runtime could not be verified.");
  }
}

export async function stageMiniMaxRuntime(root: string, destination: string, signal: AbortSignal) {
  await verifyMiniMaxRuntime(root, { destination, signal });
  return { executable: join(destination, nodeFilename), entry: join(destination, packageLocation, "cli.js") };
}
