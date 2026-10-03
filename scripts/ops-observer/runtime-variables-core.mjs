// Which environment variable names an ops-observer service may start with.
//
// docs/policy/sre-ops.md §3 rule 5 and §7 are the contract. The service entry
// point runs two independent checks over every name in its environment and
// refuses to start a child if either fails:
//
// (a) an allowlist: every name is one of the service's own variables, a fixed
//     base-image/Node name, or a fixed non-secret Railway name. An unknown name
//     is refused, so a new credential cannot pass by choosing a new shape.
// (b) a shape rule over every name except the service's own variables, which
//     catches a credential that was wrongly added to (a).
//
// Both checks read only the names. Values are never read, so a refusal can be
// reported by name without carrying a secret. Pure: the caller passes the
// environment's keys.

export const SERVICES = ["page", "digest"];

/** Each service's own variables (policy §7). */
export const SERVICE_VARIABLES = Object.freeze({
  page: Object.freeze([
    "OPS_OBSERVER_SECRET",
    "OPS_OBSERVER_HEARTBEAT_URL",
    "OPS_OBSERVER_PAGE_WEBHOOK_URL",
    "OPS_OBSERVER_ENABLED",
    "OPS_OBSERVER_APP_URL",
    "RAILWAY_DOCKERFILE_PATH",
  ]),
  digest: Object.freeze([
    "OPS_OBSERVER_DIGEST_SECRET",
    "OPS_OBSERVER_DIGEST_WEBHOOK_URL",
    "OPS_OBSERVER_DIGEST_HEARTBEAT_URL",
    "OPS_OBSERVER_ENABLED",
    "OPS_OBSERVER_APP_URL",
    "RAILWAY_DOCKERFILE_PATH",
  ]),
});

/** The variables a service's child process receives (the rest stay in the supervisor). */
export const CHILD_VARIABLES = Object.freeze({
  page: Object.freeze([
    "OPS_OBSERVER_SECRET",
    "OPS_OBSERVER_PAGE_WEBHOOK_URL",
    "OPS_OBSERVER_HEARTBEAT_URL",
    "OPS_OBSERVER_APP_URL",
  ]),
  digest: Object.freeze([
    "OPS_OBSERVER_DIGEST_SECRET",
    "OPS_OBSERVER_DIGEST_WEBHOOK_URL",
    "OPS_OBSERVER_DIGEST_HEARTBEAT_URL",
    "OPS_OBSERVER_APP_URL",
  ]),
});

/** Base image and Node names (policy §3 rule 5 (a) 2). */
export const RUNTIME_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "HOSTNAME",
  "PWD",
  "SHLVL",
  "TERM",
  "LANG",
  "NODE_VERSION",
  "YARN_VERSION",
  "NODE_ENV",
  "PORT",
]);

/** Non-secret names Railway injects (policy §3 rule 5 (a) 3). */
export const RAILWAY_NAMES = Object.freeze([
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_PROJECT_NAME",
  "RAILWAY_SERVICE_ID",
  "RAILWAY_SERVICE_NAME",
  "RAILWAY_DEPLOYMENT_ID",
  "RAILWAY_REPLICA_ID",
  "RAILWAY_REPLICA_REGION",
  "RAILWAY_SNAPSHOT_ID",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_PRIVATE_DOMAIN",
  "RAILWAY_STATIC_URL",
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_GIT_AUTHOR",
  "RAILWAY_GIT_BRANCH",
  "RAILWAY_GIT_REPO_NAME",
  "RAILWAY_GIT_REPO_OWNER",
  "RAILWAY_GIT_COMMIT_MESSAGE",
]);

/** Substrings that mark a credential, matched case-insensitively (policy §3 rule 5 (b)). */
export const CREDENTIAL_SUBSTRINGS = Object.freeze([
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "API_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
  "CREDENTIAL",
  "DATABASE_URL",
  "DIRECT_URL",
  "DSN",
]);

/** Prefixes that mark a credential (policy §3 rule 5 (b)). */
export const CREDENTIAL_PREFIXES = Object.freeze(["POSTGRES", "PG", "PRISMA_", "GH_", "ADMIN_AUDIT_INTEGRITY_"]);

function otherService(service) {
  return service === "page" ? "digest" : "page";
}

/** The other service's own variables that this one may not hold. */
export function counterpartVariables(service) {
  assertService(service);
  const own = new Set(SERVICE_VARIABLES[service]);
  return SERVICE_VARIABLES[otherService(service)].filter((name) => !own.has(name));
}

/**
 * Judge an environment's names for `service`.
 *
 * Returns `{ ok: true }` or `{ ok: false, notAllowed, credentialShaped }`,
 * each a sorted list of names (never values).
 */
export function judgeEnvironmentNames(service, names) {
  assertService(service);
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
    throw new Error("ops_observer_env_names_invalid");
  }
  const own = new Set(SERVICE_VARIABLES[service]);
  const allowed = new Set([...own, ...RUNTIME_NAMES, ...RAILWAY_NAMES]);
  const counterpart = new Set(counterpartVariables(service));

  const notAllowed = names.filter((name) => !allowed.has(name)).sort();
  const credentialShaped = names
    .filter((name) => !own.has(name))
    .filter((name) => counterpart.has(name) || isCredentialShaped(name))
    .sort();

  return notAllowed.length === 0 && credentialShaped.length === 0
    ? { ok: true }
    : { ok: false, notAllowed, credentialShaped };
}

/** True when a name looks like a credential under the shape rule. */
export function isCredentialShaped(name) {
  const upper = name.toUpperCase();
  return (
    CREDENTIAL_SUBSTRINGS.some((part) => upper.includes(part)) ||
    CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * Names a build environment must not contain: any runtime variable of either
 * service that carries a secret or a destination, and anything
 * credential-shaped. Switches and paths (`OPS_OBSERVER_ENABLED`,
 * `OPS_OBSERVER_APP_URL`, `RAILWAY_DOCKERFILE_PATH`) are not secrets and may
 * be present. Returns the offending names, sorted.
 */
export function buildEnvironmentViolations(names) {
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
    throw new Error("ops_observer_env_names_invalid");
  }
  const notSecret = new Set(["OPS_OBSERVER_ENABLED", "OPS_OBSERVER_APP_URL", "RAILWAY_DOCKERFILE_PATH"]);
  const runtimeSecrets = new Set(
    [...SERVICE_VARIABLES.page, ...SERVICE_VARIABLES.digest].filter((name) => !notSecret.has(name)),
  );
  return names.filter((name) => runtimeSecrets.has(name) || isCredentialShaped(name)).sort();
}

/** The child's environment: only its listed variables that are present. */
export function childEnvironment(service, env) {
  assertService(service);
  const out = {};
  for (const name of CHILD_VARIABLES[service]) {
    if (Object.prototype.hasOwnProperty.call(env, name)) out[name] = env[name];
  }
  return out;
}

function assertService(service) {
  if (!SERVICES.includes(service)) throw new Error("ops_observer_service_unknown");
}
