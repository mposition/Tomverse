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
