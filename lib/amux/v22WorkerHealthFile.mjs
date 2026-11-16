import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Box health signals for a v22 worker's sign-in (owner decision 2026-11-15).
 *
 * The sign-in stage (scripts/amux-v22-stage-auth.mjs) and the Claude login
 * keepalive (scripts/amux-v22-claude-login-keepalive.mjs) write one small
 * file each next to the worker's sign-in copy; the worker's sidecar reads
 * them on its `health` operation and the bridge forwards them to the app
 * (app/api/internal/amux/v22/worker-health). Before this they were only in
 * the box journal: on 2026-11-15 the stage failed every hour and the login
 * keepalive warned a day ahead, and Admin showed nothing.
 *
 * A file holds codes and times only -- never a token: the source, the
 * signal, when it was observed and, for a login, when it expires.
 */

export const AMUX_V22_HEALTH_SOURCES = Object.freeze(["login_keepalive", "auth_stage"]);
const WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SIGNAL = /^[a-z0-9_]{1,64}$/;
const MAX_BYTES = 1024;

export const amuxV22HealthFileName = (source) => `amux-health-${source}.json`;

function healthBody({ source, signal, observedAt, expiresAt = null }) {
  if (!AMUX_V22_HEALTH_SOURCES.includes(source) || typeof signal !== "string" ||
      !SIGNAL.test(signal) || !Number.isFinite(Date.parse(observedAt)) ||
      (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))))
    throw new TypeError("invalid AMUX v22 health signal");
  return { version: 1, source, signal, observedAt: new Date(observedAt).toISOString(),
    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
}

/** Writes one worker's signal from one source, atomically. */
export async function writeAmuxV22WorkerHealth({ worker, stateRoot = "/var/lib", ...signal }) {
  if (typeof worker !== "string" || !WORKER.test(worker) || !isAbsolute(stateRoot))
    throw new TypeError("invalid AMUX v22 health target");
  const body = Buffer.from(JSON.stringify(healthBody(signal)), "utf8");
  const directory = join(stateRoot, `tomverse-amux-v22-${worker}`, "cli");
  const target = join(directory, amuxV22HealthFileName(signal.source));
  const temporary = join(directory, `.${amuxV22HealthFileName(signal.source)}.${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** The signals in a worker's sign-in directory; an unreadable file is left out. */
export async function readAmuxV22WorkerHealth(directory, options = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory)) return [];
  const signals = [];
  for (const source of AMUX_V22_HEALTH_SOURCES) {
    let file;
    try {
      file = await (options.open ?? open)(join(directory, amuxV22HealthFileName(source)),
        constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (parsed?.version !== 1 || parsed.source !== source) continue;
      const body = healthBody({ source, signal: parsed.signal, observedAt: parsed.observedAt,
        expiresAt: parsed.expiresAt ?? null });
      signals.push({ source: body.source, signal: body.signal, observedAt: body.observedAt,
        ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) });
    } catch { /* missing or malformed: nothing to report */ }
    finally { await file?.close().catch(() => {}); }
  }
  return signals;
}
