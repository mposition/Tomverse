import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Claim before any CLI spawn. A failed/crashed attempt still consumes the
 * operator's one-call approval; only a new reviewed marker may retry. */
export async function claimAmuxV4SyntheticS0Once({ directory, markerName,
  expiresAt, now = Date.now() }) {
  if (process.platform !== "linux" || typeof process.getuid !== "function" ||
      typeof directory !== "string" ||
      !/^[a-z0-9-]{1,80}\.claimed$/.test(markerName) ||
      !Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        await realpath(directory) !== directory ||
        parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) {
      return false;
    }
    const path = join(directory, markerName);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const marker = await handle.stat();
      if (!marker.isFile() || marker.nlink !== 1 || marker.size !== 0 ||
          marker.uid !== process.getuid() || (marker.mode & 0o777) !== 0o600) {
        return false;
      }
      await handle.sync();
    } finally { await handle.close(); }
    const parentHandle = await open(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parentHandle.sync(); }
    finally { await parentHandle.close(); }
    return true;
  } catch { return false; }
}
