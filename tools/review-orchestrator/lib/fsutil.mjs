import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

const readOwner = (path) => {
  try {
    const [pid, token] = readFileSync(path, "utf8").trim().split(" ");
    return { pid: Number(pid), token };
  } catch {
    return null;
  }
};

/**
 * Create `path` exclusively and write "<pid> <token>" into it. When the file
 * exists, it is taken over only if its owner process is dead -- never because
 * it is old, since a slow clone is still a live owner. Single-host only.
 * Returns the token, or null when a live process holds it.
 */
export function tryAcquire(path) {
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid} ${token}\n`);
      closeSync(fd);
      return token;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readOwner(path);
      if (owner === null) continue; // vanished between open and read
      if (pidAlive(owner.pid)) return null;
      // Dead owner. Re-read just before removing so a fresh lock taken by
      // another waiter in the meantime is left alone.
      const again = readOwner(path);
      if (again && again.token === owner.token) {
        try {
          unlinkSync(path);
        } catch {
          // someone else removed it
        }
      }
    }
  }
  return null;
}

/** Remove the lock only if it is still ours. */
export function release(path, token) {
  const owner = readOwner(path);
  if (owner && owner.token === token) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
}

/**
 * The mirror lock shared by the short-lived `submit` processes and the
 * daemon, both of which touch the mirror.
 */
export async function withLock(path, fn, { timeoutMs = 10 * 60_000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  let token = tryAcquire(path);
  while (token === null) {
    if (Date.now() - started > timeoutMs) throw new Error(`lock_timeout: ${path}`);
    await sleep(100);
    token = tryAcquire(path);
  }
  try {
    return await fn();
  } finally {
    release(path, token);
  }
}
