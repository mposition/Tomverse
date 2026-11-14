// The AMUX process analysis agent's box runner (lib/amuxProcessAuditCore.ts,
// docs/ops/amux/process-audit-agent.md). A systemd user timer starts it every
// hour on the AMUX Ubuntu box; the app decides whether a run is due, so the
// cadence and the on/off switch live in Admin, not in the timer.
//
// One run: claim it and receive the app's figures, make a fresh shallow clone
// of the public repository's develop outside the home directory, run the Codex
// CLI signed in to the flat-rate subscription in that clone with a structured
// answer schema, and post the answer back. No API key, so no paid call: a run
// uses the Codex subscription's quota, shared with the AMUX workers.
//
// What the model's shell can reach is an allow list, not the account: a Codex
// permissions profile lets its commands read only the system's minimal paths,
// the clone and the CLI's own release directory (which its sandbox
// re-executes). The home directory -- this runner's secret, other services'
// environment files, the CLI's login -- and every process's environment are
// unreadable to them, nothing is writable, and the shell has no network.
// Measured on the box 2026-11-14 with Codex 0.160: a canary file in the home
// directory was "No such file or directory" to the model's `cat`, while the
// clone was readable. The CLI itself gets no variable of this process's, and
// web search is off.
//
// On the box this runs as an esbuild bundle (`npm run build:amux-process-audit-box`):
// the box's node has no TypeScript support.

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  AMUX_PROCESS_AUDIT_ANSWER_SCHEMA,
  AMUX_PROCESS_AUDIT_MIN_SECRET_LENGTH,
  AMUX_PROCESS_AUDIT_SECRET_ENV,
  parseProcessAuditAnalysis,
  processAuditPrompt,
} from "../lib/amuxProcessAuditCore.ts";
import { readMarketingCodexEvents, runMarketingCodexProcess } from "../lib/marketingCodexChannelCore.ts";

export const PROCESS_AUDIT_RUNNER_ENV = Object.freeze({
  appUrl: "AMUX_PROCESS_AUDIT_APP_URL",
  codexBin: "AMUX_PROCESS_AUDIT_CODEX_BIN",
  repository: "AMUX_PROCESS_AUDIT_REPOSITORY",
  model: "AMUX_PROCESS_AUDIT_MODEL",
});

const DEFAULT_REPOSITORY = "https://github.com/mposition/Tomverse.git";
/** One CLI run: long enough to read the pipeline, short of the app's claim hold (3 h). */
export const PROCESS_AUDIT_CODEX_TIMEOUT_MS = 45 * 60 * 1000;
const HTTP_TIMEOUT_MS = 60_000;
/** Tools the analysis never needs. The shell stays: it is how the CLI reads the clone, inside the profile. */
const DISABLED_FEATURES = ["view_image", "apps", "plugins", "image_generation", "request_permissions_tool", "tool_suggest", "multi_agent", "multi_agent_v2"];
const CODEX_CHILD_VARIABLES = ["HOME", "CODEX_HOME", "PATH", "LANG"];
/** The profile's name. It replaces `--sandbox`: the CLI refuses both at once. */
export const PROCESS_AUDIT_PERMISSIONS_PROFILE = "process_audit";

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

/**
 * The filesystem the model's commands may read, as an inline TOML table:
 * `:minimal` (the system paths a shell needs) and each root, read only.
 * Nothing else exists for them, the home directory included.
 */
export function processAuditFilesystemPermissions(readableRoots) {
  if (!Array.isArray(readableRoots) || readableRoots.length === 0) throw new Error("readable_roots_missing");
  for (const root of readableRoots) {
    // An absolute path with no quote or line break; JSON escaping makes it a valid TOML basic string.
    if (typeof root !== "string" || !isAbsolute(root) || /["\r\n]/.test(root)) throw new Error("readable_root_invalid");
  }
  return `{${[":minimal", ...readableRoots].map((path) => `${JSON.stringify(path)}="read"`).join(",")}}`;
}

export function processAuditCodexArguments({ schemaPath, model, readableRoots }) {
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "-c",
    `default_permissions=${JSON.stringify(PROCESS_AUDIT_PERMISSIONS_PROFILE)}`,
    "-c",
    `permissions.${PROCESS_AUDIT_PERMISSIONS_PROFILE}.filesystem=${processAuditFilesystemPermissions(readableRoots)}`,
    "-c",
    'web_search="disabled"',
    "-c",
    "agents.enabled=false",
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--output-schema",
    schemaPath,
    ...(model ? ["-m", model] : []),
    "-",
  ];
}

/** Whether `path` is `parent` or inside it. */
const within = (parent, path) => {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The CLI's release directory: the real binary's grandparent
 * (`.../releases/<version>/bin/codex`). The sandbox re-executes the binary, so
 * the profile must let it be read; it holds the CLI's code, never its login.
 * Refused when it would open the CLI's home or the account's home as a whole.
 */
export async function codexReleaseRoot(bin, { resolve = realpath, home = homedir(), codexHome } = {}) {
  const root = dirname(dirname(await resolve(bin)));
  const forbidden = [home, codexHome ?? join(home, ".codex")];
  if (forbidden.some((path) => within(root, path))) throw new Error("codex_release_root_too_wide");
  return root;
}

const execFileAsync = promisify(execFile);

/** A fresh shallow clone of develop in `checkout` (an empty directory outside the home directory) and its commit. */
export async function cloneDevelop({ checkout, repository, git = execFileAsync }) {
  await git("git", ["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", "develop", "--no-tags", repository, checkout]);
  const { stdout } = await git("git", ["-C", checkout, "rev-parse", "HEAD"]);
  const sha = String(stdout).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("checkout_sha_unreadable");
  return sha;
}

async function postJson(fetchImpl, url, secret, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/**
 * One poll, and one run if it is due. Returns the exit code: 0 for nothing to
 * do or a stored report, 1 for a failure (the claim then lapses after its hold
 * and the next poll may claim again).
 */
export async function runProcessAudit({
  env = process.env,
  fetchImpl = fetch,
  runCodex = runMarketingCodexProcess,
  clone = cloneDevelop,
  releaseRoot = (bin) => codexReleaseRoot(bin, { codexHome: env.CODEX_HOME }),
  workRoot = tmpdir(),
} = {}) {
  const appUrl = env[PROCESS_AUDIT_RUNNER_ENV.appUrl];
  const secret = env[AMUX_PROCESS_AUDIT_SECRET_ENV] ?? "";
  const codexBin = env[PROCESS_AUDIT_RUNNER_ENV.codexBin];
  if (!appUrl || !/^https?:\/\//.test(appUrl) || secret.length < AMUX_PROCESS_AUDIT_MIN_SECRET_LENGTH || !codexBin) {
    log("amux_process_audit_env_missing");
    return 1;
  }
  let codexRoot;
  try {
    codexRoot = await releaseRoot(codexBin);
  } catch (error) {
    log("amux_process_audit_codex_unusable", { failure: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return 1;
  }
  const base = appUrl.replace(/\/+$/, "");
  const context = await postJson(fetchImpl, `${base}/api/internal/amux-process-audit/context`, secret, {});
  if (context.status !== 200 || !context.json) {
    log("amux_process_audit_context_failed", { status: context.status });
    return 1;
  }
  if (context.json.due !== true) {
    log("amux_process_audit_not_due", { reason: context.json.reason ?? null });
    return 0;
  }
  const { token, windowStart, windowEnd, metrics, previous } = context.json;
  const startedAt = Date.now();
  const model = env[PROCESS_AUDIT_RUNNER_ENV.model] || null;
  // The clone and the schema in a directory of their own, outside the home
  // directory, removed whatever happens.
  const directory = await mkdtemp(join(workRoot, "amux-process-audit-"));
  let developSha;
  let answer;
  try {
    const checkout = join(directory, "repo");
    try {
      developSha = await clone({ checkout, repository: env[PROCESS_AUDIT_RUNNER_ENV.repository] || DEFAULT_REPOSITORY });
    } catch (error) {
      log("amux_process_audit_checkout_failed", { failure: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return 1;
    }
    const schemaPath = join(directory, "answer-schema.json");
    await writeFile(schemaPath, JSON.stringify(AMUX_PROCESS_AUDIT_ANSWER_SCHEMA), { mode: 0o600 });
    const childEnv = Object.fromEntries(CODEX_CHILD_VARIABLES.flatMap((name) =>
      typeof env[name] === "string" ? [[name, env[name]]] : []));
    const stdout = await runCodex({
      bin: codexBin,
      args: processAuditCodexArguments({ schemaPath, model, readableRoots: [checkout, codexRoot] }),
      prompt: processAuditPrompt({ windowStart, windowEnd, developSha, metrics, previous }),
      cwd: checkout,
      env: childEnv,
      timeoutMs: PROCESS_AUDIT_CODEX_TIMEOUT_MS,
      searchLimit: Number.MAX_SAFE_INTEGER,
    });
    answer = stdout === null ? null : readMarketingCodexEvents(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (!answer) {
    log("amux_process_audit_codex_no_answer", { seconds: Math.round((Date.now() - startedAt) / 1000) });
    return 1;
  }
  let analysis = null;
  try {
    analysis = parseProcessAuditAnalysis(JSON.parse(answer.content));
  } catch {
    analysis = null;
  }
  if (analysis === null) {
    log("amux_process_audit_answer_invalid", { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens });
    return 1;
  }
  const stored = await postJson(fetchImpl, `${base}/api/internal/amux-process-audit/report`, secret, {
    token, developSha, model, analysis,
  });
  log(stored.status === 201 ? "amux_process_audit_stored" : "amux_process_audit_store_failed", {
    status: stored.status,
    error: stored.status === 201 ? null : stored.json?.error ?? null,
    developSha,
    topItems: analysis.topItems.length,
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  });
  return stored.status === 201 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProcessAudit().then((code) => {
    process.exitCode = code;
  }, (error) => {
    log("amux_process_audit_failed", { failure: error instanceof Error ? error.name : "unknown" });
    process.exitCode = 1;
  });
}
