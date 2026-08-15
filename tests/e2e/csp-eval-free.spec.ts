import { expect, test, type Page } from "@playwright/test";

import { prepareGuestPage } from "./support/app-fixtures";

/**
 * The pages must load without any script-src `eval` violation.
 *
 * Zod decides once whether it may JIT-compile a validator, and it decided by
 * calling `Function("")` inside a `try`. Every page that constructs a
 * `z.object` reached that line -- `lib/productAnalyticsShared.ts` does so at
 * module scope and client components import it -- so the browser filed a
 * report to /api/security/csp-report, which forwards to Sentry: two issues,
 * 56 events in a fortnight, not one of them a fault.
 *
 * What happened after the call differed by deployment, which is worth stating
 * precisely rather than calling it "blocked" everywhere. Production runs
 * `CSP_MODE=enforce` -- readiness requires it (lib/securityEnvironment.ts) --
 * so the call threw and Zod used its interpreted path. Staging runs
 * report-only, so the same call succeeded and Zod used the JIT. Both filed the
 * report. Setting `jitless` removes the probe from both, and incidentally
 * makes staging parse the way production already was.
 *
 * instrumentation-client.ts now sets `jitless`, which Zod reads *before* the
 * probe (`const fastEnabled = jit && allowsEval.value` -- the `&&`
 * short-circuits), so the call is never made. tests/zodJitlessClient.test.mjs
 * proves the flag lands and that validation answers identically without the
 * JIT. Neither of those is the thing that was actually wrong, though: the
 * violation is a browser fact, and this is where a browser is available.
 *
 * Each test carries its own controls. "No eval violation was recorded" is also
 * what a page serving no CSP, or a page whose listener never registered, would
 * report -- silent regressions of the test rather than of the app. So after
 * asserting the absence, every test shows that the policy on this very
 * response still leaves eval out, and that the recorder does catch a violation
 * when one happens.
 */

type RecordedViolation = {
  blockedURI: string;
  violatedDirective: string;
  sourceFile: string;
};

type ViolationWindow = Window & { __cspViolations?: RecordedViolation[] };

/**
 * Registered before any page script runs, which matters here more than usual:
 * Zod's schemas are constructed at module scope, so the violation this looks
 * for happens while the first chunks are still evaluating.
 */
const recordViolations = (page: Page) =>
  page.addInitScript(() => {
    const store: RecordedViolation[] = [];
    (window as ViolationWindow).__cspViolations = store;
    document.addEventListener("securitypolicyviolation", (event) => {
      store.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective,
        sourceFile: event.sourceFile,
      });
    });
  });

const readViolations = (page: Page) =>
  page.evaluate(() => (window as ViolationWindow).__cspViolations ?? []);

/**
 * Every script-src violation, not just the one spelled `blockedURI: "eval"`
 * that Chromium reports. Engines disagree on the spelling, and pinning this to
 * one would let another engine's wording through -- and a fix that traded this
 * violation for a different script-src violation would not be a fix.
 */
const scriptViolations = (violations: RecordedViolation[]) =>
  violations.filter((violation) =>
    violation.violatedDirective.startsWith("script-src")
  );

/**
 * First control: a policy that does not permit eval is actually on this
 * response. Either header counts -- `CSP_MODE` decides between enforcing and
 * reporting, and a report-only policy reports this violation just as loudly,
 * which is the whole problem being fixed.
 *
 * Deliberately read from the header rather than by calling `new Function` from
 * the test. `page.evaluate` reaches the page over CDP, which is exempt from
 * the eval restriction, so a test that provoked the violation that way would
 * report "allowed" on a page whose CSP is perfectly strict -- it measures
 * Playwright, not the app.
 */
const expectEvalOutsidePolicy = (headers: Record<string, string>) => {
  const header =
    headers["content-security-policy"] ||
    headers["content-security-policy-report-only"];
  expect(header, "no CSP on this response").toBeTruthy();
  const scriptSrc = (header ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src "));
  expect(scriptSrc, "CSP has no script-src, so eval was never restricted").toBeTruthy();
  expect(
    scriptSrc,
    "CSP permits eval here, so the absence of a violation proves nothing"
  ).not.toContain("'unsafe-eval'");
};

/**
 * Second control: the recorder is live and this browser really does report
 * violations to it. Provoked with a connect-src violation rather than an eval,
 * for the CDP reason above -- the directive differs, the reporting path is the
 * same, and `scriptViolations` keeps it out of the assertion it guards.
 *
 * The target is a dead local port on purpose. Under report-only -- which is
 * what the e2e server serves, and what staging serves -- a violation is
 * reported but *not* blocked, so the request is really attempted. An external
 * hostname here had the test opening outbound connections on every run, which
 * a control for a security contract should not be doing. Port 9 is discard: it
 * is refused locally and immediately, and is a different origin from the page,
 * which is all the violation needs.
 */
const expectRecorderIsLive = async (page: Page) => {
  await page.evaluate(() =>
    fetch("http://127.0.0.1:9/csp-control").catch(() => undefined)
  );
  await expect
    .poll(async () => (await readViolations(page)).length)
    .toBeGreaterThan(0);
};

const expectNoEvalViolation = async (page: Page) => {
  const violations = scriptViolations(await readViolations(page));
  expect(
    violations,
    `script-src violations while loading the page: ${JSON.stringify(violations)}`
  ).toEqual([]);
};

/**
 * Tagged `@ui-risk` rather than left untagged, which would leave it to the
 * unfiltered main-push run. What it catches -- a directive loosened in
 * lib/csp.ts, the instrumentation entry deleted or renamed, a dependency
 * reintroducing a probe -- arrives in a pull request, and a security contract
 * that first speaks up after promotion speaks too late. Two tests over two
 * Chromium projects, measured under seven seconds.
 */
test.describe("CSP: the client bundle never reaches for eval", () => {
  test(
    "chat loads and hydrates without a script-src violation",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await recordViolations(page);
      await prepareGuestPage(page);
      const response = await page.goto("/chat");

      // Hydration, not just first paint: the probe fired while client modules
      // evaluated, so the page has to have actually run them.
      await expect(page.getByTestId("chat-textarea")).toBeVisible();

      await expectNoEvalViolation(page);
      expectEvalOutsidePolicy(response?.headers() ?? {});
      await expectRecorderIsLive(page);
    }
  );

  test(
    "pricing loads without a script-src violation",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await recordViolations(page);
      await prepareGuestPage(page);
      const response = await page.goto("/pricing");

      await expect(page.getByRole("main").first()).toBeVisible();

      await expectNoEvalViolation(page);
      expectEvalOutsidePolicy(response?.headers() ?? {});
      await expectRecorderIsLive(page);
    }
  );
});
