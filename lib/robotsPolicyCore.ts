/**
 * Which robots rules a deployment is allowed to serve.
 *
 * `app/robots.ts` used to emit the same body everywhere: `allow: "/"`, the
 * production sitemap and `host: https://tomverse.app`. Every deployment runs
 * that file, so staging invited crawlers in and pointed them at production's
 * canonical host while doing it. It worked -- the 2026-08-23 Search Console
 * export carried `https://staging.tomverse.app/safety`, indexed.
 *
 * That matters beyond duplicate content. Staging is where a change is deployed
 * *before* it is decided: `/review`, the Auto surfaces and anything else behind
 * a flag land there first, and a crawler reading them makes an unreleased
 * surface public without anyone choosing to release it.
 *
 * So the rules are chosen from the deployment's own public origin rather than
 * from a constant.
 *
 * ## Why an unset origin reads as production
 *
 * The two failures are not symmetric. A staging deployment that stays
 * crawlable is the state this fixes -- bad, and slow to undo, but bounded. A
 * production deployment that serves `disallow: /` because one variable went
 * missing de-indexes the whole site, and recovery is a recrawl on Google's
 * schedule, not ours.
 *
 * `PUBLIC_APP_URL` is set on every deployed environment, so the unset case is
 * a local process or a misconfiguration -- and for a robots file, guessing
 * "production" there costs less than guessing "hide everything".
 */

/** Trailing slashes and case do not change which host this is. */
const normalize = (value: string | undefined | null) => {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The origin this deployment believes it serves, in the precedence the rest of
 * the app already uses (`lib/accountEmails.ts`, `lib/billingEmails.ts`).
 */
export const deploymentOrigin = (
  environment: Record<string, string | undefined>
): string | null =>
  normalize(environment.PUBLIC_APP_URL) ??
  normalize(environment.NEXT_PUBLIC_APP_URL);

/**
 * True when this deployment is the canonical public site.
 *
 * An origin that cannot be parsed is the same as one that is not set: nothing
 * was established, so the fallback above applies.
 */
export const servesCanonicalSite = (
  siteOrigin: string,
  environment: Record<string, string | undefined>
): boolean => {
  const origin = deploymentOrigin(environment);
  if (origin === null) return true;
  return origin === normalize(siteOrigin);
};

export type RobotsDecision =
  | { kind: "canonical" }
  /** Everything, for everyone. A non-canonical deployment advertises nothing. */
  | { kind: "disallow_all"; origin: string };

export const robotsDecision = (
  siteOrigin: string,
  environment: Record<string, string | undefined>
): RobotsDecision =>
  servesCanonicalSite(siteOrigin, environment)
    ? { kind: "canonical" }
    : { kind: "disallow_all", origin: deploymentOrigin(environment) as string };
