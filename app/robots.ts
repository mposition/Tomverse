import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/seo";
import {
  CANONICAL_PRIVATE_DISALLOW,
  CONTENT_SIGNAL,
  REFUSED_AI_CRAWLERS,
  SEARCH_INDEX_CRAWLERS,
  USER_REQUEST_FETCHERS,
  robotsDecision,
} from "@/lib/robotsPolicyCore";

export default function robots(): MetadataRoute.Robots {
  // Every deployment runs this file. Only the canonical site may invite
  // crawlers; the reasoning, and why an unset origin reads as production, is
  // in lib/robotsPolicyCore.ts.
  if (robotsDecision(SITE_ORIGIN, process.env).kind !== "canonical") {
    // No sitemap and no `host` either. Both would point a crawler at the
    // production site from a deployment that just told it to go away, and the
    // `host` directive on a non-canonical origin is exactly how staging ended
    // up claiming production's canonical host.
    //
    // One group and nothing else, deliberately. A second group here -- an AI
    // crawler carve-out, a content signal -- can only weaken this one, because
    // RFC 9309 merges groups by product token and an equally specific conflict
    // resolves towards `Allow`. Refusing everyone takes exactly one rule.
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  // The access every invited crawler gets. A group that names a crawler
  // replaces the `*` group for it outright (RFC 9309 §2.2.1), so every named
  // group has to carry the private exclusions and the Content-Signal line
  // itself -- without them the named crawler would gain /admin and lose the
  // declaration the moment its name appeared in the file.
  const invitedGroup = (userAgent: readonly string[]) => ({
    userAgent: [...userAgent],
    // Emitted as a verbatim `Content-Signal:` line inside this group.
    other: { "Content-Signal": CONTENT_SIGNAL },
    allow: "/",
    disallow: [...CANONICAL_PRIVATE_DISALLOW],
  });

  return {
    rules: [
      invitedGroup(["*"]),
      // Search indexers and user-triggered fetchers get exactly the `*`
      // access, said to them by name (lib/robotsPolicyCore.ts has the who and
      // why). Googlebot and Bingbot stay on `*` deliberately.
      invitedGroup(SEARCH_INDEX_CRAWLERS),
      invitedGroup(USER_REQUEST_FETCHERS),
      // One group per crawler rather than one group naming all of them: a
      // group that listed several would still be a single rule set, and these
      // need to differ from the `*` rules above, not extend them.
      ...REFUSED_AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        disallow: "/",
      })),
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
