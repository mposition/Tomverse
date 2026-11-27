import { codeManagedEnabled } from "./codeManagedCore";

/** The runner service authenticates with this shared secret; its value is set on the server and the runner only. */
export const CODE_CLOUD_RUNNER_SECRET_ENV = "CODE_CLOUD_RUNNER_SECRET";
const MIN_SECRET_LENGTH = 32;

export function codeCloudRunnerSecret(env: Record<string, string | undefined> = process.env): string | null {
  const value = env[CODE_CLOUD_RUNNER_SECRET_ENV]?.trim();
  return value && value.length >= MIN_SECRET_LENGTH ? value : null;
}

/**
 * Desktop cloud execution (docs/ops/desktop-cloud-execution.md). Off unless every switch below is exactly `true` and a
 * runner secret is configured. Desktop reaches the job routes with the account settings session, so it also needs the
 * Desktop sign-in and account settings switches; model calls ride the managed Code reservation, so it needs that path.
 * It enrols no bearer route and adds no price: compute time is not charged while there is no compute price.
 */
export function desktopCloudExecutionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
    env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED === "true" &&
    env.TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED === "true" &&
    codeManagedEnabled(env) &&
    codeCloudRunnerSecret(env) !== null;
}
