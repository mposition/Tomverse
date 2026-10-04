import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Linux process start time (clock ticks since boot), or null where /proc is absent. */
function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22; fields after the parenthesised command name are space separated.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the recorded owner still that process? On Linux the start time must
 * match too, so a recycled pid is not mistaken for the owner.
 */
export function ownerAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    if (error.code !== "EPERM") return false;
  }
  if (owner.start && owner.start !== "-") {
    const now = startTime(owner.pid);
    if (now !== null && now !== owner.start) return false;
  }
  return true;
}

const readOwner = (path) => {
  try {
    const [pid, start, token] = readFileSync(path, "utf8").trim().split(" ");
    if (!token) return null;
    return { pid: Number(pid), start, token };
  } catch {
    return null;
  }
};

/**
 * Take `path` exclusively. The owner record is written to a private file
 * first and then hard-linked into place, so the lock never exists without its
 * owner -- an empty lock file would read as a dead owner. A lock is taken over
 * only when its owner is dead, never because it is old: a slow clone is still
 * a live owner. Single host only. Returns the token, or null when held.
 */
export function tryAcquire(path) {
  const token = randomBytes(8).toString("hex");
  const mine = `${path}.${token}.owner`;
  writeFileSync(mine, `${process.pid} ${startTime(process.pid) ?? "-"} ${token}\n`);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(mine, path);
        return token;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const owner = readOwner(path);
      if (ownerAlive(owner)) return null;
      // Dead owner. Move the lock aside under a private name, then check that
      // what was moved is the dead owner's record. If a live waiter replaced
      // it in between, put it back and stand down.
      const aside = `${path}.${token}.stale`;
      try {
        renameSync(path, aside);
      } catch {
        continue;
      }
      const moved = readOwner(aside);
      if (moved && owner && moved.token !== owner.token && ownerAlive(moved)) {
        try {
          linkSync(aside, path);
        } catch {
          // a third party took it; theirs stands
        }
        unlinkSync(aside);
        return null;
      }
      unlinkSync(aside);
    }
    return null;
  } finally {
    unlinkSync(mine);
  }
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
