import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const version = z.string().regex(/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/);
const architecture = z.enum(["arm64", "x64"]);
const releaseFeed = z.object({
  channel: z.literal("stable"),
  platform: z.literal("darwin"),
  arch: architecture,
  currentRelease: version,
  releases: z.array(z.object({
    version,
    updateTo: z.object({
      version,
      url: z.url(),
      size: z.int().positive().max(512 * 1024 * 1024),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  })).max(32),
});

async function readFeed(response: Response) {
  if (response.status !== 200 || !response.body) throw new Error("The macOS release feed is unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > 16 * 1024) throw new Error("The macOS release feed exceeded its size limit.");
      chunks.push(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return releaseFeed.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function prepareMacUpdate(fetchUpdate: (url: string, options: RequestInit) => Promise<Response>,
  feed: URL, installed: string, arch: string, temporaryDirectory: string) {
  const current = version.parse(installed).split(".").map(Number);
  const targetArch = architecture.parse(arch);
  const response = await fetchUpdate(feed.href, {
    credentials: "omit", redirect: "error", cache: "no-store",
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return null;
  const release = await readFeed(response);
  if (release.arch !== targetArch) throw new Error("The release targets another macOS architecture.");
  const target = release.currentRelease.split(".").map(Number);
  const difference = target[0]! - current[0]! || target[1]! - current[1]! || target[2]! - current[2]!;
  if (difference === 0) return null;
  if (difference < 0) throw new Error("The macOS update is older than the installed version.");

  const matches = release.releases.filter((entry) => entry.version === release.currentRelease);
  if (matches.length !== 1 || matches[0]!.updateTo.version !== release.currentRelease) {
    throw new Error("The macOS release feed does not identify a single matching update.");
  }
  const update = matches[0]!.updateTo;
  const source = new URL(update.url);
  if (source.origin !== feed.origin || source.protocol !== "https:" || source.username || source.password ||
      source.hash || !source.pathname.endsWith(".zip")) throw new Error("The update is outside the macOS release channel.");

  // Give Squirrel the validated entry on disk. A second fetch of the
  // remote manifest could select different bytes or omit the digest.
  const directory = await mkdtemp(join(temporaryDirectory, "tomverse-mac-update-"));
  const path = join(directory, "releases.json");
  const remove = async () => {
    await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
  };
  try {
    await writeFile(path, JSON.stringify({
      currentRelease: release.currentRelease,
      releases: [{ version: release.currentRelease, updateTo: { ...update, url: source.href } }],
    }), { flag: "wx", mode: 0o600 });
    return { url: pathToFileURL(path).href, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
