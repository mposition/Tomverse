#!/usr/bin/env node
// Keeps the operator's Claude login on the AMUX box alive, so the v22 Claude
// worker copies (scripts/amux-v22-stage-auth.mjs) always have a fresh source.
// Run by the operator user's amux-v22-claude-login-keepalive.timer.
//
// Why (2026-11-15): the copies drop the refresh secret on purpose, so only the
// operator's own login refreshes. Nobody used Claude on the box, the refresh
// token itself expired (04:05Z), the CLI cleared the login (05:10Z), and every
// Claude worker and the anthropic Decision Maker stopped. The Claude CLI
// refreshes its login only when it is used and the access token is about to
// expire, so this unit uses it at that moment and then restages the copies.
//
// It never reads or prints a token: only `expiresAt` and
// `refreshTokenExpiresAt`, and whether the two token fields are non-empty.
// A login that is gone is the operator's to renew (`claude auth login`); this
// unit only reports it and exits non-zero.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The script is installed on its own (~/.local/lib/tomverse-amux-v22/), so the
// health file it writes is spelled out here; lib/amux/v22WorkerHealthFile.mjs
// reads the same version-1 shape and tests/amuxCardWaitAndWorkerHealthCore
// checks the two agree.
const HEALTH_WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEALTH_SIGNAL = /^[a-z0-9_]{1,64}$/;

/** The keepalive line's health signal for the worker copies. */
export function amuxV22KeepaliveHealthSignal(line) {
  if (line?.outcome === "fresh" || line?.outcome === "refreshed")
    return line.warning === "relogin_soon" ? "relogin_soon" : "ok";
  if (line?.outcome === "refresh_failed") return "refresh_failed";
  if (line?.state === "missing") return "login_missing";
  if (line?.state === "unreadable") return "login_unreadable";
  return "login_required";
}

/** Writes one worker's keepalive signal next to its copy, atomically. Codes and times only. */
export async function writeKeepaliveHealth({ worker, signal, observedAt, expiresAt = null,
  stateRoot = "/var/lib" }) {
  if (!HEALTH_WORKER.test(worker) || !HEALTH_SIGNAL.test(signal))
    throw new TypeError("invalid health signal");
  const directory = join(stateRoot, `tomverse-amux-v22-${worker}`, "cli");
  const target = join(directory, "amux-health-login_keepalive.json");
  const temporary = join(directory, `.amux-health-login_keepalive.json.${randomBytes(6).toString("hex")}`);
  const body = JSON.stringify({ version: 1, source: "login_keepalive", signal,
    observedAt: new Date(observedAt).toISOString(),
    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) });
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Use the CLI when the access token has this little left (or is past it). */
export const CLAUDE_KEEPALIVE_REFRESH_WITHIN_MS = 10 * 60 * 1000;
/**
 * Ask the CLI no earlier than this before expiry. The CLI itself refreshes only
 * inside its own five-minute buffer: on the box (2026-11-15..20) every round
 * with five minutes or more left saw no refresh, every round with less did.
 * Asking earlier logged a `refresh_failed` every eight hours, paged as
 * AMUX_WORKER_REFRESH_FAILED, and left the actual refresh to the next round,
 * which once landed five seconds before the copies expired.
 */
export const CLAUDE_CLI_REFRESH_LEAD_MS = 4 * 60 * 1000;
/** Warn this long before the refresh token itself runs out. */
export const CLAUDE_KEEPALIVE_RELOGIN_WARN_MS = 24 * 60 * 60 * 1000;

/** What the stored login allows, from its non-secret fields only. */
export function claudeLoginState(bytes, now) {
  let auth;
  try { auth = JSON.parse(Buffer.from(bytes).toString("utf8"))?.claudeAiOauth; }
  catch { return { state: "unreadable" }; }
  if (!auth || typeof auth !== "object") return { state: "missing" };
  const hasAccess = typeof auth.accessToken === "string" && auth.accessToken.length > 0;
  const hasRefresh = typeof auth.refreshToken === "string" && auth.refreshToken.length > 0;
  const expiresAt = Number.isSafeInteger(auth.expiresAt) ? auth.expiresAt : null;
  const refreshExpiresAt = Number.isSafeInteger(auth.refreshTokenExpiresAt) ?
    auth.refreshTokenExpiresAt : null;
  const facts = { expiresAt, refreshExpiresAt };
  if (!hasRefresh || (refreshExpiresAt !== null && refreshExpiresAt <= now))
    return { state: "login_required", ...facts };
  if (!hasAccess || expiresAt === null ||
      expiresAt - now <= CLAUDE_KEEPALIVE_REFRESH_WITHIN_MS)
    return { state: "refresh_due", ...facts };
  return { state: "fresh", ...facts };
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * One keepalive round. `runCli(args)` and `runStage()` resolve when the
 * process ends (a non-zero exit rejects); `log(object)` writes one line.
 */
export async function runClaudeLoginKeepalive({ readLogin, runCli, runStage, log: writeLog,
  readCopyExpiries = async () => [], now = () => Date.now(), report = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  // Every outcome line is also reported (owner decision 2026-11-15); a
  // failed report never changes the round.
  const log = async (line) => {
    writeLog(line);
    try { await report(line); } catch { /* the journal line is written */ }
  };
  const read = async () => {
    let bytes;
    // A login file that is gone is the operator's to renew, like a cleared one.
    try { bytes = await readLogin(); }
    catch (error) {
      if (error?.code === "ENOENT") return { state: "missing" };
      return { state: "unreadable" };
    }
    return claudeLoginState(bytes, now());
  };
  let login = await read();
  const reloginSoon = (state) => state.refreshExpiresAt !== null &&
    state.refreshExpiresAt - now() <= CLAUDE_KEEPALIVE_RELOGIN_WARN_MS;
  if (login.state === "fresh") {
    // A copy behind the login (a restage that failed after a refresh, or a
    // worker added since) is restaged here instead of waiting for the hourly
    // stage timer.
    let behind = false;
    try {
      behind = (await readCopyExpiries()).some((expiresAt) =>
        expiresAt === null || expiresAt < login.expiresAt);
    } catch { behind = true; }
    let staged;
    if (behind) {
      try { await runStage(); staged = "ok"; } catch { staged = "failed"; }
    }
    await log({ outcome: "fresh", expiresAt: iso(login.expiresAt),
      refreshTokenExpiresAt: iso(login.refreshExpiresAt),
      ...(staged ? { restaged: staged } : {}),
      ...(reloginSoon(login) ? { warning: "relogin_soon" } : {}) });
    return staged === "failed" ? 1 : 0;
  }
  if (login.state !== "refresh_due") {
    await log({ outcome: "login_required", state: login.state,
      refreshTokenExpiresAt: iso(login.refreshExpiresAt),
      action: "operator: run `claude auth login` as this user" });
    return 1;
  }
  const before = login.expiresAt ?? 0;
  const refreshed = () => login.state === "fresh" && (login.expiresAt ?? 0) > before;
  // The window is wider than the timer's step so a round always lands in it;
  // a round that lands before the CLI would refresh waits here for it
  // (at most the window less the lead, inside the unit's TimeoutStartSec).
  const wait = login.expiresAt === null ? 0 : login.expiresAt - CLAUDE_CLI_REFRESH_LEAD_MS - now();
  let how = null;
  if (wait > 0) {
    await sleep(wait);
    login = await read();
    // Another use of the operator's CLI may have refreshed it meanwhile.
    if (refreshed()) how = "elsewhere";
  }
  // The cheapest use first; a one-line prompt if status did not refresh.
  if (!how && login.state === "refresh_due") {
    for (const [use, args] of [
      ["status", ["auth", "status"]],
      ["prompt", ["-p", "Reply with OK.", "--model", "haiku",
        "--output-format", "json", "--strict-mcp-config"]],
    ]) {
      try { await runCli(args); } catch { /* judged by the stored login below */ }
      login = await read();
      if (refreshed()) { how = use; break; }
      if (login.state === "login_required") break;
    }
  }
  const waited = wait > 0 ? { waitedSeconds: Math.round(wait / 1000) } : {};
  if (how) {
    // No stage at all (an account with no worker copies, e.g. autorec) is
    // "skipped", never a silent "ok": that is set explicitly in main().
    let staged = runStage ? "ok" : "skipped";
    if (runStage) { try { await runStage(); } catch { staged = "failed"; } }
    await log({ outcome: "refreshed", by: how, staged, ...waited,
      expiresAt: iso(login.expiresAt), refreshTokenExpiresAt: iso(login.refreshExpiresAt),
      ...(reloginSoon(login) ? { warning: "relogin_soon" } : {}) });
    return staged === "failed" ? 1 : 0;
  }
  await log({ outcome: login.state === "login_required" ? "login_required" : "refresh_failed", ...waited,
    state: login.state, expiresAt: iso(login.expiresAt),
    refreshTokenExpiresAt: iso(login.refreshExpiresAt),
    action: "operator: run `claude auth login` as this user" });
  return 1;
}

/** Writes the round's signal next to each worker's copy; a failed write is skipped. */
export async function reportClaudeKeepaliveHealth(workers, line, write = writeKeepaliveHealth) {
  const signal = amuxV22KeepaliveHealthSignal(line);
  const observedAt = new Date().toISOString();
  for (const worker of workers) {
    try {
      await write({ worker, signal, observedAt, expiresAt: line?.refreshTokenExpiresAt ?? null });
    } catch { /* the journal line still says it */ }
  }
}

const run = (file, args, options) => new Promise((resolve, reject) => {
  // Output is discarded: nothing the CLI prints belongs in the journal.
  execFile(file, args, { ...options, maxBuffer: 1024 * 1024 }, (error) =>
    (error ? reject(new Error(`exit ${error.code ?? "unknown"}`)) : resolve()));
});

async function main() {
  const home = process.env.HOME;
  if (!home) { console.error("HOME is not set"); return 2; }
  const cli = process.env.AMUX_V22_CLAUDE_BIN || join(home, ".local/bin/claude");
  const stageScript = process.env.AMUX_V22_STAGE_AUTH_SCRIPT;
  // "off": this login has no worker copies to restage or report next to --
  // the daily product agent's autorec account (2026-11-21). Explicit, so an
  // operator unit that merely forgot its workers still fails its restage.
  const restage = process.env.AMUX_V22_KEEPALIVE_RESTAGE !== "off";
  const workers = restage ? (process.env.AMUX_V22_CLAUDE_WORKERS || "")
    .split(/\s+/).filter(Boolean) : [];
  if (!restage && process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    // A `claude setup-token` token replaces the stored login; nothing to refresh.
    console.log(JSON.stringify({ event: "amux_v22_claude_keepalive", outcome: "env_token" }));
    return 0;
  }
  const workDir = await mkdtemp(join(tmpdir(), "amux-claude-keepalive-"));
  try {
    return await runClaudeLoginKeepalive({
      readLogin: () => readFile(join(home, ".claude/.credentials.json")),
      // Each worker copy's expiry only; an unreadable copy counts as behind.
      readCopyExpiries: () => Promise.all(workers.map(async (worker) => {
        try {
          const state = claudeLoginState(await readFile(
            join("/var/lib", `tomverse-amux-v22-${worker}`, "cli", ".credentials.json")), Date.now());
          return state.expiresAt ?? null;
        } catch { return null; }
      })),
      runCli: (args) => run(cli, args, { cwd: workDir, timeout: 180_000 }),
      // A missing stage setting is a failed restage, never a silent "ok".
      runStage: !restage ? null : () => (stageScript && workers.length > 0 ?
        run(process.execPath, [stageScript, ...workers.map((w) => `anthropic:${w}`)],
          { timeout: 60_000 }) :
        Promise.reject(new Error("AMUX_V22_STAGE_AUTH_SCRIPT or AMUX_V22_CLAUDE_WORKERS is not set"))),
      log: (line) => console.log(JSON.stringify({ event: "amux_v22_claude_keepalive", ...line })),
      // Owner decision 2026-11-15: the outcome also goes next to each Claude
      // worker's copy, so the worker's sidecar and bridge carry it to Admin
      // (login_required, relogin_soon). Never fatal.
      report: (line) => reportClaudeKeepaliveHealth(workers, line),
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
