import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Commit and push for a host whose approval window can show them (Tomverse Desktop). The tools only ask: the host opens a card showing
 * exactly what would be committed or pushed (the remote, the branch, every commit, the pull request text), and the person answers it.
 * Nothing in the input can approve, force or delete: there is no such field.
 */
export type GitToolAction =
    | { kind: "commit"; message: string; paths: string[] }
    | { kind: "publish"; remote?: string; remoteBranch?: string; pullRequest?: { title: string; body: string; base: string; draft: boolean } };

export type GitToolReply =
    | { status: "committed"; sha: string }
    | { status: "published"; remote: string; branch: string; sha: string; pullRequest?: { state: string; url?: string } }
    | { status: "denied" | "disabled" | "error"; code?: string };

export type GitToolHost = (action: GitToolAction, signal: AbortSignal) => Promise<GitToolReply | null>;

const branch = z.string().min(1).max(200);

const commitInput = z.object({
    message: z.string().min(1).max(4000).describe("The commit message: a short subject line, a blank line, then what changed and why."),
    paths: z.array(z.string().min(1).max(1024)).min(1).max(500).describe("Paths exactly as `git status` lists them, relative to the repository root."),
}).strict();

const publishInput = z.object({
    remoteBranch: branch.optional().describe("The branch name to push to. Defaults to the current branch; never the repository's default branch."),
    pullRequest: z.object({
        title: z.string().min(1).max(256),
        body: z.string().max(8000),
        base: branch.describe("The branch the pull request merges into."),
        draft: z.boolean(),
    }).strict().optional().describe("Also open a pull request after the push (GitHub remotes only, through the person's signed-in gh)."),
}).strict();

const unavailable = { status: "error", message: "Git actions are not available in this session." };

export function createGitTools(host: GitToolHost, blocked: () => string | undefined, signal: () => AbortSignal): ToolSet {
    const ask = async (action: GitToolAction) => {
        const reason = blocked();
        if (reason) return { status: "error", message: reason };
        signal().throwIfAborted();
        const reply = await host(action, signal());
        signal().throwIfAborted();
        return reply ?? unavailable;
    };
    return {
        commit_changes: tool({
            description: "Ask the user to approve a git commit of the listed files. The user sees the message and the files on a card and may deny it; you cannot approve it. If it is denied or disabled, do not ask again: explain what you would have committed.",
            inputSchema: commitInput,
            execute: (input) => ask({ kind: "commit", ...input }),
        }),
        publish_changes: tool({
            description: "Ask the user to approve pushing the current branch's commits (and optionally opening a pull request). The user sees the remote, the branch, every commit and the pull request text on a card and may deny it; you cannot approve it. Never force, delete or push to the default branch: those are not possible. Commit first; only commits are pushed. If it is denied or disabled, do not ask again.",
            inputSchema: publishInput,
            execute: (input) => ask({ kind: "publish", ...input }),
        }),
    };
}
