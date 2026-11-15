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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Use the CLI when the access token has this little left (or is past it). */
export const CLAUDE_KEEPALIVE_REFRESH_WITHIN_MS = 10 * 60 * 1000;
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
export async function runClaudeLoginKeepalive({ readLogin, runCli, runStage, log,
  now = () => Date.now() }) {
  const read = async () => claudeLoginState(await readLogin(), now());
  let login = await read();
  const reloginSoon = (state) => state.refreshExpiresAt !== null &&
    state.refreshExpiresAt - now() <= CLAUDE_KEEPALIVE_RELOGIN_WARN_MS;
  if (login.state === "fresh") {
    log({ outcome: "fresh", expiresAt: iso(login.expiresAt),
      refreshTokenExpiresAt: iso(login.refreshExpiresAt),
      ...(reloginSoon(login) ? { warning: "relogin_soon" } : {}) });
    return 0;
  }
  if (login.state !== "refresh_due") {
    log({ outcome: "login_required", state: login.state,
      refreshTokenExpiresAt: iso(login.refreshExpiresAt),
      action: "operator: run `claude auth login` as this user" });
    return 1;
  }
  const before = login.expiresAt ?? 0;
  // The cheapest use first; a one-line prompt if status did not refresh.
  for (const [how, args] of [
    ["status", ["auth", "status"]],
    ["prompt", ["-p", "Reply with OK.", "--model", "haiku",
      "--output-format", "json", "--strict-mcp-config"]],
  ]) {
    try { await runCli(args); } catch { /* judged by the stored login below */ }
    login = await read();
    if (login.state === "fresh" && (login.expiresAt ?? 0) > before) {
      let staged = "ok";
      try { await runStage(); } catch { staged = "failed"; }
      log({ outcome: "refreshed", by: how, staged,
        expiresAt: iso(login.expiresAt), refreshTokenExpiresAt: iso(login.refreshExpiresAt),
        ...(reloginSoon(login) ? { warning: "relogin_soon" } : {}) });
      return staged === "ok" ? 0 : 1;
    }
    if (login.state === "login_required") break;
  }
  log({ outcome: login.state === "login_required" ? "login_required" : "refresh_failed",
    state: login.state, expiresAt: iso(login.expiresAt),
    refreshTokenExpiresAt: iso(login.refreshExpiresAt),
    action: "operator: run `claude auth login` as this user" });
  return 1;
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
  const workers = (process.env.AMUX_V22_CLAUDE_WORKERS || "")
    .split(/\s+/).filter(Boolean);
  const workDir = await mkdtemp(join(tmpdir(), "amux-claude-keepalive-"));
  try {
    return await runClaudeLoginKeepalive({
      readLogin: () => readFile(join(home, ".claude/.credentials.json")),
      runCli: (args) => run(cli, args, { cwd: workDir, timeout: 180_000 }),
      runStage: () => (stageScript && workers.length > 0 ?
        run(process.execPath, [stageScript, ...workers.map((w) => `anthropic:${w}`)],
          { timeout: 60_000 }) : Promise.resolve()),
      log: (line) => console.log(JSON.stringify({ event: "amux_v22_claude_keepalive", ...line })),
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
