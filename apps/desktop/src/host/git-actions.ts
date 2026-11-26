import { isAbsolute, resolve } from "node:path";
import { commandEnv } from "../../../tomverse-cli/src/env.js";
import type {
  AgentGitResult, GitApprovalView, GitErrorCode, GitFailure, GitFileStatus, GitPublishInput, GitPublishResult, GitStatusResult, PullRequestDraft,
} from "../git-actions-contract";
import { ApprovalLedger, digestOf } from "./git-approval-ledger";
import { cleanExternalText, createPullRequest, githubRepoOfRemote, readGhStatus, type GhRunner } from "./github-cli";
import { resolveProgram, runProgram, type ProcessResult } from "./tool-process";

export type GitRun = (args: readonly string[], options?: { input?: string; timeoutMs?: number }) => Promise<ProcessResult>;
export type GitContext = {
  /** The repository's top folder: every command runs here, so the paths `git status` prints mean what they say. */
  top: string;
  run: GitRun;
  /** A Tomverse-managed worktree: its branch is fixed because the task is bound to it. */
  managed: boolean;
  /** The repository's own configuration can start programs or redirect the push; commits and pushes are refused. */
  blocked: boolean;
  gh: GhRunner | null;
  /** The GitHub repository an address names. Replaceable so tests can use a local bare remote as "GitHub". */
  githubRepo: (url: string) => string | null;
};
/** Opens the card for a ticket the main process issued and resolves true only when the person approved it. */
export type ApprovalRequester = (view: GitApprovalView, ticket: string) => Promise<boolean>;
export type GitApprovals = { ledger: ApprovalLedger; request: ApprovalRequester };

const MAX_FILES = 500;
const MAX_COMMITS = 100;
const fail = (code: GitErrorCode): GitFailure => ({ status: "error", code });

/**
 * Keys that, set in the repository's own configuration, run a program or redirect a connection when Git commits or pushes. The person's
 * own global configuration is trusted (it holds their credential helper); a repository's is not.
 */
const unsafeConfig = /^(?:core\.(?:sshcommand|gitproxy|askpass)|include(?:if)?\..+|filter\..+|diff\.external|diff\..+\.(?:command|textconv)|credential\.(?:.+\.)?helper|gpg\.(?:.+\.)?program|remote\..+\.(?:receivepack|uploadpack|vcs|proxy)|http\.(?:.+\.)?(?:proxy|extraheader)|extensions\.worktreeconfig)$/i;

/** The environment Git runs with: the person's own HOME and agent sockets (their credential setup), but no tokens, no prompts, English output. */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = commandEnv(["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "DISPLAY", "GIT_ASKPASS", "XDG_CONFIG_HOME"], source);
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "file:https:ssh", LC_ALL: "C", LANG: "C" };
}

const baseArguments = (hooksOff: string) => ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
  "-c", "core.longpaths=true", "-c", "core.quotepath=false", "-c", "push.followTags=false", "-c", "push.recurseSubmodules=no",
  // Repository hooks are programs of the repository, not of the person who approved this action.
  "-c", "core.hooksPath=" + hooksOff];

export async function openGitContext(folder: string, options: {
  managed: boolean; gh: GhRunner | null; hooksOff: string; env?: NodeJS.ProcessEnv; githubRepo?: (url: string) => string | null;
}): Promise<GitContext | null> {
  const env = gitEnvironment(options.env);
  const executable = resolveProgram("git", env, folder);
  if (!executable) return null;
  const runIn = (cwd: string): GitRun => (args, run) => runProgram(executable, [...baseArguments(options.hooksOff), ...args],
    { cwd, env, timeoutMs: run?.timeoutMs ?? 20_000, ...(run?.input === undefined ? {} : { input: run.input }) });
  const probe = await runIn(folder)(["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0 || !probe.stdout.trim()) return null;
  const top = resolve(probe.stdout.trim());
  const run = runIn(top);
  const config = await run(["config", "--local", "--no-includes", "--name-only", "--list", "-z"]);
  const blocked = config.code !== 0 || config.stdout.split("\0").some((key) => unsafeConfig.test(key));
  return { top, run, managed: options.managed, blocked, gh: options.gh, githubRepo: options.githubRepo ?? githubRepoOfRemote };
}

const text = async (ctx: GitContext, args: string[]) => {
  const result = await ctx.run(args);
  return result.code === 0 ? result.stdout.trim() : null;
};

/** What the card and the panel show for a remote address: never an embedded password. */
export const displayRemote = (url: string) => cleanExternalText(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"), 300);

function supportedRemote(url: string) {
  if (/^(?:https|ssh):\/\/[^\s]+$/i.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return true;
  if (/^file:\/\/[^\s]+$/i.test(url)) return true;
  // A local path (a bare repository on this computer). Transport helpers such as ext:: or fd:: are never one.
  return isAbsolute(url) && !/::/.test(url);
}

async function remoteChoice(ctx: GitContext, branch: string | null, wanted?: string) {
  const names = (await text(ctx, ["remote"]))?.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
  const upstream = branch ? await text(ctx, ["config", "--get", "branch." + branch + ".remote"]) : null;
  const name = wanted ?? (upstream && upstream !== "." && names.includes(upstream) ? upstream : names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined);
  if (!name || !names.includes(name)) return { names, chosen: null };
  const url = await text(ctx, ["remote", "get-url", "--push", name]);
  return { names, chosen: url ? { name, url } : null };
}

async function defaultBranchOf(ctx: GitContext, remote: string) {
  const ref = await text(ctx, ["symbolic-ref", "--quiet", "--short", "refs/remotes/" + remote + "/HEAD"]);
  return ref?.startsWith(remote + "/") ? ref.slice(remote.length + 1) : null;
}

function parseStatus(output: string): GitFileStatus[] {
  return output.split("\0").filter((entry) => entry.length > 3 && entry[2] === " ")
    .map((entry) => ({ index: entry[0]!, worktree: entry[1]!, path: entry.slice(3) }));
}

async function changedFiles(ctx: GitContext) {
  const result = await ctx.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { timeoutMs: 30_000 });
  return result.code === 0 ? parseStatus(result.stdout) : null;
}

export async function readGitStatus(ctx: GitContext, busy: boolean): Promise<GitStatusResult> {
  const [branchText, headText, files] = await Promise.all([
    text(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"]), text(ctx, ["rev-parse", "--verify", "HEAD"]), changedFiles(ctx),
  ]);
  if (!files) return { kind: "unavailable", reason: "error" };
  const choice = await remoteChoice(ctx, branchText);
  const remotes = [];
  for (const name of choice.names.slice(0, 10)) {
    const url = await text(ctx, ["remote", "get-url", "--push", name]);
    if (url) remotes.push({ name, url: displayRemote(url) });
  }
  const aheadText = choice.chosen && headText ? await text(ctx, ["rev-list", "--count", "HEAD", "--not", "--remotes=" + choice.chosen.name]) : null;
  const ahead = aheadText === null ? null : Number(aheadText);
  return {
    kind: "ready", root: ctx.top, branch: branchText, head: headText, managed: ctx.managed, canCreateBranch: !ctx.managed && !ctx.blocked && !busy,
    remotes, remote: choice.chosen?.name ?? null, defaultBranch: choice.chosen ? await defaultBranchOf(ctx, choice.chosen.name) : null,
    files: files.slice(0, MAX_FILES), moreFiles: Math.max(0, files.length - MAX_FILES), ahead: ahead !== null && Number.isFinite(ahead) ? ahead : null, busy,
  };
}

export async function createBranch(ctx: GitContext, name: string): Promise<{ status: "ok"; branch: string } | GitFailure> {
  if (ctx.managed) return fail("managed-worktree");
  if (ctx.blocked) return fail("config-blocked");
  if ((await ctx.run(["check-ref-format", "--branch", name])).code !== 0) return fail("invalid-name");
  if ((await ctx.run(["show-ref", "--verify", "--quiet", "refs/heads/" + name])).code === 0) return fail("branch-exists");
  const created = await ctx.run(["checkout", "-b", name]);
  return created.code === 0 ? { status: "ok", branch: name } : fail("unavailable");
}

const label = (file: GitFileStatus) => (file.index !== " " && file.index !== "?" ? file.index : file.worktree);

async function commitPlan(ctx: GitContext, input: { message: string; paths: string[] }) {
  const files = await changedFiles(ctx);
  if (!files) return fail("unavailable");
  const wanted = new Set(input.paths);
  const known = new Map(files.map((file) => [file.path, file]));
  if (wanted.size !== input.paths.length || input.paths.some((path) => !known.has(path))) return fail("unknown-path");
  const staged = await ctx.run(["diff", "--cached", "--name-only", "-z"], { timeoutMs: 30_000 });
  if (staged.code !== 0) return fail("unavailable");
  // The commit must contain exactly what was selected: files someone already staged elsewhere would ride along unseen.
  if (staged.stdout.split("\0").filter(Boolean).some((path) => !wanted.has(path))) return fail("staged-elsewhere");
  const head = await text(ctx, ["rev-parse", "--verify", "HEAD"]);
  const view: GitApprovalView["commit"] = { message: input.message, files: input.paths.map((path) => ({ path: cleanExternalText(path, 400), status: label(known.get(path)!) })) };
  return { view, digest: digestOf({ repository: ctx.top, head, message: input.message, files: [...input.paths].sort().map((path) => [path, label(known.get(path)!)]) }) };
}

/**
 * Commits the selected files. The person's own commit (the Git panel) needs no card: the panel already listed these files. An agent's
 * commit opens the same approval card as a push, and runs only if the repository still matches what the card showed.
 */
export async function commitChanges(ctx: GitContext, input: { message: string; paths: string[] }, origin: "user" | "agent", approvals?: GitApprovals):
  Promise<{ status: "ok"; sha: string } | GitFailure> {
  if (ctx.blocked) return fail("config-blocked");
  const plan = await commitPlan(ctx, input);
  if ("status" in plan) return plan;
  if (origin === "agent") {
    if (!approvals) return fail("denied");
    const ticket = approvals.ledger.issue(plan.digest);
    let approved = false;
    try { approved = await approvals.request({ kind: "commit", origin, repository: ctx.top, commit: plan.view }, ticket); }
    catch { approved = false; }
    if (!approved) { approvals.ledger.revoke(ticket); return fail("denied"); }
    const again = await commitPlan(ctx, input);
    if ("status" in again) { approvals.ledger.revoke(ticket); return again; }
    if (!approvals.ledger.redeem(ticket, again.digest)) return fail("changed");
  }
  const added = await ctx.run(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: input.paths.join("\0") + "\0", timeoutMs: 60_000 });
  if (added.code !== 0) return fail("commit-failed");
  const committed = await ctx.run(["commit", "-q", "-m", input.message], { timeoutMs: 60_000 });
  if (committed.code !== 0) {
    if (/tell me who you are|empty ident|unable to auto-detect/i.test(committed.stderr)) return fail("identity");
    return fail(/nothing (?:added )?to commit/i.test(committed.stdout + committed.stderr) ? "nothing-to-commit" : "commit-failed");
  }
  const sha = await text(ctx, ["rev-parse", "--verify", "HEAD"]);
  return sha ? { status: "ok", sha } : fail("commit-failed");
}

type PublishPlan = { view: NonNullable<GitApprovalView["publish"]>; digest: string; draft?: PullRequestDraft; repo?: string };

const protectedBranches = new Set(["main", "master"]);

async function publishPlan(ctx: GitContext, input: GitPublishInput): Promise<PublishPlan | GitFailure> {
  if (ctx.blocked) return fail("config-blocked");
  const branch = await text(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) return fail("detached");
  const head = await text(ctx, ["rev-parse", "--verify", "HEAD"]);
  if (!head) return fail("no-commits");
  const { chosen } = await remoteChoice(ctx, branch, input.remote);
  if (!chosen) return fail("no-remote");
  if (!supportedRemote(chosen.url)) return fail("remote-unsupported");
  const remoteBranch = input.remoteBranch ?? branch;
  if ((await ctx.run(["check-ref-format", "refs/heads/" + remoteBranch])).code !== 0) return fail("invalid-name");
  const defaultBranch = await defaultBranchOf(ctx, chosen.name);
  // Never straight to the default branch: it goes through a branch and a pull request.
  if (protectedBranches.has(remoteBranch) || remoteBranch === defaultBranch) return fail("default-branch");
  const log = await ctx.run(["log", head, "--not", "--remotes=" + chosen.name, "--format=%H%x1f%an%x1f%s", "-n", String(MAX_COMMITS + 1)], { timeoutMs: 30_000 });
  if (log.code !== 0) return fail("unavailable");
  const rows = log.stdout.split("\n").filter(Boolean).map((line) => line.split("\x1f"));
  const commits = rows.slice(0, MAX_COMMITS).map(([sha = "", author = "", subject = ""]) => ({ sha, author: cleanExternalText(author, 100), subject: cleanExternalText(subject, 200) }));
  if (!commits.length && !input.pullRequest) return fail("nothing-to-publish");
  const files = await changedFiles(ctx);
  let pullRequest: NonNullable<GitApprovalView["publish"]>["pullRequest"];
  let repo: string | undefined;
  if (input.pullRequest) {
    repo = ctx.githubRepo(chosen.url) ?? undefined;
    if (!repo) return fail("pr-needs-github");
    if (input.pullRequest.base === remoteBranch) return fail("pr-same-branch");
    const status = await readGhStatus(ctx.gh);
    if (status.state !== "ready") return fail(status.state === "missing" ? "gh-missing" : "gh-signed-out");
    const { title, body, base, draft } = input.pullRequest;
    pullRequest = { repo, head: remoteBranch, base, title, body, draft };
  }
  const view: PublishPlan["view"] = {
    remote: { name: chosen.name, url: displayRemote(chosen.url) }, localBranch: branch, remoteBranch, head, commits,
    moreCommits: Math.max(0, rows.length - MAX_COMMITS), uncommitted: files?.length ?? 0, ...(pullRequest ? { pullRequest } : {}),
  };
  // The raw address binds the digest, so a changed remote is caught even when its masked display is the same.
  return { view, digest: digestOf({ repository: ctx.top, view, rawRemote: chosen.url }), ...(input.pullRequest ? { draft: input.pullRequest } : {}), ...(repo ? { repo } : {}) };
}

const rejected = /rejected|non-fast-forward|fetch first|stale info|protected branch|denied/i;

/**
 * Pushes the current branch and, if asked, opens a pull request. Nothing is sent before the person approves a card showing the remote,
 * the branch, the commits that go up and the pull request text. After the approval the plan is read again: if it differs by even one
 * commit the action is refused. The push names the approved commit, never a force, never a deletion, never the default branch.
 */
export async function publishBranch(ctx: GitContext, input: GitPublishInput, origin: "user" | "agent", approvals: GitApprovals):
  Promise<GitPublishResult | GitFailure> {
  const first = await publishPlan(ctx, input);
  if ("status" in first) return first;
  const ticket = approvals.ledger.issue(first.digest);
  let approved = false;
  try { approved = await approvals.request({ kind: "publish", origin, repository: ctx.top, publish: first.view }, ticket); }
  catch { approved = false; }
  if (!approved) { approvals.ledger.revoke(ticket); return fail("denied"); }
  const second = await publishPlan(ctx, input);
  if ("status" in second) { approvals.ledger.revoke(ticket); return second; }
  if (!approvals.ledger.redeem(ticket, second.digest)) return fail("changed");
  const { view } = second;
  const pushed = await ctx.run(["push", "--porcelain", "--no-verify", "--no-recurse-submodules", view.remote.name, view.head + ":refs/heads/" + view.remoteBranch],
    { timeoutMs: 180_000 });
  if (pushed.code !== 0) return fail(rejected.test(pushed.stderr + pushed.stdout) ? "push-rejected" : "push-failed");
  // Track the remote branch when Git has it; the push itself already succeeded.
  await ctx.run(["branch", "--set-upstream-to=" + view.remote.name + "/" + view.remoteBranch, view.localBranch]);
  const result: GitPublishResult = { status: "ok", remote: view.remote.name, branch: view.remoteBranch, sha: view.head };
  if (second.draft && second.repo && ctx.gh) result.pullRequest = await createPullRequest(ctx.gh, second.repo, view.remoteBranch, second.draft, ctx.top);
  return result;
}

export const agentResult = (result: { status: "ok"; sha: string } | GitPublishResult | GitFailure): AgentGitResult => {
  if (result.status === "ok") {
    return "remote" in result ? { status: "published", remote: result.remote, branch: result.branch, sha: result.sha, ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}) }
      : { status: "committed", sha: result.sha };
  }
  return { status: result.code === "denied" ? "denied" : result.code === "disabled" ? "disabled" : "error", code: result.code };
};
