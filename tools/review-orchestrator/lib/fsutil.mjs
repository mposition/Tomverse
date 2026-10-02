import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * A directory lock shared by the short-lived `submit` processes and the
 * daemon, both of which touch the mirror. A lock older than `staleMs` belongs
 * to a process that died holding it.
 */
export async function withLock(path, fn, { timeoutMs = 120_000, staleMs = 10 * 60_000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`lock_timeout: ${path}`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
