#!/usr/bin/env node
/**
 * The auto-rec credential gateway. It is the only process that holds the
 * app's shared secret and the GitHub token, and it runs as its own systemd
 * DynamicUser, never as `autorec`: that account runs code the agent wrote
 * (its tests), and any process of the same uid can read another's
 * /proc/<pid>/environ. The same split as review-status-sender.
 *
 * systemd starts one instance per connection on /run/autorec-gateway.sock
 * (Accept=yes, socket mode 0600 owned by autorec). The request is one JSON
 * line, followed for `publish` by a git bundle; the answer is one JSON line.
 *
 *   {"op":"claim"}                                  -> claimed | empty | error | unknown
 *   {"op":"result","id","outcome","prUrl"|"reason"} -> reported | error | unknown
 *   {"op":"publish","id","branch","head","title","body"} + bundle
 *                                                   -> published | refused | failed | unknown
 *
 * Whatever the caller says, the gateway itself decides what may leave: the
 * branch is the recommendation's own new `claude/to-develop/auto-rec-*` branch,
 * the change passes the same scope check as the runner's against a develop it
 * fetched itself, a push never overwrites a branch, and at most
 * LIMITS.publishesPerDay publishes start in 24 hours. Outcomes it cannot see
 * are verified once (ls-remote, a PR listing) and otherwise answered as
 * `unknown`; nothing is retried.
 *
 * Node built-ins only, plus the pure modules next to it.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_CLAIM_PATH,
  APP_RESULT_PATH,
  GITHUB_API,
  LIMITS,
  REPO_OWNER,
  REPO_SLUG,
  REPO_URL,
  appRequestHeaders,
} from "../lib/contract.mjs";
import {
  RECOMMENDATION_ID,
  boundPrText,
  branchNameFor,
  buildResultBody,
  checkChangeScope,
  isAutoRecBranch,
  isPrUrl,
  parseRawDiff,
  validateClaim,
} from "../lib/core.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DAY_MS = 24 * 60 * 60_000;

export function readGatewayConfig(env) {
  const appUrl = env.AUTOREC_APP_URL ?? "";
  let origin = null;
  try {
    const url = new URL(appUrl);
    if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.username) origin = url.origin;
  } catch {
    origin = null;
  }
  const missing = [];
  if (!origin) missing.push("AUTOREC_APP_URL");
  if ((env.AUTOREC_APP_SECRET ?? "").length < 16) missing.push("AUTOREC_APP_SECRET");
  if ((env.AUTOREC_GITHUB_TOKEN ?? "").length < 20) missing.push("AUTOREC_GITHUB_TOKEN");
  return {
    missing,
    appOrigin: origin,
    appSecret: env.AUTOREC_APP_SECRET ?? "",
    githubToken: env.AUTOREC_GITHUB_TOKEN ?? "",
    // systemd sets STATE_DIRECTORY for StateDirectory=.
    stateDir: env.STATE_DIRECTORY?.split(":")[0] || "/var/lib/autorec-gw",
    tmpDir: tmpdir(),
    path: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
}

/** One JSON header line, then the payload bytes. */
export function splitRequest(buffer) {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0 || newline > LIMITS.headerBytes) throw new Error("request_header_invalid");
  let header;
  try {
    header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
  } catch {
    throw new Error("request_header_invalid");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("request_header_invalid");
  return { header, payload: buffer.subarray(newline + 1) };
}

// ---------------------------------------------------------------- app

async function appPost(deps, path, body) {
  const { config } = deps;
  let response;
  try {
    response = await deps.fetch(`${config.appOrigin}${path}`, {
      method: "POST",
      headers: appRequestHeaders(config.appSecret),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // Sent or not, the app may have acted: the caller does not retry.
    return { kind: "unknown" };
  }
  if (response.status >= 500) return { kind: "unknown", status: response.status };
  let json = null;
  if (response.status === 200) {
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
  }
  return { kind: "answer", status: response.status, json };
}

async function claim(deps) {
  const answer = await appPost(deps, APP_CLAIM_PATH, {});
  if (answer.kind === "unknown") return { status: "unknown", code: answer.status ? `http_${answer.status}` : "network" };
  if (answer.status === 204) return { status: "empty" };
  if (answer.status !== 200) return { status: "error", code: `http_${answer.status}` };
  const checked = validateClaim(answer.json);
  if (!checked.ok) return { status: "error", code: checked.code };
  return { status: "claimed", claim: checked.claim };
}

async function result(deps, header) {
  let body;
  try {
    body = buildResultBody(header);
  } catch (error) {
    return { status: "error", code: error.message };
  }
  const answer = await appPost(deps, APP_RESULT_PATH, body);
  if (answer.kind === "unknown") return { status: "unknown", code: answer.status ? `http_${answer.status}` : "network" };
  if (answer.status >= 200 && answer.status < 300) return { status: "reported" };
  return { status: "error", code: `http_${answer.status}` };
}

// ---------------------------------------------------------------- publish

function gitEnv(config, extra = {}) {
  return {
    PATH: config.path,
    HOME: config.stateDir,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/** The token reaches git through its environment, never its argv (/proc/<pid>/cmdline is world-readable). */
function pushEnv(config) {
  const basic = Buffer.from(`x-access-token:${config.githubToken}`, "utf8").toString("base64");
  return gitEnv(config, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
}

/** Reserve one of the day's publishes before doing anything that can leave the host. */
function reservePublish(deps) {
  const path = join(deps.config.stateDir, "publishes.json");
  const now = deps.now();
  let stamps = [];
  const text = deps.fs.readText(path);
  if (text !== null) {
    try {
      stamps = JSON.parse(text).filter((value) => Number.isFinite(value) && value > now - DAY_MS);
    } catch {
      // An unreadable log counts as full: refusing is the safe reading.
      return false;
    }
  }
  if (stamps.length >= LIMITS.publishesPerDay) return false;
  deps.fs.writeTextAtomic(path, JSON.stringify([...stamps, now]));
  return true;
}

const refused = (code, detail = undefined) => ({ status: "refused", code, ...(detail ? { detail } : {}) });

async function githubRequest(deps, method, path, body) {
  try {
    const response = await deps.fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${deps.config.githubToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "tomverse-auto-rec-gateway",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: true, status: response.status, json };
  } catch {
    return { ok: false };
  }
}

async function findOpenPr(deps, branch) {
  const head = encodeURIComponent(`${REPO_OWNER}:${branch}`);
  const answer = await githubRequest(deps, "GET", `/repos/${REPO_SLUG}/pulls?head=${head}&base=develop&state=open`);
  if (!answer.ok || answer.status !== 200 || !Array.isArray(answer.json)) return { known: false, pr: null };
  return { known: true, pr: answer.json[0] ?? null };
}

/**
 * Auto PR to Develop opens a draft for the pushed branch; wait for it, and
 * open the draft here only when it has not appeared, so the two never race
 * into two pull requests.
 */
async function ensurePullRequest(deps, branch, text) {
  const deadline = deps.now() + LIMITS.autoPrWaitMs;
  let found = await findOpenPr(deps, branch);
  while (!found.pr && deps.now() < deadline) {
    await deps.sleep(LIMITS.autoPrPollMs);
    found = await findOpenPr(deps, branch);
  }
  let created = false;
  if (!found.pr) {
    const answer = await githubRequest(deps, "POST", `/repos/${REPO_SLUG}/pulls`, {
      title: text.title,
      head: branch,
      base: "develop",
      body: text.body,
      draft: true,
    });
    if (answer.ok && answer.status === 201) {
      found = { known: true, pr: answer.json };
      created = true;
    } else {
      // 422 (Auto PR got there first) or an unanswered request: look once.
      found = await findOpenPr(deps, branch);
    }
  }
  const prUrl = found.pr?.html_url;
  if (!isPrUrl(prUrl)) return { status: "failed", code: "pr_failed", pushed: true, branch };
  let bodyUpdated = created;
  if (!created) {
    const patch = await githubRequest(deps, "PATCH", `/repos/${REPO_SLUG}/pulls/${found.pr.number}`, text);
    bodyUpdated = patch.ok && patch.status === 200;
  }
  return { status: "published", prUrl, number: found.pr.number, bodyUpdated };
}

async function publish(deps, header, payload) {
  const { config, git } = deps;
  const { id, branch, head } = header;
  if (typeof id !== "string" || !RECOMMENDATION_ID.test(id)) return refused("runner_error", "id_invalid");
  if (!isAutoRecBranch(branch) || branch !== branchNameFor(id)) return refused("runner_error", "branch_invalid");
  if (typeof head !== "string" || !SHA.test(head)) return refused("runner_error", "head_invalid");
  if (payload.length === 0 || payload.length > LIMITS.bundleBytes) return refused("runner_error", "bundle_size");
  if (!reservePublish(deps)) return refused("rate_limited");

  const mirror = join(config.stateDir, "mirror.git");
  const env = gitEnv(config);
  const run = (args, timeoutMs = 120_000, extraEnv = env) => git(["-C", mirror, ...args], { env: extraEnv, timeoutMs });
  if (!deps.fs.exists(join(mirror, "HEAD"))) {
    const init = await git(["init", "--quiet", "--bare", mirror], { env, timeoutMs: 60_000 });
    if (init.code !== 0) return refused("setup_failed", "mirror_init");
  }
  // Develop as GitHub has it, read anonymously: the base the change is judged against.
  const fetched = await run(["fetch", "--no-tags", "--quiet", REPO_URL, "+refs/heads/develop:refs/remotes/origin/develop"], 30 * 60_000);
  if (fetched.code !== 0) return refused("setup_failed", "develop_fetch");

  const bundle = join(config.tmpDir, `autorec-${randomBytes(8).toString("hex")}.bundle`);
  deps.fs.writeBuffer(bundle, payload);
  try {
    if ((await run(["bundle", "verify", "--quiet", bundle])).code !== 0) return refused("setup_failed", "bundle_verify");
    const incoming = "refs/autorec/incoming";
    if ((await run(["fetch", "--no-tags", "--quiet", bundle, `+refs/heads/${branch}:${incoming}`])).code !== 0) {
      return refused("setup_failed", "bundle_fetch");
    }
    const tip = await run(["rev-parse", "--verify", `${incoming}^{commit}`]);
    if (tip.code !== 0 || tip.stdout.trim() !== head) return refused("setup_failed", "head_mismatch");
  } finally {
    deps.fs.remove(bundle);
  }

  const forkPoint = await run(["merge-base", "refs/remotes/origin/develop", head]);
  if (forkPoint.code !== 0) return refused("setup_failed", "no_merge_base");
  const diff = await run(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", forkPoint.stdout.trim(), head]);
  if (diff.code !== 0) return refused("setup_failed", "diff");
  let scope;
  try {
    scope = checkChangeScope(parseRawDiff(diff.stdout));
  } catch {
    return refused("setup_failed", "diff_unparsed");
  }
  if (!scope.ok) return refused(scope.reason);

  // Create-only: an empty lease value means the branch must not exist yet.
  const push = await run(
    ["push", "--porcelain", "--no-verify", `--force-with-lease=refs/heads/${branch}:`, REPO_URL, `${head}:refs/heads/${branch}`],
    10 * 60_000,
    pushEnv(config),
  );
  if (push.code !== 0) {
    if (/\t\[(?:remote )?rejected\]/.test(push.stdout)) return refused("push_rejected");
    // Unknown outcome: look, once, without credentials.
    const look = await run(["ls-remote", REPO_URL, `refs/heads/${branch}`], 120_000);
    if (look.code !== 0) return { status: "unknown", step: "push" };
    const remote = look.stdout.trim().split(/\s+/)[0] ?? "";
    if (remote === "") return refused("push_failed");
    if (remote !== head) return refused("push_rejected");
  }
  deps.log("pushed", { branch, head });
  return ensurePullRequest(deps, branch, boundPrText(header));
}

// ---------------------------------------------------------------- dispatch

export async function handleRequest(deps, header, payload) {
  if (deps.config.missing.length > 0) return { status: "error", code: "gateway_config_missing", missing: deps.config.missing };
  if (header.op === "claim") return claim(deps);
  if (header.op === "result") return result(deps, header);
  if (header.op === "publish") return publish(deps, header, payload);
  return { status: "error", code: "op_invalid" };
}

function realGit(args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", () => resolve({ code: 127, stdout: "", stderr: "" }));
    child.on("close", (code) =>
      resolve({ code: code ?? 124, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

export function realGatewayDeps(env) {
  const config = readGatewayConfig(env);
  return {
    config,
    git: realGit,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fs: {
      exists: (path) => existsSync(path),
      readText: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      writeTextAtomic: (path, text) => {
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, path);
      },
      writeBuffer: (path, buffer) => writeFileSync(path, buffer, { mode: 0o600 }),
      remove: (path) => rmSync(path, { force: true }),
    },
    // Event names and codes only: never a header, an environment value or a response body.
    log: (event, fields = {}) => process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`),
  };
}

async function readAll(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const deps = realGatewayDeps(process.env);
  let answer;
  let op = null;
  try {
    const { header, payload } = splitRequest(await readAll(process.stdin, LIMITS.headerBytes + LIMITS.bundleBytes + 1));
    op = typeof header.op === "string" ? header.op.slice(0, 20) : null;
    answer = await handleRequest(deps, header, payload);
  } catch (error) {
    answer = { status: "error", code: error.message === "request_too_large" ? "request_too_large" : "request_invalid" };
  }
  deps.log("gateway_answer", { op, status: answer.status, code: answer.code ?? null, detail: answer.detail ?? null });
  // stdout is the connection: exit only once the answer has been handed to it.
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(answer)}\n`, resolve));
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
    () => process.exit(0),
    () => process.exit(1),
  );
}
