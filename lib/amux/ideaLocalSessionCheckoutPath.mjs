import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

export const AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV =
  "TOMVERSE_AMUX_V19_TRACKED_REPOSITORY_ROOT";
const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const execFileAsync = promisify(execFile);
const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";

function repositoryFromRemote(value) {
  if (typeof value !== "string" || value.length > 512 || value.includes("\n"))
    return null;
  let path;
  if (/^git@github\.com:/i.test(value)) {
    path = value.replace(/^git@github\.com:/i, "");
  } else {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== "github.com" || url.port ||
          url.password || url.search || url.hash ||
          !((url.protocol === "https:" && !url.username) ||
            (url.protocol === "ssh:" && url.username === "git"))) return null;
      path = url.pathname.slice(1);
    } catch { return null; }
  }
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return REPOSITORY.test(path) ? path.toLowerCase() : null;
}

async function matchesClaimedRemote(path, repository) {
  try {
    const { stdout } = await execFileAsync(
      GIT_BINARY,
      ["--no-optional-locks", "-C", path, "config", "--local", "--get",
        "remote.origin.url"], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 1_024,
        windowsHide: true,
        env: { SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
    return repositoryFromRemote(stdout.trim()) === repository.toLowerCase();
  } catch { return false; }
}

/** The claim's case-insensitive repository slug selects a lower-case local
 * mirror below one fixed root. Owner/repo symlinks cannot alias another repo.
 * A caller-supplied repositoryPath is never authority for CLI source bytes. */
export async function resolveAmuxV19ClaimCheckoutPath(repository) {
  const configured = process.env[AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV];
  if (typeof configured !== "string" || !isAbsolute(configured) ||
      configured.includes("\0") || typeof repository !== "string" ||
      !REPOSITORY.test(repository)) return null;
  const segments = repository.toLowerCase().split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  try {
    const root = await realpath(configured);
    const owner = join(root, segments[0]);
    const path = join(owner, segments[1]);
    const [ownerStat, pathStat] = await Promise.all([lstat(owner), lstat(path)]);
    if (ownerStat.isSymbolicLink() || pathStat.isSymbolicLink() ||
        !ownerStat.isDirectory() || !pathStat.isDirectory()) return null;
    const candidate = await realpath(path);
    const within = relative(root, candidate);
    if (!within || within === ".." || within.startsWith(`..${sep}`) ||
        isAbsolute(within)) return null;
    if (!await matchesClaimedRemote(candidate, repository)) return null;
    return candidate;
  } catch { return null; }
}
