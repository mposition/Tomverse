// What the improvement scout's browser may load, with no IO of its own.
//
// docs/policy/product-research-agent.md §12 fixes the twenty pages and the
// browser rules: GET and HEAD only, an allow-listed set of origins, every
// redirect hop judged before it is sent, and no WebSocket, service worker,
// download or permission. The browser service owns the IO; every decision it
// makes about a request is here so the tests can reach it without a browser.

/** The origin the scout walks unless told otherwise (§12). */
export const SCOUT_PAGE_ORIGIN = "https://tomverse.app";

/**
 * Every origin a walker may be pointed at: production, and dev and Test when
 * that environment's walker walks its own screens (§12, §13).
 */
export const SCOUT_PAGE_ORIGINS = Object.freeze([SCOUT_PAGE_ORIGIN, "https://dev.tomverse.app", "https://staging.tomverse.app"]);

/**
 * Where this run walks and the headers that gets it there.
 *
 * dev and Test sit behind Cloudflare Access, so they need its service token;
 * without one every page would stop at the login, so the run refuses to start
 * rather than judge nothing. Production never receives the token.
 *
 * @param {{ origin?: string, accessClientId?: string, accessClientSecret?: string }} variables
 * @returns {{ origin: string, headers: Record<string, string> } | { refused: "page_origin" | "access_token" }}
 */
export function scoutWalkTarget({ origin, accessClientId, accessClientSecret }) {
  const chosen = (origin ?? "").trim() || SCOUT_PAGE_ORIGIN;
  if (!SCOUT_PAGE_ORIGINS.includes(chosen)) return { refused: "page_origin" };
  if (chosen === SCOUT_PAGE_ORIGIN) return { origin: chosen, headers: {} };
  const id = (accessClientId ?? "").trim();
  const secret = (accessClientSecret ?? "").trim();
  if (!id || !secret) return { refused: "access_token" };
  return { origin: chosen, headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } };
}

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

/**
 * The screens a person sees once signed in (§12), seen as the test account.
 * Same shape as SCOUT_PAGES, and read the same way: GET and HEAD only.
 */
export const SCOUT_SIGNED_IN_PAGES = Object.freeze(
  [
    ["signed-in-chat.ko", "/chat", "ko"],
    ["signed-in-chat.en", "/chat", "en"],
    ["review.ko", "/review", "ko"],
    ["plugins.ko", "/plugins", "ko"],
    ["settings-assistants.ko", "/settings/assistants", "ko"],
    ["settings-data.ko", "/settings/data", "ko"],
    ["settings-memory.ko", "/settings/memory", "ko"],
    ["settings-notifications.ko", "/settings/notifications", "ko"],
    ["settings-imports.ko", "/settings/imports", "ko"],
  ].map(([id, path, lang]) => Object.freeze({ id, path, lang })),
);

/**
 * What the walker asks the product to make for real, as the test account (§14):
 * four files typed into the chat composer and one image. Each is one permit
 * from the daily generation cap an owner sets in Admin.
 */
export const SCOUT_GENERATIONS = Object.freeze(
  [
    ["generated.pdf", "2026년 1분기 국내 커피 프랜차이즈 시장을 정리한 한 쪽짜리 보고서를 PDF 파일로 만들어 주세요. 제목, 소제목 세 개, 작은 표 하나를 넣어 주세요. 수치는 예시로 만들어도 됩니다."],
    ["generated.docx", "신입 사원 온보딩 안내문을 Word(docx) 파일로 만들어 주세요. 제목, 번호 목록, 작은 표 하나를 넣어 주세요."],
    ["generated.xlsx", "월별 매출과 비용 예시 데이터 12개월치를 Excel(xlsx) 파일로 만들어 주세요. 합계 행과 이익 열을 넣어 주세요."],
    ["generated.pptx", "작은 카페 창업 계획 발표 자료를 PowerPoint(pptx) 파일로 다섯 장 만들어 주세요."],
    ["generated.image", "아침 햇살이 드는 작은 카페 창가에 놓인 커피 한 잔, 사진처럼 사실적으로"],
  ].map(([id, prompt]) => Object.freeze({ id, prompt })),
);

/** The browser context locale for a page language. */
export const SCOUT_LOCALES = Object.freeze({ en: "en-AU", ko: "ko-KR" });

/** Methods the browser may send (§12). Everything else is aborted. */
export const SCOUT_ALLOWED_METHODS = Object.freeze(["GET", "HEAD"]);

/** One chat POST per model: a turn compares at most this many (APP_DEFAULTS.maxSelectedModels). */
const SCOUT_TURN_CHAT_POSTS_MAX = 3;
/**
 * What the product's own send path posts around the turn: creating the
 * conversation, preflight, the concurrency slot, the prompt refiner, saving the
 * messages, the title. tests/e2e/scout-chat-turn-writes.spec.ts sends through the
 * real composer under this rule, so a new call on that path fails there rather
 * than quietly costing the Scout every file.
 */
const SCOUT_TURN_SUPPORT_POSTS =
  /^\/api\/chat\/(availability|concurrency|context|conversation-title|image-intent|location-intent|preflight|prompt-refiner\/(prepare|proposal|scope))$|^\/api\/products\/chat\/(conversations|drafts\/[^/]+)$|^\/api\/conversations\/[^/]+\/(messages|messages\/receipt|generate-title)$/;
const SCOUT_TURN_SUPPORT_POSTS_MAX = 40;

/**
 * The POSTs one real chat turn may make (§14), as a counter for that turn. The
 * walker opens it as it presses send and closes it when the answer settles, so
 * nothing the page does before or after can write, and nothing during the turn
 * can reach another paid route (voice, Review, deep research, an image turn).
 *
 * @returns {(url: string) => boolean}
 */
export function scoutTurnWrites() {
  let chatPosts = 0;
  let supportPosts = 0;
  return (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/chat") return ++chatPosts <= SCOUT_TURN_CHAT_POSTS_MAX;
    return SCOUT_TURN_SUPPORT_POSTS.test(pathname) && ++supportPosts <= SCOUT_TURN_SUPPORT_POSTS_MAX;
  };
}

/**
 * What the app's signed-in answer gives the browser.
 *
 * The cookie is only ever set for the origin the answer came from: a session
 * signed by one environment's app is not sent to another's host, whatever the
 * variables say. A permit the walker has no generation for is dropped.
 *
 * @param {unknown} answer
 * @param {{ ingestUrl: string, origin: string }} place
 */
export function signedInAccess(answer, { ingestUrl, origin }) {
  if (originOf(ingestUrl) !== origin) return { refused: "origin_mismatch" };
  const session = answer?.session;
  const expires = Date.parse(session?.expiresAt ?? "");
  if (typeof session?.name !== "string" || !/^(__Secure-)?next-auth\.session-token$/.test(session.name)) return { refused: "no_session" };
  if (typeof session.value !== "string" || session.value.length === 0 || !Number.isFinite(expires)) return { refused: "no_session" };
  const known = new Set(SCOUT_GENERATIONS.map((generation) => generation.id));
  const permits = Array.isArray(answer.permits) ? answer.permits.filter((id) => known.has(id)) : [];
  return {
    cookie: { name: session.name, value: session.value, url: origin, httpOnly: true, secure: true, sameSite: "Lax", expires: Math.floor(expires / 1000) },
    permits,
  };
}

/** Whether a page the walker opened signed in ended on the sign-in screens instead. */
export const isSignedOutPath = (url) => {
  try {
    return new URL(url).pathname.startsWith("/auth/");
  } catch {
    return false;
  }
};

/**
 * Whether one request may leave the browser.
 *
 * `allowedOrigins` holds exact origins (scheme, host and port). A URL that does
 * not parse, or whose origin is opaque (`data:`, `blob:`, `about:`), is
 * refused: the rule names origins, and an opaque one is not on any list.
 *
 * `allowWrite` is the current turn's counter (scoutTurnWrites), present only while
 * a real file is being made. It is asked last, so a request the origin rule
 * refuses does not use up the turn.
 *
 * @param {{ method: string, url: string, allowedOrigins: readonly string[], allowWrite?: ((url: string) => boolean) | null }} request
 * @returns {{ allow: true } | { allow: false, reason: "method" | "origin" | "invalid_url" }}
 */
export function decideScoutRequest({ method, url, allowedOrigins, allowWrite = null }) {
  const verb = String(method).toUpperCase();
  const read = SCOUT_ALLOWED_METHODS.includes(verb);
  if (!read && !(verb === "POST" && allowWrite)) return { allow: false, reason: "method" };
  const origin = originOf(url);
  if (origin === null) return { allow: false, reason: "invalid_url" };
  if (!allowedOrigins.includes(origin)) return { allow: false, reason: "origin" };
  if (!read && !allowWrite(url)) return { allow: false, reason: "method" };
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
 * `net::ERR_*` code or the timeout kind leaves the walker.
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
 * Chromium writes the location after `FATAL:` as `file.cc(123)` in older
 * builds and `path/to/file.cc:123` in newer ones (156 on Railway, 2026-10-21);
 * both are read, and `source` is always `file.cc(123)`. When no location can
 * be read, `fatalPrefix` keeps what Chromium printed there, reduced to path
 * characters, so the next run says which file it was.
 *
 * @param {unknown} error
 * @returns {{ cause: "sandbox_unavailable" | "sandbox_refused" | "browser_missing" | "launch_failed", fatal: string | null, source: string | null, fatalPrefix: string | null }}
 */
export function launchFailure(error) {
  const message = String(error?.message ?? error ?? "");
  const match = /:FATAL:([^\]\n]{0,200})\]\s*([^\n]+)/.exec(message);
  const prefix = match?.[1] ?? null;
  const location = prefix === null ? null : /([A-Za-z0-9_.-]+\.(?:cc|cpp|c|h|mm))(?:\((\d{1,6})\)|:(\d{1,6}))/.exec(prefix);
  const file = location?.[1] ?? null;
  const source = location ? `${file}(${location[2] ?? location[3]})` : null;
  const line = match?.[2] ?? null;
  const fatal = line === null ? null : line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").trim().slice(0, 200);
  const fatalPrefix = source === null && prefix !== null ? prefix.replace(/[^A-Za-z0-9_./:()-]/g, "").slice(0, 120) || null : null;
  const cause = /No usable sandbox/i.test(message)
    ? "sandbox_unavailable"
    : /Executable doesn't exist/i.test(message)
      ? "browser_missing"
      : file !== null && SANDBOX_SETUP_SOURCES.includes(file)
        ? "sandbox_refused"
        : "launch_failed";
  return { cause, fatal, source, fatalPrefix };
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
 * Whether a console error is one the scout's own rules caused (§12): those are
 * left out of what the model is shown.
 *
 * Chromium reports a request the route handler aborted as
 * `net::ERR_BLOCKED_BY_CLIENT` and one the host resolver rules refused as
 * `net::ERR_NAME_NOT_RESOLVED`. Only the error code is read -- the rest of the
 * message is page text and never leaves the browser service.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isScoutCausedConsoleError(text) {
  return /net::ERR_(BLOCKED_BY_CLIENT|NAME_NOT_RESOLVED)\b/.test(String(text));
}
