// The AMUX process analysis agent's box runner (lib/amuxProcessAuditCore.ts,
// docs/ops/amux/process-audit-agent.md). A systemd user timer starts it every
// hour on the AMUX Ubuntu box; the app decides whether a run is due, so the
// cadence and the on/off switch live in Admin, not in the timer.
//
// One run: claim it and receive the app's figures, bring a read-only checkout
// of the public repository to origin/develop, run the Codex CLI signed in to
// the flat-rate subscription in that checkout with a structured answer schema,
// and post the answer back. No API key, so no paid call: a run uses the Codex
// subscription's quota, shared with the AMUX workers.
//
// The CLI gets no variable of this process's: not the secret, not the app's
// address. Its sandbox is read-only and web search is off. What it reads is
// public code; what it writes is only its answer.
//
// On the box this runs as an esbuild bundle (`npm run build:amux-process-audit-box`):
// the box's node has no TypeScript support.

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  checkout: "AMUX_PROCESS_AUDIT_CHECKOUT",
  repository: "AMUX_PROCESS_AUDIT_REPOSITORY",
  model: "AMUX_PROCESS_AUDIT_MODEL",
});

const DEFAULT_REPOSITORY = "https://github.com/mposition/Tomverse.git";
/** One CLI run: long enough to read the pipeline, short of the app's claim hold (3 h). */
export const PROCESS_AUDIT_CODEX_TIMEOUT_MS = 45 * 60 * 1000;
const HTTP_TIMEOUT_MS = 60_000;
/** Tools the analysis never needs. The shell stays: it is how the CLI reads the checkout, inside the read-only sandbox. */
const DISABLED_FEATURES = ["view_image", "apps", "plugins", "image_generation", "request_permissions_tool", "tool_suggest", "multi_agent", "multi_agent_v2"];
const CODEX_CHILD_VARIABLES = ["HOME", "CODEX_HOME", "PATH", "LANG"];

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

export function processAuditCodexArguments({ schemaPath, model }) {
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--sandbox",
    "read-only",
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

const execFileAsync = promisify(execFile);

/** Brings the runner's own clone to origin/develop and returns the commit. */
export async function refreshDevelopCheckout({ checkout, repository, git = execFileAsync }) {
  const exists = await stat(join(checkout, ".git")).then(() => true, () => false);
  if (!exists) await git("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", repository, checkout]);
  await git("git", ["-C", checkout, "fetch", "--quiet", "--no-tags", "origin", "develop"]);
  await git("git", ["-C", checkout, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]);
  await git("git", ["-C", checkout, "clean", "-fdxq"]);
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
  refresh = refreshDevelopCheckout,
} = {}) {
  const appUrl = env[PROCESS_AUDIT_RUNNER_ENV.appUrl];
  const secret = env[AMUX_PROCESS_AUDIT_SECRET_ENV] ?? "";
  const codexBin = env[PROCESS_AUDIT_RUNNER_ENV.codexBin];
  const checkout = env[PROCESS_AUDIT_RUNNER_ENV.checkout];
  if (!appUrl || !/^https?:\/\//.test(appUrl) || secret.length < AMUX_PROCESS_AUDIT_MIN_SECRET_LENGTH || !codexBin || !checkout) {
    log("amux_process_audit_env_missing");
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
  let developSha;
  try {
    developSha = await refresh({ checkout, repository: env[PROCESS_AUDIT_RUNNER_ENV.repository] || DEFAULT_REPOSITORY });
  } catch (error) {
    log("amux_process_audit_checkout_failed", { failure: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return 1;
  }
  const model = env[PROCESS_AUDIT_RUNNER_ENV.model] || null;
  const directory = await mkdtemp(join(tmpdir(), "amux-process-audit-"));
  let answer;
  try {
    const schemaPath = join(directory, "answer-schema.json");
    await writeFile(schemaPath, JSON.stringify(AMUX_PROCESS_AUDIT_ANSWER_SCHEMA), { mode: 0o600 });
    const childEnv = Object.fromEntries(CODEX_CHILD_VARIABLES.flatMap((name) =>
      typeof env[name] === "string" ? [[name, env[name]]] : []));
    const stdout = await runCodex({
      bin: codexBin,
      args: processAuditCodexArguments({ schemaPath, model }),
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
