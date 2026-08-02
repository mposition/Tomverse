# Canonical visual baseline

`EXT-REAUDIT-F001` / `RECON-QA-001`. Screenshot goldens only mean something if
every run that judges them rasterises text the same way. Before this policy the
snapshot environment was implicit: the runner image floated on `ubuntu-latest`,
the browser came from whatever `npx playwright install` fetched, and locale and
time zone were inherited from the machine. A green suite and a red suite could
differ by nothing but the box they ran on, which is exactly what happened -- a
run on Chromium 141 against goldens recorded on Chromium 151 reported 906
differing pixels (2-3% of the image) spread across the *glyph edges of every
text run*, with no element moved and no layout changed.

That failure says nothing about the product. This document fixes what does.

## The canonical environment

| Axis | Value | Where it is pinned |
|---|---|---|
| OS | Linux x64 | `runs-on: ubuntu-24.04` |
| Runner image | `ubuntu-24.04` (never `ubuntu-latest`) | `.github/workflows/e2e.yml`, `.github/workflows/nightly-visual-regression.yml` |
| Playwright | the version in `package-lock.json` (`1.62.0`) | lockfile + `npm ci` |
| Browser | that Playwright version's bundled Chromium | `desktop-chromium` project |
| Locale | `en-US` | `canonicalRendering` in `playwright.config.ts` |
| Time zone | `UTC` | `canonicalRendering` in `playwright.config.ts` |
| Device pixel ratio | the project's own device preset (desktop 1, Pixel 5 2.625) | per project in `playwright.config.ts` |
| Animations | disabled by Playwright during `toHaveScreenshot` | Playwright default |
| Fonts | whatever `ubuntu-24.04` ships, plus the self-hosted webfonts `next/font` emits | runner image + `lib/fonts.ts` |

`ubuntu-latest` is not acceptable for any job that judges a golden. GitHub
re-points that label to a new image on its own schedule, and a font-package
bump inside a new image re-rasterises every snapshot at once -- which reads as
a product regression in the diff and is not one. Pin the image, or run in a
container pinned by digest.

Locale is pinned because it decides the font stack, not just the words:
`:lang()` selects `Noto Sans KR` and `Noto Sans SC` over `Geist` for whole
subtrees (see `docs/ui-contracts/typography.md`), so a runner defaulting to a
different locale renders different glyphs for identical markup.

## Which platforms may judge a golden

- **`desktop-chromium` on the canonical image** is the only combination whose
  screenshot result is evidence about the product.
- **Windows** and **WebKit / `mobile-safari`** run for *functional* regression
  only. Their assertions about behaviour count; their pixels do not. A
  screenshot difference seen only there is a platform difference until it is
  reproduced on the canonical combination.
- A run using the `PLAYWRIGHT_CHROMIUM_EXECUTABLE` escape hatch (see below) is
  **not** canonical. Its screenshots must be reported as `Not verified`, never
  as a pass and never as a reason to re-record.

## Updating a golden

1. Reproduce on the canonical environment. A diff that only appears elsewhere
   is not a reason to touch the baseline.
2. Look at the diff image and say, in the change description, what moved and
   why the new rendering is correct.
3. Re-record on the canonical environment only.
4. Get the new image reviewed like any other change.

Step 3 is the awkward one, because the canonical environment *is* CI. There is
one workflow for it and no other route:

```
Actions → Record Visual Baseline → Run workflow
```

`.github/workflows/visual-baseline-record.yml` runs on the pinned image with
the bundled Chromium, captures the diff against the outgoing baseline first,
re-records, re-runs to prove the new images are stable, and pushes the result
to a fresh `visual-baseline/<run id>` branch. It cannot move `develop` or
`main`; accepting the recording is a normal reviewed merge, which is step 4.

No workflow that *judges* a golden may rewrite one.
`scripts/security-regression-check.mjs` asserts that no snapshot-updating flag
appears in PR Fast Gate, Main Chromium Regression, Nightly Visual Regression or
the daily audit, and that the recorder is still `workflow_dispatch`-only, still
on `ubuntu-24.04`, and still pushing to a throwaway branch. An accidental
`--update-snapshots` anywhere else fails the build rather than quietly
rewriting the baseline.

### A baseline recorded off-canonical is a defect, not a baseline

`chat-state-visual-regression`'s 63 goldens were re-recorded inside an agent
container that cannot install the canonical browser, so they captured Chromium
141. The result looked like a passing suite everywhere it was recorded and
failed 49 of 74 the first time the canonical runner judged it -- with the same
uniform 0.01-0.04 glyph-edge signature, in English as well as Korean.

The tell is worth remembering, because it is symmetric and the direction is
easy to get backwards: when *both* sides are available, run the suite twice.
Passing on the non-canonical browser and failing on the canonical one means the
baseline is the artefact that is wrong. Only the canonical result decides.

## When the canonical browser cannot be installed

Some environments cannot reach `cdn.playwright.dev` -- it answers
`403 request rejected: host not permitted` -- so `npx playwright install`
fails and the Chromium projects cannot launch at all. Those images usually ship
a pre-provisioned Chromium instead. Point Playwright at it:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test --project=desktop-chromium
```

Unset -- which is the case in CI and on developer machines -- Playwright uses
its own pinned build and nothing about the canonical projects changes.

This is a capability fallback for *behavioural* coverage, so that a blocked
download does not cost the entire suite. It does not make the run canonical.
Report the blocked host, mark the visual result `Not verified`, and leave the
goldens alone.

### The suite says so itself

That paragraph was the whole policy for a while, and prose does not survive
contact with a red test. Every run in such an environment produced a wall of
screenshot diffs, and each time somebody re-derived the same conclusion from
scratch -- three separate write-ups in `.github/audits/` reach it independently.

So the goldens now declare it. `tests/e2e/support/canonical-visual.ts` exposes
`skipUnlessCanonicalVisualBrowser()`, which every golden is gated on:

| environment | goldens | behavioural tests |
|---|---|---|
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` unset (CI, developer machines) | judged | run |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set | **skipped, reason = `Not verified`** | run |

A skip is the accurate result here, and specifically not a pass: Playwright
reports it as skipped with the reason and this document attached, which is what
`Not verified` was always supposed to mean. Nothing about the canonical run
changes, because CI never sets the variable --
`scripts/security-regression-check.mjs` fails the build if any workflow does,
since a runner in the substitute case would skip every golden and still report
green.

Only the goldens are gated. `mobile-composer-contract.spec.ts` keeps measuring
overlap, widths, line boxes and overflow on the substitute browser; those
answers do not depend on the rasteriser.

#### The signature, for whoever meets it next

On a substitute Chromium the diff is invariant to the product, which is how you
tell it apart from a regression. `mobile-composer-contract`'s two composer
goldens reported **exactly 906 differing pixels** on Chromium 141 against a
baseline recorded on Chromium 151 -- the same 906 on `e46389e` (2026-07-30) and
on `90e5572` (2026-08-01), across a composer rework, a provider-banner change
and the UI-001 theme change in between. Both were judged green by the canonical
runner throughout (`e2e.yml` shard 1, runs `30696253742` and `30703064212`).
A product regression moves that number; a rasteriser difference does not.
