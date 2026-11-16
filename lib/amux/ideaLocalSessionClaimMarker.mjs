import { constants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** The subscription runner's marker name, the same as before 2026-11-16 so a
 * marker already on the host is found. */
const MARKER = "analysis-outcome-unknown.halt";
/** The marker of the one-file layout before 2026-10. */
const LEGACY_MARKER = "outcome-unknown.halt";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTITY_KEYS = ["claimId", "requestId", "reservationId", "ideaId",
  "invocationOrdinal"];

/** The claim a marker names, rebuilt field by field; anything else is null. */
export function amuxSessionClaimMarkerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, value[key]]));
  return IDENTITY_KEYS.slice(0, 4).every((key) =>
    typeof identity[key] === "string" && UUID.test(identity[key])) &&
    Number.isSafeInteger(identity.invocationOrdinal) &&
    identity.invocationOrdinal >= 0 && identity.invocationOrdinal <= 2_147_483_647
    ? Object.freeze(identity) : null;
}

/**
 * The subscription (v19) session runner's local record of the one claim it
 * has not reconciled yet. It is written and fsynced before the claim's
 * network write, so a crash cannot lose the claim: the next tick finds the
 * marker, reports that claim's outcome unknown to the app (which closes a
 * subscription claim at zero) and removes the marker once the app confirms.
 * Nothing waits for a person (operator, 2026-11-16). The marker names the
 * claim and holds no secret, prompt or model output. A pre-created, private
 * state directory is required.
 *
 * A marker written before 2026-11-16 names no claim, and neither does the
 * legacy one-file marker. The cycle reads the marker's time, asks the app for
 * the subscription claims still in flight from before it, reports each one's
 * outcome unknown, and removes the marker only once every one is closed. The
 * paid path keeps its own blocking marker (ideaLocalRetentionHaltFile.mjs),
 * unchanged.
 */
export function localAmuxSessionClaimMarker(stateDir) {
  if (process.platform !== "linux" || typeof stateDir !== "string" ||
      !isAbsolute(stateDir)) {
    throw new Error("local_state_unavailable");
  }
  const marker = join(stateDir, MARKER);
  const legacy = join(stateDir, LEGACY_MARKER);
  const checkDirectory = async () => {
    const info = await lstat(stateDir);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error("local_state_unavailable");
    }
  };
  /** false when absent; throws on a file that is not our private marker. */
  const present = async (path) => {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() ||
        info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error("local_state_unavailable");
    }
    return true;
  };
  return {
    /** Records `identity` as the claim about to be written. False when a
     * marker is already there: reconcile it first (`read`). */
    async claim(identity) {
      await checkDirectory();
      const named = amuxSessionClaimMarkerIdentity(identity);
      if (!named) throw new Error("local_state_unavailable");
      let handle;
      try {
        handle = await open(marker, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(`${JSON.stringify({ version: 2, identity: named })}\n`);
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
    /** null when nothing is pending; else the claim the marker names, or
     * `identity: null` for a marker that names none, and when it was
     * written (the file's mtime, ms). A marker that names no claim carries the
     * latest mtime of the unnamed markers there, so every claim a stopped run
     * of that runner left in flight was written before it. */
    async read() {
      await checkDirectory();
      if (await present(marker)) {
        let parsed = null;
        try { parsed = JSON.parse(await readFile(marker, "utf8")); }
        catch { /* A marker from before 2026-11-16 is one plain line. */ }
        const identity = amuxSessionClaimMarkerIdentity(parsed?.identity);
        let { mtimeMs } = await lstat(marker);
        if (!identity && await present(legacy)) {
          mtimeMs = Math.max(mtimeMs, (await lstat(legacy)).mtimeMs);
        }
        return { identity, writtenAtMs: mtimeMs };
      }
      return await present(legacy)
        ? { identity: null, writtenAtMs: (await lstat(legacy)).mtimeMs } : null;
    },
    /** Removes the marker and a legacy one; nothing there is an error. */
    async release() {
      await checkDirectory();
      let removed = false;
      for (const path of [marker, legacy]) {
        if (!await present(path)) continue;
        await unlink(path);
        removed = true;
      }
      if (!removed) throw new Error("local_state_unavailable");
    },
  };
}
