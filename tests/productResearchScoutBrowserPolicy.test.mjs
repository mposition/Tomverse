import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortTally,
  SCOUT_LOCALES,
  SCOUT_PAGE_ORIGIN,
  SCOUT_PAGES,
  decideScoutRequest,
  documentStop,
  errorCode,
  headersFromCdp,
  isScoutCausedConsoleError,
  launchFailure,
  originOf,
  retriesWithoutSandbox,
} from "../lib/productResearchScoutBrowserPolicy.mjs";

const allowedOrigins = [SCOUT_PAGE_ORIGIN];

test("the page table is the policy's twenty pages, in order, with unique ids", () => {
  // docs/policy/product-research-agent.md §12. Change it together with the policy's table.
  assert.deepEqual(
    SCOUT_PAGES.map(({ id, path, lang }) => `${id} ${path} ${lang}`),
    [
      "home.en / en",
      "pricing.en /pricing en",
      "models.en /models en",
      "compare-ai-models.en /compare-ai-models en",
      "chatgpt-vs-claude.en /chatgpt-vs-claude en",
      "ai-for-file-analysis.en /ai-for-file-analysis en",
      "about.en /about en",
      "faq.en /faq en",
      "support.en /support en",
      "help-centre.en /support/help-centre en",
      "privacy.en /privacy en",
      "terms.en /terms en",
      "safety.en /safety en",
      "chat-guest.en /chat en",
      "home.ko / ko",
      "pricing.ko /pricing ko",
      "models.ko /models ko",
      "faq.ko /faq ko",
      "support.ko /support ko",
      "chat-guest.ko /chat ko",
    ],
  );
  assert.equal(new Set(SCOUT_PAGES.map(({ id }) => id)).size, 20);
  assert.equal(SCOUT_PAGE_ORIGIN, "https://tomverse.app");
  for (const { lang } of SCOUT_PAGES) assert.ok(SCOUT_LOCALES[lang], `locale for ${lang}`);
  assert.ok(Object.isFrozen(SCOUT_PAGES) && SCOUT_PAGES.every((page) => Object.isFrozen(page)));
});

test("only GET and HEAD leave the browser, whatever the case", () => {
  for (const method of ["GET", "get", "HEAD", "head"]) {
    assert.deepEqual(decideScoutRequest({ method, url: `${SCOUT_PAGE_ORIGIN}/x`, allowedOrigins }), { allow: true });
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "post", ""]) {
    assert.deepEqual(
      decideScoutRequest({ method, url: `${SCOUT_PAGE_ORIGIN}/x`, allowedOrigins }),
      { allow: false, reason: "method" },
      method,
    );
  }
});

test("the method is judged before the origin, so a forbidden method never reads as an origin miss", () => {
  assert.deepEqual(
    decideScoutRequest({ method: "POST", url: "https://elsewhere.example/x", allowedOrigins }),
    { allow: false, reason: "method" },
  );
});

test("an origin must match exactly: scheme, host and port", () => {
  for (const url of [
    "http://tomverse.app/",
    "https://tomverse.app:8443/",
    "https://www.tomverse.app/",
    "https://staging.tomverse.app/",
    "https://tomverse.app.evil.example/",
    "https://evil.example/?https://tomverse.app",
  ]) {
    assert.deepEqual(decideScoutRequest({ method: "GET", url, allowedOrigins }), { allow: false, reason: "origin" }, url);
  }
  assert.deepEqual(
    decideScoutRequest({ method: "GET", url: "https://tomverse.app:443/pricing", allowedOrigins }),
    { allow: true },
  );
});

test("opaque and unparsable URLs are refused, never treated as same-origin", () => {
  for (const url of ["data:text/html,hi", "blob:https://tomverse.app/abc", "about:blank", "javascript:alert(1)", "not a url", "ws://tomverse.app/"]) {
    const decision = decideScoutRequest({ method: "GET", url, allowedOrigins });
    assert.equal(decision.allow, false, url);
    assert.equal(decision.reason, "invalid_url", url);
  }
  assert.equal(originOf("blob:https://tomverse.app/abc"), null);
  assert.equal(originOf("https://tomverse.app/a?b#c"), "https://tomverse.app");
});

test("the document response stops the page on a challenge or an error status, before it loads", () => {
  assert.equal(documentStop({ status: 200, headers: { "cf-mitigated": "challenge" } }), "challenge");
  assert.equal(documentStop({ status: 403, headers: { "cf-mitigated": "Challenge", server: "cloudflare" } }), "challenge");
  assert.equal(documentStop({ status: 403, headers: { server: "cloudflare" } }), "status");
  assert.equal(documentStop({ status: 503, headers: {} }), "status");
  assert.equal(documentStop({ status: 404, headers: {} }), "status");
  assert.equal(documentStop({ status: Number.NaN, headers: {} }), "status");
  assert.equal(documentStop({ status: 200, headers: { server: "cloudflare" } }), null);
  assert.equal(documentStop({ status: 304, headers: {} }), null);
});

test("an error leaves the probe as a code, never as the URL the message carries", () => {
  const navigation = new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT at https://tomverse.app/chat?token=abc\nCall log:");
  assert.equal(errorCode(navigation), "ERR_BLOCKED_BY_CLIENT");
  const timeout = Object.assign(new Error("page.goto: Timeout 45000ms exceeded.\n navigating to \"https://tomverse.app/x?y\""), { name: "TimeoutError" });
  assert.equal(errorCode(timeout), "timeout");
  assert.equal(errorCode(new Error("page.goto: Timeout 100ms exceeded.")), "timeout");
  assert.equal(errorCode(new Error("Target page, context or browser has been closed at https://tomverse.app/secret")), "error");
  assert.equal(errorCode("boom"), "error");
  for (const value of [navigation, timeout]) assert.ok(!errorCode(value).includes("tomverse"));
});

test("a launch failure says whether the sandbox ran, without the URLs Chromium prints", () => {
  // The shape Playwright gives a launch whose browser exits on its own.
  const sandbox = new Error(
    [
      "browserType.launch: Target page, context or browser has been closed",
      "Browser logs:",
      "",
      "<launching> /ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell --disable-field-trial-config --host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE tomverse.app",
      "<launched> pid=41",
      "[pid=41][err] [1019/085605.523:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.",
      "Call log:",
    ].join("\n"),
  );
  const failure = launchFailure(sandbox);
  assert.equal(failure.cause, "sandbox_unavailable");
  assert.match(failure.fatal, /^No usable sandbox! If you are running on Ubuntu 23\.10\+/);
  assert.ok(failure.fatal.includes("<url>"));
  assert.ok(!/https?:|googlesource|tomverse/.test(failure.fatal));
  assert.ok(failure.fatal.length <= 200);
  assert.equal(failure.source, "zygote_host_impl_linux.cc(128)");

  assert.deepEqual(launchFailure(new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1200/chrome-linux/chrome")), {
    cause: "browser_missing",
    fatal: null,
    source: null,
    fatalPrefix: null,
  });
  assert.deepEqual(launchFailure(new Error("browserType.launch: Target page, context or browser has been closed")), {
    cause: "launch_failed",
    fatal: null,
    source: null,
    fatalPrefix: null,
  });
  assert.deepEqual(launchFailure("boom"), { cause: "launch_failed", fatal: null, source: null, fatalPrefix: null });

  // A refused sandbox in the older location format, file.cc(123).
  const refused = launchFailure(
    new Error(
      "browserType.launch: Target page, context or browser has been closed\n[pid=7][err] [1021/045759.360:FATAL:credentials.cc(132)] Check failed: . : Permission denied (13)",
    ),
  );
  assert.deepEqual(refused, {
    cause: "sandbox_refused",
    fatal: "Check failed: . : Permission denied (13)",
    source: "credentials.cc(132)",
    fatalPrefix: null,
  });
  // And in the newer one, path/to/file.cc:123, which Chromium 156 prints.
  const newer = launchFailure(
    new Error("[pid=7][err] [1021/102815.405:FATAL:sandbox/linux/services/credentials.cc:132] Check failed: . : Permission denied (13)"),
  );
  assert.deepEqual(newer, {
    cause: "sandbox_refused",
    fatal: "Check failed: . : Permission denied (13)",
    source: "credentials.cc(132)",
    fatalPrefix: null,
  });
  // The location exactly as a local Chromium 156 printed one (2026-10-21), on Windows separators.
  assert.equal(
    launchFailure(new Error(String.raw`[1021/203045.654:FATAL:base\allocator\scheduler_loop_quarantine_config.cc:199] Check failed: .`)).source,
    "scheduler_loop_quarantine_config.cc(199)",
  );
  // A location that cannot be read is kept, as path characters only, for the next run's diagnosis.
  const unread = launchFailure(new Error("[pid=7][err] [1021/102815.405:FATAL:<somewhere odd>] Check failed: . : Permission denied (13)"));
  assert.equal(unread.cause, "launch_failed");
  assert.equal(unread.source, null);
  assert.equal(unread.fatalPrefix, "somewhereodd");
  assert.equal(launchFailure(new Error("[x:FATAL:] Check failed: .")).fatalPrefix, null);
  // The same words from a file outside the sandbox setup are not a refused sandbox.
  const elsewhere = launchFailure(
    new Error("[pid=7][err] [1021/045759.360:FATAL:platform_shared_memory_region_posix.cc(212)] Check failed: . : Permission denied (13)"),
  );
  assert.equal(elsewhere.cause, "launch_failed");
  assert.equal(elsewhere.source, "platform_shared_memory_region_posix.cc(212)");
  for (const file of ["namespace_sandbox.cc", "zygote_host_impl_linux.cc", "setuid_sandbox_host.cc"]) {
    assert.equal(launchFailure(new Error(`[err] [x:FATAL:${file}(9)] Check failed: .`)).cause, "sandbox_refused", file);
  }
});

test("only a refused or unavailable sandbox is retried without it, and the operator can turn that off", () => {
  const refused = { cause: "sandbox_refused" };
  assert.equal(retriesWithoutSandbox(undefined, refused), true);
  assert.equal(retriesWithoutSandbox("", refused), true);
  assert.equal(retriesWithoutSandbox("on", refused), true);
  assert.equal(retriesWithoutSandbox("off", refused), false);
  assert.equal(retriesWithoutSandbox(" OFF ", refused), false);
  assert.equal(retriesWithoutSandbox(undefined, { cause: "sandbox_unavailable" }), true);
  // Not the sandbox's failure: a timeout, a crash, a missing library or browser.
  assert.equal(retriesWithoutSandbox(undefined, { cause: "launch_failed" }), false);
  assert.equal(retriesWithoutSandbox(undefined, { cause: "browser_missing" }), false);
  assert.equal(
    retriesWithoutSandbox(undefined, launchFailure(Object.assign(new Error("browserType.launch: Timeout 180000ms exceeded."), { name: "TimeoutError" }))),
    false,
  );
});

test("the abort tally keeps method and origin and drops the path", () => {
  const tally = new AbortTally();
  tally.add({ reason: "method", method: "post", url: "https://tomverse.app/api/consent?token=secret" });
  tally.add({ reason: "method", method: "POST", url: "https://tomverse.app/other/path" });
  tally.add({ reason: "origin", method: "GET", url: "https://cdn.example:8443/a.js" });
  tally.add({ reason: "invalid_url", method: "GET", url: "data:text/plain,x" });
  const entries = tally.entries();
  assert.deepEqual(entries, [
    { reason: "invalid_url", method: "GET", origin: "opaque", count: 1 },
    { reason: "method", method: "POST", origin: "https://tomverse.app", count: 2 },
    { reason: "origin", method: "GET", origin: "https://cdn.example:8443", count: 1 },
  ]);
  assert.ok(!JSON.stringify(entries).includes("secret"));
  assert.ok(!JSON.stringify(entries).includes("/api/consent"));
});

test("console errors the scout's own blocking caused are told apart by their error code", () => {
  assert.equal(isScoutCausedConsoleError("Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector"), true);
  assert.equal(isScoutCausedConsoleError("Failed to load resource: net::ERR_NAME_NOT_RESOLVED"), true);
  // Real page failures stay in UI-02.
  assert.equal(isScoutCausedConsoleError("Failed to load resource: the server responded with a status of 500 ()"), false);
  assert.equal(isScoutCausedConsoleError("Failed to load resource: net::ERR_CONNECTION_REFUSED"), false);
  assert.equal(isScoutCausedConsoleError("TypeError: Cannot read properties of undefined"), false);
  assert.equal(isScoutCausedConsoleError("net::ERR_BLOCKED_BY_CLIENTX"), false);
});

test("CDP response headers are read case-insensitively, so a challenge header in any case still stops the page", () => {
  const headers = headersFromCdp([
    { name: "CF-Mitigated", value: "challenge" },
    { name: "Server", value: "cloudflare" },
  ]);
  assert.deepEqual(headers, { "cf-mitigated": "challenge", server: "cloudflare" });
  assert.equal(documentStop({ status: 200, headers }), "challenge");
  assert.deepEqual(headersFromCdp(undefined), {});
});
