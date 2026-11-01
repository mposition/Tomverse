// The marketing SEO code agent's runner (policy 9.2, S5). Default off.
//
// Two phases, which must run as separate processes with separate environments:
//
//   node --experimental-strip-types --no-warnings scripts/marketing-seo-agent.mjs \
//     --phase validate --topic "<what to improve>" --out <empty dir> [--base <commit>] [--proposal-file <json>]
//
//   node --experimental-strip-types --no-warnings scripts/marketing-seo-agent.mjs \
//     --phase publish --out <the same dir>
//
// Run from a clone of this repository with dependencies installed, after
// `git fetch origin develop`. Nothing happens unless MARKETING_SEO_AGENT_ENABLED
// is exactly `true` and MARKETING_AUTOMATION_KILL_SWITCH is empty.
//
// Why two phases: validation runs lint, typecheck and the policy tests, and the
// policy tests import the very files the model edited, so proposed code runs.
// That phase therefore refuses to start with the GitHub token in its
// environment, and its checks get an allowlisted environment of their own. The
// publish phase refuses to start with any LLM variable, takes only a commit and
// a record from the first phase, and recomputes the commit's tree, parent and
// diff from git before it pushes anything. Run the validate phase on a
// disposable runner with no other credentials: the shared node_modules the
// checks use is the one thing this script cannot isolate.
//
// The rules live in lib/marketingSeoAgentCore.ts; this file binds them to git,
// the marketing LLM cost ledger and GitHub. The paid call runs in a child
// process (`--stage llm`) that has the ledger's variables and no repository
// credential. Nothing here calls a merge or auto-merge API: before graduation
// the publish phase opens a draft PR for a person; after graduation the push is
// what the standard `Auto PR to Develop` workflow acts on.
//
// Variables (names only; the values and the GitHub App are the operator's):
//   MARKETING_SEO_AGENT_ENABLED        exactly "true" to run, both phases
//   MARKETING_AUTOMATION_KILL_SWITCH   any value stops it
//   MARKETING_APP_URL, MARKETING_GENERATOR_SUBMIT_SECRET, MARKETING_LLM_API_KEY
//                                      validate phase only: cost ledger and provider
//   MARKETING_SEO_GITHUB_APP_TOKEN     publish phase only: installation token of the repository-only GitHub App
//   MARKETING_SEO_GITHUB_REPOSITORY    publish phase only: owner/name
//   MARKETING_SEO_AUTO_PR              repository variable; "true" only after graduation
//
// `--proposal-file` replaces the LLM call with a saved answer, for trying the
// validation without spending anything.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  runSeoAgentPublish,
  runSeoAgentValidate,
  seoAgentGate,
  seoAgentStageEnvironment,
} from "../lib/marketingSeoAgentCore.ts";

/** One LLM call; the ledger's own reservation expiry bounds it further. */
const LLM_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const BUNDLE_REF = "seo-agent-change";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const git = (cwd, args, extra = {}) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...extra });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).split("\n")[0]}`);
  return result.stdout;
};

// ---------------------------------------------------------------------------
// The LLM stage, in its own process
// ---------------------------------------------------------------------------

if (option("--stage") === "llm") {
  // The same gate as the parent: a direct run of this stage does not spend.
  const gate = seoAgentGate(process.env);
  if (!gate.on) {
    console.log(JSON.stringify({ status: "refused", stage: "reserve", code: gate.reason }));
    process.exit(0);
  }
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
// Shared by the phases
// ---------------------------------------------------------------------------

const self = fileURLToPath(import.meta.url);

const printAndExit = (event, result, okStatuses) => {
  console.log(JSON.stringify({ event, ...result }));
  process.exit(okStatuses.includes(result.status) ? 0 : 2);
};

const fail = (error) => {
  console.error(
    JSON.stringify({
      event: "marketing_seo_agent_failed",
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message.slice(0, 200) : "",
    }),
  );
  process.exit(1);
};

const phase = option("--phase");

// ---------------------------------------------------------------------------
// Phase 1: validate
// ---------------------------------------------------------------------------

if (process.argv[1] && self === resolve(process.argv[1]) && phase === "validate") {
  const topic = option("--topic");
  const outDir = option("--out");
  if (!topic || !outDir) fail(new Error("--topic and --out are required"));
  const proposalFile = option("--proposal-file");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const baseCommit = git(root, ["rev-parse", "--verify", `${option("--base") ?? "origin/develop"}^{commit}`]).trim();
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) fail(new Error("--out must be an empty directory"));
  const scratch = mkdtempSync(join(tmpdir(), "seo-agent-"));

  const identity = ["-c", "user.name=marketing-agent", "-c", "user.email=marketing-agent@users.noreply.github.com"];

  const ports = {
    prepareWorkspace: async (base) => {
      // A clone of its own, so the proposed code cannot reach the main clone's refs, config or hooks.
      const dir = join(scratch, "wt");
      git(root, ["clone", "--shared", "--no-checkout", "--quiet", root, dir]);
      git(dir, ["remote", "remove", "origin"]);
      git(dir, ["checkout", "--quiet", "--detach", base]);
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
      return await new Promise((resolveOutcome) => {
        const unreadable = { status: "stopped", stage: "settle", callId: null, requestKey: "unreadable" };
        const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", self, "--stage", "llm", "--input", input], {
          env: seoAgentStageEnvironment(process.env, "llm"),
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        const killer = setTimeout(() => child.kill("SIGKILL"), LLM_STAGE_TIMEOUT_MS);
        child.on("error", () => resolveOutcome(unreadable));
        child.on("exit", () => {
          clearTimeout(killer);
          try {
            resolveOutcome(JSON.parse(out.trim().split("\n").pop()));
          } catch {
            resolveOutcome(unreadable);
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
    indexTree: async (dir) => git(dir, ["write-tree"]).trim(),
    baseTests: async (base) =>
      SEO_AGENT_POLICY_TESTS.filter((path) => spawnSync("git", ["cat-file", "-e", `${base}:${path}`], { cwd: root }).status === 0),
    runChecks: async (dir, commands) => {
      // The checks execute the proposed code: they get an allowlisted environment, not this process's.
      const env = { ...seoAgentStageEnvironment(process.env, "checks") };
      env.NODE_OPTIONS ??= "--max-old-space-size=8192";
      for (const command of commands) {
        console.log(JSON.stringify({ event: "marketing_seo_agent_check", check: command.label }));
        const result = spawnSync(command.argv[0], command.argv.slice(1), {
          cwd: dir,
          env,
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        if (result.status !== 0) return { ok: false, label: command.label };
      }
      return { ok: true };
    },
    commit: async (dir, message) => {
      git(dir, [...identity, "commit", "-q", "-m", message]);
      return { commitSha: git(dir, ["rev-parse", "HEAD"]).trim(), treeHash: git(dir, ["rev-parse", "HEAD^{tree}"]).trim() };
    },
    exportCommit: async (dir, base, commitSha) => {
      git(dir, ["branch", BUNDLE_REF, commitSha]);
      git(dir, ["bundle", "create", join(resolve(outDir), "change.bundle"), BUNDLE_REF, `^${base}`]);
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
      rmSync(scratch, { recursive: true, force: true });
    },
  };

  try {
    const result = await runSeoAgentValidate({ topic, baseCommit, env: process.env }, ports);
    if (result.status === "validated") writeFileSync(join(resolve(outDir), "record.json"), `${JSON.stringify(result.record, null, 2)}\n`);
    printAndExit("marketing_seo_agent_validate", result, ["validated", "off"]);
  } catch (error) {
    fail(error);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: publish
// ---------------------------------------------------------------------------

if (process.argv[1] && self === resolve(process.argv[1]) && phase === "publish") {
  const outDir = option("--out");
  if (!outDir) fail(new Error("--out is required"));
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const token = process.env[SEO_AGENT_GITHUB_TOKEN_ENV];
  const repository = process.env[SEO_AGENT_GITHUB_REPOSITORY_ENV];
  const gate = seoAgentGate(process.env);
  if (gate.on && (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))) {
    fail(new Error(`${SEO_AGENT_GITHUB_TOKEN_ENV} and ${SEO_AGENT_GITHUB_REPOSITORY_ENV} (owner/name) are required to publish`));
  }
  let record = null;
  try {
    record = JSON.parse(readFileSync(join(resolve(outDir), "record.json"), "utf8"));
  } catch {
    // The core refuses an unreadable record; an off switch needs none.
  }

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

  const ports = {
    importCommit: async (rec) => {
      // Objects only, into the trusted clone: the bundle carries no config, hook or ref this clone uses.
      git(root, ["fetch", "--quiet", join(resolve(outDir), "change.bundle"), BUNDLE_REF]);
      git(root, ["cat-file", "-e", `${rec.commitSha}^{commit}`]);
    },
    commitFacts: async (commitSha) => {
      const parents = git(root, ["rev-list", "--parents", "-n", "1", commitSha]).trim().split(" ").slice(1);
      return { tree: git(root, ["rev-parse", `${commitSha}^{tree}`]).trim(), parent: parents[0] ?? null, parentCount: parents.length };
    },
    diff: async (base, commitSha) => ({
      raw: git(root, ["diff", "--raw", "-z", "-M", "-C", "--no-abbrev", base, commitSha]),
      numstat: git(root, ["diff", "--numstat", "-z", "--no-renames", base, commitSha]),
    }),
    lookupGraduation: async () => {
      // The surface graduation read belongs to S4 (graduation) and does not exist
      // yet, so a repository variable alone cannot say "graduated": this throws,
      // and a throw is "not graduated" (policy 6.1: the lookup must succeed).
      if (process.env[SEO_AGENT_GRADUATED_VARIABLE_ENV] !== "true") return false;
      throw new Error("the surface graduation lookup is not connected");
    },
    push: async (commitSha, branch) => {
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      git(root, ["push", `https://github.com/${repository}.git`, `${commitSha}:refs/heads/${branch}`], {
        env: {
          ...seoAgentStageEnvironment(process.env, "publish"),
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: header,
        },
      });
    },
    remoteTree: async (branch, commitSha) => {
      const ref = await github("GET", `/git/ref/heads/${branch}`);
      if (ref.status !== 200 || ref.body?.object?.sha !== commitSha) return null;
      const commit = await github("GET", `/git/commits/${commitSha}`);
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
  };

  try {
    printAndExit("marketing_seo_agent_publish", await runSeoAgentPublish({ record, env: process.env }, ports), ["pushed", "off"]);
  } catch (error) {
    fail(error);
  }
}

if (process.argv[1] && self === resolve(process.argv[1]) && phase !== "validate" && phase !== "publish") {
  console.error("Usage: --phase validate|publish (see the header of this file).");
  process.exit(1);
}
