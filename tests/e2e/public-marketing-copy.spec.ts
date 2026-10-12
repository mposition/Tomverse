import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { assistantKnowledgeGuideContent } from "@/components/marketing/assistantKnowledgeGuideContent";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { CHATGPT_VS_CLAUDE_MODEL_IDS } from "@/lib/marketingModelReferences";
import { LOCALIZED_MARKETING_BASE_PATHS } from "@/lib/marketingRoutes";
import {
  assistantKnowledgeMetadata,
  publicMarketingMetadataCopy,
  type PublicMarketingPagePath,
} from "@/lib/publicMarketingMetadata";
import {
  SEO_LOCALES,
  SITE_ORIGIN,
  localizedLanguageAlternates,
  localizedPath,
} from "@/lib/seo";
import type { Language } from "@/lib/language";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

// Eleven newly localized static routes; Knowledge is a separate, dynamic,
// query-language page. The assertions exercise served HTML, not build files.
const publicPaths = Object.keys(publicMarketingMetadataCopy) as PublicMarketingPagePath[];
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const decodeHtml = (text: string) => text.replace(
  /&(?:amp|quot|apos|lt|gt|#39|#x[\da-f]+|#\d+);/gi,
  entity => {
    const named: Record<string, string> = {
      "&amp;": "&", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&lt;": "<", "&gt;": ">",
    };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = entity.toLowerCase().startsWith("&#x");
    return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
  },
);

function attributes(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
    .map(match => [match[1].toLowerCase(), decodeHtml(match[3])]));
}

function servedDocument(html: string) {
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]));
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => attributes(match[0]));
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map(match => normalize(decodeHtml(match[1].replace(/<[^>]*>/g, " "))));
  return {
    language: attributes(html.match(/<html\b[^>]*>/i)?.[0] ?? "").lang,
    title: decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    description: meta.find(item => item.name === "description")?.content,
    ogTitle: meta.find(item => item.property === "og:title")?.content,
    ogDescription: meta.find(item => item.property === "og:description")?.content,
    canonical: links.find(item => item.rel === "canonical")?.href,
    alternates: Object.fromEntries(links.filter(item => item.rel === "alternate" && item.hreflang)
      .map(item => [item.hreflang, item.href])),
    h1,
    anchors: [...html.matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0]).href).filter(Boolean),
  };
}

function expectInlineHashes(html: string, headers: Record<string, string>, path: string) {
  const policies = [headers["content-security-policy"], headers["content-security-policy-report-only"]].filter(Boolean);
  expect(policies.length, `${path} must serve a CSP`).toBeGreaterThan(0);
  for (const policy of policies) {
    const directives = new Map(policy.split(";").map(part => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }));
    for (const tag of ["script", "style"] as const) {
      const sources = directives.get(`${tag}-src-elem`) ?? directives.get(`${tag}-src`) ?? directives.get("default-src") ?? [];
      expect(sources, `${path} ${tag} must use hashes, not blanket inline permission`).not.toContain("'unsafe-inline'");
      if (tag === "script") expect(sources).not.toContain("'unsafe-eval'");
      let inlineCount = 0;
      for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))) {
        if (tag === "script" && attributes(match[1]).src) continue;
        if (!match[2]) continue;
        inlineCount++;
        const hash = `'sha384-${createHash("sha384").update(match[2], "utf8").digest("base64")}'`;
        expect(sources, `${path}: CSP omits the served inline ${tag} hash ${hash}`).toContain(hash);
      }
      if (tag === "script") expect(inlineCount, `${path} must exercise actual inline hydration scripts`).toBeGreaterThan(0);
    }
  }
}

function expectDynamicNonces(html: string, headers: Record<string, string>, path: string) {
  const policies = [headers["content-security-policy"], headers["content-security-policy-report-only"]].filter(Boolean);
  expect(policies.length, `${path} must serve a request-time CSP`).toBeGreaterThan(0);
  let trustedNonce: string | undefined;
  for (const policy of policies) {
    const directives = new Map(policy.split(";").map(part => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }));
    const sources = directives.get("script-src-elem") ?? directives.get("script-src") ?? [];
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    const nonces = sources.filter(source => /^'nonce-[^']+'$/.test(source));
    expect(nonces, `${path} must expose exactly one server-generated script nonce`).toHaveLength(1);
    const nonce = nonces[0].slice("'nonce-".length, -1);
    if (trustedNonce) expect(nonce, `${path}: enforcing and reporting policies disagree`).toBe(trustedNonce);
    trustedNonce = nonce;
  }
  // Derive the expected value from the delivered CSP, never from a script's
  // own attribute: both Next's bootstrap and our inline scripts must match it.
  const roles = new Set<string>();
  let checkedScripts = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = attributes(match[1]);
    const hasSource = Object.prototype.hasOwnProperty.call(attrs, "src");
    if (hasSource) expect(attrs.src.trim().length, `${path}: an empty src is not an inline script`).toBeGreaterThan(0);
    const content = match[2].trim();
    // Empty inline placeholders execute nothing. External scripts still need
    // the nonce even though their script element has no inline body.
    if (!hasSource && !content) continue;
    checkedScripts++;
    expect(attrs.nonce, `${path}: ${attrs.src || attrs.type || "inline script"} misses the response nonce`).toBe(trustedNonce);
    if (!hasSource && content.startsWith("(function") && content.includes(".dataset.theme")) roles.add("theme");
    if (!hasSource && content.startsWith("(function") && content.includes("data-consent-pending")) roles.add("consent");
    if (attrs.type === "application/ld+json" && content) roles.add("jsonld");
    if (!hasSource && /(?:self|window)\.__next_f\b/.test(content)) roles.add("rsc");
  }
  expect(checkedScripts, `${path}: check actual HTML scripts, not only a policy header`).toBeGreaterThanOrEqual(4);
  expect([...roles].sort(), `${path}: all script surfaces must be present`).toEqual(["consent", "jsonld", "rsc", "theme"]);
}

function expectLocalizedLinks(hrefs: string[], language: Language) {
  const supported = LOCALIZED_MARKETING_BASE_PATHS as readonly string[];
  const queryLinks = new Map<string, string>();
  let marketingLinks = 0;
  for (const href of hrefs) {
    if (!href.startsWith("/")) continue;
    const url = new URL(href, SITE_ORIGIN);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    const hasLocale = SEO_LOCALES.includes(parts[0] as Language);
    const base = hasLocale ? (parts.length === 1 ? "/" : `/${parts.slice(1).join("/")}`) : path;
    if (!supported.includes(base)) continue;
    marketingLinks++;
    if (hasLocale) {
      expect(parts[0], `${language} link loses its locale: ${href}`).toBe(language);
    } else if (url.searchParams.has("lang")) {
      expect(url.searchParams.get("lang"), `${language} link has a different query language: ${href}`).toBe(language);
      queryLinks.set(`${url.pathname}${url.search}`, base);
    } else {
      expect(language, `${language} link loses both its locale prefix and query: ${href}`).toBe("en");
    }
  }
  expect(marketingLinks).toBeGreaterThan(0);
  return [...queryLinks].map(([href, base]) => ({ href, base }));
}

for (const language of SEO_LOCALES) {
  test(`${language}: public routes serve translated HTML, metadata, links and valid static CSP hashes`, async ({ request }) => {
    test.setTimeout(60_000);
    expect(publicPaths).toHaveLength(11);
    for (const base of publicPaths) {
      await test.step(`${language}${base}`, async () => {
        expect(LOCALIZED_MARKETING_BASE_PATHS as readonly string[]).toContain(base);
        const path = localizedPath(language, base);
        const response = await request.get(path);
        expect(response.status(), path).toBe(200);
        expect(new URL(response.url()).pathname, `${path} must not redirect to English`).toBe(path);
        expect(response.headers()["content-type"]).toContain("text/html");
        const html = await response.text();
        const document = servedDocument(html);
        const expected = publicMarketingMetadataCopy[base][language];
        expect(document.language, path).toBe(language);
        expect(document.title, path).toBe(expected.title);
        expect(document.description, path).toBe(expected.description);
        expect(document.ogTitle, path).toBe(expected.title);
        expect(document.ogDescription, path).toBe(expected.description);
        expect(document.canonical, path).toBe(`${SITE_ORIGIN}${path}`);
        expect(document.alternates, path).toEqual(localizedLanguageAlternates(base));
        expect(document.h1, `${path}: primary heading must be in served HTML`).toHaveLength(1);
        expect(document.h1[0].length).toBeGreaterThan(3);
        for (const target of expectLocalizedLinks(document.anchors, language)) {
          const linkedResponse = await request.get(target.href);
          expect(linkedResponse.status(), `${path} -> ${target.href}`).toBe(200);
          const finalPath = new URL(linkedResponse.url()).pathname;
          const allowedPaths = language === "en"
            ? [target.base, localizedPath(language, target.base)]
            : [localizedPath(language, target.base)];
          expect(allowedPaths, `${target.href} redirects to the wrong locale`).toContain(finalPath);
          expect(linkedResponse.headers()["content-type"]).toContain("text/html");
          const linkedDocument = servedDocument(await linkedResponse.text());
          expect(linkedDocument.language, `${target.href} serves the wrong document language`).toBe(language);
          expect(linkedDocument.h1, `${target.href} must serve the destination body`).toHaveLength(1);
          expect(linkedDocument.h1[0].length).toBeGreaterThan(3);
        }
        expectInlineHashes(html, response.headers(), path);
        if (language !== "en") {
          const english = await request.get(localizedPath("en", base));
          expect(english.status()).toBe(200);
          expect(document.h1[0], `${path}: body fell back to English`).not.toBe(servedDocument(await english.text()).h1[0]);
        }
      });
    }
    await test.step(`${language}: dynamic Knowledge guide`, async () => {
      const response = await request.get(`/guides/assistant-knowledge?lang=${language}`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      const document = servedDocument(html);
      const metadata = assistantKnowledgeMetadata(language);
      expect(document.language).toBe(language);
      expect(document.title).toBe((metadata.title as { absolute: string }).absolute);
      expect(document.description).toBe(metadata.description);
      expect(document.canonical).toBe(`${SITE_ORIGIN}/guides/assistant-knowledge?lang=${language}`);
      expect(document.alternates).toEqual(metadata.alternates?.languages);
      expect(document.h1).toEqual([normalize(assistantKnowledgeGuideContent[language].title)]);
      expectDynamicNonces(html, response.headers(), `/guides/assistant-knowledge?lang=${language}`);
    });
  });
}

type ScriptViolationWindow = Window & { __publicMarketingScriptViolations?: string[] };

async function preparePublicPage(page: Page) {
  await prepareGuestPage(page, "en");
  const generationPosts: string[] = [];
  const isGeneration = (pathname: string) =>
    /^\/api\/(?:chat|ai-review|deep-research|prompt-refiner)(?:\/|$)/.test(pathname) &&
    !/^\/api\/chat\/(?:preflight|availability|context)(?:\/|$)/.test(pathname);
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && isGeneration(pathname)) generationPosts.push(pathname);
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && isGeneration(pathname)) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Generation is not allowed in this public-copy test"}' });
    } else await route.fallback();
  });
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as ScriptViolationWindow).__publicMarketingScriptViolations = store;
    document.addEventListener("securitypolicyviolation", event => {
      if (event.violatedDirective.startsWith("script-src")) store.push(event.violatedDirective);
    });
  });
  return generationPosts;
}

async function expectBrowserMetadata(page: Page, base: PublicMarketingPagePath, language: Language) {
  const expected = publicMarketingMetadataCopy[base][language];
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page).toHaveTitle(expected.title);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", expected.description);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE_ORIGIN}${localizedPath(language, base)}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const representatives: Array<{ language: Language; next: Language; base: PublicMarketingPagePath }> = [
  { language: "ko", next: "fr", base: "/about" },
  { language: "fr", next: "de", base: "/faq" },
  { language: "de", next: "pt", base: "/models" },
  { language: "pt", next: "ko", base: "/support/help-centre/chat-workspace" },
];

for (const { language, next, base } of representatives) {
  test(`${language}: public content reflows at 320px and language switching updates path and head`, async ({ page }) => {
    const generationPosts = await preparePublicPage(page);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(localizedPath(language, base));
    await expectBrowserMetadata(page, base, language);
    const originalHeading = await page.getByRole("heading", { level: 1 }).innerText();
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("marketing-language-switcher").first().selectOption(next);
    await expect(page).toHaveURL(new RegExp(`${localizedPath(next, base)}$`));
    await expectBrowserMetadata(page, base, next);
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(originalHeading);
    await expect(page.getByTestId("marketing-language-switcher").first()).toHaveValue(next);
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => (window as ScriptViolationWindow).__publicMarketingScriptViolations ?? [])).toEqual([]);
    expect(generationPosts).toEqual([]);
  });
}

test("FAQ explains both products and French Knowledge identifies its English media", async ({ page }) => {
  const generationPosts = await preparePublicPage(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/ko/faq");
  const productQuestion = infoPages.faq.ko.sections[0];
  await expect(page.getByRole("heading", { name: productQuestion.title, exact: true })).toBeVisible();
  await expect(page.getByText(productQuestion.body, { exact: true })).toBeVisible();
  expect(productQuestion.body).toContain("Chat");
  expect(productQuestion.body).toContain("Review");
  const response = await page.goto("/guides/assistant-knowledge?lang=fr");
  expect(response).not.toBeNull();
  const html = await response!.text();
  expect(servedDocument(html).language, "French must be present before hydration").toBe("fr");
  expectDynamicNonces(html, response!.headers(), "/guides/assistant-knowledge?lang=fr");
  const knowledge = assistantKnowledgeGuideContent.fr;
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByTestId("marketing-language-switcher").first()).toHaveValue("fr");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(knowledge.title);
  await expect(page.locator("article[lang='fr']")).toBeVisible();
  await expect(page.getByText(knowledge.videoLabel, { exact: true })).toBeVisible();
  await expect(page.getByText(knowledge.videoHint, { exact: true }).first()).toBeVisible();
  await expect(page.locator("video source")).toHaveAttribute("src", /assistant-knowledge\.en\.mp4$/);
  await expect(page.locator("video track")).toHaveAttribute("srclang", "en");
  await expect(page.locator("video track")).toHaveAttribute("src", /assistant-knowledge\.en\.vtt$/);
  await expect(page.getByText(knowledge.exampleMaterial, { exact: true })).toBeVisible();
  await expect(page.getByText(knowledge.exampleOutput, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => (window as ScriptViolationWindow).__publicMarketingScriptViolations)).toEqual([]);
  expect(generationPosts).toEqual([]);
});

test("comparison examples preserve their source and prepare a draft without generating answers", async ({ page }) => {
  const generationPosts = await preparePublicPage(page);
  await mockAuthenticatedApi(page);
  await page.goto("/ko/chatgpt-vs-claude");
  const preparedLink = page.locator('a[href*="source=chatgpt-vs-claude"]');
  await expect(preparedLink).toHaveAttribute("href", /^\/review\?/);
  const prepared = new URL((await preparedLink.getAttribute("href"))!, SITE_ORIGIN);
  expect(prepared.searchParams.get("models")?.split(",")).toEqual([...CHATGPT_VS_CLAUDE_MODEL_IDS]);
  const prompt = prepared.searchParams.get("prompt")!;
  expect(prompt).toContain(assistantKnowledgeGuideContent.ko.exampleMaterial);
  await preparedLink.click();
  await expect(page).toHaveURL(/\/review\?/);
  await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
  expect(generationPosts).toEqual([]);

  await page.goto("/ko/ai-answer-review");
  const demonstration = await page.locator("main").evaluate(main => {
    const markers = [...main.querySelectorAll("span")].filter(span => /^[ABC]$/.test(span.textContent?.trim() ?? ""));
    const answers = markers.map(span => span.parentElement?.textContent?.trim() ?? "");
    let region = markers[0]?.parentElement ?? null;
    while (region && !region.querySelector("article h3")) region = region.parentElement;
    const findings = [...(region?.querySelectorAll("article") ?? [])].map(article => article.textContent ?? "");
    const quotes = findings.flatMap(text => [...text.matchAll(/“([^”]+)”/g)].map(match => match[1]));
    return { answers, quotes };
  });
  expect(demonstration.answers).toHaveLength(3);
  expect(demonstration.quotes).toHaveLength(3);
  for (const quote of demonstration.quotes) expect(demonstration.answers.some(answer => answer.includes(quote)), quote).toBe(true);
  expect(generationPosts).toEqual([]);
});
