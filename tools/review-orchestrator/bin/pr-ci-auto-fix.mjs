#!/usr/bin/env node
/**
 * One pass of the CI auto-fix's proposing half (lib/ci-fix.mjs), run by
 * deploy/pr-ci-auto-fix.timer as the review account, where the subscription
 * Claude CLI is signed in. It picks at most one failed agent pull request,
 * asks the model for a patch and leaves it in the outbox. It cannot dispatch:
 * bin/pr-ci-auto-fix-sender.mjs holds that token under its own account,
 * because the model runs as this account and could be asked by a log or a
 * branch to read this process's environment.
 *
 * Environment:
 *   REVIEW_ORCH_CONFIG                     the review server's config (providers, repos, stateDir)
 *   PR_CI_AUTO_FIX_READ_TOKEN              GitHub token with read access only (Actions, Pull requests)
 *   PR_CI_AUTO_FIX_REPO                    owner/name
 *   PR_CI_AUTO_FIX_OUTBOX                  absolute directory the sender reads
 *   PR_CI_AUTO_FIX_WORK                    absolute directory for the model's checkout and log,
 *                                          outside HOME, the review stateDir and the outbox
 *   PR_CI_AUTO_FIX_MODEL                   optional, default sonnet
 *   PR_CI_AUTO_FIX_MIN_REMAINING_PERCENT   optional, default 30: the account quota a pass needs
 *   PR_CI_AUTO_FIX_CONFLICTS               optional: "on" also resolves conflicts with develop
 *                                          (the workflow publishes them only when the repository
 *                                          variable PR_AUTO_FIX_CONFLICTS_ENABLED is "true")
 *
 * Exit 0 after a pass whatever it found, 64 when the settings cannot run, 65 on error.
 */
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { githubClient, pruneOutbox, runCiFix } from "../lib/ci-fix.mjs";
import { loadConfig } from "../lib/config.mjs";
import { release, tryAcquire } from "../lib/fsutil.mjs";
import { readQuotaStatus } from "../lib/quota.mjs";

export const READ_TOKEN_ENV = "PR_CI_AUTO_FIX_READ_TOKEN";
/** The sender's token. It must never be set here or passed to a CLI. */
export const DISPATCH_TOKEN_ENV = "PR_CI_AUTO_FIX_DISPATCH_TOKEN";
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,63}$/;

/** The settings, or a reason this pass cannot run. A token's value never appears in a reason. */
export function ciFixSettings(env, config) {
  if (env[DISPATCH_TOKEN_ENV] !== undefined) {
    return { error: `${DISPATCH_TOKEN_ENV} belongs to the sender's account, not this one` };
  }
  const token = env[READ_TOKEN_ENV];
  if (typeof token !== "string" || token.length < 20) return { error: `${READ_TOKEN_ENV} is missing` };
  if (!REPO.test(env.PR_CI_AUTO_FIX_REPO ?? "")) return { error: "PR_CI_AUTO_FIX_REPO must be owner/name" };
  const outbox = env.PR_CI_AUTO_FIX_OUTBOX ?? "";
  const workDir = env.PR_CI_AUTO_FIX_WORK ?? "";
  if (!isAbsolute(outbox)) return { error: "PR_CI_AUTO_FIX_OUTBOX must be an absolute path" };
  if (!isAbsolute(workDir)) return { error: "PR_CI_AUTO_FIX_WORK must be an absolute path" };
  // The model is denied the home, the review state and the outbox
  // (deniedPaths), so its checkout must lie outside all three.
  const home = env.HOME ?? "";
  if (!isAbsolute(home)) return { error: "HOME must be an absolute path" };
  for (const [name, dir] of [["HOME", home], ["stateDir", config.stateDir], ["PR_CI_AUTO_FIX_OUTBOX", outbox]]) {
    if (within(workDir, dir) || within(dir, workDir)) {
      return { error: `PR_CI_AUTO_FIX_WORK must not overlap ${name}: the model is denied it` };
    }
  }
  const model = env.PR_CI_AUTO_FIX_MODEL ?? "sonnet";
  if (!MODEL.test(model)) return { error: "PR_CI_AUTO_FIX_MODEL is not a model name" };
  const minRemainingPercent = Number(env.PR_CI_AUTO_FIX_MIN_REMAINING_PERCENT ?? 30);
  if (!(minRemainingPercent >= 0 && minRemainingPercent <= 100)) {
    return { error: "PR_CI_AUTO_FIX_MIN_REMAINING_PERCENT must be 0 to 100" };
  }
  // reviewerEnv hands a CLI only the names it lists plus passEnv.
  const leaky = config.providers.find((p) => (p.passEnv ?? []).some((name) => name === READ_TOKEN_ENV || name === DISPATCH_TOKEN_ENV));
  if (leaky) return { error: `providers.${leaky.id}: passEnv must not carry a GitHub token` };
  const conflicts = env.PR_CI_AUTO_FIX_CONFLICTS === "on";
  return { token, repo: env.PR_CI_AUTO_FIX_REPO, outbox, workDir, home, model, minRemainingPercent, conflicts };
}

const isAbsolute = (path) => typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");
/** Is path the directory dir or inside it? Both absolute POSIX paths. */
export const within = (path, dir) => {
  const clean = (value) => value.replace(/\/+$/, "") || "/";
  const a = clean(path);
  const b = clean(dir);
  return a === b || b === "/" || a.startsWith(`${b}/`);
};

/**
 * Every secret this account holds in clear, for the last check on a patch
 * (patchProblem): the read token, credentials a CLI is given by environment,
 * and the string values in the Claude CLI's credential file.
 */
export function knownSecrets(env, config, readText = (path) => readFileSync(path, "utf8")) {
  const names = new Set([READ_TOKEN_ENV, "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
    ...config.providers.flatMap((provider) => provider.passEnv ?? [])]);
  const values = [...names].map((name) => env[name]).filter((value) => typeof value === "string");
  const strings = (value) => (typeof value === "string" ? [value]
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);
  try {
    values.push(...strings(JSON.parse(readText(join(env.HOME ?? "/nonexistent", ".claude", ".credentials.json")))));
  } catch {
    // no credential file: the CLI is signed in some other way
  }
  return values.filter((value) => value.length >= 16);
}

async function main() {
  const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const config = loadConfig();
  const settings = ciFixSettings(process.env, config);
  if (settings.error) {
    log(`ci-fix not started: ${settings.error}`);
    return 64;
  }
  // The timer never overlaps a pass; this stops a manual run beside it.
  const lockPath = join(config.stateDir, "ci-fix", "run.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = tryAcquire(lockPath);
  if (lock === null) {
    log("ci-fix: another pass is running");
    return 0;
  }
  try {
    pruneOutbox(settings.outbox, Date.now());
    const result = await runCiFix({
      config,
      github: githubClient({ repo: settings.repo, token: settings.token }),
      outbox: settings.outbox,
      workDir: settings.workDir,
      model: settings.model,
      minRemainingPercent: settings.minRemainingPercent,
      conflicts: settings.conflicts,
      // The daemon's last reading: a pass never probes the account itself.
      quota: async (provider) => readQuotaStatus(config, Date.now())[provider.id],
      secrets: knownSecrets(process.env, config),
      log,
    });
    log(`ci-fix: ${JSON.stringify(result)}`);
    return 0;
  } finally {
    release(lockPath, lock);
  }
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`ci-fix failed: ${error.message}\n`);
      process.exit(65);
    },
  );
}
