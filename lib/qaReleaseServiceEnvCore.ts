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
 * Names the platform and the Node runtime set on their own. Provisional until
 * operational check O-10 records the exact list from a live Railway service;
 * kept narrow on purpose -- a missing entry stops the service, an extra one
 * could let a credential through.
 */
export const QA_RELEASE_RUNTIME_VARIABLES: readonly string[] = Object.freeze([
  "HOME",
  "HOSTNAME",
  "LANG",
  "NODE_ENV",
  "NODE_VERSION",
  "PATH",
  "PWD",
  "SHLVL",
  "TZ",
  "YARN_VERSION",
  "_",
]);

/** Railway's own variables. Every one is named, none is a credential to this repository. */
export const QA_RELEASE_RUNTIME_PREFIX = "RAILWAY_";

export type QaReleaseEnvCheck = { ok: true } | { ok: false; unexpectedCount: number };

/**
 * Whether the service may start. The result carries how many names were
 * unexpected, never which: a name can itself reveal what was leaked.
 */
export function checkQaReleaseServiceEnv(service: QaReleaseService, names: readonly string[]): QaReleaseEnvCheck {
  const own = new Set<string>(QA_RELEASE_SERVICE_VARIABLES[service]);
  const runtime = new Set(QA_RELEASE_RUNTIME_VARIABLES);
  const unexpected = names.filter(
    (name) => !own.has(name) && !runtime.has(name) && !name.startsWith(QA_RELEASE_RUNTIME_PREFIX),
  );
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
    if (value("QA_RELEASE_MERGE_LANE_KILL_SWITCH") !== "") return "disabled";
    if (value("QA_RELEASE_MERGE_LANE_ENABLED") !== "true") return "disabled";
  }
  if (REQUIRED[service].some((name) => value(name) === "")) return "refuse";
  if (!/^[1-9][0-9]{0,8}$/.test(value("QA_RELEASE_CONTROL_REVISION"))) return "refuse";
  return "run";
}
