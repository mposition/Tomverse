import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const AMUX_V19_TRACKED_REPOSITORY_ROOT_ENV =
  "TOMVERSE_AMUX_V19_TRACKED_REPOSITORY_ROOT";
const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;

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
    return candidate;
  } catch { return null; }
}
