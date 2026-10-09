import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";

/** This is QA eligibility, never a product rollout or provider permission. */
export function chatE04StagingFixtureEligible(input: {
  environment: NodeJS.ProcessEnv;
  authenticated: boolean;
  administrator: boolean;
}) {
  return resolveDeploymentEnvironment(input.environment) === "staging"
    && input.authenticated === true && input.administrator === true;
}

export const CHAT_E04_AUTO_ACTIONS = [
  "default_off", "accepted", "kept_original", "stale", "replay", "unknown",
] as const;
export type ChatE04AutoAction = typeof CHAT_E04_AUTO_ACTIONS[number];

export function parseChatE04AutoAction(value: unknown): ChatE04AutoAction | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.action === "string"
    && (CHAT_E04_AUTO_ACTIONS as readonly string[]).includes(record.action)
    ? record.action as ChatE04AutoAction : null;
}
