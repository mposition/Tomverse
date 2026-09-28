// The engineering agent publisher service's entry point
// (docs/policy/engineering-agent.md §8, §9, §10). Railway runs it on a schedule, in its own image, with
// `node --experimental-strip-types scripts/engineering-agent-publisher.mjs`.
//
// It holds the publisher GitHub App's key, the publisher's route secret and
// its dead-man monitor URL -- and nothing else: no model key, no database, no
// AMUX secret. The App token is minted only after a claim returns work, for
// this one repository and the three permissions the policy names, and is
// revoked when the cycle ends. A token that would carry `workflows` is
// refused before use. The clone is fetched without credentials; the token is
// handed to git only for the push, in the environment, never in a URL or an
// argument. Nothing from the clone is installed or executed. At the hard
// deadline the supervisor kills the whole process group.
//
// Imports: node builtins and the dependency-free core only.

import { spawn } from "node:child_process";
import { createHash, createSign } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalSignalIsSuccess, reportedHalt } from "../lib/engineeringAgentCore.ts";
import { runPublisherCycle } from "./engineering-agent-publisher-core.mjs";
import { isSupervisedWorker, superviseCycle } from "./engineering-agent-supervisor.mjs";

/** The hard deadline of one cycle, inside the claim's ten-minute lease (§12). */
export const PUBLISHER_HARD_DEADLINE_MS = 8 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const OWNER = "mposition";
const REPOSITORY = "Tomverse";
const REPOSITORY_URL = `https://github.com/${OWNER}/${REPOSITORY}.git`;
const API = "https://api.github.com";
/** AMUX's review diff limit (lib/amux/reviewGitHub.ts): a larger diff is not one it binds. */
const MAX_DIFF_BYTES = 1024 * 1024;
/** Revoking the token must finish inside the supervisor's grace before SIGKILL. */
const REVOKE_TIMEOUT_MS = 3_000;

/** Exactly the variables this service reads; the IaC declaration lists the same. */
export const PUBLISHER_VARIABLES = [
  "ENGINEERING_AGENT_APP_URL",
  "ENGINEERING_AGENT_PUBLISHER_SECRET",
  "ENGINEERING_AGENT_PUBLISHER_APP_ID",
  "ENGINEERING_AGENT_PUBLISHER_INSTALLATION_ID",
  "ENGINEERING_AGENT_PUBLISHER_PRIVATE_KEY",
  "ENGINEERING_AGENT_PUBLISHER_DEADMAN_URL",
];

/** The permissions the installation token asks for, and the only ones it may carry (§8, §9-2). */
export const PUBLISHER_TOKEN_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  metadata: "read",
});

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const base64url = (input) => Buffer.from(input).toString("base64url");

/** A GitHub App JWT (RS256), valid for nine minutes from a minute ago. */
export const appJwt = (appId, privateKey, nowSeconds) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
};

/** A token whose permissions are anything but the three named is not used. */
export const tokenPermissionsAllowed = (permissions) => {
  if (permissions === null || typeof permissions !== "object") return false;
  const entries = Object.entries(permissions);
  return (
    entries.length === Object.keys(PUBLISHER_TOKEN_PERMISSIONS).length &&
    entries.every(([name, level]) => PUBLISHER_TOKEN_PERMISSIONS[name] === level)
  );
};

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // No hooks, no templates, no prompts, no user or system configuration.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_TEMPLATE_DIR: "",
        ...(options.env ?? {}),
      },
    });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out) }));
    child.on("error", () => resolve({ code: -1, stdout: Buffer.alloc(0) }));
  });

const git = (args, options) =>
  run("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "commit.gpgsign=false", ...args], options);

async function workspaceAt(baseSha) {
  const work = await realpath(await mkdtemp(join(tmpdir(), "engineering-publisher-")));
  const home = work;
  const repo = join(work, "repo");
  const step = async (args, options = {}) => {
    const result = await git(["-C", repo, ...args], { home, ...options });
    if (result.code !== 0) throw new Error("git_failed");
    return result.stdout.toString("utf8");
  };
  if ((await git(["init", "-q", repo], { home })).code !== 0) throw new Error("git_failed");
  let baseCommitterDate = null;
  if (baseSha !== null) {
    if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("base_sha_invalid");
    await step(["fetch", "-q", "--depth", "1", REPOSITORY_URL, baseSha]);
    const baseObject = await step(["cat-file", "commit", baseSha]);
    const committer = baseObject.split("\n").find((line) => line.startsWith("committer "));
    const date = committer?.match(/ ([0-9]{1,12} [+-][0-9]{4})$/)?.[1];
    if (!date) throw new Error("base_commit_unreadable");
    baseCommitterDate = date;
  }
  return {
    baseCommitterDate,
    build: async ({ patch, identity, date, message }) => {
      const patchFile = join(work, "change.patch");
      const messageFile = join(work, "message");
      await writeFile(patchFile, patch, "utf8");
      await writeFile(messageFile, message, "utf8");
      await step(["read-tree", baseSha]);
      const applied = await git(["-C", repo, "apply", "--cached", patchFile], { home });
      if (applied.code !== 0) return null;
      const treeId = (await step(["write-tree"])).trim();
      const env = {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_COMMITTER_DATE: date,
      };
      const commitSha = (await step(["commit-tree", treeId, "-p", baseSha, "-F", messageFile], { env })).trim();
      const commitObject = await step(["cat-file", "commit", commitSha]);
      return { treeId, commitSha, commitObject };
    },
    // The one push: create the branch, which must not exist (an empty lease).
    push: async (commitSha, branch, token) => {
      const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
      const result = await git(
        ["-C", repo, "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:`, REPOSITORY_URL, `${commitSha}:refs/heads/${branch}`],
        {
          home,
          env: {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${REPOSITORY_URL}.extraheader`,
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
          },
        },
      );
      return result.code === 0;
    },
    commitObjectAt: async (sha) => {
      if (!/^[0-9a-f]{40}$/.test(sha)) return null;
      const fetched = await git(["-C", repo, "fetch", "-q", "--depth", "1", REPOSITORY_URL, sha], { home });
      if (fetched.code !== 0) return null;
      const object = await git(["-C", repo, "cat-file", "commit", sha], { home });
      return object.code === 0 ? object.stdout.toString("utf8") : null;
    },
    dispose: () => rm(work, { recursive: true, force: true }),
  };
}

const githubRequest = async (token, method, path, { body, accept, timeoutMs = TIMEOUT_MS } = {}) =>
  fetch(`${API}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: accept ?? "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/**
 * The digest AMUX's review binds (lib/amux/reviewGitHub.ts): the diff's own
 * bytes, and only for a diff AMUX would take -- valid UTF-8, a git diff, no
 * binary patch, no control or bidirectional character that could hide or
 * reorder what a person reviews. Anything else is refused, never hashed.
 */
export const bindableDiffDigest = (bytes) => {
  if (bytes.byteLength > MAX_DIFF_BYTES || bytes.includes(0)) return { refused: true };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { refused: true };
  }
  if (
    /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(text) ||
    !text.startsWith("diff --git ") ||
    /^GIT binary patch$/m.test(text) ||
    /^Binary files .+ differ$/m.test(text)
  ) {
    return { refused: true };
  }
  return { digest: createHash("sha256").update(bytes).digest("hex") };
};

const hasNextPage = (link) => link !== null && /<[^>]*>\s*;\s*rel="?next"?/i.test(link);

const pullOf = (value) => ({
  number: value?.number,
  state: value?.state,
  baseRef: value?.base?.ref,
  baseSha: value?.base?.sha,
  headRef: value?.head?.ref,
  headSha: value?.head?.sha,
  body: typeof value?.body === "string" ? value.body : "",
});

const githubPorts = (token) => ({
  branchOid: async (branch) => {
    const response = await githubRequest(token, "GET", `/repos/${OWNER}/${REPOSITORY}/git/ref/heads/${branch}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("github_read_failed");
    const body = await response.json();
    // A prefix match returns a list: not this branch.
    if (Array.isArray(body) || body?.ref !== `refs/heads/${branch}`) throw new Error("github_read_failed");
    return body.object?.sha ?? null;
  },
  pullsForHead: async (branch) => {
    const response = await githubRequest(
      token,
      "GET",
      `/repos/${OWNER}/${REPOSITORY}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${OWNER}:${branch}`)}`,
    );
    if (!response.ok || hasNextPage(response.headers.get("link"))) throw new Error("github_read_failed");
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("github_read_failed");
    return body.map(pullOf);
  },
  pullDiffDigest: async (number) => {
    const response = await githubRequest(token, "GET", `/repos/${OWNER}/${REPOSITORY}/pulls/${number}`, {
      accept: "application/vnd.github.diff",
    }).catch(() => null);
    if (response === null || !response.ok) return null;
    // Read with the limit, as AMUX does: a body past it stops being read.
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DIFF_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { refused: true };
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    return bindableDiffDigest(Buffer.concat(chunks));
  },
  createPull: async ({ title, body, head }) => {
    let response;
    try {
      response = await githubRequest(token, "POST", `/repos/${OWNER}/${REPOSITORY}/pulls`, {
        body: { title, body, head, base: "develop", draft: false, maintainer_can_modify: false },
      });
    } catch {
      return { status: "unknown" };
    }
    if (response.status === 201) {
      const created = await response.json().catch(() => null);
      return Number.isSafeInteger(created?.number) ? { status: "created", number: created.number } : { status: "unknown" };
    }
    // A 4xx is a definite refusal (§10); anything else is not known.
    return response.status >= 400 && response.status < 500 ? { status: "rejected" } : { status: "unknown" };
  },
});

async function mintToken({ appId, installationId, privateKey }, hold) {
  const jwt = appJwt(appId, privateKey, Math.floor(Date.now() / 1000));
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ repositories: [REPOSITORY], permissions: PUBLISHER_TOKEN_PERMISSIONS }),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 201 || typeof body?.token !== "string") throw new Error("token_unavailable");
  const revoke = async () => {
    await githubRequest(body.token, "DELETE", "/installation/token", { timeoutMs: REVOKE_TIMEOUT_MS }).catch(() => undefined);
  };
  // Held before anything else is awaited, so a SIGTERM from here on revokes it.
  const minted = { token: body.token, revoke };
  hold(minted);
  if (!tokenPermissionsAllowed(body.permissions)) {
    await revoke();
    throw new Error("token_permissions_refused");
  }
  return minted;
}

/**
 * A workspace whose writes -- build, push, reading an object -- refuse at the
 * moment they are called once the process is stopping: a SIGTERM that arrives
 * while the last look is answering must not be followed by a push (§9-8).
 * Disposing still works.
 */
export const stoppableWorkspace = (open, isStopping) => async (...args) => {
  if (isStopping()) throw new Error("stopping");
  const workspace = await open(...args);
  const guard = (fn) => (...inner) => {
    if (isStopping()) throw new Error("stopping");
    return fn(...inner);
  };
  return {
    ...workspace,
    build: guard(workspace.build),
    push: guard(workspace.push),
    commitObjectAt: guard(workspace.commitObjectAt),
  };
};

async function main() {
  // The supervisor: a cycle that outlives its deadline is killed with its
  // whole process group -- git included -- not trusted.
  if (!isSupervisedWorker()) {
    const deadMan = required("ENGINEERING_AGENT_PUBLISHER_DEADMAN_URL");
    process.exit(
      await superviseCycle({
        deadlineMs: PUBLISHER_HARD_DEADLINE_MS,
        failUrl: `${deadMan.replace(/\/+$/, "")}/fail`,
        event: "engineering_publisher_deadline",
      }),
    );
  }

  const appUrl = required("ENGINEERING_AGENT_APP_URL").replace(/\/+$/, "");
  const secret = required("ENGINEERING_AGENT_PUBLISHER_SECRET");
  const deadMan = required("ENGINEERING_AGENT_PUBLISHER_DEADMAN_URL");
  const credentials = {
    appId: required("ENGINEERING_AGENT_PUBLISHER_APP_ID"),
    installationId: required("ENGINEERING_AGENT_PUBLISHER_INSTALLATION_ID"),
    privateKey: required("ENGINEERING_AGENT_PUBLISHER_PRIVATE_KEY").replace(/\\n/g, "\n"),
  };

  const app = async (path, body) => {
    const response = await fetch(`${appUrl}/api/internal/engineering-agent/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  // The supervisor's first signal at the deadline: revoke the token this cycle
  // holds before the group is killed (§13-20), then stop.
  let heldToken = null;
  // From SIGTERM on, nothing more is written or signalled: every call to the
  // app or GitHub refuses, the token is revoked, and the process exits.
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
    void (heldToken?.revoke() ?? Promise.resolve()).finally(() => process.exit(70));
  });
  const unlessStopping = (fn) => (...args) => {
    if (stopping) throw new Error("stopping");
    return fn(...args);
  };

  let result;
  try {
    result = await runPublisherCycle({
      app: unlessStopping(app),
      mintToken: unlessStopping(() =>
        mintToken(credentials, (minted) => {
          heldToken = minted;
        }),
      ),
      github: (token) => {
        const ports = githubPorts(token);
        return Object.fromEntries(Object.entries(ports).map(([name, fn]) => [name, unlessStopping(fn)]));
      },
      workspace: stoppableWorkspace(workspaceAt, () => stopping),
    });
  } catch (error) {
    result = { finishedNormally: false, halt: "unknown", reason: error instanceof Error ? error.message : "failed" };
  }

  // A cycle that ran to its end says so, and reads the halt once more: the
  // signal follows the halt as it stands now, not as it stood at the claim.
  let haltAfter = "unknown";
  if (stopping) return;
  if (result.finishedNormally) {
    const finished = await app("service/finished", {}).catch(() => null);
    haltAfter = finished?.status === 200 ? reportedHalt(finished.json?.halt) : "unknown";
  }
  const success = finalSignalIsSuccess({ finishedNormally: result.finishedNormally, roundHalt: result.halt, haltAfter });
  // SIGTERM may have come while the halt was read: then the supervisor signals.
  if (stopping) return;
  await fetch(success ? deadMan : `${deadMan.replace(/\/+$/, "")}/fail`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  console.log(
    JSON.stringify({ event: "engineering_publisher_cycle", finishedNormally: result.finishedNormally, halt: result.halt, reason: result.reason }),
  );
  process.exit(result.finishedNormally ? 0 : 1);
}

if (process.argv[1]?.endsWith("engineering-agent-publisher.mjs")) {
  await main();
}
