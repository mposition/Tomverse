// The engineering agent runner service's entry point
// (docs/policy/engineering-agent.md §8, §12). Railway runs it on a schedule, in its own image, with
// `node --experimental-strip-types scripts/engineering-agent-runner.mjs`.
//
// It holds the runner's route secret, the agent's own model key, an optional
// read-only GitHub token and its dead-man monitor URL -- and nothing else: no
// database, no GitHub write, no AMUX secret. It clones the public repository
// without credentials, never installs or runs anything from the clone, and is
// force-stopped at the hard deadline by its supervisor, which kills the whole
// process group (./engineering-agent-supervisor.mjs).
//
// Imports: node builtins and the dependency-free core only.

import { spawn } from "node:child_process";
import { mkdtemp, realpath, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";

import { finalSignalIsSuccess, reportedHalt } from "../lib/engineeringAgentCore.ts";
import { runModelSession } from "../lib/engineeringAgentModelCall.ts";
import { runRunnerCycle } from "./engineering-agent-runner-core.mjs";
import { isSupervisedWorker, superviseCycle } from "./engineering-agent-supervisor.mjs";

/** The hard deadline of one cycle (§12); the supervisor kills the process group there. */
export const RUNNER_HARD_DEADLINE_MS = 20 * 60 * 1000;
const APP_TIMEOUT_MS = 25_000;
const REPOSITORY_URL = "https://github.com/mposition/Tomverse.git";
const DEVELOP_HEAD_URL = "https://api.github.com/repos/mposition/Tomverse/commits/develop";
const API_REPO = "https://api.github.com/repos/mposition/Tomverse";

/** Exactly the variables this service reads; the IaC declaration lists the same. */
export const RUNNER_VARIABLES = [
  "ENGINEERING_AGENT_APP_URL",
  "ENGINEERING_AGENT_RUNNER_SECRET",
  "ENGINEERING_AGENT_ANTHROPIC_API_KEY",
  "ENGINEERING_AGENT_GITHUB_READ_TOKEN",
  "ENGINEERING_AGENT_RUNNER_DEADMAN_URL",
];

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // No hooks, no templates, no prompts, no user or system configuration.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_TEMPLATE_DIR: "",
      },
    });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", () => undefined);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out) }));
    child.on("error", () => resolve({ code: -1, stdout: Buffer.alloc(0) }));
  });

const git = (args, options) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=true", ...args], options);

async function cloneAt(baseSha) {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("base_sha_invalid");
  const work = await mkdtemp(join(tmpdir(), "engineering-runner-"));
  const root = await realpath(join(work));
  const home = root;
  const repo = join(root, "repo");
  const steps = [
    ["init", "-q", repo],
    ["-C", repo, "fetch", "-q", "--depth", "1", REPOSITORY_URL, baseSha],
    ["-C", repo, "checkout", "-q", "--detach", "FETCH_HEAD"],
  ];
  for (const step of steps) {
    const result = await git(step, { home });
    if (result.code !== 0) throw new Error("clone_failed");
  }
  const listed = await git(["-C", repo, "ls-files", "-z"], { home });
  if (listed.code !== 0) throw new Error("clone_failed");
  const trackedPaths = new Set(listed.stdout.toString("utf8").split("\0").filter(Boolean));
  const repoRoot = await realpath(repo);
  return {
    root: repoRoot,
    trackedPaths,
    fsPorts: {
      realpath: (path) => realpath(path),
      lstatIsSymlink: async (path) => (await lstat(path)).isSymbolicLink(),
      lstatIsFile: async (path) => (await lstat(path)).isFile(),
      readFile: async (path) => new Uint8Array(await readFile(path)),
    },
    applies: async (patch) => {
      const file = join(root, "change.patch");
      await writeFile(file, patch, "utf8");
      const checked = await git(["-C", repo, "apply", "--check", file], { home });
      return checked.code === 0;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The sha256 of one commit's object, fetched without credentials; null when it cannot be read. */
async function commitDigestAt(sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const work = await realpath(await mkdtemp(join(tmpdir(), "engineering-observe-")));
  try {
    const repo = join(work, "repo");
    if ((await git(["init", "-q", repo], { home: work })).code !== 0) return null;
    if ((await git(["-C", repo, "fetch", "-q", "--depth", "1", REPOSITORY_URL, sha], { home: work })).code !== 0) return null;
    const object = await git(["-C", repo, "cat-file", "commit", sha], { home: work });
    return object.code === 0 ? createHash("sha256").update(object.stdout).digest("hex") : null;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  // The supervisor: a cycle that outlives its deadline is killed with its
  // whole process group, not trusted.
  if (!isSupervisedWorker()) {
    const deadMan = required("ENGINEERING_AGENT_RUNNER_DEADMAN_URL");
    process.exit(
      await superviseCycle({
        deadlineMs: RUNNER_HARD_DEADLINE_MS,
        failUrl: `${deadMan.replace(/\/+$/, "")}/fail`,
        event: "engineering_runner_deadline",
      }),
    );
  }

  const appUrl = required("ENGINEERING_AGENT_APP_URL").replace(/\/+$/, "");
  const secret = required("ENGINEERING_AGENT_RUNNER_SECRET");
  const apiKey = required("ENGINEERING_AGENT_ANTHROPIC_API_KEY");
  const deadMan = required("ENGINEERING_AGENT_RUNNER_DEADMAN_URL");
  const readToken = process.env.ENGINEERING_AGENT_GITHUB_READ_TOKEN?.trim() || null;

  const app = async (path, body) => {
    const response = await fetch(`${appUrl}/api/internal/engineering-agent/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(APP_TIMEOUT_MS),
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

  // GitHub, read-only; a list that is not the whole list is refused, not read as whole.
  // Each list is read on its own and returned as what was read plus whether
  // it is the whole list: a page with a next page is judged for what it holds
  // and marked incomplete; a list with no body at all is null. Neither is
  // ever taken for a complete, empty list.
  const githubList = async (path, { notFoundIsEmpty = false } = {}) => {
    let response;
    try {
      response = await fetch(`${API_REPO}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(APP_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(readToken ? { authorization: `Bearer ${readToken}` } : {}),
        },
      });
    } catch {
      return null;
    }
    // No ref under the prefix is answered 404: that is the list, empty.
    if (notFoundIsEmpty && response.status === 404) return { items: [], complete: true };
    const link = response.headers.get("link");
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body)) return null;
    // The same next-page reading as lib/engineeringAgentGitHubRead.ts.
    const hasNext = link !== null && /<[^>]*>\s*;\s*rel="?next"?/i.test(link);
    return { items: body, complete: !hasNext };
  };

  let result;
  try {
    result = await runRunnerCycle({
      app,
      namespace: async () => {
        const refs = await githubList("/git/matching-refs/heads/agent/engineering/?per_page=100", { notFoundIsEmpty: true });
        const pulls = await githubList("/pulls?state=open&per_page=100");
        return {
          refsComplete: refs?.complete === true,
          pullsComplete: pulls?.complete === true,
          refs: refs === null ? null : refs.items.map((ref) => ({ ref: String(ref.ref ?? ""), sha: ref.object?.sha ?? null })),
          pulls: pulls === null ? null : pulls.items.map((pull) => ({
            number: pull.number,
            headRef: pull.head?.ref ?? "",
            headSha: pull.head?.sha ?? null,
            body: pull.body ?? "",
          })),
        };
      },
      developHead: async () => {
        const response = await fetch(DEVELOP_HEAD_URL, {
          redirect: "error",
          signal: AbortSignal.timeout(APP_TIMEOUT_MS),
          headers: {
            accept: "application/vnd.github+json",
            ...(readToken ? { authorization: `Bearer ${readToken}` } : {}),
          },
        });
        const body = await response.json();
        if (!response.ok || typeof body?.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha)) {
          throw new Error("develop_head_unreadable");
        }
        return body.sha;
      },
      commitDigestAt,
      clone: cloneAt,
      model: (session) =>
        runModelSession({
          apiKey,
          system: session.system,
          userContent: session.userContent,
          readFile: session.readFile,
          transport: async (request) => {
            const response = await fetch(request.url, {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(request.timeoutMs),
              headers: request.headers,
              body: request.body,
            });
            return { status: response.status, json: await response.json().catch(() => null) };
          },
        }),
      setInterval,
      clearInterval,
    });
  } catch (error) {
    result = { finishedNormally: false, halt: "unknown", reason: error instanceof Error ? error.message : "failed" };
  }

  // A cycle that ran to its end says so, in mode off too (§12), and reads the
  // halt once more: the signal follows the halt as it stands now.
  let haltAfter = "unknown";
  if (result.finishedNormally) {
    const finished = await app("service/finished", {}).catch(() => null);
    haltAfter = finished?.status === 200 ? reportedHalt(finished.json?.halt) : "unknown";
  }
  const success = finalSignalIsSuccess({ finishedNormally: result.finishedNormally, roundHalt: result.halt, haltAfter });
  await fetch(success ? deadMan : `${deadMan.replace(/\/+$/, "")}/fail`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  console.log(
    JSON.stringify({ event: "engineering_runner_cycle", finishedNormally: result.finishedNormally, halt: result.halt, reason: result.reason }),
  );
  process.exit(result.finishedNormally ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("engineering-agent-runner.mjs")) {
  await main();
}
