// Which deployment this process is, as distinct from how it was built.
//
// NODE_ENV answers "was this a production build?". Staging answers yes -- it
// runs `next build` and `next start` exactly as production does, which is the
// point of having it. So every rule written as `NODE_ENV === "production"`
// silently reads "this is the production deployment", and staging inherits
// rules it cannot satisfy. lib/securityEnvironment.ts required a live-mode
// Stripe key that way, so staging's /api/ready returned 503 permanently:
//
//   {"ok":false,"checks":{"database":true,"securityEnvironment":false,...}}
//   Failed checks: stripeLiveMode          (staging, 2026-08-12)
//
// A staging environment must use a test key. The check was not merely
// unsatisfiable there, it was asking for the wrong thing.
//
// Pure and dependency-free on purpose: lib/buildInfo.ts is server-only and
// reads the filesystem, and this has to be usable from anywhere that needs to
// know which deployment it is.

export const DEPLOYMENT_ENVIRONMENTS = [
  "development",
  "staging",
  "production",
  "test",
] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export function validateEnvironment(
  value: unknown
): DeploymentEnvironment | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(normalized)
    ? (normalized as DeploymentEnvironment)
    : null;
}

/**
 * APP_ENV, then Railway's own environment name, then the build mode.
 *
 * The last step is what keeps this fail-closed: an unlabelled production build
 * resolves to `production` and therefore keeps production's rules. A
 * deployment only gets staging's weaker requirements by *saying* it is
 * staging, never by omission.
 */
export const resolveDeploymentEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): DeploymentEnvironment =>
  validateEnvironment(env.APP_ENV) ??
  validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME) ??
  (env.NODE_ENV === "production" ? "production" : "development");

/**
 * The environment name Sentry tags events with.
 *
 * `SENTRY_ENVIRONMENT` exists so an operator can label a deployment's events
 * for Sentry's own grouping without changing what the deployment is. What it
 * must never do is *contradict* the deployment, and on 2026-08-12 that is
 * exactly what it did: staging carried `SENTRY_ENVIRONMENT=production` -- the
 * value the README's own example shows -- so every staging error arrived filed
 * under production while the same process's /api/build-info answered
 * "staging". Filtering Sentry by production returned staging noise, which is
 * the one thing an environment tag is for.
 *
 * So the override is allowed to *name* something the resolver has no opinion
 * about (`production-eu`, `canary`), and refused when it names one of the four
 * canonical environments and picks a different one than this deployment is.
 * That kills the observed failure without killing the feature.
 *
 * The refusal is loud. A silently ignored variable is its own confusion, and
 * whoever set it needs to know it is doing nothing.
 */
let warnedAboutSentryEnvironment = false;

export const resolveSentryEnvironmentTag = (
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message)
): string => {
  const deployment = resolveDeploymentEnvironment(env);
  const override = env.SENTRY_ENVIRONMENT?.trim();
  if (!override) return deployment;

  const named = validateEnvironment(override);
  if (named && named !== deployment) {
    if (!warnedAboutSentryEnvironment) {
      warnedAboutSentryEnvironment = true;
      warn(
        JSON.stringify({
          event: "sentry_environment_override_ignored",
          override: named,
          deployment,
          reason:
            "SENTRY_ENVIRONMENT names a different canonical environment than this deployment resolves to. Remove it, or set it to a label that is not one of: " +
            DEPLOYMENT_ENVIRONMENTS.join(", "),
        })
      );
    }
    return deployment;
  }
  return override;
};

/** Test seam: the warning is once per process, which a test has to reset. */
export const resetSentryEnvironmentWarningForTests = () => {
  warnedAboutSentryEnvironment = false;
};
