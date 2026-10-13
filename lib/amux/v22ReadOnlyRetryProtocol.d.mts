export declare const AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION: 1;
export declare const AMUX_V22_READ_ONLY_RETRY_CAPABILITY: "read_only_retry_v1";
export declare const AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION:
  "amux-v22-read-only-retry-v1";
export declare const AMUX_V22_READ_ONLY_ALLOWED_TOOLS:
  readonly ["Glob", "Grep", "Read"];
export declare const AMUX_V22_SIDECAR_LAUNCH_ENV: Readonly<{
  worker: "TOMVERSE_AMUX_V22_WORKER";
  binaryPath: "TOMVERSE_AMUX_V22_CLAUDE_BINARY";
  worktreePath: "TOMVERSE_AMUX_V22_WORKTREE";
  homePath: "TOMVERSE_AMUX_V22_HOME";
  claudeConfigDir: "TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR";
}>;

export type AmuxV22CliReadOnlyRetryBinding = {
  version: 1;
  launchBindingId: string;
  riskAcceptanceDigest: string;
  safeStopEvidenceDigest: string;
  launchProofDigest: string;
  launchScopeDigest: string;
  launcherPolicyVersion: "amux-v22-read-only-retry-v1";
  launcherConfigDigest: string;
  fixedArgvDigest: string;
  toolPolicyDigest: string;
  profileConfigDigest: string;
  briefDigest: string;
  provider: string;
  modelId: string;
  routeId: string;
  routePolicyDigest: string;
  catalogApprovalId: string;
  catalogVersion: string;
  pricingVersion: string;
  costReceiptDigest: string;
  additionalCapMicroUsd: string;
  worstExposureMicroUsd: string;
  role: "investigate";
};

export type AmuxV22ReadOnlyApiRetryBinding = {
  version: 1;
  executorKind: "read_only_api_retry_v1";
  launchBindingId: string;
  riskAcceptanceDigest: string;
  safeStopEvidenceDigest: string;
  launchProofDigest: string;
  launchScopeDigest: string;
  launcherConfigDigest: string;
  apiExecutionFrame: import("./v22ReadOnlyApiProtocol.mjs").AmuxV22ReadOnlyApiExecutionFrame;
  apiExecutionFrameDigest: string;
  briefDigest: string;
  provider: "anthropic";
  modelId: string;
  routeId: string;
  routePolicyDigest: string;
  catalogApprovalId: string;
  catalogVersion: string;
  pricingVersion: string;
  costReceiptDigest: string;
  additionalCapMicroUsd: string;
  worstExposureMicroUsd: string;
  role: "investigate";
};

export type AmuxV22ReadOnlyRetryBinding =
  | AmuxV22CliReadOnlyRetryBinding
  | AmuxV22ReadOnlyApiRetryBinding;

export type AmuxV22ReadOnlyLaunchScope = {
  version: 1;
  launcherPolicyVersion: "amux-v22-read-only-retry-v1";
  launcherConfigDigest: string;
  fixedArgvDigest: string;
  toolPolicyDigest: string;
  profileConfigDigest: string;
  role: "investigate";
  allowedTools: ["Glob", "Grep", "Read"];
};

export type AmuxV22SidecarLaunchConfig = {
  worker: string;
  binaryPath: string;
  worktreePath: string;
  homePath: string;
  claudeConfigDir: string;
};

export declare function amuxV22SidecarLaunchConfigFromEnvironment(
  environment: Record<string, string | undefined>,
): Readonly<AmuxV22SidecarLaunchConfig>;
export declare function amuxV22ReadOnlyActualLauncherConfigDigest(input:
  AmuxV22SidecarLaunchConfig & {
    profileConfigDigest: string;
    nodeArtifactDigest: string;
    sidecarArtifactDigest: string;
    cliArtifactDigest: string;
    localCustomizationDigest: string;
    worktreeIdentityDigest: string;
    homeIdentityDigest: string;
    claudeConfigIdentityDigest: string;
  }): string;
export declare function inspectAmuxV22ReadOnlyLocalCustomizations(
  config: AmuxV22SidecarLaunchConfig,
  options?: Record<string, unknown>,
): Promise<{ current: false } | {
  current: true;
  localCustomizationDigest: string;
}>;
export declare function inspectAmuxV22ReadOnlyLauncherConfig(
  config: AmuxV22SidecarLaunchConfig,
  profileConfigDigest: string,
  options?: Record<string, unknown>,
): Promise<{ current: false } | { current: true; launcherConfigDigest: string }>;

export declare function amuxV22ReadOnlyLauncherDigests(
  profileConfigDigest: string,
  actualLauncherConfigDigest?: string,
): {
  launcherConfigDigest: string;
  fixedArgvDigest: string;
  toolPolicyDigest: string;
};
export declare function amuxV22ReadOnlyLaunchScope(input: {
  profileConfigDigest: string;
  launcherConfigDigest?: string;
}): AmuxV22ReadOnlyLaunchScope;
export declare function amuxV22ReadOnlyLaunchScopeDigest(
  scope: AmuxV22ReadOnlyLaunchScope,
): string;
export declare function validateAmuxV22ReadOnlyRetryBinding(input: unknown):
  { ok: true } | { ok: false; reason: string };
export declare function amuxV22ReadOnlyClaudeArgs(request: {
  role: string;
  modelId: string;
  budgetMicrousd: number;
  readOnlyRetry: AmuxV22ReadOnlyRetryBinding;
}): string[];
export declare const AMUX_V22_READ_ONLY_EXEC_START: readonly [
  "/usr/bin/node", "/opt/tomverse-amux-v22/task-sidecar.mjs",
];
