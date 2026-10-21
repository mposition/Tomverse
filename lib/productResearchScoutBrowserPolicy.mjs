// What the improvement scout's browser may load, with no IO of its own.
//
// docs/policy/product-research-agent.md §12 fixes the twenty pages and the
// browser rules: GET and HEAD only, an allow-listed set of origins, every
// redirect hop judged before it is sent, and no WebSocket, service worker,
// download or permission. The browser service owns the IO; every decision it
// makes about a request is here so the tests can reach it without a browser.
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

/** Methods the browser may send (§12). Everything else is aborted. */
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
 * Whether the document response stops the page before anything else runs
 * (§11-5: a challenge stops the page and is recorded; it is never solved or
 * waited out).
 *
 * The browser service reads it while CDP Fetch holds the document response,
 * before a byte reaches the renderer, so a challenge's scripts never run. Cloudflare marks a challenge with
 * `cf-mitigated: challenge`. Any other status of 400 or more also stops the
 * page: every proxied response says `server: cloudflare`, so a block page and
 * an origin error cannot be told apart from the status alone, and the scout
 * has nothing to measure on either.
 *
 * @param {{ status: number, headers: Record<string, string> }} response
 * @returns {"challenge" | "status" | null}
 */
export function documentStop({ status, headers }) {
  const mitigated = String(headers["cf-mitigated"] ?? "").toLowerCase();
  if (mitigated === "challenge") return "challenge";
  if (!Number.isInteger(status) || status >= 400) return "status";
  return null;
}

/**
 * CDP's response headers (`[{ name, value }]`) as a lowercase-keyed record, so
 * `documentStop` reads `cf-mitigated` whatever case the edge sent. A repeated
 * header keeps its last value; the one header read here is never repeated.
 *
 * @param {{ name: string, value: string }[] | undefined} entries
 * @returns {Record<string, string>}
 */
export function headersFromCdp(entries) {
  const headers = {};
  for (const { name, value } of entries ?? []) headers[String(name).toLowerCase()] = String(value);
  return headers;
}

/**
 * A browser or network error reduced to its code.
 *
 * Playwright's messages carry the URL that failed, which can hold a path or a
 * query the page chose, and a redirect target the page did not show. Only a
 * `net::ERR_*` code or the timeout kind leaves the probe.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
  const message = String(error?.message ?? error ?? "");
  const network = /net::(ERR_[A-Z0-9_]+)/.exec(message);
  if (network) return network[1];
  if (error?.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(message)) return "timeout";
  return "error";
}

/**
 * Why Chromium did not start, from the browser log a launch error carries.
 *
 * A launch fails before any page exists, so nothing a page chose can be in
 * it. The cause is a closed code; `fatal` is Chromium's own FATAL line with
 * any URL taken out, cut short, and `source` the Chromium file and line that
 * raised it, so a run says whether and where the sandbox failed (§12)
 * instead of "error".
 *
 * `sandbox_refused` is a FATAL raised in Chromium's Linux sandbox setup
 * (SANDBOX_SETUP_SOURCES): the host would not give the sandbox what it
 * needs. Any other failure -- a timeout, a crash, a missing library -- is
 * `launch_failed` and says nothing about the sandbox.
 *
 * @param {unknown} error
 * @returns {{ cause: "sandbox_unavailable" | "sandbox_refused" | "browser_missing" | "launch_failed", fatal: string | null, source: string | null }}
 */
export function launchFailure(error) {
  const message = String(error?.message ?? error ?? "");
  const match = /:FATAL:([A-Za-z0-9_./-]{1,80}\(\d{1,6}\))?[^\]\n]*\]\s*([^\n]+)/.exec(message);
  const source = match?.[1] ?? null;
  const line = match?.[2] ?? null;
  const fatal = line === null ? null : line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").trim().slice(0, 200);
  const cause = /No usable sandbox/i.test(message)
    ? "sandbox_unavailable"
    : /Executable doesn't exist/i.test(message)
      ? "browser_missing"
      : source !== null && SANDBOX_SETUP_SOURCES.includes(source.replace(/\(\d+\)$/, ""))
        ? "sandbox_refused"
        : "launch_failed";
  return { cause, fatal, source };
}

/**
 * The Chromium source files of its Linux sandbox setup: user and PID
 * namespaces, credentials, the zygote that starts sandboxed children, and the
 * setuid helper. A FATAL from one of them is the host refusing the sandbox.
 */
export const SANDBOX_SETUP_SOURCES = Object.freeze([
  "credentials.cc",
  "namespace_sandbox.cc",
  "namespace_utils.cc",
  "sandbox_linux.cc",
  "sandbox_host_linux.cc",
  "setuid_sandbox_client.cc",
  "setuid_sandbox_host.cc",
  "zygote_host_impl_linux.cc",
  "zygote_main_linux.cc",
  "zygote_linux.cc",
]);

/** The walker's variable that turns the unsandboxed retry off. */
export const SCOUT_SANDBOX_FALLBACK_ENV = "PRODUCT_RESEARCH_SCOUT_SANDBOX_FALLBACK";

/**
 * Whether a Chromium that would not start with its sandbox is started again
 * without it (operator decision 2026-10-21, §12): some Railway hosts refuse the
 * sandbox's user namespace setup, and on those days the pages were skipped.
 * The retry keeps every request rule and the container's unprivileged user;
 * only Chromium's own sandbox is off, and the run says so. Only a refused or
 * unavailable sandbox is retried: a failure that is not the sandbox's -- a
 * timeout, a crash, a missing browser or library -- stops the page step as
 * before. The variable set to `off` turns the retry off.
 *
 * @param {string | undefined} setting
 * @param {{ cause: string }} failure
 */
export function retriesWithoutSandbox(setting, failure) {
  if ((setting ?? "").trim().toLowerCase() === "off") return false;
  return failure.cause === "sandbox_unavailable" || failure.cause === "sandbox_refused";
}

/**
 * Whether a console error is one the scout's own rules caused (§12: those are
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
 * §12: the browser service reports aborts as method and origin counts only --
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
