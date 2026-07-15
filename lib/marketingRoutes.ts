const exactMarketingPaths = new Set([
  "/",
  "/about",
  "/ai-answer-review",
  "/ai-for-file-analysis",
  "/chatgpt-vs-claude",
  "/compare-ai-models",
  "/faq",
  "/models",
  "/pricing",
  "/privacy",
  "/refund",
  "/safety",
  "/safety/approach",
  "/safety/security-privacy",
  "/safety/trust-transparency",
  "/support",
  "/support/help-centre",
  "/terms",
]);

const localizedMarketingLocales = new Set([
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
  "kr",
  "cn",
]);

const localizedSearchIntentPaths = new Set([
  "ai-answer-review",
  "ai-for-file-analysis",
  "chatgpt-vs-claude",
  "compare-ai-models",
]);

const normalizePathname = (pathname: string) => {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
};

export const isStaticMarketingPathname = (pathname: string) => {
  const normalized = normalizePathname(pathname);
  if (exactMarketingPaths.has(normalized)) return true;

  const segments = normalized.split("/").filter(Boolean);
  if (!localizedMarketingLocales.has(segments[0] || "")) return false;
  if (segments.length === 1) return true;
  return (
    segments.length === 2 && localizedSearchIntentPaths.has(segments[1] || "")
  );
};
