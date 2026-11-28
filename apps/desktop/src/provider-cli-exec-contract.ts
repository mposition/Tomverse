import { claudeFixtureExecution, codexFixtureExecution, zaiClaudeExecution, type CliProvider } from "./code-execution";
import type { PermissionModeId } from "./permission-contract";

/**
 * Running a task with the provider's own CLI (the person's saved, trusted file) instead of the Tomverse API. The run
 * costs no Tomverse credits and calls no Tomverse coding API. Codex and Claude Code have an adapter; the other CLIs keep
 * their fixture-only routes. `zai` is Claude Code on the person's Z.ai Coding Plan: the same saved Claude Code file and
 * adapter, with its own settings folder and the Z.ai key, so the person's Claude sign-in is neither used nor changed.
 */
export const liveCliProviders = ["openai", "anthropic", "zai"] as const;
export type LiveCliProvider = (typeof liveCliProviders)[number];

/** The saved CLI file each route runs. */
export const liveCliFile = { openai: "openai", anthropic: "anthropic", zai: "anthropic" } as const satisfies Record<LiveCliProvider, CliProvider>;
/** The name the composer and the task show. */
export const liveCliNames = { openai: "Codex", anthropic: "Claude Code", zai: "Z.ai CLI (via Claude Code)" } as const satisfies Record<LiveCliProvider, string>;
/** What a task run on the route says it ran with. */
export const liveCliExecution = (provider: LiveCliProvider) =>
  provider === "openai" ? codexFixtureExecution : provider === "zai" ? zaiClaudeExecution : claudeFixtureExecution;
/** Z.ai's Anthropic-compatible endpoint for the Coding Plan (docs.z.ai, Claude Code). */
export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

/** The Tomverse catalogue provider whose models each CLI runs on the person's own subscription. */
export const liveCliCatalogProvider = { openai: "openai", anthropic: "anthropic", zai: "zhipu" } as const satisfies Record<LiveCliProvider, string>;

/**
 * The composer's model id for a provider CLI: with a Tomverse catalogue model id the CLI runs that model (its provider's own
 * model id, which the host looks up in the catalogue), without one the CLI runs with its own default model.
 */
export const liveCliModelId = (provider: LiveCliProvider, catalogueModelId?: string) =>
  catalogueModelId ? `provider-cli:${provider}:${catalogueModelId}` : `provider-cli:${provider}`;
/** A catalogue model id the composer may name: the coding catalogue's own id shape. */
const catalogueModelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
/** A provider model id the host may pass to a CLI as `--model`: never an option, a path or more than one argument. */
export const cliModelArgumentPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;
export function liveCliChoiceForModel(id: string): { provider: LiveCliProvider; catalogueModelId?: string } | null {
  for (const provider of liveCliProviders) {
    const base = liveCliModelId(provider);
    if (id === base) return { provider };
    const rest = id.startsWith(base + ":") ? id.slice(base.length + 1) : "";
    if (catalogueModelIdPattern.test(rest)) return { provider, catalogueModelId: rest };
  }
  return null;
}
export function liveCliProviderForModel(id: string): LiveCliProvider | null {
  return liveCliChoiceForModel(id)?.provider ?? null;
}

/** How much each permission mode lets a task do, lowest first. The CLI is never started above the mode the person chose. */
export const permissionRank: Record<PermissionModeId, number> = { read_only: 0, ask: 1, auto_review: 2, allow_all: 3 };

/** Who answers an approval the CLI asks for: nobody (it is never asked), or the person on the approval card. The CLI's own reviewer never does. */
export type CliApprovals = "none" | "card";
/** One line shown in the task when the CLI could not honour the chosen mode as is and the run is narrower. */
export type CliPermissionNotice = "cliAskReadOnly" | "cliAutoReviewScoped" | "cliAutoReviewAsks" | "cliAllowAllScoped" | "cliAllowAllCommandsAsk";
export type CliPermissionPlan = {
  /** What the CLI is allowed to do in this run; its rank is never above the chosen mode's. */
  grants: PermissionModeId;
  approvals: CliApprovals;
  notice?: CliPermissionNotice;
};

/**
 * Codex runs `codex exec`, which has no way to ask a person: it never asks for approval, so "ask" runs read-only (the
 * safer side) and says why. Auto review and Allow all stay inside Codex's project sandbox (writes in the project, no
 * network, nothing that needs an escalation), which is narrower than no sandbox. Codex's own automatic reviewer
 * (`--approve-for-me`) and Claude Code's auto mode are not used: they could approve a push or an upload that, in Tomverse,
 * stays the person's to approve.
 * Claude Code runs the stream protocol, which sends each approval to the host, so Ask and Auto review use the card. Its shell
 * cannot be confined on every system, so Allow all pre-approves its file edits only (never a credential file): commands
 * still come to the card, which keeps "actions that leave this app still ask you" true.
 */
export const cliPermissionPlans: Record<LiveCliProvider, Record<PermissionModeId, CliPermissionPlan>> = {
  openai: {
    read_only: { grants: "read_only", approvals: "none" },
    ask: { grants: "read_only", approvals: "none", notice: "cliAskReadOnly" },
    auto_review: { grants: "auto_review", approvals: "none", notice: "cliAutoReviewScoped" },
    allow_all: { grants: "allow_all", approvals: "none", notice: "cliAllowAllScoped" },
  },
  anthropic: {
    read_only: { grants: "read_only", approvals: "none" },
    ask: { grants: "ask", approvals: "card" },
    auto_review: { grants: "ask", approvals: "card", notice: "cliAutoReviewAsks" },
    allow_all: { grants: "allow_all", approvals: "card", notice: "cliAllowAllCommandsAsk" },
  },
  zai: {
    read_only: { grants: "read_only", approvals: "none" },
    ask: { grants: "ask", approvals: "card" },
    auto_review: { grants: "ask", approvals: "card", notice: "cliAutoReviewAsks" },
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
