/**
 * What a `robots.txt` body actually means, as a crawler would read it.
 *
 * This exists because the obvious test -- assert the response contains
 * `Disallow: /` -- passed on staging while staging was, in fact, crawlable.
 * Cloudflare's managed `robots.txt` setting was prepending its own
 * `User-agent: * / Allow: /` group to the origin's body, and by the rules
 * below those two groups merge and the conflict resolves towards `Allow`. Both
 * strings were present; the file said the opposite of what the string
 * suggested.
 *
 * So the check has to be semantic. This module answers one question -- may
 * this crawler fetch this path, given this exact body -- and the tests and
 * scripts/check-edge-robots.mjs both ask it of what the *edge* serves, not of
 * what the application returns.
 *
 * The rules implemented here:
 *
 * - RFC 9309 §2.2.1: a group is one or more `user-agent` lines followed by
 *   rules, and groups matching the same product token are merged into one.
 * - RFC 9309 §2.2.1: the `*` group applies only when no group names the
 *   crawler. A named group wins outright; it does not add to `*`.
 * - Google's precedence: the most specific rule wins, measured by the length
 *   of the path pattern, and an equally specific `Allow` beats `Disallow`.
 * - Anything not matched by a rule is allowed.
 *
 * `*` matches any run of characters and `$` anchors the end of the path, as
 * both Google and RFC 9309 §2.2.3 describe.
 */

export type RobotsRule = {
  kind: "allow" | "disallow";
  /** The path pattern as written, `*` and `$` included. */
  path: string;
};

export type RobotsGroup = {
  /** Lower-cased product tokens this group is addressed to. */
  userAgents: string[];
  rules: RobotsRule[];
};

const stripComment = (line: string) => {
  const hash = line.indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
};

export const parseRobotsTxt = (body: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // A `user-agent` line extends the current group's header while the group has
  // no rules yet, and starts a new group once it has any. That is what makes
  // consecutive `user-agent` lines one group and a later one a new group.
  let headerOpen = false;

  for (const rawLine of body.split(/\r?\n/)) {
  const line = stripComment(rawLine);
  if (!line) continue;

  const separator = line.indexOf(":");
  if (separator === -1) continue;
  const field = line.slice(0, separator).trim().toLowerCase();
  const value = line.slice(separator + 1).trim();

  if (field === "user-agent") {
    if (!current || !headerOpen) {
    current = { userAgents: [], rules: [] };
    groups.push(current);
    headerOpen = true;
    }
    current.userAgents.push(value.toLowerCase());
    continue;
  }

  if (field !== "allow" && field !== "disallow") {
    // `sitemap`, `host`, `content-signal`, `crawl-delay` and anything else.
    // None of them decide access, and none of them close a header.
    continue;
  }

  if (!current) continue;
  headerOpen = false;
  // An empty `Disallow:` is the documented way to say "nothing is
  // forbidden". Dropping it is correct: a rule that matches no path cannot
  // win the specificity comparison either.
  if (value === "") continue;
  current.rules.push({ kind: field, path: value });
  }

  return groups;
};

/**
 * The rules that bind one crawler: every group naming it, merged. Falls back
 * to the `*` groups only when nothing names it.
 */
export const rulesForUserAgent = (
  groups: readonly RobotsGroup[],
  userAgent: string
): RobotsRule[] => {
  const token = userAgent.toLowerCase();
  const named = groups.filter((group) => group.userAgents.includes(token));
  const applicable = named.length
  ? named
  : groups.filter((group) => group.userAgents.includes("*"));
  return applicable.flatMap((group) => group.rules);
};

const matchesPath = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body
  .split("*")
  .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join(".*");
  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(path);
};

/** The length that decides specificity: the pattern without its `$` anchor. */
const specificity = (rule: RobotsRule) =>
  rule.path.endsWith("$") ? rule.path.length - 1 : rule.path.length;

export const isPathAllowed = (
  body: string,
  userAgent: string,
  path: string
): boolean => {
  const matching = rulesForUserAgent(parseRobotsTxt(body), userAgent).filter(
  (rule) => matchesPath(rule.path, path)
  );
  if (matching.length === 0) return true;

  const longest = Math.max(...matching.map(specificity));
  const decisive = matching.filter((rule) => specificity(rule) === longest);
  // The tie-break that made the staging bug invisible: same length, so the
  // least restrictive rule wins, so one `Allow: /` anywhere in the file
  // overrides every `Disallow: /` in it.
  return decisive.some((rule) => rule.kind === "allow");
};

/**
 * The part of a served `robots.txt` the application actually produced.
 *
 * Cloudflare's managed block is prepended and closed by a marker line, so
 * while the zone setting is on, a served file is two authors' work spliced
 * together. Both halves matter, and they answer different questions:
 *
 * - the whole file says what a crawler will *do*;
 * - this half says whether our own policy is carrying its weight.
 *
 * Keeping them apart is not pedantry. On 2026-08-25 the production check
 * passed while `app/robots.ts` named no AI crawler at all -- Cloudflare's half
 * was refusing them, and the merged file looked exactly as it should. A check
 * that cannot tell the two apart cannot tell you it is safe to turn the
 * managed block off, which is the one question it is being asked.
 *
 * Returns the whole body when no managed block is present, which is the state
 * this is all working towards.
 */
const MANAGED_BLOCK_END = "# END Cloudflare Managed Content";

export const carriesManagedBlock = (body: string) => body.includes(MANAGED_BLOCK_END);

export const applicationServedBody = (body: string): string => {
  const marker = body.indexOf(MANAGED_BLOCK_END);
  if (marker === -1) return body;
  return body.slice(marker + MANAGED_BLOCK_END.length);
};
