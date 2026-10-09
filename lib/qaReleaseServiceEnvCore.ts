/**
 * The environment-name check each QA-release service runs before it does
 * anything.
 *
 * docs/policy/qa-release-agent.md, section 3: the three services share no
 * variables, and none holds product-database or GitHub-write credentials
 * except as listed. A service whose environment carries any name outside its
 * own list and the runtime's list exits without doing work -- the check fails
 * closed, so a runtime list that is too short only stops the service, it
 * never lets a credential through.
 *
 * Pure: the caller passes the environment's names, never its values.
 */

export const QA_RELEASE_SERVICE_VARIABLES = Object.freeze({
  digest: Object.freeze([
    "QA_RELEASE_DIGEST_ENABLED",
    "QA_RELEASE_DIGEST_SECRET",
    "QA_RELEASE_GITHUB_READ_TOKEN",
    "QA_RELEASE_CONTROL_REVISION",
  ]),
  monitor: Object.freeze(["QA_RELEASE_MONITOR_SECRET", "QA_RELEASE_CONTROL_REVISION"]),
  mergeLane: Object.freeze([
    "QA_RELEASE_MERGE_LANE_SECRET",
    "QA_RELEASE_MERGE_LANE_APP_ID",
    "QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY",
    "QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN",
    "QA_RELEASE_MERGE_LANE_ENABLED",
    "QA_RELEASE_MERGE_LANE_KILL_SWITCH",
    "QA_RELEASE_CONTROL_REVISION",
  ]),
} as const);

export type QaReleaseService = keyof typeof QA_RELEASE_SERVICE_VARIABLES;

/**
 * Names the Railpack-built Agents image puts in every process environment, by
 * exact name. Measured in a live Railway container on 2026-10-09 (names only)
 * and matching the 2026-10-03 measurement that
 * tests/productResearchObservationRunnerCore.test.mjs records; the two __MISE_
 * names are only in that earlier one, set by the mise shim a `node` start goes
 * through. Without these every service built from this repository refused to
 * start on Railway: the builder, the mise toolchain and npm's configuration
 * each add names no list written from a developer machine contains. A builder
 * change that adds another name stops the services again; the fix is to
 * measure again, not to admit a prefix.
 */
export const QA_RELEASE_IMAGE_VARIABLES: readonly string[] = Object.freeze([
  "CI",
  "NEXT_TELEMETRY_DISABLED",
  "NPM_CONFIG_FETCH_RETRIES",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_PRODUCTION",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "RAILPACK_BUILT_AT",
  "RAILPACK_VERSION",
  "MISE_CACHE_DIR",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_INSTALLS_DIR",
  "MISE_SHIMS_DIR",
  "__MISE_DIFF",
  "__MISE_SHIM",
]);

/**
 * Names the platform and the Node runtime set on their own, the image's
 * included. The first group is provisional until operational check O-10
 * records the exact list from a live Railway service; kept narrow on purpose
 * -- a missing entry stops the service, an extra one could let a credential
 * through.
 */
export const QA_RELEASE_RUNTIME_VARIABLES: readonly string[] = Object.freeze([
  "HOME",
  "HOSTNAME",
  "LANG",
  "NODE_ENV",
  "NODE_VERSION",
  "PATH",
  "PORT",
  "PWD",
  "SHLVL",
  "TZ",
  "YARN_VERSION",
  "_",
  ...QA_RELEASE_IMAGE_VARIABLES,
]);

/**
 * Railway's own variables, by exact name -- never by the "RAILWAY_" prefix,
 * which would also admit a credential someone named RAILWAY_TOKEN or
 * RAILWAY_DATABASE_URL. Taken from Railway's variables reference (identity,
 * networking, volume and git-source variables); provisional until O-10
 * records a live service, like the list above. RAILWAY_BETA_ENABLE_RUNTIME_V2
 * is measured: Railway sets it on services that run on its V2 runtime, and the
 * Support Triage service named it when it refused to start on 2026-10-09.
 */
export const QA_RELEASE_RAILWAY_VARIABLES: readonly string[] = Object.freeze([
  "RAILWAY_BETA_ENABLE_RUNTIME_V2",
  "RAILWAY_DEPLOYMENT_ID",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_GIT_AUTHOR",
  "RAILWAY_GIT_BRANCH",
  "RAILWAY_GIT_COMMIT_MESSAGE",
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_GIT_REPO_NAME",
  "RAILWAY_GIT_REPO_OWNER",
  "RAILWAY_PRIVATE_DOMAIN",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_PROJECT_NAME",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_REPLICA_ID",
  "RAILWAY_REPLICA_REGION",
  "RAILWAY_SERVICE_ID",
  "RAILWAY_SERVICE_NAME",
  "RAILWAY_SNAPSHOT_ID",
  "RAILWAY_STATIC_URL",
  "RAILWAY_TCP_APPLICATION_PORT",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
  "RAILWAY_VOLUME_MOUNT_PATH",
  "RAILWAY_VOLUME_NAME",
]);

export type QaReleaseEnvCheck = { ok: true } | { ok: false; unexpectedCount: number };

/**
 * Whether the service may start. The result carries how many names were
 * unexpected, never which: a name can itself reveal what was leaked.
 */
export function checkQaReleaseServiceEnv(service: QaReleaseService, names: readonly string[]): QaReleaseEnvCheck {
  const own = new Set<string>(QA_RELEASE_SERVICE_VARIABLES[service]);
  const runtime = new Set([...QA_RELEASE_RUNTIME_VARIABLES, ...QA_RELEASE_RAILWAY_VARIABLES]);
  const unexpected = names.filter((name) => !own.has(name) && !runtime.has(name));
  return unexpected.length === 0 ? { ok: true } : { ok: false, unexpectedCount: unexpected.length };
}

/** Variables that must be present for the service to do anything at all. */
const REQUIRED: Record<QaReleaseService, readonly string[]> = {
  digest: ["QA_RELEASE_DIGEST_SECRET", "QA_RELEASE_GITHUB_READ_TOKEN", "QA_RELEASE_CONTROL_REVISION"],
  monitor: ["QA_RELEASE_MONITOR_SECRET", "QA_RELEASE_CONTROL_REVISION"],
  mergeLane: [
    "QA_RELEASE_MERGE_LANE_SECRET",
    "QA_RELEASE_MERGE_LANE_APP_ID",
    "QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY",
    "QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN",
    "QA_RELEASE_CONTROL_REVISION",
  ],
};

export type QaReleaseStartDecision =
  /** Exit 0 without work: the service is switched off. */
  | "disabled"
  /** Exit 1 without work: a name outside the lists, or a required one missing. */
  | "refuse"
  | "run";

/**
 * The start decision from the names present and the enable flag's value.
 * The merge lane also stops on any value in its kill switch (policy section 8
 * item 6). The Monitor has no enable flag of its own: it is off when its
 * cron is not declared.
 */
export function decideQaReleaseServiceStart(
  service: QaReleaseService,
  env: Readonly<Record<string, string | undefined>>,
): QaReleaseStartDecision {
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  if (!checkQaReleaseServiceEnv(service, names).ok) return "refuse";

  const value = (name: string) => (env[name] ?? "").trim();
  if (service === "digest" && value("QA_RELEASE_DIGEST_ENABLED") !== "true") return "disabled";
  if (service === "mergeLane") {
    // Policy section 8 item 6: the lane runs only while the kill switch is
    // empty, stops on any value, and stops when the switch cannot be read.
    // An undeclared variable is the unreadable case -- a deployment that lost
    // its kill switch must not run as if nobody had pulled it -- so the
    // operator declares it empty to run and fills it to stop.
    const killSwitch = env.QA_RELEASE_MERGE_LANE_KILL_SWITCH;
    // Any character stops it, whitespace included: only a declared, empty value runs.
    if (killSwitch !== "") return "disabled";
    if (value("QA_RELEASE_MERGE_LANE_ENABLED") !== "true") return "disabled";
  }
  if (REQUIRED[service].some((name) => value(name) === "")) return "refuse";
  if (!/^[1-9][0-9]{0,8}$/.test(value("QA_RELEASE_CONTROL_REVISION"))) return "refuse";
  return "run";
}
