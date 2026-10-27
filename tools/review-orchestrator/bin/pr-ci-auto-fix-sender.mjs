#!/usr/bin/env node
/**
 * Dispatches .github/workflows/pr-ci-auto-fix.yml with the patches that
 * bin/pr-ci-auto-fix.mjs leaves in its outbox.
 *
 * One self-contained file that imports only Node built-ins. It is installed
 * root-owned outside the review account's checkout and runs under its own
 * account (deploy/pr-ci-auto-fix-sender.service, systemd DynamicUser), because
 * it holds the only token that can dispatch a workflow and the model runs as
 * the review account. Code the review account can edit must never run here.
 *
 * The outbox is written by the review account, so every request is untrusted:
 * it is rebuilt field by field, each request is sent once, a head sends at
 * most MAX_SENDS_PER_HEAD, and at most MAX_DISPATCHES_PER_HOUR go out an hour. The workflow re-decides everything
 * from GitHub's own records; the worst a forged request can do is what a bad
 * model patch can do, and the workflow's guard judges both.
 *
 * Environment:
 *   PR_CI_AUTO_FIX_DISPATCH_TOKEN   GitHub token: Actions read and write on the repository, nothing else
 *   PR_CI_AUTO_FIX_REPO             owner/name
 *   PR_CI_AUTO_FIX_OUTBOX           absolute directory bin/pr-ci-auto-fix.mjs writes
 *   STATE_DIRECTORY                 set by systemd's StateDirectory=: where the sent ledger lives
 *
 * Exit 64 when the settings cannot run; otherwise it runs until stopped.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DISPATCH_TOKEN_ENV = "PR_CI_AUTO_FIX_DISPATCH_TOKEN";
export const SCAN_INTERVAL_SECONDS = 60;
/**
 * A request older than this is not sent (logged once). The proposing half
 * queues no faster than the hourly cap, so only a long outage expires one;
 * the workflow refuses a head the branch has moved past anyway.
 */
export const REQUEST_MAX_AGE_MS = 6 * 60 * 60_000;
export const REQUEST_MAX_BYTES = 128 * 1024;
export const MAX_DISPATCHES_PER_HOUR = 6;
/**
 * Requests one head may send in all: a failed-CI fix and a conflict
 * resolution, each tried once and once more on the operator's request. A
 * request is sent once (its head and creation time), so a new request for a
 * head -- a retry, the other kind -- is sent too, up to this many.
 */
export const MAX_SENDS_PER_HEAD = 4;
const SENT_KEY = /^([0-9a-f]{40})(@[0-9]{1,16})?$/;
/** A request's identity in the sent ledger. */
export const requestKey = (request) => `${request.headSha}@${request.createdAt}`;
export const SENT_KEEP_MS = 14 * 86_400_000;
const TIMEOUT_MS = 30_000;
// The workflow's own input limits (its target job refuses anything else).
const PATCH_MAX_CHARS = 60_000;
const MAX_RUN_IDS = 8;
const MAX_RUN_ID = 999_999_999_999_999;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const REQUEST_NAME = /^[0-9a-f]{40}\.json$/;

const isAbsolute = (path) => typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");

/**
 * The request rebuilt from an outbox file, or null when it is not one. A
 * failed-CI fix names its failed runs; a conflict resolution (`kind:
 * "conflict"`) names the develop commit to merge and no runs.
 */
export function normaliseDispatchRequest(value, fileName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { schemaVersion, kind = "ci", baseSha, prNumber, headSha, runIds, patchGzB64, createdAt } = value;
  if (schemaVersion !== 1) return null;
  if (kind !== "ci" && kind !== "conflict") return null;
  if (!Number.isInteger(prNumber) || prNumber < 1 || prNumber > 9_999_999) return null;
  if (typeof headSha !== "string" || !SHA.test(headSha) || fileName !== `${headSha}.json`) return null;
  if (!Array.isArray(runIds) || runIds.length > MAX_RUN_IDS) return null;
  if (kind === "ci" ? runIds.length < 1 : runIds.length !== 0) return null;
  if (!runIds.every((id) => Number.isSafeInteger(id) && id > 0 && id <= MAX_RUN_ID)) return null;
  if (kind === "conflict" ? typeof baseSha !== "string" || !SHA.test(baseSha) : baseSha !== undefined) return null;
  if (typeof patchGzB64 !== "string" || patchGzB64.length === 0 || patchGzB64.length > PATCH_MAX_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(patchGzB64)) return null;
  // A whole number of milliseconds: it is the request's key in the sent
  // ledger (requestKey), which must read back as the key it was written.
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  const request = { prNumber, headSha, runIds: [...runIds], patchGzB64, createdAt };
  return kind === "conflict" ? { kind, baseSha, ...request } : request;
}

/**
 * The workflow_dispatch inputs, named as .github/workflows/pr-ci-auto-fix.yml
 * declares them. A failed-CI fix sends exactly the inputs it always has, so a
 * workflow on main older than the conflict inputs still takes it.
 */
export const dispatchInputs = (request) => ({
  pr_number: String(request.prNumber),
  head_sha: request.headSha,
  run_ids: request.runIds.join(","),
  patch_gz_b64: request.patchGzB64,
  ...(request.kind === "conflict" ? { kind: "conflict", base_sha: request.baseSha } : {}),
});

/**
 * One POST to the default branch's workflow. Resolves to the HTTP status as
 * an outcome, or a short reason when no answer came. Redirects are refused:
 * the token goes to api.github.com and nowhere else.
 */
export async function dispatchWorkflow({ repo, token, request, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/pr-ci-auto-fix.yml/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: dispatchInputs(request) }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.status === 204, outcome: `http_${response.status}` };
  } catch (error) {
    return { ok: false, outcome: error?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

/** The settings from the environment, or a reason the sender cannot run. The token's value never appears in a reason. */
export function senderSettings(env = process.env) {
  const token = env[DISPATCH_TOKEN_ENV];
  if (typeof token !== "string" || token.length < 20) return { error: `${DISPATCH_TOKEN_ENV} is missing` };
  if (!REPO.test(env.PR_CI_AUTO_FIX_REPO ?? "")) return { error: "PR_CI_AUTO_FIX_REPO must be owner/name" };
  if (!isAbsolute(env.PR_CI_AUTO_FIX_OUTBOX)) return { error: "PR_CI_AUTO_FIX_OUTBOX must be an absolute path" };
  if (!isAbsolute(env.STATE_DIRECTORY)) return { error: "STATE_DIRECTORY must be an absolute path (systemd StateDirectory=)" };
  return { token, repo: env.PR_CI_AUTO_FIX_REPO, outbox: env.PR_CI_AUTO_FIX_OUTBOX, stateDir: env.STATE_DIRECTORY };
}

/**
 * One open file and at most one byte past the cap, so a larger file is
 * refused without loading it. Opened non-blocking and without following a
 * link: the review account could leave a FIFO under a request's name, and a
 * blocking open would wait for a writer forever.
 */
export function readRequestFile(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(REQUEST_MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
      if (size === buffer.length) return null;
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const parseOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The sent ledger { headSha: sentAt } without entries older than SENT_KEEP_MS. */
export function readSent(path, now) {
  const value = parseOrNull((() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "{}";
    }
  })());
  const sent = {};
  // Keys are requests (head sha, then the created stamp); a bare head is a sender older than that.
  for (const [key, at] of Object.entries(value ?? {})) {
    if (SENT_KEY.test(key) && Number.isFinite(at) && now - at < SENT_KEEP_MS) sent[key] = at;
  }
  return sent;
}

function writeSent(path, sent) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sent)}\n`);
  renameSync(tmp, path);
}

/**
 * One scan per call, oldest request first. A request is written to the
 * sent ledger before its POST, so an unknown outcome is never sent again; a
 * head sends at most MAX_SENDS_PER_HEAD requests. Logs one line per request
 * it acts on, and the rate cap once while it holds.
 */
export function createDispatchSender({
  settings, log, fetchImpl = fetch, now = Date.now,
  listOutbox = (dir) => readdirSync(dir), readRequest = readRequestFile,
}) {
  const sentPath = join(settings.stateDir, "sent.json");
  let capped = false;
  const expired = new Set();
  return {
    async scanOnce() {
      let names;
      try {
        names = listOutbox(settings.outbox);
      } catch (error) {
        log(`outbox unreadable: ${error.code ?? "error"}`);
        return;
      }
      const at = now();
      const sent = readSent(sentPath, at);
      const requests = [];
      for (const name of names) {
        if (!REQUEST_NAME.test(name)) continue;
        let text;
        try {
          text = readRequest(join(settings.outbox, name));
        } catch {
          continue;
        }
        const request = text === null ? null : normaliseDispatchRequest(parseOrNull(text), name);
        if (request === null) {
          log(`request ${name.slice(0, 9)} is not a valid request; not sending`);
          continue;
        }
        if (at - request.createdAt > REQUEST_MAX_AGE_MS || request.createdAt - at > 5 * 60_000) {
          if (!expired.has(request.headSha)) log(`#${request.prNumber} ${request.headSha.slice(0, 9)}: request expired; not sending`);
          expired.add(request.headSha);
          continue;
        }
        const head = request.headSha;
        if (sent[requestKey(request)] !== undefined) continue;
        // A head an older sender recorded: the request it sent was made before then.
        if (sent[head] !== undefined && sent[head] >= request.createdAt) continue;
        if (Object.keys(sent).filter((key) => key.startsWith(head)).length >= MAX_SENDS_PER_HEAD) {
          if (!expired.has(`cap:${head}`)) log(`#${request.prNumber} ${head.slice(0, 9)}: ${MAX_SENDS_PER_HEAD} requests sent for this head; not sending`);
          expired.add(`cap:${head}`);
          continue;
        }
        requests.push(request);
      }
      requests.sort((a, b) => a.createdAt - b.createdAt);
      for (const request of requests) {
        const lastHour = Object.values(sent).filter((time) => at - time < 60 * 60_000).length;
        if (lastHour >= MAX_DISPATCHES_PER_HOUR) {
          if (!capped) log(`rate cap: ${MAX_DISPATCHES_PER_HOUR} dispatches in the last hour; waiting`);
          capped = true;
          return;
        }
        capped = false;
        sent[requestKey(request)] = at;
        mkdirSync(settings.stateDir, { recursive: true });
        writeSent(sentPath, sent);
        const result = await dispatchWorkflow({ repo: settings.repo, token: settings.token, request, fetchImpl });
        log(`#${request.prNumber} ${request.headSha.slice(0, 9)}: ${result.ok ? "dispatched" : `dispatch failed: ${result.outcome}`}`);
      }
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const settings = senderSettings(process.env);
  if (settings.error) {
    log(`ci-fix sender not started: ${settings.error}`);
    return 64;
  }
  // A POST in flight is recorded as sent already; stopping just ends it.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  const sender = createDispatchSender({ settings, log });
  log("ci-fix sender started");
  for (;;) {
    await sender.scanOnce();
    await sleep(SCAN_INTERVAL_SECONDS * 1000);
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
      process.stderr.write(`ci-fix sender failed: ${error.message}\n`);
      process.exit(65);
    },
  );
}
