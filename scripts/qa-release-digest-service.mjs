// The QA-release Digest service's entry point (docs/policy/qa-release-agent.md
// sections 1 and 3). Railway runs it on cron `0 21 * * *` UTC with
// `node --experimental-strip-types scripts/qa-release-digest-service.mjs` and
// force-stops it at the 15-minute hard timeout.
//
// It holds the app's digest submission secret, a read-only GitHub token and
// the operator control revision -- and nothing else (lib/qaReleaseServiceEnvCore.ts
// refuses to start with any other name). All decisions are in
// lib/qaReleaseDigestServiceCore.ts; this file only connects the ports:
//
// * report scripts and checks run as children with a minimal environment.
//   The submission secret is never passed down; the read token reaches the
//   issue report alone, as GITHUB_TOKEN.
// * GitHub is read with the read token, structured endpoints only.
// * The submission follows no redirect, so it cannot leave the destination
//   fixed in lib/qaReleaseDigestEndpointCore.ts.
//
// It prints the outcome code and, on a refusal, the HTTP status -- never a
// body, a token or a header.

import { spawn } from "node:child_process";

import { collectQaReleaseCi } from "../lib/qaReleaseCiCollectCore.ts";
import { QA_RELEASE_DIGEST_HARD_TIMEOUT_MS, runQaReleaseDigestService } from "../lib/qaReleaseDigestServiceCore.ts";

const SCRIPT_TIMEOUT_MS = 4 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30_000;
const GITHUB_API = "https://api.github.com";

// Policy section 10: the run is bounded at 15 minutes, and Railway's cron does
// not stop it on its own, so the service stops itself -- and the report child
// it is waiting on, whose process group it leads. A run stopped here submits
// nothing; the app's deadline would refuse a late submission anyway.
const activeChildren = new Set();
const supervisor = setTimeout(() => {
  for (const pid of activeChildren) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  console.log(JSON.stringify({ exitCode: 1, outcome: "hard_timeout" }));
  process.exit(1);
}, QA_RELEASE_DIGEST_HARD_TIMEOUT_MS);

/**
 * `npm run <name> -- <args>` with only what a report needs to run. The child
 * leads its own process group, so the timeout kills npm and every process it
 * started, and the promise settles at the timeout even if a grandchild still
 * holds the pipe open.
 */
const runScript = (name, args, extraEnv = {}) =>
  new Promise((resolve) => {
    let settled = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn("npm", ["run", "--silent", name, ...(args.length > 0 ? ["--", ...args] : [])], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        ...extraEnv,
      },
    });
    if (child.pid) activeChildren.add(child.pid);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // A report larger than this is not one the digest can carry anyway.
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk;
    });
    timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      settle({ exitCode: 1, stdout: "" });
    }, SCRIPT_TIMEOUT_MS);
    child.on("close", (code) => {
      activeChildren.delete(child.pid);
      settle({ exitCode: code ?? 1, stdout });
    });
    child.on("error", () => {
      activeChildren.delete(child.pid);
      settle({ exitCode: 1, stdout: "" });
    });
  });

const githubJson = (token) => async (path) => {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`github_${response.status}`);
  return response.json();
};

const postJson = async (url, headers, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return { status: response.status };
};

const result = await runQaReleaseDigestService(process.env, {
  runScript,
  collectCi: async (token) => (token ? collectQaReleaseCi({ fetchJson: githubJson(token), nowMs: Date.now() }) : null),
  postJson,
  now: () => new Date(),
});

clearTimeout(supervisor);
console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
