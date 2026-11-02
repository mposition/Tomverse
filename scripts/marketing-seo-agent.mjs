// The marketing SEO code agent's runner (policy 9.2, S5). Default off.
//
// Two phases, which must run as separate processes with separate environments:
//
//   node --experimental-strip-types --no-warnings scripts/marketing-seo-agent.mjs \
//     --phase validate --topic "<what to improve>" --out <empty dir> [--base <commit>] [--proposal-file <json>]
//
//   node --experimental-strip-types --no-warnings scripts/marketing-seo-agent.mjs \
//     --phase publish --out <the same dir> [--wait-minutes <n>]
//
//   node --experimental-strip-types --no-warnings scripts/marketing-seo-agent.mjs \
//     --phase arm --out <the same dir> [--wait-minutes <n>]
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
// disposable runner with no other credentials, and the publish phase on a
// different machine from a trusted checkout of develop with its own
// dependencies, taking only the three files of --out from the first: the shared
// node_modules the checks use is the one thing this script cannot isolate, so
// it must not be one the publish phase also uses.
//
// The rules live in lib/marketingSeoAgentCore.ts; this file binds them to git,
// the marketing LLM cost ledger and GitHub. The paid call runs in a child
// process (`--stage llm`) that has the ledger's variables and no repository
// credential. Nothing here merges a pull request. Before graduation the publish
// phase opens a draft PR for a person; after graduation the push is what the
// standard `Auto PR to Develop` workflow acts on. The one merge-related write is
// GitHub's auto-merge (`enablePullRequestAutoMerge`, merge commit), turned on by
// the arm step only when MARKETING_SEO_AUTO_MERGE is exactly "true" and the
// graduation variable is "true" (policy 9.2, operator decision 2026-11-02).
//
// The arm step: the workflow opens the graduated PR as a draft, GitHub does not
// arm a draft, and the CI admission bot marks it ready when it has runners. So
// `--phase arm` (which the publish phase runs by itself after a graduated push)
// re-verifies the signed record exactly as publish does, then looks at the pull
// request for --wait-minutes (default 240, at least 1; every minute while it waits, every 20
// seconds once armed): it arms an open, non-draft PR from this repository, based on
// develop, whose head is exactly the validated commit, and it arms at most once per
// run. If auto-merge is off again afterwards, a person or GitHub turned it off, and it
// is left off. GitHub keeps auto-merge on when someone with write access pushes another
// commit, so an armed PR is never left unattended: a head that moved or a base that is
// not develop is disarmed, and so is any arming still standing when the window ends,
// when the PR cannot be read, on any ending but a merge or a close, on an error and on
// SIGINT/SIGTERM (a killed process cannot: a person turns auto-merge off in the PR then).
// Running the phase again later is an operator action and may arm again. GitHub merges the PR once
// the required checks of develop pass; the App needs Pull requests: write and
// Contents: write, which the push and the PR already needed.
//
// Variables (names only; the values and the GitHub App are the operator's):
//   MARKETING_SEO_AGENT_ENABLED        exactly "true" to run, both phases
//   MARKETING_AUTOMATION_KILL_SWITCH   any value stops it
//   MARKETING_APP_URL, MARKETING_GENERATOR_SUBMIT_SECRET, MARKETING_LLM_API_KEY
//                                      validate phase only: cost ledger and provider
//   MARKETING_SEO_CHECK_UID, MARKETING_SEO_CHECK_GID
//                                      validate phase, POSIX: the unprivileged user the checks run as (the parent
//                                      must be able to switch to it, i.e. root in a disposable container). A result
//                                      the publish phase accepts comes only from checks run as this user; without
//                                      it the phase refuses, except for --dry-run
//   MARKETING_SEO_ATTESTATION_KEY      both phases, 32+ characters: the validate phase signs its result with it and
//                                      the publish phase refuses anything that does not verify
//   MARKETING_SEO_GITHUB_APP_TOKEN     publish phase only: installation token of the repository-only GitHub App
//   MARKETING_SEO_GITHUB_REPOSITORY    publish phase only: owner/name
//   MARKETING_SEO_AUTO_PR              the surface's graduation record, set by the operator: "true" only after graduation
//   MARKETING_SEO_AUTO_MERGE           exactly "true" lets the arm step turn on auto-merge; default off
//
// `--proposal-file` replaces the LLM call with a saved answer, for trying the
// validation without spending anything. `--dry-run` (validate only) runs the whole
// validation as this user, holds no attestation key, and writes nothing to --out: it
// shows what the validation says for a saved --proposal-file, and produces nothing that can be published.
// It runs the proposal's code as your own user with your files and your network: use it only on a
// proposal you trust, or on a disposable machine.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
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
  SEO_AGENT_JUNIT_PLACEHOLDER,
  SEO_AGENT_POLICY_TESTS,
  runSeoAgentArmLoop,
  runSeoAgentPublish,
  runSeoAgentValidate,
  seoAgentAutoMergeGate,
  seoAgentGate,
  seoAgentJunitVerdict,
  seoAgentStageEnvironment,
} from "../lib/marketingSeoAgentCore.ts";

/** One LLM call; the ledger's own reservation expiry bounds it further. */
const LLM_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const BUNDLE_REF = "seo-agent-change";
/** One check, lint or typecheck or the policy tests. */
const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
/** One GitHub API request. */
const GITHUB_TIMEOUT_MS = 30 * 1000;
/** How long the arm step waits between two looks while there is nothing armed yet. */
const ARM_POLL_MS = 60 * 1000;
/** ...and while it is armed: a moved head has to be seen long before the required checks can finish on it. */
const ARM_ARMED_POLL_MS = 20 * 1000;
/** The window the arm step watches for: the CI admission queue, then the required checks. An arming is disarmed when it ends. */
const ARM_DEFAULT_WAIT_MINUTES = 240;

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const git = (cwd, args, extra = {}) => {
  // safe.directory: the validate workspace may be owned by the user the checks run as.
  const result = spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...extra });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).split("\n")[0]}`);
  return result.stdout;
};

// ---------------------------------------------------------------------------
// The LLM stage, in its own process
// ---------------------------------------------------------------------------

if (option("--stage") === "llm" && process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
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
  const dryRun = process.argv.includes("--dry-run");
  const outDir = option("--out");
  if (!topic || (!outDir && !dryRun)) fail(new Error("--topic and --out are required (--out is not used by --dry-run)"));
  if (dryRun && !option("--proposal-file")) fail(new Error("--dry-run replays a saved proposal: give --proposal-file (it holds no LLM credential)"));
  const proposalFile = option("--proposal-file");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const baseCommit = git(root, ["rev-parse", "--verify", "--end-of-options", `${option("--base") ?? "origin/develop"}^{commit}`]).trim();
  if (outDir && !dryRun) {
    mkdirSync(outDir, { recursive: true });
    if (readdirSync(outDir).length > 0) fail(new Error("--out must be an empty directory"));
  }
  const scratch = mkdtempSync(join(tmpdir(), "seo-agent-"));
  // Removed on every exit path, a refusal or a throw included.
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

  // The workspace's git directory lives beside the work tree, not in it, and is this process's:
  // the check user owns the files and can change neither the repository's config, its hooks nor
  // its refs. Every git command here names the directory explicitly and trusts no hook.
  const workspace = { gitDir: join(scratch, "git"), tree: join(scratch, "wt"), hooks: join(scratch, "no-hooks") };
  mkdirSync(workspace.hooks);
  const wgit = (args, extra = {}) =>
    git(workspace.tree, ["-c", `core.hooksPath=${workspace.hooks}`, ...args], {
      env: { ...seoAgentStageEnvironment(process.env, "checks"), GIT_DIR: workspace.gitDir, GIT_WORK_TREE: workspace.tree },
      ...extra,
    });

  const identity = ["-c", "user.name=marketing-agent", "-c", "user.email=marketing-agent@users.noreply.github.com"];

  const ports = {
    prepareWorkspace: async (base) => {
      // A clone of its own, so the proposed code cannot reach the main clone's refs, config or hooks.
      const dir = workspace.tree;
      git(root, ["clone", "--shared", "--no-checkout", "--quiet", "--separate-git-dir", workspace.gitDir, root, dir]);
      wgit(["remote", "remove", "origin"]);
      wgit(["checkout", "--quiet", "--detach", base]);
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
        // 'close', not 'exit': stdout is complete only when its stream has ended.
        child.on("close", () => {
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
      wgit(["add", "-A", "--", "."]);
      return {
        raw: wgit(["diff", "--cached", "--raw", "-z", "-M", "-C", "--no-abbrev", base]),
        numstat: wgit(["diff", "--cached", "--numstat", "-z", "--no-renames", base]),
        patch: wgit(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base]),
      };
    },
    indexTree: async () => wgit(["write-tree"]).trim(),
    baseTestSources: async (base) => {
      const sources = {};
      for (const path of SEO_AGENT_POLICY_TESTS) {
        const shown = spawnSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        if (shown.status === 0) sources[path] = shown.stdout;
      }
      return sources;
    },
    runChecks: async (dir, commands, isolation) => {
      // One check, with every process it starts. spawnSync's timeout ends only the direct child, so the
      // check leads its own process group (a job on Windows is taskkill /T) and the whole group is killed
      // at the deadline and again when the check ends, whatever it left running.
      const runOne = (command, options) =>
        new Promise((resolveRun) => {
          const child = spawn(command.argv[0], command.argv.slice(1), { ...options, detached: process.platform !== "win32" });
          let timedOut = false;
          const killTree = () => {
            try {
              if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
              else process.kill(-child.pid, "SIGKILL");
            } catch {
              // Nothing of the group is left.
            }
            killLeftovers();
          };
          const killLeftovers = () => {
            // A process that started a new session left the group. As the check user, kill(-1) ends every
            // process that user owns -- the user is the operator's and is used for nothing else.
            if (isolation.mode === "separate_user") {
              // With no secret in its environment: it runs as the user whose processes may be reading it.
              spawnSync("kill", ["-9", "-1"], {
                uid: isolation.uid,
                gid: isolation.gid,
                stdio: "ignore",
                env: seoAgentStageEnvironment({ PATH: process.env.PATH }, "checks"),
              });
            }
          };
          const timer = setTimeout(() => {
            timedOut = true;
            killTree();
          }, CHECK_TIMEOUT_MS);
          child.on("error", () => {
            clearTimeout(timer);
            resolveRun(1);
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            // After a normal exit only the user-wide kill runs (inside killTree, for the check user): the
            // group id could have been reused by then, so the group is not signalled again.
            if (isolation.mode === "separate_user") killLeftovers();
            resolveRun(timedOut ? 124 : (code ?? 1));
          });
        });
      // The checks execute the proposed code: they get an allowlisted environment, not this process's...
      const env = { ...seoAgentStageEnvironment(process.env, "checks"), NODE_OPTIONS: "--max-old-space-size=8192" };
      // ...and, where the operator gave a user for them, they run as that user, who cannot read
      // this process's /proc/<pid>/environ (the LLM key, the attestation key) or its files.
      const asUser = isolation.mode === "separate_user" ? { uid: isolation.uid, gid: isolation.gid } : {};
      if (isolation.mode === "separate_user") {
        if (typeof process.getuid === "function" && process.getuid() === isolation.uid) {
          throw new Error("the check user is this process's own user");
        }
        const home = join(scratch, "check-home");
        mkdirSync(home, { recursive: true });
        env.HOME = home;
        // The check user may walk to the work tree (execute only: it cannot list the scratch directory),
        // and it can read all of it, but it can write only what the tools emit -- `.next`,
        // `next-env.d.ts` (both ignored by git) -- and its HOME. The tests, the configuration and the
        // proposed files are this process's, so proposed code cannot weaken the tests that judge it,
        // not even for as long as the checks run.
        chmodSync(scratch, 0o711);
        mkdirSync(join(dir, ".next"), { recursive: true });
        if (!existsSync(join(dir, "next-env.d.ts"))) writeFileSync(join(dir, "next-env.d.ts"), "");
        const owned = spawnSync("chown", ["-R", "-h", `${isolation.uid}:${isolation.gid}`, join(dir, ".next"), join(dir, "next-env.d.ts"), home]);
        if (owned.status !== 0) throw new Error("the workspace could not be handed to the check user");
      }
      // A policy test's report goes where the check user can write; it is read after the check and its processes are gone.
      const reports = join(scratch, "check-home");
      mkdirSync(reports, { recursive: true });
      let reportNumber = 0;
      for (const rawCommand of commands) {
        const reportPath = join(reports, `policy-test-${(reportNumber += 1)}.xml`);
        const command = rawCommand.policyTest
          ? { ...rawCommand, argv: rawCommand.argv.map((arg) => arg.replace(SEO_AGENT_JUNIT_PLACEHOLDER, reportPath)) }
          : rawCommand;
        rmSync(reportPath, { force: true });
        console.log(JSON.stringify({ event: "marketing_seo_agent_check", check: command.label }));
        // Proposed code can loop forever or leave processes behind; a check that outlives its time has failed.
        const status = await runOne(command, { cwd: dir, env, stdio: "inherit", shell: process.platform === "win32", ...asUser });
        if (status !== 0) return { ok: false, label: command.label };
        if (command.policyTest) {
          // The exit code is not evidence that the tests ran: the report is.
          let xml = "";
          try {
            xml = readFileSync(reportPath, "utf8");
          } catch {
            // No report is no evidence.
          }
          const verdict = seoAgentJunitVerdict(xml, command.policyTest.path, command.policyTest.minTests);
          if (!verdict.ok) return { ok: false, label: `${command.label} (${verdict.reason})` };
        }
      }
      return { ok: true };
    },
    commit: async (dir, message) => {
      wgit([...identity, "commit", "-q", "-m", message]);
      return { commitSha: wgit(["rev-parse", "HEAD"]).trim(), treeHash: wgit(["rev-parse", "HEAD^{tree}"]).trim() };
    },
    exportCommit: async (dir, base, commitSha) => {
      wgit(["branch", BUNDLE_REF, commitSha]);
      const bundle = join(resolve(outDir ?? scratch), "change.bundle");
      wgit(["bundle", "create", bundle, BUNDLE_REF, `^${base}`]);
      return { bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex") };
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
    const result = await runSeoAgentValidate({ topic, baseCommit, env: process.env, platform: process.platform, ownUid: process.getuid?.(), dryRun }, ports);
    if (result.status === "validated" && outDir) {
      writeFileSync(join(resolve(outDir), "record.json"), `${JSON.stringify(result.record, null, 2)}\n`);
      writeFileSync(
        join(resolve(outDir), "attestation.json"),
        `${JSON.stringify({ bundleSha256: result.bundleSha256, attestation: result.attestation })}\n`,
      );
    }
    // The signature stays in the artifact; the log carries the outcome and the tree.
    const loggable = { ...result };
    delete loggable.attestation;
    printAndExit("marketing_seo_agent_validate", loggable, ["validated", "validated_dry_run", "off"]);
  } catch (error) {
    fail(error);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: publish
// ---------------------------------------------------------------------------

if (process.argv[1] && self === resolve(process.argv[1]) && (phase === "publish" || phase === "arm")) {
  const outDir = option("--out");
  if (!outDir) fail(new Error("--out is required"));
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const token = process.env[SEO_AGENT_GITHUB_TOKEN_ENV];
  const repository = process.env[SEO_AGENT_GITHUB_REPOSITORY_ENV];
  const gate = seoAgentGate(process.env);
  if (gate.on && (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))) {
    fail(new Error(`${SEO_AGENT_GITHUB_TOKEN_ENV} and ${SEO_AGENT_GITHUB_REPOSITORY_ENV} (owner/name) are required to publish`));
  }
  // Exactly the three files the validate phase writes; anything else in the directory is refused.
  const artifacts = existsSync(outDir) ? readdirSync(outDir).sort() : [];
  if (gate.on && artifacts.join(",") !== "attestation.json,change.bundle,record.json") {
    fail(new Error("--out must hold exactly attestation.json, change.bundle and record.json"));
  }
  const readArtifact = (name) => {
    try {
      return JSON.parse(readFileSync(join(resolve(outDir), name), "utf8"));
    } catch {
      return null;
    }
  };
  const record = readArtifact("record.json");
  const attestationFile = readArtifact("attestation.json");

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
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const graphql = async (query, variables) => {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || !body || Array.isArray(body.errors) || !body.data) {
      throw new Error(`GitHub GraphQL request failed (HTTP ${response.status}): ${String(body?.errors?.[0]?.message ?? "").slice(0, 120)}`);
    }
    return body.data;
  };
  const [repositoryOwner, repositoryName] = (repository ?? "/").split("/");

  const ports = {
    bundleSha256: async () => createHash("sha256").update(readFileSync(join(resolve(outDir), "change.bundle"))).digest("hex"),
    baseOnDevelop: async (base) => {
      // The base must be a commit of the real develop, not one the artifacts invented.
      const compared = await github("GET", `/compare/develop...${base}`);
      return compared.status === 200 && ["behind", "identical"].includes(compared.body?.status);
    },
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
      patch: git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, commitSha]),
    }),
    // The SEO surface has no account row to graduate: the operator's own record is this variable, set after
    // the operator has checked the O3 conditions (policy 6.1, 9.2). Exactly "true"; unset, empty or any other
    // value is "not graduated", and so is a read that throws.
    lookupGraduation: async () => process.env[SEO_AGENT_GRADUATED_VARIABLE_ENV] === "true",
    push: async (commitSha, branch) => {
      // The lease with an empty expected value is "the branch must not exist": the server
      // refuses the update if it does, so a branch created since the lookup is never advanced.
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      git(root, ["push", `--force-with-lease=refs/heads/${branch}:`, `https://github.com/${repository}.git`, `${commitSha}:refs/heads/${branch}`], {
        env: {
          ...seoAgentStageEnvironment(process.env, "publish"),
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: header,
        },
      });
    },
    remoteRef: async (branch) => {
      const ref = await github("GET", `/git/ref/heads/${branch}`);
      if (ref.status === 404) return { exists: false, sha: null };
      return ref.status === 200 && typeof ref.body?.object?.sha === "string" ? { exists: true, sha: ref.body.object.sha } : null;
    },
    remoteTree: async (branch, commitSha) => {
      const ref = await github("GET", `/git/ref/heads/${branch}`);
      if (ref.status !== 200 || ref.body?.object?.sha !== commitSha) return null;
      const commit = await github("GET", `/git/commits/${commitSha}`);
      return commit.status === 200 ? (commit.body?.tree?.sha ?? null) : null;
    },
    deleteBranch: async (branch, commitSha) => {
      // Deleted only if the server still has this run's commit there; a branch that moved is left alone.
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      git(root, ["push", `--force-with-lease=refs/heads/${branch}:${commitSha}`, `https://github.com/${repository}.git`, `:refs/heads/${branch}`], {
        env: {
          ...seoAgentStageEnvironment(process.env, "publish"),
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: header,
        },
      });
    },
    findPullRequests: async (branch) => {
      // Open ones and finished ones are asked separately, so a long history cannot hide an open pull request,
      // and a page that is not the whole list is unreadable: an arming is never decided on part of the open ones.
      const nodeFields = "id number state isDraft baseRefName headRefName headRefOid isCrossRepository autoMergeRequest { enabledAt }";
      const data = await graphql(
        `query($owner: String!, $name: String!, $head: String!) {
          repository(owner: $owner, name: $name) {
            open: pullRequests(headRefName: $head, states: [OPEN], first: 20) { pageInfo { hasNextPage } nodes { ${nodeFields} } }
            finished: pullRequests(headRefName: $head, states: [MERGED, CLOSED], first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${nodeFields} } }
          }
        }`,
        { owner: repositoryOwner, name: repositoryName, head: branch },
      );
      const openList = data.repository?.open;
      if (!Array.isArray(openList?.nodes) || openList.pageInfo?.hasNextPage !== false || !Array.isArray(data.repository?.finished?.nodes)) return null;
      const nodes = [...openList.nodes, ...data.repository.finished.nodes];
      const views = [];
      for (const node of nodes) {
        // A shape that is not exactly what the decision reads is unreadable, never a guess.
        if (
          typeof node?.id !== "string" || !Number.isInteger(node.number) || !["OPEN", "MERGED", "CLOSED"].includes(node.state) ||
          typeof node.isDraft !== "boolean" || typeof node.baseRefName !== "string" || typeof node.headRefName !== "string" ||
          !/^[0-9a-f]{40}$/.test(node.headRefOid ?? "") || typeof node.isCrossRepository !== "boolean"
        ) {
          return null;
        }
        views.push({
          nodeId: node.id, number: node.number, state: node.state, isDraft: node.isDraft, base: node.baseRefName,
          head: node.headRefName, headSha: node.headRefOid, crossRepository: node.isCrossRepository, autoMerge: node.autoMergeRequest != null,
        });
      }
      return views;
    },
    enableAutoMerge: async ({ nodeId, headSha }) => {
      // expectedHeadOid: GitHub refuses if the head is no longer the validated commit. A merge commit,
      // as the merge train makes. The merge itself is GitHub's, when develop's required checks pass.
      const data = await graphql(
        `mutation($id: ID!, $sha: GitObjectID!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $sha }) {
            pullRequest { autoMergeRequest { enabledAt } }
          }
        }`,
        { id: nodeId, sha: headSha },
      );
      if (data.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest == null) throw new Error("auto-merge was not enabled");
    },
    disableAutoMerge: async ({ nodeId }) => {
      const data = await graphql(
        `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { enabledAt } } } }`,
        { id: nodeId },
      );
      if (data.disablePullRequestAutoMerge?.pullRequest?.autoMergeRequest != null) throw new Error("auto-merge was not disabled");
    },
    createPullRequest: async ({ branch, title, body }) => {
      // Draft, against develop, and no merge call of any kind.
      const created = await github("POST", "/pulls", { title, head: branch, base: "develop", body, draft: true });
      if (created.status !== 201 || typeof created.body?.html_url !== "string") {
        throw new Error(`pull request was not created (HTTP ${created.status})`);
      }
      return { url: created.body.html_url };
    },
  };

  // The loop is in the core (runSeoAgentArmLoop): it looks until the window is over, watches an armed pull
  // request, and disarms it again at the end of the window, on any other ending and on a throw. A signal
  // does the same here, because GitHub keeps auto-merge on after a person with write access pushes.
  let armedNow = null;
  // A signal waits for an enabling request that is already on its way (turning it off first would be
  // overtaken by it), refuses a new one, and asks to turn it off up to three times.
  let stopping = false;
  let enableInFlight = Promise.resolve();
  const enableOnce = ports.enableAutoMerge;
  ports.enableAutoMerge = (pull) => {
    if (stopping) throw new Error("stopping: no new auto-merge request");
    const request = enableOnce(pull);
    enableInFlight = request.then(() => undefined, () => undefined);
    return request;
  };
  const armLoop = async () => {
    // A flag with no value after it is a mistake, not the default.
    if (process.argv.includes("--wait-minutes") && option("--wait-minutes") === undefined) throw new Error("--wait-minutes needs a number of minutes");
    const waitMinutes = Number(option("--wait-minutes") ?? ARM_DEFAULT_WAIT_MINUTES);
    if (!Number.isFinite(waitMinutes) || waitMinutes < 1) throw new Error("--wait-minutes must be a number of minutes, 1 or more");
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, async () => {
        stopping = true;
        await enableInFlight;
        for (let attempt = 0; armedNow !== null && attempt < 3; attempt += 1) {
          try {
            await ports.disableAutoMerge(armedNow);
            break;
          } catch {
            // Asked again; a person turns it off in the PR if all three fail.
          }
        }
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
    return await runSeoAgentArmLoop(
      { record, attestation: attestationFile?.attestation, env: process.env, windowMs: waitMinutes * 60 * 1000 },
      ports,
      {
        now: () => Date.now(),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        pollMs: ARM_POLL_MS,
        armedPollMs: ARM_ARMED_POLL_MS,
        onArmed: (pull) => {
          armedNow = pull;
        },
        onResult: (result) => console.log(JSON.stringify({ event: "marketing_seo_agent_arm", ...result })),
      },
    );
  };
  const armFinished = ["merged", "off"];

  try {
    if (phase === "arm") {
      const result = await armLoop();
      process.exit(armFinished.includes(result.status) ? 0 : 2);
    }
    const published = await runSeoAgentPublish({ record, attestation: attestationFile?.attestation, env: process.env }, ports);
    console.log(JSON.stringify({ event: "marketing_seo_agent_publish", ...published }));
    if (published.status !== "pushed") process.exit(published.status === "off" ? 0 : 2);
    // After a graduated push the workflow opens the draft PR; arm it when, and only when, the switch says so.
    if (published.graduated && seoAgentAutoMergeGate(process.env, true).on) {
      const result = await armLoop();
      process.exit(armFinished.includes(result.status) ? 0 : 2);
    }
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

if (process.argv[1] && self === resolve(process.argv[1]) && phase !== "validate" && phase !== "publish" && phase !== "arm") {
  console.error("Usage: --phase validate|publish|arm (see the header of this file).");
  process.exit(1);
}
