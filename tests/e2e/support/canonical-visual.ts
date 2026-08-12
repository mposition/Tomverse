import { test } from "@playwright/test";

/**
 * `docs/qa/canonical-visual-baseline.md`. A screenshot golden is evidence about
 * the product only when the browser judging it is the one the lockfile pins.
 *
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE` is the documented capability fallback for
 * images that cannot reach `cdn.playwright.dev` (it answers
 * `403 request rejected: host not permitted`), so the pinned build cannot be
 * downloaded and the Chromium projects would otherwise not launch at all. It
 * buys back the behavioural coverage. It cannot buy back the pixels: a
 * different Chromium re-rasterises every glyph edge, and the goldens go red
 * for a reason that has nothing to do with the change under test.
 *
 * That is not a hypothesis. On this repository the mismatch produces a
 * signature that is invariant to the product: `mobile-composer-contract`'s two
 * composer goldens report **exactly 906 differing pixels** on Chromium 141
 * against a baseline recorded on Chromium 151 -- the same 906 on `e46389e`
 * (2026-07-30) as on `90e5572`, across the composer rework, the provider
 * banner change and the UI-001 theme change in between. A real regression
 * would have moved that number. See
 * `.github/audits/provider-status-banner-visual-nv-2026-07-30.md`.
 *
 * The policy for that case is already written -- report `Not verified`, never
 * a pass, never re-record -- but it lived only in prose, so every run in such
 * an environment produced a red diff that somebody then had to re-diagnose
 * from scratch. It has been re-diagnosed at least three times. This states it
 * in the test result instead: the golden reports as skipped, with the reason
 * and the policy pointer attached, which is what `Not verified` means.
 *
 * CI never sets the variable, so nothing here changes what the canonical
 * runner judges. `scripts/security-regression-check.mjs` asserts that no
 * workflow sets it -- otherwise this guard would be a way to make the goldens
 * disappear from the one environment entitled to judge them.
 */
export const isCanonicalVisualBrowser = () =>
  !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export const NON_CANONICAL_BROWSER_REASON =
  "Not verified -- non-canonical browser. PLAYWRIGHT_CHROMIUM_EXECUTABLE is set, so the " +
  "Chromium judging this golden is not the one the lockfile pins and its pixels are not " +
  "evidence about the product. Do not re-record from here; see docs/qa/canonical-visual-baseline.md.";

/**
 * Call it at the capture, not in a `beforeEach`.
 *
 * "Behavioural assertions in the same spec are untouched" is the contract, and
 * a `beforeEach` cannot keep it: it skips the whole test before anything runs,
 * including tests that take no screenshot at all. That is not theoretical --
 * `chat-state-visual-regression.spec.ts` gated its file on the claim that every
 * test in it was a golden, and 18 of its 81 are behavioural. Among them was the
 * focus assertion on the credit-pack dialog, the one the nightly used to catch
 * the focus race on 18d1e891, so on a substitute browser the check most likely
 * to notice a regression was the one silently not running.
 *
 * Called from the capture instead, a golden still reports `Not verified` and
 * gets there having run its behavioural assertions first, and a test with no
 * capture runs to completion. `tests/canonicalVisualGate.test.mjs` holds the
 * placement.
 */
export function skipUnlessCanonicalVisualBrowser() {
  test.skip(!isCanonicalVisualBrowser(), NON_CANONICAL_BROWSER_REASON);
}
