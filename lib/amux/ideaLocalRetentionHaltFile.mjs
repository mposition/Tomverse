import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const LEGACY_MARKER = "outcome-unknown.halt";

/** A pre-created, private state directory is required. The marker is fsynced
 * before network I/O, so a process crash cannot silently schedule a replay. */
export function localAmuxHaltFile(stateDir, kind) {
  if (process.platform !== "linux" || typeof stateDir !== "string" ||
      !isAbsolute(stateDir) || !["retention", "analysis"].includes(kind)) {
    throw new Error("local_state_unavailable");
  }
  const marker = join(stateDir, `${kind}-outcome-unknown.halt`);
  const checkDirectory = async () => {
    const info = await lstat(stateDir);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error("local_state_unavailable");
    }
  };
  return {
    async claim() {
      await checkDirectory();
      // A marker from before per-capability namespacing is ambiguous. Never
      // schedule either capability until an operator reconciles it.
      try { await lstat(join(stateDir, LEGACY_MARKER)); return false; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      let handle;
      try {
        handle = await open(marker, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(`${kind}_outcome_unverified\n`);
        await handle.sync();
        const directory = await open(stateDir, constants.O_RDONLY |
          constants.O_DIRECTORY);
        try { await directory.sync(); }
        finally { await directory.close(); }
        return true;
      } catch (error) {
        if (error?.code === "EEXIST") return false;
        throw error;
      } finally { await handle?.close(); }
    },
    async release() {
      await checkDirectory();
      const info = await lstat(marker);
      if (!info.isFile() || info.isSymbolicLink() ||
          info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
          throw new Error("local_state_unavailable");
      }
      await unlink(marker);
    },
  };
}

export const localRetentionHaltFile = (stateDir) =>
  localAmuxHaltFile(stateDir, "retention");
