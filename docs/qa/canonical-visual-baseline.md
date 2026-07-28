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

Never run a snapshot-updating flag in CI. `scripts/security-regression-check.mjs`
asserts that no such flag appears in the visual-regression or PR Fast Gate
workflows, so an accidental `--update-snapshots` there fails the build rather
than quietly rewriting the baseline.

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
