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

/**
 * ## Who owns the AI crawler list now
 *
 * Until 2026-08-25 this list did not live here. Cloudflare's managed
 * `robots.txt` setting (zone `tomverse.app`) prepended its own block to
 * whatever the origin served, and that block carried both these `Disallow`
 * groups and the `Content-Signal` line below.
 *
 * That setting had to go, because the same block also prepended
 *
 *     User-agent: *
 *     Allow: /
 *
 * to *every* hostname in the zone -- staging included. RFC 9309 merges groups
 * that share a product token, and Google resolves an equally specific
 * `Allow`/`Disallow` conflict in favour of `Allow`, so staging's own
 * `Disallow: /` was being read as "crawl everything". Turning the setting off
 * fixes staging and costs production the block, so the block moves here.
 *
 * **This list is now a snapshot, and nothing updates it for us.** Cloudflare
 * maintained it; we do not. It is what their managed block served on
 * 2026-08-25, verbatim and in their order. When a new crawler matters, it gets
 * added here by hand -- their published list
 * (https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/)
 * is still the reasonable thing to diff against.
 *
 * Worth being honest about what this buys: `robots.txt` is a request, not a
 * boundary. Cloudflare say so about their own feature, and it is equally true
 * of ours -- an operator that ignores the file is unaffected by anything in
 * this module. Enforcement, if it is ever wanted, is a separate control
 * (Cloudflare AI Crawl Control), and turning the managed `robots.txt` setting
 * off does not turn that off.
 */
export const REFUSED_AI_CRAWLERS = [
  "Amazonbot",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "ClaudeBot",
  "CloudflareBrowserRenderingCrawler",
  "Google-Extended",
  "GPTBot",
  "meta-externalagent",
] as const;

/**
 * The content signals the canonical site declares (https://contentsignals.org/).
 *
 * Same provenance as the list above: this is the value Cloudflare's managed
 * block carried, kept so that turning their setting off does not silently drop
 * a declaration that was already being made. `search=yes` is why the site
 * exists; `ai-train=no` and `use=reference` say the content may be indexed and
 * linked, not used as training data.
 *
 * Only the canonical site says this. A deployment that refuses every crawler
 * has nothing to express a preference about.
 */
export const CONTENT_SIGNAL = "search=yes, ai-train=no, use=reference";
