import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
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
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
