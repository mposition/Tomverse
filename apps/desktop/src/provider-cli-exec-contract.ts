import { antigravityFixtureExecution, claudeFixtureExecution, cliUsesInstallationFolder, cliUsesReleaseArchive, codexFixtureExecution, grokFixtureExecution, kimiFixtureExecution,
  miniMaxFixtureExecution, providerClis, qwenFixtureExecution, vibeFixtureExecution, zaiClaudeExecution, type CliProvider, type SavedCliPath } from "./code-execution";
import type { PermissionModeId } from "./permission-contract";

/**
 * Running a task with the provider's own CLI (the person's saved, trusted file) instead of the Tomverse API. The run
 * costs no Tomverse credits and calls no Tomverse coding API. Codex and Claude Code have an adapter of their own; Qwen Code,
 * Grok Build, Kimi Code, Mistral Vibe, MiniMax Code and Antigravity share one "live ACP" adapter (Agent Client Protocol over stdio).
 * `zai` is Claude Code on the person's Z.ai Coding Plan: the same saved Claude Code
 * file and adapter, with its own settings folder and the Z.ai key, so the person's Claude sign-in is neither used nor changed.
 */
export const liveAcpProviders = ["qwen", "xai", "moonshot", "mistral", "minimax", "google"] as const;
export type LiveAcpProvider = (typeof liveAcpProviders)[number];
export const liveCliProviders = ["openai", "anthropic", "zai", ...liveAcpProviders] as const;
export type LiveCliProvider = (typeof liveCliProviders)[number];
export const isLiveAcpProvider = (provider: LiveCliProvider): provider is LiveAcpProvider => (liveAcpProviders as readonly string[]).includes(provider);

/** The saved CLI file each route runs. */
export const liveCliFile = { openai: "openai", anthropic: "anthropic", zai: "anthropic", qwen: "qwen", xai: "xai", moonshot: "moonshot",
  mistral: "mistral", minimax: "minimax", google: "google" } as const satisfies Record<LiveCliProvider, CliProvider>;
/** The name the composer and the task show. */
export const liveCliNames = { openai: "Codex", anthropic: "Claude Code", zai: "Z.ai CLI (via Claude Code)", qwen: providerClis.qwen, xai: providerClis.xai,
  moonshot: providerClis.moonshot, mistral: providerClis.mistral, minimax: providerClis.minimax, google: providerClis.google } as const satisfies Record<LiveCliProvider, string>;
const liveAcpExecution = { qwen: qwenFixtureExecution, xai: grokFixtureExecution, moonshot: kimiFixtureExecution, mistral: vibeFixtureExecution,
  minimax: miniMaxFixtureExecution, google: antigravityFixtureExecution } as const satisfies Record<LiveAcpProvider, unknown>;
/** What a task run on the route says it ran with. */
export const liveCliExecution = (provider: LiveCliProvider) =>
  isLiveAcpProvider(provider) ? liveAcpExecution[provider] : provider === "openai" ? codexFixtureExecution : provider === "zai" ? zaiClaudeExecution : claudeFixtureExecution;

/**
 * Whether the saved file of a route is something a task can start. A pinned release that was verified is the file itself for
 * most CLIs, but for Qwen Code and Mistral Vibe it is the release archive and for MiniMax Code its installation folder: those
 * run only from an executable the person trusted ("userTrusted").
 */
export function liveCliRunnable(provider: LiveCliProvider, saved: Pick<SavedCliPath, "status"> | undefined) {
  if (!saved) return false;
  if (saved.status === "userTrusted") return true;
  const file = liveCliFile[provider];
  return saved.status === "pathVerified" && !cliUsesReleaseArchive(file) && !cliUsesInstallationFolder(file);
}

/**
 * What each ACP CLI does under its own rules, without sending Desktop a permission request (seen in real runs on the owner's computer,
 * 2026-11-28). Desktop can only answer the requests it receives, so none of this can be refused: Qwen Code and Antigravity read
 * project files, including a `.env`, and the content goes to the model; Antigravity and MiniMax Code edit project files in Ask
 * too; Mistral Vibe and Qwen Code run commands they judge safe (`ls`, `echo`) in Read only. Grok Build: not checked yet, so nothing
 * is claimed for it. Kimi Code asked for everything that was tried. A task on a CLI with any of these says so (`cliOwnRules`).
 * Qwen Code's `--disallowed-tools` / `--tools` options exist, but their value format is not confirmed, so they are not used.
 */
export type AcpOwnRules = { readsWithoutAsking: boolean; editsWithoutAsking: boolean; safeCommandsWithoutAsking: boolean };
export const acpOwnRules: Record<LiveAcpProvider, AcpOwnRules> = {
  qwen: { readsWithoutAsking: true, editsWithoutAsking: false, safeCommandsWithoutAsking: true },
  google: { readsWithoutAsking: true, editsWithoutAsking: true, safeCommandsWithoutAsking: false },
  minimax: { readsWithoutAsking: false, editsWithoutAsking: true, safeCommandsWithoutAsking: false },
  mistral: { readsWithoutAsking: false, editsWithoutAsking: false, safeCommandsWithoutAsking: true },
  moonshot: { readsWithoutAsking: false, editsWithoutAsking: false, safeCommandsWithoutAsking: false },
  xai: { readsWithoutAsking: false, editsWithoutAsking: false, safeCommandsWithoutAsking: false },
};
/** Whether a task on this route runs something under the CLI's own rules that Desktop cannot ask about. */
export const cliRunsOwnRules = (provider: LiveCliProvider) => isLiveAcpProvider(provider) && Object.values(acpOwnRules[provider]).some(Boolean);

/**
 * The folders in a person's home where the provider CLIs keep their sign-in and settings. A live ACP run uses the person's
 * real home, so these are the files a CLI could be asked to read or change on a model's say-so: a request naming anything
 * under one is refused in every permission mode and never shown on an approval card. Names are matched as whole path
 * segments, lower case, in any position (so a project's own `.qwen` folder counts too).
 */
export const providerConfigFolders = [".qwen", ".vibe", ".grok", ".kimi-code", ".kimi", ".minimax", ".minimax-code", ".codex", ".claude", ".gemini"] as const;
/** Z.ai's Anthropic-compatible endpoint for the Coding Plan (docs.z.ai, Claude Code). */
export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

/** The composer's model id for a provider CLI that runs with its own default model. */
export const liveCliModelId = (provider: LiveCliProvider) => `provider-cli:${provider}` as const;
export function liveCliProviderForModel(id: string): LiveCliProvider | null {
  return liveCliProviders.find((provider) => liveCliModelId(provider) === id) ?? null;
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
  // The ACP CLIs send each approval as `session/request_permission`, so they follow the Claude Code plan: Read only refuses
  // every write or command request, Ask and Auto review use the card, and Allow all pre-approves only edits inside the project.
  qwen: acpPlans(), xai: acpPlans(), moonshot: acpPlans(), mistral: acpPlans(), minimax: acpPlans(), google: acpPlans(),
};

function acpPlans(): Record<PermissionModeId, CliPermissionPlan> {
  return {
    read_only: { grants: "read_only", approvals: "none" },
    ask: { grants: "ask", approvals: "card" },
    auto_review: { grants: "ask", approvals: "card", notice: "cliAutoReviewAsks" },
    allow_all: { grants: "allow_all", approvals: "card", notice: "cliAllowAllCommandsAsk" },
  };
}

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
