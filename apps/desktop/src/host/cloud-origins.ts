import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathIdentity } from "../../../tomverse-cli/src/patch.js";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
/** Tasks kept on record; cloud jobs end and expire long before this many more are started. */
const KEEP = 500;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * The folder a cloud task came from, as a value that is the same after a restart: the folder's real path (case-folded
 * where the file system ignores case) and its file-system identity, so a different folder later put at that path is a
 * different origin. Hashed, so the record holds no path. Null when the folder cannot be identified.
 */
export function projectOrigin(root: string): string | null {
  try {
    const real = realpathSync.native(root);
    const identity = pathIdentity(real, "directory");
    if (!identity) return null;
    return createHash("sha256").update(`${caseInsensitive ? real.toLowerCase() : real}\0${identity}`).digest("hex");
  } catch {
    return null;
  }
}

export type CloudOriginStore = {
  /** The origin recorded for a task, or null when this computer has none (started elsewhere, or before origins were kept). */
  read(taskId: string): Promise<string | null>;
  /** Records a task's origin; throws when it could not be written, so the task is not started. */
  record(taskId: string, origin: string): Promise<void>;
};

type Entry = { origin: string; at: string };

/**
 * Task origins in one file under the app's data folder, so reviewing and applying a task's changes after a restart or
 * a new sign-in still checks the folder it came from. Reads and writes are serialised; a write goes to a temporary file
 * that replaces the record whole. An unreadable record knows no origin, which refuses rather than allows.
 */
export function createCloudOriginStore(file: string): CloudOriginStore {
  let cache: Map<string, Entry> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  async function load() {
    if (cache) return cache;
    const loaded = new Map<string, Entry>();
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: unknown; tasks?: Record<string, Partial<Entry>> };
      if (parsed.version === 1 && parsed.tasks && typeof parsed.tasks === "object") {
        for (const [taskId, entry] of Object.entries(parsed.tasks)) {
          if (typeof entry?.origin === "string" && DIGEST.test(entry.origin) && typeof entry.at === "string") loaded.set(taskId, { origin: entry.origin, at: entry.at });
        }
      }
    } catch { /* no record yet, or one that cannot be read */ }
    cache = loaded;
    return cache;
  }
  return {
    read: (taskId) => serial(async () => (await load()).get(taskId)?.origin ?? null),
    record: (taskId, origin) => serial(async () => {
      if (!DIGEST.test(origin)) throw new Error("Invalid origin.");
      const tasks = new Map(await load());
      tasks.set(taskId, { origin, at: new Date().toISOString() });
      const kept = [...tasks.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, KEEP);
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, tasks: Object.fromEntries(kept) }), { mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      cache = new Map(kept);
    }),
  };
}
