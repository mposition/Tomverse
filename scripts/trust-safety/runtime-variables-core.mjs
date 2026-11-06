// Which environment variable names the trust-safety observer service may
// start with (docs/policy/trust-safety-compliance-agent.md §4).
//
// §4 is short and absolute: the service holds two variables and that is all --
// the internal route's secret and the route's URL. It is given no product
// database credential, no GitHub token, no model key, and **not** the dead-man
// ping URL, which lives in the main app. Lengthening that list is an amendment
// of the policy, so this file is the list and a test holds the IaC equal to it.
//
// Two independent checks, as the ops-observer precedent does them:
//
//   (a) an allowlist -- every name is one of the two, a base-image or Node
//       name, or a non-secret name Railway injects. An unknown name is
//       refused, so a new credential cannot pass by choosing a new shape.
//   (b) a shape rule over every name except the two, which catches a
//       credential that was wrongly added to (a).
//
// Both read only names. A refusal can therefore be reported by name without
// carrying a value, which is what the supervisor prints.

/** The service's own variables (§4). Two, and the policy says that is all. */
export const SERVICE_VARIABLES = Object.freeze([
  "TRUST_SAFETY_OBSERVER_SECRET",
  "TRUST_SAFETY_OBSERVER_URL",
]);

/**
 * What the child process receives: both of them.
 *
 * The child is the only thing that makes the request, so it needs the URL and
 * the secret; the supervisor keeps nothing else to withhold. The split exists
 * so the shape is the same as the services this one is modelled on, and so a
 * variable added later has an obvious place to be withheld from.
 */
export const CHILD_VARIABLES = SERVICE_VARIABLES;

/** Base image and Node names. */
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

/**
 * Non-secret names Railway injects.
 *
 * `RAILWAY_BETA_ENABLE_RUNTIME_V2` is here because the ops-observer service
 * refused to start on it when that runtime appeared (2026-10-23); a name
 * missing from this list stops the service, which is the safe direction but
 * not a reason to relearn it.
 */
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
  "RAILWAY_BETA_ENABLE_RUNTIME_V2",
]);

/** Substrings that mark a credential, matched case-insensitively. */
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
  // The one §4 names specifically: the ping URL belongs to the app, and a
  // service holding it could reach the monitor directly.
  "PING_URL",
]);

/** Prefixes that mark a credential. */
export const CREDENTIAL_PREFIXES = Object.freeze([
  "POSTGRES",
  "PG",
  "PRISMA_",
  "GH_",
  "ADMIN_AUDIT_INTEGRITY_",
]);

/** True when a name looks like a credential under the shape rule. */
export function isCredentialShaped(name) {
  const upper = name.toUpperCase();
  return (
    CREDENTIAL_SUBSTRINGS.some((part) => upper.includes(part)) ||
    CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * Judge an environment's names.
 *
 * Returns `{ ok: true }` or `{ ok: false, notAllowed, credentialShaped }`,
 * each a sorted list of names -- never values.
 */
export function judgeEnvironmentNames(names) {
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    throw new Error("trust_safety_env_names_invalid");
  }
  const own = new Set(SERVICE_VARIABLES);
  const allowed = new Set([...own, ...RUNTIME_NAMES, ...RAILWAY_NAMES]);

  const notAllowed = names.filter((name) => !allowed.has(name)).sort();
  const credentialShaped = names
    .filter((name) => !own.has(name))
    .filter((name) => isCredentialShaped(name))
    .sort();

  return notAllowed.length === 0 && credentialShaped.length === 0
    ? { ok: true }
    : { ok: false, notAllowed, credentialShaped };
}

/**
 * Names a build environment must not contain: the service's secret, and
 * anything credential-shaped. The route URL is a destination rather than a
 * secret (§4 says so in as many words) and may be present.
 */
export function buildEnvironmentViolations(names) {
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    throw new Error("trust_safety_env_names_invalid");
  }
  const notSecret = new Set(["TRUST_SAFETY_OBSERVER_URL"]);
  const runtimeSecrets = new Set(SERVICE_VARIABLES.filter((name) => !notSecret.has(name)));
  return names.filter((name) => runtimeSecrets.has(name) || isCredentialShaped(name)).sort();
}

/** The child's environment: only its listed variables that are present. */
export function childEnvironment(env) {
  const out = {};
  for (const name of CHILD_VARIABLES) {
    if (Object.prototype.hasOwnProperty.call(env, name)) out[name] = env[name];
  }
  return out;
}
