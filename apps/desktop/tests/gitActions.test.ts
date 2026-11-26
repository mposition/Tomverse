import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { agentGitAction, gitBranchName, gitCommand, type GitApprovalView } from "../src/git-actions-contract";
import { commitChanges, createBranch, openGitContext, publishBranch, readGitStatus, type GitApprovals, type GitContext } from "../src/host/git-actions";
import { ApprovalLedger } from "../src/host/git-approval-ledger";
import type { GhRunner } from "../src/host/github-cli";

const scratch = mkdtempSync(join(tmpdir(), "tomverse-git-actions-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

// A throwaway home, so the person's own Git configuration never changes what these tests see.
const home = join(scratch, "home");
mkdirSync(home);
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
const hooksOff = join(scratch, "no-hooks");
let counter = 0;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...env, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
}

function folder(name: string) {
  const path = join(scratch, name + "-" + counter++);
  mkdirSync(path);
  return path;
}

async function repository(options: { remote?: boolean; managed?: boolean; gh?: GhRunner | null; githubRepo?: string } = {}) {
  const work = folder("work");
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "a\n");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  let bare = "";
  if (options.remote !== false) {
    bare = folder("remote");
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "origin", "main");
    git(work, "remote", "set-head", "origin", "main");
  }
  const ctx = await openGitContext(work, { managed: options.managed ?? false, gh: options.gh ?? null, hooksOff, env,
    ...(options.githubRepo ? { githubRepo: () => options.githubRepo! } : {}) });
  assert.ok(ctx);
  return { work, bare, ctx: ctx as GitContext };
}

function approvals(decision: boolean | (() => Promise<void> | void) = true) {
  const ledger = new ApprovalLedger();
  const views: GitApprovalView[] = [];
  const result: GitApprovals & { views: GitApprovalView[] } = {
    ledger, views,
    request: async (view, ticket) => {
      views.push(view);
      if (typeof decision === "function") await decision();
      const approved = typeof decision === "function" ? true : decision;
      if (approved) ledger.grant(ticket);
      return approved;
    },
  };
  return result;
}

const remoteRefs = (bare: string) => git(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");

test("The status lists changed files and the branch, and a managed worktree cannot start a branch", async () => {
  const { work, ctx } = await repository();
  writeFileSync(join(work, "a.txt"), "changed\n");
  writeFileSync(join(work, "new.txt"), "new\n");
  const status = await readGitStatus(ctx, false);
  assert.equal(status.kind, "ready");
  if (status.kind !== "ready") return;
  assert.equal(status.branch, "main");
  assert.deepEqual(status.files.map((file) => [file.path, file.index + file.worktree]).sort(), [["a.txt", " M"], ["new.txt", "??"]]);
  assert.equal(status.remote, "origin");
  assert.equal(status.defaultBranch, "main");
  assert.equal(status.ahead, 0);
  assert.equal(status.canCreateBranch, true);
  const managed = await repository({ managed: true });
  assert.deepEqual(await createBranch(managed.ctx, "feature"), { status: "error", code: "managed-worktree" });
  assert.equal(git(managed.work, "branch", "--show-current"), "main");
});

test("A branch is created and checked out; a bad or existing name is refused", async () => {
  const { work, ctx } = await repository();
  assert.deepEqual(await createBranch(ctx, "feature/login"), { status: "ok", branch: "feature/login" });
  assert.equal(git(work, "branch", "--show-current"), "feature/login");
  assert.deepEqual(await createBranch(ctx, "feature/login"), { status: "error", code: "branch-exists" });
  assert.deepEqual(await createBranch(ctx, "bad.lock"), { status: "error", code: "invalid-name" });
  assert.equal(git(work, "branch", "--show-current"), "feature/login");
});

test("A commit contains exactly the selected files and runs no repository hook", async () => {
  const { work, ctx } = await repository();
  const marker = join(work, "hook-ran");
  mkdirSync(join(work, ".git", "hooks"), { recursive: true });
  writeFileSync(join(work, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
  writeFileSync(join(work, "a.txt"), "changed\n");
  writeFileSync(join(work, "b.txt"), "changed too\n");
  const result = await commitChanges(ctx, { message: "Change a", paths: ["a.txt"] }, "user");
  assert.equal(result.status, "ok");
  assert.equal(git(work, "show", "--name-only", "--format=%s", "HEAD").split("\n").join("|"), "Change a||a.txt");
  assert.match(git(work, "status", "--porcelain"), /^M b\.txt$/);
  assert.equal(existsSync(marker), false, "the repository's pre-commit hook must not run");
});

test("A commit refuses unknown paths, files staged elsewhere and an empty selection of changes", async () => {
  const { work, ctx } = await repository();
  writeFileSync(join(work, "a.txt"), "changed\n");
  writeFileSync(join(work, "b.txt"), "changed too\n");
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["nope.txt"] }, "user"), { status: "error", code: "unknown-path" });
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["../outside"] }, "user"), { status: "error", code: "unknown-path" });
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["a.txt", "a.txt"] }, "user"), { status: "error", code: "unknown-path" });
  git(work, "add", "b.txt");
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["a.txt"] }, "user"), { status: "error", code: "staged-elsewhere" });
  assert.equal(git(work, "rev-list", "--count", "HEAD"), "1");
});

test("A repository configuration that runs a program or redirects Git blocks commits and pushes", async () => {
  const { work } = await repository();
  git(work, "config", "core.sshCommand", "echo owned");
  const ctx = await openGitContext(work, { managed: false, gh: null, hooksOff, env });
  assert.equal(ctx?.blocked, true);
  writeFileSync(join(work, "a.txt"), "changed\n");
  assert.deepEqual(await commitChanges(ctx!, { message: "x", paths: ["a.txt"] }, "user"), { status: "error", code: "config-blocked" });
  assert.deepEqual(await publishBranch(ctx!, {}, "user", approvals()), { status: "error", code: "config-blocked" });
  git(work, "config", "--unset", "core.sshCommand");
  git(work, "config", "core.hooksPath", ".husky");
  assert.equal((await openGitContext(work, { managed: false, gh: null, hooksOff, env }))?.blocked, false);
});

async function featureCommit(work: string, ctx: GitContext, file = "feature.txt") {
  if (git(work, "branch", "--show-current") === "main") await createBranch(ctx, "feature");
  writeFileSync(join(work, file), "feature\n");
  const result = await commitChanges(ctx, { message: "Add " + file, paths: [file] }, "user");
  assert.equal(result.status, "ok");
  return result.status === "ok" ? result.sha : "";
}

test("A push shows the remote, the branch and the commits first, then pushes exactly that commit", async () => {
  const { work, bare, ctx } = await repository();
  const sha = await featureCommit(work, ctx);
  const ask = approvals();
  const result = await publishBranch(ctx, {}, "user", ask);
  assert.deepEqual(result, { status: "ok", remote: "origin", branch: "feature", sha });
  assert.equal(ask.views.length, 1);
  const shown = ask.views[0]!;
  assert.equal(shown.kind, "publish");
  assert.equal(shown.origin, "user");
  assert.equal(shown.publish?.remote.name, "origin");
  assert.equal(shown.publish?.localBranch, "feature");
  assert.equal(shown.publish?.remoteBranch, "feature");
  assert.deepEqual(shown.publish?.commits.map((commit) => [commit.sha, commit.subject]), [[sha, "Add feature.txt"]]);
  assert.match(remoteRefs(bare), new RegExp("refs/heads/feature " + sha));
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "feature@{upstream}"), "origin/feature");
});

test("Nothing is pushed without approval: a denied card, a card that throws and a card nobody answered all leave the remote unchanged", async () => {
  const { work, bare, ctx } = await repository();
  await featureCommit(work, ctx);
  const before = remoteRefs(bare);
  assert.deepEqual(await publishBranch(ctx, {}, "user", approvals(false)), { status: "error", code: "denied" });
  const throwing = approvals();
  throwing.request = async () => { throw new Error("window closed"); };
  assert.deepEqual(await publishBranch(ctx, {}, "user", throwing), { status: "error", code: "denied" });
  // An answer that was never granted by the main process's ledger cannot be redeemed, whatever the requester returns.
  const forged = approvals();
  forged.request = async () => true;
  assert.deepEqual(await publishBranch(ctx, {}, "user", forged), { status: "error", code: "changed" });
  assert.equal(remoteRefs(bare), before);
});

test("A commit added while the card is open makes the approval void and nothing is pushed", async () => {
  const { work, bare, ctx } = await repository();
  await featureCommit(work, ctx);
  const before = remoteRefs(bare);
  const ask = approvals(async () => { writeFileSync(join(work, "late.txt"), "late\n"); git(work, "add", "late.txt"); git(work, "commit", "-q", "-m", "late"); });
  assert.deepEqual(await publishBranch(ctx, {}, "user", ask), { status: "error", code: "changed" });
  assert.equal(remoteRefs(bare), before);
  // A fresh card for the new state works, and shows both commits.
  const again = approvals();
  assert.equal((await publishBranch(ctx, {}, "user", again)).status, "ok");
  assert.equal(again.views[0]?.publish?.commits.length, 2);
});

test("A changed remote address while the card is open also voids the approval", async () => {
  const { work, bare, ctx } = await repository();
  await featureCommit(work, ctx);
  const other = folder("other");
  git(other, "init", "-q", "--bare", "-b", "main");
  const before = remoteRefs(bare);
  const ask = approvals(() => { git(work, "remote", "set-url", "--push", "origin", other); });
  assert.deepEqual(await publishBranch(ctx, {}, "user", ask), { status: "error", code: "changed" });
  assert.equal(remoteRefs(bare), before);
  assert.equal(git(other, "for-each-ref", "refs/heads/"), "");
});

test("The default branch is never pushed to directly", async () => {
  const { work, bare, ctx } = await repository();
  writeFileSync(join(work, "a.txt"), "changed\n");
  assert.equal((await commitChanges(ctx, { message: "On main", paths: ["a.txt"] }, "user")).status, "ok");
  const before = remoteRefs(bare);
  const ask = approvals();
  assert.deepEqual(await publishBranch(ctx, {}, "user", ask), { status: "error", code: "default-branch" });
  await createBranch(ctx, "topic");
  for (const remoteBranch of ["main", "master"]) {
    assert.deepEqual(await publishBranch(ctx, { remoteBranch }, "user", ask), { status: "error", code: "default-branch" });
  }
  assert.equal(ask.views.length, 0, "no card is shown for a push that is refused outright");
  assert.equal(remoteRefs(bare), before);
});

test("A diverged remote branch is rejected and never overwritten: there is no force", async () => {
  const { work, bare, ctx } = await repository();
  const first = await featureCommit(work, ctx);
  assert.equal((await publishBranch(ctx, {}, "user", approvals())).status, "ok");
  git(work, "commit", "-q", "--amend", "-m", "Rewritten history");
  const rewritten = git(work, "rev-parse", "HEAD");
  assert.notEqual(rewritten, first);
  const result = await publishBranch(ctx, {}, "user", approvals());
  assert.deepEqual(result, { status: "error", code: "push-rejected" });
  assert.match(remoteRefs(bare), new RegExp("refs/heads/feature " + first));
});

test("Publishing with nothing new, no remote or a detached head is refused before any card", async () => {
  const { work, ctx } = await repository();
  const ask = approvals();
  await createBranch(ctx, "idle");
  assert.deepEqual(await publishBranch(ctx, {}, "user", ask), { status: "error", code: "nothing-to-publish" });
  assert.deepEqual(await publishBranch(ctx, { remote: "elsewhere" }, "user", ask), { status: "error", code: "no-remote" });
  git(work, "checkout", "-q", "--detach");
  assert.deepEqual(await publishBranch(ctx, {}, "user", ask), { status: "error", code: "detached" });
  const local = await repository({ remote: false });
  assert.deepEqual(await publishBranch(local.ctx, {}, "user", ask), { status: "error", code: "no-remote" });
  assert.equal(ask.views.length, 0);
});

test("Unsupported transports are never pushed to", async () => {
  const { work, ctx } = await repository();
  await featureCommit(work, ctx);
  for (const url of ["ext::sh -c touch% /tmp/owned", "fd::3", "http://example.com/x.git", "relative/path.git"]) {
    git(work, "remote", "set-url", "origin", url);
    assert.deepEqual(await publishBranch(ctx, {}, "user", approvals()), { status: "error", code: "remote-unsupported" }, url);
  }
});

test("A remote with more than one push address is never pushed to: the card could show only one of them", async () => {
  const { work, bare, ctx } = await repository();
  await featureCommit(work, ctx);
  const second = folder("second");
  git(second, "init", "-q", "--bare");
  // Git pushes to every push address of a remote, the first one included.
  git(work, "remote", "set-url", "--add", "--push", "origin", bare);
  git(work, "remote", "set-url", "--add", "--push", "origin", second);
  const ask = approvals();
  assert.deepEqual(await publishBranch(ctx, {}, "user", ask), { status: "error", code: "remote-unsupported" });
  assert.equal(ask.views.length, 0, "no card is shown for a push that would reach an address it does not name");
  assert.equal(git(bare, "for-each-ref").includes("feature"), false);
  assert.equal(git(second, "for-each-ref").includes("feature"), false);
});

const signedIn: GhRunner = async (args) => (args[0] === "auth" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" });
const draft = { title: "Add feature", body: "Why and how", base: "main", draft: false };

test("A pull request needs a GitHub remote and a signed-in gh before the card, and is opened only after the push", async () => {
  const plain = await repository({ gh: signedIn });
  await featureCommit(plain.work, plain.ctx);
  const ask = approvals();
  assert.deepEqual(await publishBranch(plain.ctx, { pullRequest: draft }, "user", ask), { status: "error", code: "pr-needs-github" });
  const missing = await repository({ gh: null, githubRepo: "example/site" });
  await featureCommit(missing.work, missing.ctx);
  assert.deepEqual(await publishBranch(missing.ctx, { pullRequest: draft }, "user", ask), { status: "error", code: "gh-missing" });
  const signedOut = await repository({ gh: async () => ({ code: 1, stdout: "", stderr: "not logged in" }), githubRepo: "example/site" });
  await featureCommit(signedOut.work, signedOut.ctx);
  assert.deepEqual(await publishBranch(signedOut.ctx, { pullRequest: draft }, "user", ask), { status: "error", code: "gh-signed-out" });
  assert.deepEqual(await publishBranch(plain.ctx, { pullRequest: { ...draft, base: "feature" } }, "user", ask), { status: "error", code: "pr-needs-github" });
  assert.equal(ask.views.length, 0);
  assert.equal(remoteRefs(plain.bare).includes("feature"), false);
});

test("The approved pull request is created with gh using the approved text, once", async () => {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: "https://github.com/example/site/pull/7\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const { work, bare, ctx } = await repository({ gh, githubRepo: "example/site" });
  const sha = await featureCommit(work, ctx);
  const ask = approvals();
  const result = await publishBranch(ctx, { pullRequest: { ...draft, draft: true } }, "agent", ask);
  assert.deepEqual(result, { status: "ok", remote: "origin", branch: "feature", sha, pullRequest: { state: "created", url: "https://github.com/example/site/pull/7" } });
  assert.deepEqual(ask.views[0]?.publish?.pullRequest, { repo: "example/site", head: "feature", base: "main", title: "Add feature", body: "Why and how", draft: true });
  assert.equal(ask.views[0]?.origin, "agent");
  const creates = calls.filter((call) => call[0] === "pr" && call[1] === "create");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], ["pr", "create", "--repo", "example/site", "--head", "feature", "--base", "main", "--title", "Add feature", "--body", "Why and how", "--draft"]);
  assert.match(remoteRefs(bare), /refs\/heads\/feature/);
});

test("An agent's push and pull request never run on anything but a granted card: denied, closed, thrown and unanswered cards all leave the remote and gh untouched", async () => {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    return args[0] === "auth" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
  const { work, bare, ctx } = await repository({ gh, githubRepo: "example/site" });
  await featureCommit(work, ctx);
  const answers: Array<[string, GitApprovals["request"]]> = [
    ["denied", async () => false],
    ["thrown", async () => { throw new Error("the window crashed"); }],
    // A card answered "yes" without the ledger granting its ticket (anything but the approval window) is not an approval.
    ["not granted", async () => true],
  ];
  for (const [label, request] of answers) {
    const result = await publishBranch(ctx, { pullRequest: { ...draft, draft: true } }, "agent", { ledger: new ApprovalLedger(), request });
    assert.deepEqual(result, { status: "error", code: label === "not granted" ? "changed" : "denied" }, label);
  }
  assert.equal(remoteRefs(bare).includes("feature"), false, "nothing was pushed");
  assert.deepEqual(calls.filter((call) => call[0] === "pr"), [], "no pull request was created");
  // An agent's commit with no approvals at all is refused instead of running.
  writeFileSync(join(work, "late.txt"), "late\n");
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["late.txt"] }, "agent"), { status: "error", code: "denied" });
});

test("When creating the pull request has an unknown outcome the branch's open pull requests are checked, and it is never retried", async () => {
  let creates = 0;
  const run = (listed: string | null): GhRunner => async (args) => {
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    if (args[1] === "create") { creates += 1; return { code: null, stdout: "", stderr: "" }; }
    if (args[1] === "list") return listed === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: listed, stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  for (const [listed, state] of [[JSON.stringify([{ url: "https://github.com/example/site/pull/9" }]), "exists"], ["[]", "unknown"], [null, "unknown"]] as const) {
    creates = 0;
    const { work, ctx } = await repository({ gh: run(listed), githubRepo: "example/site" });
    await featureCommit(work, ctx);
    const result = await publishBranch(ctx, { pullRequest: draft }, "user", approvals());
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.pullRequest?.state, state);
    assert.equal(creates, 1);
  }
});

test("A failed pull request creation is reported as failed only when gh exited with an error and no pull request exists", async () => {
  const gh: GhRunner = async (args) => {
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    if (args[1] === "create") return { code: 1, stdout: "", stderr: "GraphQL: not allowed" };
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const { work, ctx } = await repository({ gh, githubRepo: "example/site" });
  await featureCommit(work, ctx);
  const result = await publishBranch(ctx, { pullRequest: draft }, "user", approvals());
  assert.equal(result.status === "ok" && result.pullRequest?.state, "failed");
});

test("An agent's commit needs the same card, and a denied or changed card commits nothing", async () => {
  const { work, ctx } = await repository();
  writeFileSync(join(work, "a.txt"), "changed\n");
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["a.txt"] }, "agent"), { status: "error", code: "denied" });
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["a.txt"] }, "agent", approvals(false)), { status: "error", code: "denied" });
  const moved = approvals(() => { git(work, "add", "b.txt"); });
  writeFileSync(join(work, "b.txt"), "other work\n");
  assert.deepEqual(await commitChanges(ctx, { message: "x", paths: ["a.txt"] }, "agent", moved), { status: "error", code: "staged-elsewhere" });
  git(work, "reset", "-q", "b.txt");
  assert.equal(git(work, "rev-list", "--count", "HEAD"), "1");
  const ok = approvals();
  const done = await commitChanges(ctx, { message: "Agent change", paths: ["a.txt"] }, "agent", ok);
  assert.equal(done.status, "ok");
  assert.deepEqual(ok.views[0]?.commit, { message: "Agent change", files: [{ path: "a.txt", status: "M" }] });
  assert.equal(git(work, "log", "-1", "--format=%s"), "Agent change");
});

test("The approval ledger issues one-time tickets that only a grant and the same fingerprint redeem", () => {
  let now = 1_000;
  const ledger = new ApprovalLedger(() => now, 5_000);
  const ticket = ledger.issue("digest-a");
  assert.equal(ledger.redeem(ticket, "digest-a"), false, "not granted yet");
  const second = ledger.issue("digest-a");
  assert.equal(ledger.grant(second), true);
  assert.equal(ledger.grant(second), false, "a ticket is granted once");
  assert.equal(ledger.redeem(second, "digest-b"), false, "a different fingerprint");
  assert.equal(ledger.redeem(second, "digest-a"), false, "a failed redemption spends the ticket");
  const third = ledger.issue("digest-a");
  ledger.grant(third);
  assert.equal(ledger.redeem(third, "digest-a"), true);
  assert.equal(ledger.redeem(third, "digest-a"), false, "a ticket redeems once");
  const late = ledger.issue("digest-a");
  ledger.grant(late);
  now += 6_000;
  assert.equal(ledger.redeem(late, "digest-a"), false, "an expired ticket");
  assert.equal(ledger.grant("not-issued"), false);
});

test("The renderer can ask for neither a force push, a branch deletion nor its own approval", () => {
  for (const command of [
    { type: "push" }, { type: "force-push" }, { type: "delete-branch", name: "x" }, { type: "approve", id: "x" },
    { type: "publish", force: true }, { type: "publish", approved: true }, { type: "publish", ticket: "x" }, { type: "publish", remoteBranch: "--delete" },
    { type: "publish", remoteBranch: "+main" }, { type: "publish", remoteBranch: "a..b" }, { type: "commit", message: "x", paths: [] },
    { type: "create-branch", name: "-f" },
  ]) assert.equal(gitCommand.safeParse(command).success, false, JSON.stringify(command));
  assert.equal(gitCommand.safeParse({ type: "publish", remoteBranch: "feature/x", pullRequest: draft }).success, true);
  assert.equal(agentGitAction.safeParse({ kind: "publish", approved: true }).success, false);
  for (const name of ["feature/x", "fix-1.2", "a_b"]) assert.equal(gitBranchName.safeParse(name).success, true, name);
  for (const name of ["", "-x", "a b", "a..b", "a//b", "x.lock", "x/", "x.", "a@{b", "a~b", "a:b"]) assert.equal(gitBranchName.safeParse(name).success, false, name);
});

test("The push is built from the approved commit and never from a forcing or deleting form", () => {
  const source = readFileSync(new URL("../src/host/git-actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /--force|--delete|--mirror|--prune|"-f"|"-d"|"-D"|\+refs|--tags|--all/);
  assert.match(source, /view\.head \+ ":refs\/heads\/" \+ view\.remoteBranch/);
});
