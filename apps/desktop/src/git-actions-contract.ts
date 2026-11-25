import { z } from "zod";
import { pullLink, type PullEvidence } from "./github-pr-contract";

/** A branch name the Git panel may create or publish to. Git itself checks the name again in the main process. */
export const gitBranchName = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((name) =>
  !name.includes("..") && !name.includes("//") && !name.includes("/.") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock") &&
  !name.includes(".lock/"), "Invalid branch name");
export const gitRemoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const gitCommitMessage = z.string().trim().min(1).max(4_000).refine((text) => !text.includes("\0"), "Invalid message");
export const gitFilePath = z.string().min(1).max(1_024).refine((path) => !path.includes("\0"), "Invalid path");
/** A pull request the person asked to open after the push. It is shown on the approval card exactly as it will be sent. */
export const pullRequestDraft = z.object({
  title: z.string().trim().min(1).max(256).refine((text) => !/[\u0000-\u001f\u007f]/.test(text), "Invalid title"),
  body: z.string().max(8_000).refine((text) => !text.includes("\0"), "Invalid body"),
  base: gitBranchName,
  draft: z.boolean(),
}).strict();
export type PullRequestDraft = z.infer<typeof pullRequestDraft>;

export const gitPublishInput = z.object({
  remote: gitRemoteName.optional(),
  remoteBranch: gitBranchName.optional(),
  pullRequest: pullRequestDraft.optional(),
}).strict();
export type GitPublishInput = z.infer<typeof gitPublishInput>;

/**
 * Everything the renderer may ask of the Git panel and the pull request screen. There is no force push, no branch deletion and no
 * "approved" flag: a publish is approved on a card the main process opens, never by a value the renderer sends.
 */
export const gitCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }).strict(),
  z.object({ type: z.literal("gh") }).strict(),
  z.object({ type: z.literal("agent-actions"), enabled: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("create-branch"), name: gitBranchName }).strict(),
  z.object({ type: z.literal("commit"), message: gitCommitMessage, paths: z.array(gitFilePath).min(1).max(500) }).strict(),
  z.object({ type: z.literal("publish"), ...gitPublishInput.shape }).strict(),
  z.object({ type: z.literal("pr-view"), link: pullLink }).strict(),
  z.object({ type: z.literal("pr-check-log"), link: pullLink, check: z.string().min(1).max(256) }).strict(),
]);
export type GitCommand = z.infer<typeof gitCommand>;

/** What the agent's own tools may ask. Same shapes as the person's, and each one opens the same approval card. */
export const agentGitAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), message: gitCommitMessage, paths: z.array(gitFilePath).min(1).max(500) }).strict(),
  z.object({ kind: z.literal("publish"), ...gitPublishInput.shape }).strict(),
]);
export type AgentGitAction = z.infer<typeof agentGitAction>;

export type GitErrorCode =
  | "busy" | "no-project" | "no-git" | "unavailable" | "managed-worktree" | "invalid-name" | "branch-exists" | "nothing-to-commit"
  | "staged-elsewhere" | "unknown-path" | "identity" | "commit-failed" | "detached" | "no-commits" | "no-remote" | "remote-unsupported"
  | "default-branch" | "config-blocked" | "nothing-to-publish" | "gh-missing" | "gh-signed-out" | "pr-needs-github" | "pr-same-branch"
  | "denied" | "changed" | "push-rejected" | "push-failed" | "disabled" | "not-linked" | "no-failed-check" | "log-unavailable";

export type GitFileStatus = { path: string; index: string; worktree: string };
export type GitStatusResult =
  | { kind: "unavailable"; reason: "no-project" | "no-git" | "error" }
  | {
    kind: "ready"; root: string; branch: string | null; head: string | null; managed: boolean; canCreateBranch: boolean;
    remotes: Array<{ name: string; url: string }>; remote: string | null; defaultBranch: string | null;
    files: GitFileStatus[]; moreFiles: number; ahead: number | null; busy: boolean;
  };
export type GhStatusResult = { state: "ready" } | { state: "missing" } | { state: "signed-out" };
export type GitFailure = { status: "error"; code: GitErrorCode };
export type PullRequestOutcome = { state: "created" | "exists"; url: string } | { state: "failed" } | { state: "unknown" };
export type GitPublishResult = {
  status: "ok"; remote: string; branch: string; sha: string; pullRequest?: PullRequestOutcome;
};

export type PrCheck = {
  name: string; bucket: "pass" | "fail" | "pending" | "skipping" | "cancel"; state: string;
  workflow?: string; link?: string; description?: string; startedAt?: string; completedAt?: string;
};
export type PrComment = {
  id: string; kind: "review" | "inline" | "comment"; author: string; body: string;
  path?: string; line?: number; state?: string; createdAt?: string; url?: string;
};
export type PrDetails = {
  number: number; title: string; state: string; isDraft: boolean; url: string; headRef: string; baseRef: string; headSha: string;
  reviewDecision?: string; mergeable?: string; checks: PrCheck[]; comments: PrComment[]; omittedComments: number;
};
export type PrViewResult =
  | { status: "ok"; source: "gh"; details: PrDetails }
  | { status: "limited"; reason: "gh-missing" | "gh-signed-out" | "gh-error"; evidence: PullEvidence | null }
  | GitFailure;
export type PrCheckLogResult = { status: "ok"; text: string; truncated: boolean } | GitFailure;

export type GitResultMap = {
  status: GitStatusResult;
  gh: GhStatusResult;
  "agent-actions": { enabled: boolean };
  "create-branch": { status: "ok"; branch: string } | GitFailure;
  commit: { status: "ok"; sha: string } | GitFailure;
  publish: GitPublishResult | GitFailure;
  "pr-view": PrViewResult;
  "pr-check-log": PrCheckLogResult;
};
export type AgentGitResult =
  | { status: "committed"; sha: string }
  | { status: "published"; remote: string; branch: string; sha: string; pullRequest?: PullRequestOutcome }
  | { status: "denied" | "disabled" | "error"; code?: GitErrorCode };

/** What the approval window shows. It is built by the main process from the repository, never from renderer text. */
export type GitApprovalView = {
  kind: "commit" | "publish";
  origin: "user" | "agent";
  repository: string;
  commit?: { message: string; files: Array<{ path: string; status: string }> };
  publish?: {
    remote: { name: string; url: string };
    localBranch: string; remoteBranch: string; head: string;
    commits: Array<{ sha: string; subject: string; author: string }>; moreCommits: number; uncommitted: number;
    pullRequest?: { repo: string; head: string; base: string; title: string; body: string; draft: boolean };
  };
};
