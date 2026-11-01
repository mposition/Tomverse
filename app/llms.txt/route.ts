import { SITE_ORIGIN, reviewSeoCopy } from "@/lib/seo";

/**
 * `/llms.txt`: a plain-text map of the public pages for AI assistants
 * (marketing policy §9.2, the AEO decision that it is an optional experiment).
 *
 * Off by default. The file is served only while `LLMS_TXT_ENABLED` is exactly
 * `true`; anything else, including an unset variable, answers 404 as if the
 * route did not exist. Turning it off again is a variable change and a redeploy
 * of the same build, not a code change.
 *
 * Every factual sentence is copied from copy a public page already carries
 * (`reviewSeoCopy`), and every link is a public page that app/sitemap.ts lists.
 * tests/llmsTxtRoute.test.mjs holds both to that, so this file cannot say more
 * than the site does. It carries no price, no limit and no date.
 */

export const dynamic = "force-dynamic";

const PAGES: ReadonlyArray<{ path: string; title: string }> = [
  { path: "/products/review", title: "Tomverse Review" },
  { path: "/compare-ai-models", title: "Compare AI models" },
  { path: "/ai-answer-review", title: "AI answer review" },
  { path: "/chatgpt-vs-claude", title: "ChatGPT vs Claude" },
  { path: "/ai-for-file-analysis", title: "AI for file analysis" },
  { path: "/models", title: "Models" },
  { path: "/pricing", title: "Pricing" },
  { path: "/faq", title: "FAQ" },
  { path: "/about", title: "About" },
  { path: "/safety", title: "Safety" },
  { path: "/support", title: "Support" },
  { path: "/privacy", title: "Privacy" },
  { path: "/terms", title: "Terms" },
];

const llmsTxt = () =>
  [
    "# Tomverse",
    "",
    `> ${reviewSeoCopy.en.description}`,
    "",
    "Tomverse is where GPT, Claude and Gemini are used in one place.",
    "",
    "## Pages",
    "",
    ...PAGES.map((page) => `- [${page.title}](${SITE_ORIGIN}${page.path})`),
    "",
  ].join("\n");

export function GET() {
  if (process.env.LLMS_TXT_ENABLED !== "true") {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return new Response(llmsTxt(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
