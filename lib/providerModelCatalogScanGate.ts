import { resolveDeploymentEnvironment } from "./deploymentEnvironment.ts";

/**
 * Whether this deployment runs the daily provider catalogue scan.
 *
 * Production only (owner decision, 2026-11-11): dev and staging take
 * production's catalogue, discovery queue included, from the weekly copy
 * (lib/modelCatalogEnvSync.ts), so a scan of their own only files a second
 * queue and sends a second and third copy of the daily report. Gated here and
 * not only in the cron's start command, because the IaC declares the same
 * command in every environment and an apply puts it back.
 *
 * A manual `?test=true` run still goes through anywhere: it is how the report
 * is checked before a release.
 */
export const providerModelCatalogScanRuns = (
  input: { test: boolean },
  env: NodeJS.ProcessEnv = process.env
) => input.test || resolveDeploymentEnvironment(env) === "production";
