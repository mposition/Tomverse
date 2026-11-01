// The marketing SEO code agent's runner (policy 9.2, S5). Default off.
//
//   node --experimental-strip-types --no-warnings scripts/marketing-seo-agent.mjs \
//     --topic "<what to improve>" [--base <commit>] [--no-publish] [--proposal-file <json>]
//
// Run it from a clone of this repository with dependencies installed, after
// `git fetch origin develop`. It does nothing unless MARKETING_SEO_AGENT_ENABLED
// is exactly `true` and MARKETING_AUTOMATION_KILL_SWITCH is empty.
//
// The rules live in lib/marketingSeoAgentCore.ts; this file only binds them to
// git, the marketing LLM cost ledger and GitHub:
//
// - The paid call runs in a child process started with the ledger's three
//   variables and nothing of GitHub's (`--stage llm`). The GitHub App token is
//   read only by the publish steps in this process, and the checks run without
//   either secret.
// - Everything is built in a detached worktree at the base commit, in a temp
//   directory, and removed afterwards. The main clone's files are not touched.
// - It never calls a merge or auto-merge API. Before graduation it opens a
//   draft PR for a person; after graduation the push is what the standard
//   `Auto PR to Develop` workflow acts on.
//
// Variables (names only; the values and the GitHub App are the operator's):
//   MARKETING_SEO_AGENT_ENABLED        exactly "true" to run
//   MARKETING_AUTOMATION_KILL_SWITCH   any value stops it
//   MARKETING_APP_URL, MARKETING_GENERATOR_SUBMIT_SECRET, MARKETING_LLM_API_KEY
//                                      the LLM stage (cost ledger and provider)
//   MARKETING_SEO_GITHUB_APP_TOKEN     installation token of the repository-only GitHub App
//   MARKETING_SEO_GITHUB_REPOSITORY    owner/name
//   MARKETING_SEO_AUTO_PR              repository variable; "true" only after graduation
//
// `--no-publish` stops after the commit is validated and prints the tree hash.
// `--proposal-file` replaces the LLM call with a saved answer and is allowed only with `--no-publish`.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { marketingLlmPinProblems } from "../lib/marketingLlmBudgetCore.ts";
import { marketingLlmBudgetHttpPort, runMarketingLlmCall } from "../lib/marketingLlmClientCore.ts";
import {
  marketingGeneratorAppPorts,
  marketingGeneratorPinForContext,
  marketingGeneratorWorkerConfig,
} from "../lib/marketingGeneratorCycleCore.ts";
import {
  SEO_AGENT_ALLOWED_FILES,
  SEO_AGENT_GITHUB_REPOSITORY_ENV,
  SEO_AGENT_GITHUB_TOKEN_ENV,
  SEO_AGENT_GRADUATED_VARIABLE_ENV,
  SEO_AGENT_POLICY_TESTS,
  runSeoAgent,
  seoAgentGate,
  seoAgentStageEnvironment,
} from "../lib/marketingSeoAgentCore.ts";

/** One LLM call; the ledger's own reservation expiry bounds it further. */
const LLM_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const SECRET_NAMES = [
  "MARKETING_APP_URL",
  "MARKETING_GENERATOR_SUBMIT_SECRET",
  "MARKETING_LLM_API_KEY",
  SEO_AGENT_GITHUB_TOKEN_ENV,
];

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const flag = (name) => process.argv.includes(name);

const git = (cwd, args, extra = {}) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...extra });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).split("\n")[0]}`);
  return result.stdout;
};

// ---------------------------------------------------------------------------
// The LLM stage, in its own process
// ---------------------------------------------------------------------------

if (option("--stage") === "llm") {
  const { messages } = JSON.parse(readFileSync(option("--input"), "utf8"));
  const configured = marketingGeneratorWorkerConfig(process.env);
  if (!configured.ok) {
    console.log(JSON.stringify({ status: "refused", stage: "reserve", code: "not_configured" }));
    process.exit(0);
  }
  const { appUrl, secret, apiKey } = configured.config;
  const runId = randomUUID();
  const deadlineAt = new Date(Date.now() + LLM_STAGE_TIMEOUT_MS).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_STAGE_TIMEOUT_MS - 5_000);
  const app = marketingGeneratorAppPorts({ appUrl, secret, generatorRunId: runId, fetch, signal: controller.signal });
  const chosen = marketingGeneratorPinForContext(await app.readContext(), marketingLlmPinProblems);
  if (!chosen.ok) {
    console.log(JSON.stringify({ status: "refused", stage: "reserve", code: "no_pin" }));
    process.exit(0);
  }
  // "brief" is the ledger's purpose for a call that is neither a draft nor market intel.
  const outcome = await runMarketingLlmCall(
    { pin: chosen.pin, generatorRunId: runId, purpose: "brief", messages },
    {
      budget: marketingLlmBudgetHttpPort({ appUrl: appUrl.toString(), secret, deadlineAt, fetch, signal: controller.signal }),
      transport: fetch,
      apiKey,
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  console.log(JSON.stringify(outcome));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gate = seoAgentGate(process.env);
  if (!gate.on) {
    console.log(JSON.stringify({ event: "marketing_seo_agent", status: "off", reason: gate.reason }));
    process.exit(0);
  }
  const topic = option("--topic");
  if (!topic) {
    console.error("--topic is required.");
    process.exit(1);
  }
  const noPublish = flag("--no-publish");
  const proposalFile = option("--proposal-file");
  if (proposalFile && !noPublish) {
    console.error("--proposal-file replaces the LLM call and is allowed only with --no-publish.");
    process.exit(1);
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const baseCommit = git(root, ["rev-parse", "--verify", `${option("--base") ?? "origin/develop"}^{commit}`]).trim();
  const token = process.env[SEO_AGENT_GITHUB_TOKEN_ENV];
  const repository = process.env[SEO_AGENT_GITHUB_REPOSITORY_ENV];
  if (!noPublish && (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))) {
    console.error(`${SEO_AGENT_GITHUB_TOKEN_ENV} and ${SEO_AGENT_GITHUB_REPOSITORY_ENV} (owner/name) are required to publish.`);
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), "seo-agent-"));
  const publishEnv = seoAgentStageEnvironment(process.env, "publish");
  let pushedSha = null;
  let validatedTree = null;
  class StopBeforePush extends Error {}

  const github = async (method, path, body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  /** The checks run with neither the LLM's nor GitHub's secret. */
  const checkEnvironment = () => {
    const env = { ...process.env };
    for (const name of SECRET_NAMES) delete env[name];
    env.NODE_OPTIONS ??= "--max-old-space-size=8192";
    return env;
  };

  const ports = {
    prepareWorktree: async (base) => {
      const dir = join(scratch, "wt");
      git(root, ["worktree", "add", "--detach", dir, base]);
      symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      return dir;
    },
    readFiles: async (dir) =>
      Object.fromEntries(
        SEO_AGENT_ALLOWED_FILES.map((path) => [path, existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null]),
      ),
    propose: async (messages) => {
      if (proposalFile) {
        return { status: "answered", callId: "local", requestKey: "local", content: readFileSync(proposalFile, "utf8"), citations: [], ledgerState: "settled" };
      }
      const input = join(scratch, "llm-input.json");
      writeFileSync(input, JSON.stringify({ messages }));
      return await new Promise((resolve) => {
        const unreadable = { status: "stopped", stage: "settle", callId: null, requestKey: "unreadable" };
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "--stage", "llm", "--input", input],
          { env: seoAgentStageEnvironment(process.env, "llm"), stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        const killer = setTimeout(() => child.kill("SIGKILL"), LLM_STAGE_TIMEOUT_MS);
        child.on("error", () => resolve(unreadable));
        child.on("exit", () => {
          clearTimeout(killer);
          try {
            resolve(JSON.parse(out.trim().split("\n").pop()));
          } catch {
            resolve(unreadable);
          }
        });
      });
    },
    writeFiles: async (dir, files) => {
      for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    },
    stagedDiff: async (dir, base) => {
      git(dir, ["add", "-A", "--", "."]);
      return {
        raw: git(dir, ["diff", "--cached", "--raw", "-z", "-M", "-C", "--no-abbrev", base]),
        numstat: git(dir, ["diff", "--cached", "--numstat", "-z", "--no-renames", base]),
      };
    },
    baseTests: async (base) =>
      SEO_AGENT_POLICY_TESTS.filter((path) => spawnSync("git", ["cat-file", "-e", `${base}:${path}`], { cwd: root }).status === 0),
    runChecks: async (dir, commands) => {
      for (const command of commands) {
        console.log(JSON.stringify({ event: "marketing_seo_agent_check", check: command.label }));
        const result = spawnSync(command.argv[0], command.argv.slice(1), {
          cwd: dir,
          env: checkEnvironment(),
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        if (result.status !== 0) return { ok: false, label: command.label };
      }
      return { ok: true };
    },
    commit: async (dir, message) => {
      git(dir, [
        "-c", "user.name=marketing-agent",
        "-c", "user.email=marketing-agent@users.noreply.github.com",
        "commit", "-q", "-m", message,
      ]);
      validatedTree = git(dir, ["rev-parse", "HEAD^{tree}"]).trim();
      return { commitSha: git(dir, ["rev-parse", "HEAD"]).trim(), treeHash: validatedTree };
    },
    treeOf: async (dir, commitSha) => git(dir, ["rev-parse", `${commitSha}^{tree}`]).trim(),
    lookupGraduation: async () => {
      // The surface graduation read belongs to S4 (graduation) and does not exist
      // yet, so a repository variable alone cannot say "graduated": this throws,
      // and a throw is "not graduated" (policy 6.1: the lookup must succeed).
      if (process.env[SEO_AGENT_GRADUATED_VARIABLE_ENV] !== "true") return false;
      throw new Error("the surface graduation lookup is not connected");
    },
    push: async (dir, commitSha, branch) => {
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${publishEnv[SEO_AGENT_GITHUB_TOKEN_ENV]}`).toString("base64")}`;
      git(dir, ["push", `https://github.com/${repository}.git`, `${commitSha}:refs/heads/${branch}`], {
        env: {
          ...publishEnv,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: header,
        },
      });
      pushedSha = commitSha;
    },
    remoteTree: async (branch) => {
      const ref = await github("GET", `/git/ref/heads/${branch}`);
      if (ref.status !== 200 || ref.body?.object?.sha !== pushedSha) return null;
      const commit = await github("GET", `/git/commits/${pushedSha}`);
      return commit.status === 200 ? (commit.body?.tree?.sha ?? null) : null;
    },
    deleteBranch: async (branch) => {
      await github("DELETE", `/git/refs/heads/${branch}`);
    },
    createPullRequest: async ({ branch, title, body }) => {
      // Draft, against develop, and no merge or auto-merge call of any kind.
      const created = await github("POST", "/pulls", { title, head: branch, base: "develop", body, draft: true });
      if (created.status !== 201 || typeof created.body?.html_url !== "string") {
        throw new Error(`pull request was not created (HTTP ${created.status})`);
      }
      return { url: created.body.html_url };
    },
    cleanup: async (dir) => {
      for (const unlink of [unlinkSync, rmdirSync]) {
        try {
          unlink(join(dir, "node_modules"));
          break;
        } catch {
          // Not present, or not that kind of link.
        }
      }
      spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: root });
      rmSync(scratch, { recursive: true, force: true });
    },
  };

  if (noPublish) {
    // Validation only: nothing is pushed, and the graduation and GitHub ports are not reached.
    ports.push = async () => {
      throw new StopBeforePush();
    };
  }

  let exitCode = 0;
  try {
    const result = await runSeoAgent({ topic, baseCommit, env: process.env }, ports);
    console.log(JSON.stringify({ event: "marketing_seo_agent", ...result }));
    exitCode = result.status === "pushed" || result.status === "off" ? 0 : 2;
  } catch (error) {
    if (error instanceof StopBeforePush) {
      console.log(JSON.stringify({ event: "marketing_seo_agent", status: "validated_not_published", baseCommit, treeHash: validatedTree }));
    } else {
      console.error(JSON.stringify({ event: "marketing_seo_agent_failed", errorName: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message.slice(0, 200) : "" }));
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}
