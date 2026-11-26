import { agentGitAction, gitCommand, type AgentGitResult, type GitCommand, type GitFailure, type GitResultMap } from "../git-actions-contract";
import { githubPullUrl, type PullEvidence, type PullLink } from "../github-pr-contract";
import type { ApprovalLedger } from "./git-approval-ledger";
import {
  agentResult, commitChanges, createBranch, openGitContext, publishBranch, readGitStatus, type ApprovalRequester, type GitApprovals, type GitContext,
} from "./git-actions";
import { readFailedCheckLog, readGhStatus, readPullRequestWithGh, type GhRunner } from "./github-cli";

export type GitHostDeps = {
  /** The folder the Git panel works on (the task's worktree or the project), or null when none is open or it changed. */
  target(): { folder: string; managed: boolean } | null;
  /** An agent run or another approval card is active: the person's own commit, branch and publish wait. */
  busy(): boolean;
  ledger: ApprovalLedger;
  requestApproval: ApprovalRequester;
  /** A folder that does not exist: Git hooks are pointed here, so none of the repository's programs run. */
  hooksOff: string;
  gh(): GhRunner | null;
  /** The pull request links saved for the open task: the only ones the pull request screen reads. */
  savedLinks(): PullLink[];
  linkPull(url: string): Promise<void>;
  readPublic(link: PullLink): Promise<PullEvidence | null>;
  agentSwitch: { read(): boolean; write(enabled: boolean): void };
  afterBranchChange?(): void;
  env?: NodeJS.ProcessEnv;
};

const fail = (code: GitFailure["code"]): GitFailure => ({ status: "error", code });
const sameLink = (a: string, b: string) => githubPullUrl(a)?.url.toLowerCase() === githubPullUrl(b)?.url.toLowerCase();

/** The one place renderer commands and agent tool calls become Git and `gh` work. Each action that leaves the app opens an approval card first. */
export function createGitHost(deps: GitHostDeps) {
  const approvals: GitApprovals = { ledger: deps.ledger, request: deps.requestApproval };

  async function context(): Promise<GitContext | null> {
    const target = deps.target();
    return target ? openGitContext(target.folder, { managed: target.managed, gh: deps.gh(), hooksOff: deps.hooksOff, ...(deps.env ? { env: deps.env } : {}) }) : null;
  }

  async function handle<T extends GitCommand["type"]>(raw: unknown): Promise<GitResultMap[T]>;
  async function handle(raw: unknown): Promise<GitResultMap[keyof GitResultMap]> {
    const command = gitCommand.parse(raw);
    switch (command.type) {
      case "agent-actions": {
        if (command.enabled !== undefined) deps.agentSwitch.write(command.enabled);
        return { enabled: deps.agentSwitch.read() };
      }
      case "gh": return readGhStatus(deps.gh());
      case "pr-view": {
        if (!deps.savedLinks().some((link) => sameLink(link.url, command.link.url))) return fail("not-linked");
        const gh = deps.gh();
        const read = gh ? await readPullRequestWithGh(gh, command.link) : null;
        if (read?.status === "ok") return { status: "ok", source: "gh", details: read.details };
        return { status: "limited", reason: read ? read.reason : "gh-missing", evidence: await deps.readPublic(command.link).catch(() => null) };
      }
      case "pr-check-log": {
        if (!deps.savedLinks().some((link) => sameLink(link.url, command.link.url))) return fail("not-linked");
        const gh = deps.gh();
        if (!gh) return fail("gh-missing");
        const log = await readFailedCheckLog(gh, command.link, command.check);
        return log.status === "ok" ? log : fail(log.code);
      }
      default: break;
    }
    const ctx = await context();
    const target = deps.target();
    if (!ctx || !target) return command.type === "status" ? { kind: "unavailable", reason: target ? "no-git" : "no-project" } : fail(target ? "no-git" : "no-project");
    if (command.type === "status") return readGitStatus(ctx, deps.busy());
    if (deps.busy()) return fail("busy");
    switch (command.type) {
      // A draft needs the model runtime, which the main process owns; it never comes through here.
      case "draft": return fail("unavailable");
      case "create-branch": {
        const result = await createBranch(ctx, command.name);
        if (result.status === "ok") deps.afterBranchChange?.();
        return result;
      }
      case "commit": return commitChanges(ctx, { message: command.message, paths: command.paths }, "user");
      case "publish": {
        const { type: _type, ...input } = command;
        const result = await publishBranch(ctx, input, "user", approvals);
        if (result.status === "ok" && result.pullRequest && "url" in result.pullRequest) await deps.linkPull(result.pullRequest.url).catch(() => undefined);
        return result;
      }
    }
  }

  /** An agent tool call. Disabled unless the person switched it on; every call opens an approval card the agent cannot answer. */
  async function agent(raw: unknown): Promise<AgentGitResult> {
    if (!deps.agentSwitch.read()) return { status: "disabled" };
    const parsed = agentGitAction.safeParse(raw);
    if (!parsed.success) return { status: "error" };
    const ctx = await context();
    if (!ctx) return { status: "error", code: "no-git" };
    const action = parsed.data;
    if (action.kind === "commit") return agentResult(await commitChanges(ctx, { message: action.message, paths: action.paths }, "agent", approvals));
    const { kind: _kind, ...input } = action;
    const result = await publishBranch(ctx, input, "agent", approvals);
    if (result.status === "ok" && result.pullRequest && "url" in result.pullRequest) await deps.linkPull(result.pullRequest.url).catch(() => undefined);
    return agentResult(result);
  }

  return { handle, agent, ledger: deps.ledger };
}

export type GitHost = ReturnType<typeof createGitHost>;
