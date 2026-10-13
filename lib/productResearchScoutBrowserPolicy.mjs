// What the improvement scout's browser may load, with no IO of its own.
//
// docs/policy/product-research-agent.md §12 fixes the twenty pages and §13 the
// browser rules: GET and HEAD only, an allow-listed set of origins, redirects
// judged on where they land, and no WebSocket, service worker, download or
// permission. The browser service owns the IO; every decision it makes about a
// request is here so the tests can reach it without a browser.
//
// The S0 probe (scripts/agents/product-research-scout-s0-probe.mjs) uses the
// same functions, so what S0 measures is the rule the service will run, not a
// copy of it.

/** The only origin the scout walks (§12). */
export const SCOUT_PAGE_ORIGIN = "https://tomverse.app";

/**
 * The twenty production public pages, in the policy's order (§12).
 *
 * `lang` is applied as the browser context's locale, which is what the site
 * reads from `Accept-Language` when the path carries no language; the page id
 * is what a finding names, never the URL. Changing this table is a policy
 * change.
 */
export const SCOUT_PAGES = Object.freeze(
  [
    ["home.en", "/", "en"],
    ["pricing.en", "/pricing", "en"],
    ["models.en", "/models", "en"],
    ["compare-ai-models.en", "/compare-ai-models", "en"],
    ["chatgpt-vs-claude.en", "/chatgpt-vs-claude", "en"],
    ["ai-for-file-analysis.en", "/ai-for-file-analysis", "en"],
    ["about.en", "/about", "en"],
    ["faq.en", "/faq", "en"],
    ["support.en", "/support", "en"],
    ["help-centre.en", "/support/help-centre", "en"],
    ["privacy.en", "/privacy", "en"],
    ["terms.en", "/terms", "en"],
    ["safety.en", "/safety", "en"],
    ["chat-guest.en", "/chat", "en"],
    ["home.ko", "/", "ko"],
    ["pricing.ko", "/pricing", "ko"],
    ["models.ko", "/models", "ko"],
    ["faq.ko", "/faq", "ko"],
    ["support.ko", "/support", "ko"],
    ["chat-guest.ko", "/chat", "ko"],
  ].map(([id, path, lang]) => Object.freeze({ id, path, lang })),
);

/** The browser context locale for a page language. */
export const SCOUT_LOCALES = Object.freeze({ en: "en-AU", ko: "ko-KR" });

/** Methods the browser may send (§13). Everything else is aborted. */
export const SCOUT_ALLOWED_METHODS = Object.freeze(["GET", "HEAD"]);

/**
 * Whether one request may leave the browser.
 *
 * `allowedOrigins` holds exact origins (scheme, host and port). A URL that does
 * not parse, or whose origin is opaque (`data:`, `blob:`, `about:`), is
 * refused: the rule names origins, and an opaque one is not on any list.
 *
 * @param {{ method: string, url: string, allowedOrigins: readonly string[] }} request
 * @returns {{ allow: true } | { allow: false, reason: "method" | "origin" | "invalid_url" }}
 */
export function decideScoutRequest({ method, url, allowedOrigins }) {
  if (!SCOUT_ALLOWED_METHODS.includes(String(method).toUpperCase())) {
    return { allow: false, reason: "method" };
  }
  const origin = originOf(url);
  if (origin === null) return { allow: false, reason: "invalid_url" };
  if (!allowedOrigins.includes(origin)) return { allow: false, reason: "origin" };
  return { allow: true };
}

/**
 * The origin of a URL, or null when it has none a list could name.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function originOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

/**
 * Whether a document response is a bot-protection challenge (§11-6).
 *
 * Cloudflare marks a challenge with `cf-mitigated: challenge`; older
 * interstitials answer 403 or 503 from `server: cloudflare` with the
 * "Just a moment" title. A challenge stops the page -- the scout never solves
 * or waits one out -- so a false negative here is the dangerous direction and
 * the title check stays even though the header is the documented signal.
 *
 * @param {{ status: number, headers: Record<string, string>, title: string }} document
 * @returns {boolean}
 */
export function isBotChallenge({ status, headers, title }) {
  const header = (name) => String(headers[name] ?? headers[name.toLowerCase()] ?? "").toLowerCase();
  if (header("cf-mitigated") === "challenge") return true;
  const fromCloudflare = header("server").includes("cloudflare");
  const interstitial = /just a moment|attention required/i.test(String(title ?? ""));
  return fromCloudflare && (status === 403 || status === 503) && interstitial;
}

/**
 * Whether a console error is one the scout's own rules caused (§13: those are
 * left out of UI-02).
 *
 * Chromium reports a request the route handler aborted as
 * `net::ERR_BLOCKED_BY_CLIENT` and one the host resolver rules refused as
 * `net::ERR_NAME_NOT_RESOLVED`; S0 found every console error on the twenty
 * pages to be one of the first. Only the error code is read -- the rest of the
 * message is page text and never leaves the browser service.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isScoutCausedConsoleError(text) {
  return /net::ERR_(BLOCKED_BY_CLIENT|NAME_NOT_RESOLVED)\b/.test(String(text));
}

/**
 * Counts of aborted requests, keyed `${reason}:${method}:${origin}`.
 *
 * §13: the browser service reports aborts as method and origin counts only --
 * never the path, which can carry anything the page put there.
 */
export class AbortTally {
  constructor() {
    /** @type {Map<string, number>} */
    this.counts = new Map();
  }

  /** @param {{ reason: string, method: string, url: string }} aborted */
  add({ reason, method, url }) {
    const key = `${reason}:${String(method).toUpperCase()}:${originOf(url) ?? "opaque"}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** @returns {{ reason: string, method: string, origin: string, count: number }[]} */
  entries() {
    return [...this.counts.entries()]
      .map(([key, count]) => {
        const [reason, method, ...rest] = key.split(":");
        return { reason, method, origin: rest.join(":"), count };
      })
      .sort((a, b) => (a.reason + a.method + a.origin).localeCompare(b.reason + b.method + b.origin));
  }
}
