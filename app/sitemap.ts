import type { MetadataRoute } from "next";
import {
  SEO_LOCALES,
  LOCALIZED_SEO_PATHS,
  SITE_ORIGIN,
  localizedLanguageAlternates,
  localizedPath,
} from "@/lib/seo";
import { SITEMAP_CONTENT_EVIDENCE } from "@/lib/sitemapContentDates";

/**
 * `lastModified` only where a page's content date is evidenced, and absent
 * everywhere else (AEO-04). See lib/sitemapContentDates.ts for what counts.
 */
const lastModifiedFor = (path: string) => {
  const date = SITEMAP_CONTENT_EVIDENCE[path]?.date;
  return date ? { lastModified: new Date(`${date}T00:00:00.000Z`) } : {};
};
const publicPages: Array<{
  path: string;
  changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  priority: number;
}> = [
  { path: "/about", changeFrequency: "monthly", priority: 0.7 },
  { path: "/models", changeFrequency: "weekly", priority: 0.8 },
  { path: "/pricing", changeFrequency: "weekly", priority: 0.8 },
  { path: "/faq", changeFrequency: "monthly", priority: 0.6 },
  { path: "/support", changeFrequency: "monthly", priority: 0.5 },
  { path: "/support/help-centre", changeFrequency: "monthly", priority: 0.5 },
  { path: "/support/help-centre/chat-workspace", changeFrequency: "monthly", priority: 0.6 },
  { path: "/safety", changeFrequency: "monthly", priority: 0.6 },
  { path: "/safety/approach", changeFrequency: "monthly", priority: 0.5 },
  { path: "/safety/security-privacy", changeFrequency: "monthly", priority: 0.5 },
  { path: "/safety/trust-transparency", changeFrequency: "monthly", priority: 0.5 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.4 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.4 },
  { path: "/refund", changeFrequency: "yearly", priority: 0.4 },
  { path: "/status", changeFrequency: "daily", priority: 0.5 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const localizedEntries = LOCALIZED_SEO_PATHS.flatMap((basePath) => {
    const alternates = { languages: localizedLanguageAlternates(basePath) };
    const priority = basePath === "/" ? 1 : 0.85;
    return [
      {
        url: `${SITE_ORIGIN}${basePath}`,
        ...lastModifiedFor(basePath),
        changeFrequency: "weekly" as const,
        priority,
        alternates,
      },
      ...SEO_LOCALES.map((locale) => ({
        url: `${SITE_ORIGIN}${localizedPath(locale, basePath)}`,
        ...lastModifiedFor(basePath),
        changeFrequency: "weekly" as const,
        priority,
        alternates,
      })),
    ];
  });

  return [
    ...localizedEntries,
    ...publicPages.map((page) => ({
      url: `${SITE_ORIGIN}${page.path}`,
      ...lastModifiedFor(page.path),
      changeFrequency: page.changeFrequency,
      priority: page.priority,
    })),
  ];
}
