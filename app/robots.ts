import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/seo";
import {
  CONTENT_SIGNAL,
  REFUSED_AI_CRAWLERS,
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

  return {
    rules: [
      {
        userAgent: "*",
        // Emitted as a verbatim `Content-Signal:` line inside this group.
        other: { "Content-Signal": CONTENT_SIGNAL },
        allow: "/",
        disallow: [
          "/admin",
          "/api",
          "/auth",
          // The Playwright fixture mount. It is a 404 on any real deployment
          // (lib/e2eTestMode.ts), so this is belt-and-braces rather than the
          // control -- but it also keeps the path out of any crawler's history.
          "/e2e",
          "/chat$",
          "/chat/",
          "/share",
        ],
      },
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
