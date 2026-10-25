import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from
  "node:fs/promises";
import { join } from "node:path";

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const FILE_NAME = "queue-cursor";
const corrupt = () => Object.assign(new Error("v19_queue_cursor_corrupt"),
  { code: "v19_queue_cursor_corrupt" });

async function directoryReady(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform === "linux" &&
        (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error("v19_queue_state_unavailable");
  }
}

/** A local pagination hint only. The app database remains the queue source of
 * truth; a lost hint repeats read-only discovery and never repeats a claim. */
export function amuxV19QueueCursorState(directory) {
  if (typeof directory !== "string" || !directory.startsWith("/") &&
      process.platform === "linux") throw new TypeError("invalid queue state path");
  const path = join(directory, FILE_NAME);
  return Object.freeze({
    async read() {
      await directoryReady(directory);
      let handle;
      try { handle = await open(path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        if (error.code === "ELOOP") throw corrupt();
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 513) throw corrupt();
        if (process.platform === "linux" && stat.uid !== process.getuid()) {
          throw new Error("v19_queue_state_unavailable");
        }
        if (process.platform === "linux" && (stat.mode & 0o077) !== 0)
          throw corrupt();
        const raw = await handle.readFile({ encoding: "utf8" });
        if (!/^[A-Za-z0-9_-]{1,512}\n?$/.test(raw))
          throw corrupt();
        const cursor = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
        return cursor;
      } finally { await handle.close(); }
    },
    async save(cursor) {
      if (typeof cursor !== "string" || !CURSOR.test(cursor))
        throw new TypeError("invalid queue cursor");
      await directoryReady(directory);
      const temporary = join(directory, `.queue-cursor-${randomUUID()}`);
      try {
        await writeFile(temporary, `${cursor}\n`, { flag: "wx", mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
      } finally {
        try { await unlink(temporary); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
    async clear() {
      await directoryReady(directory);
      try { await unlink(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    },
  });
}
