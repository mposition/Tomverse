import type { CliProvider } from "./code-execution";
import type { PermissionModeId } from "./permission-contract";

/**
 * Running a task with the provider's own CLI (the person's saved, trusted file) instead of the Tomverse API. The run
 * costs no Tomverse credits and calls no Tomverse coding API. Only these two providers have an adapter; the others
 * keep their fixture-only routes.
 */
export const liveCliProviders = ["openai", "anthropic"] as const satisfies readonly CliProvider[];
export type LiveCliProvider = (typeof liveCliProviders)[number];
export const isLiveCliProvider = (provider: CliProvider): provider is LiveCliProvider =>
  (liveCliProviders as readonly CliProvider[]).includes(provider);

/** The composer's model id for a provider CLI that runs with its own default model. */
export const liveCliModelId = (provider: LiveCliProvider) => `provider-cli:${provider}` as const;
export function liveCliProviderForModel(id: string): LiveCliProvider | null {
  return liveCliProviders.find((provider) => liveCliModelId(provider) === id) ?? null;
}

/** How much each permission mode lets a task do, lowest first. The CLI is never started above the mode the person chose. */
export const permissionRank: Record<PermissionModeId, number> = { read_only: 0, ask: 1, auto_review: 2, allow_all: 3 };

/** Who answers an approval the CLI asks for: nobody (it is never asked), the person on the approval card, or the CLI's own reviewer. */
export type CliApprovals = "none" | "card" | "cli_reviewer";
/** One line shown in the task when the CLI could not honour the chosen mode as is and the run is narrower. */
export type CliPermissionNotice = "cliAskReadOnly" | "cliAllowAllScoped" | "cliAllowAllCommandsAsk";
export type CliPermissionPlan = {
  /** What the CLI is allowed to do in this run; its rank is never above the chosen mode's. */
  grants: PermissionModeId;
  approvals: CliApprovals;
  notice?: CliPermissionNotice;
};

/**
 * Codex runs `codex exec`, which has no way to ask a person: it never asks for approval, so "ask" runs read-only (the
 * safer side) and says why. Its own automatic reviewer (`--approve-for-me`) is the Auto review mode. Allow all stays
 * inside Codex's project sandbox (writes in the project, no network), which is narrower than no sandbox.
 * Claude Code runs the stream protocol, which sends each approval to the host, so Ask and Auto review use the card. Its shell
 * cannot be confined on every system, so Allow all pre-approves its file edits only: commands still come to the card, which
 * keeps "actions that leave this app still ask you" true.
 */
export const cliPermissionPlans: Record<LiveCliProvider, Record<PermissionModeId, CliPermissionPlan>> = {
  openai: {
    read_only: { grants: "read_only", approvals: "none" },
    ask: { grants: "read_only", approvals: "none", notice: "cliAskReadOnly" },
    auto_review: { grants: "auto_review", approvals: "cli_reviewer" },
    allow_all: { grants: "allow_all", approvals: "none", notice: "cliAllowAllScoped" },
  },
  anthropic: {
    read_only: { grants: "read_only", approvals: "none" },
    ask: { grants: "ask", approvals: "card" },
    auto_review: { grants: "auto_review", approvals: "card" },
    allow_all: { grants: "allow_all", approvals: "card", notice: "cliAllowAllCommandsAsk" },
  },
};

export const cliPermissionPlan = (provider: LiveCliProvider, mode: PermissionModeId): CliPermissionPlan => cliPermissionPlans[provider][mode];

/** What a task shows for the tool calls and file changes the CLI reports. Bounded so a long run cannot grow the task without limit. */
export const LIVE_CLI_LIMITS = {
  /** Text kept of one command's output. */
  commandOutput: 4_000,
  /** One assistant message. */
  message: 24_000,
  /** Transcript entries kept (messages and tool events); the rest are counted in one line. */
  entries: 400,
  /** Changed files listed. */
  changes: 400,
  /** One protocol line. A longer one is skipped. */
  line: 2 * 1024 * 1024,
  /** Everything the CLI may print before the run is ended. */
  stream: 256 * 1024 * 1024,
} as const;
