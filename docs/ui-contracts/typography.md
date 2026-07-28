# Typography and Font System Contract

## Status

- Contract type: Design-system invariant
- Applies to: Every customer surface; the admin console inherits the same tokens
- Severity when violated: Release blocker for the font-routing and size-floor rules
- Owners: Product Design, Frontend, Accessibility, QA
- Last reviewed: 2026-07-28

## Scope

| Area | File |
| --- | --- |
| Font loading and preload policy | `lib/fonts.ts` |
| Locale font routing, semantic roles | `app/globals.css` |
| Root layout font variables | `app/layout.tsx` |
| `lang` attribute source of truth | `components/LanguageProvider.tsx` |
| Email font policy | `lib/emailTypography.ts` |
| Preload measurement | `scripts/report-font-preload.mjs` |

## Font strategy

### One family per locale, not per glyph

Every `font-family` in the app resolves through `--font-ui` (or `--font-code`).
`:lang()` rules re-point those variables, so a mixed string such as
`AI Review 결과` or `월 1,000 credits` is drawn by a single family. Patching only
the CJK glyphs through a fallback would leave the Latin run in a different face,
with a different baseline, stroke weight and advance width in the same sentence.

`LanguageProvider` writes `document.documentElement.lang`, which is what
`:lang()` matches.

| Locale | Stack |
| --- | --- |
| Default (en, de, fr, es, pt) | `Geist → system-ui → -apple-system → BlinkMacSystemFont → Segoe UI → sans-serif` |
| `:lang(ko)` | `Noto Sans KR → Apple SD Gothic Neo → Malgun Gothic → system-ui → sans-serif` |
| `:lang(zh)` | `Noto Sans SC → PingFang SC → Microsoft YaHei → system-ui → sans-serif` |
| Code (`--font-code`) | `Geist Mono → ui-monospace → SFMono-Regular → Menlo → Consolas → monospace` |

Under `:lang(ko)` and `:lang(zh)`, `--font-code` appends the locale UI face after
the monospace chain, so Korean or Chinese text inside a preserved-formatting
input still lands in the same family as the rest of that locale.

### Why Noto Sans KR over Pretendard

Both are OFL-licensed variable fonts (100–900) with Latin coverage good enough
to carry a mixed string. Noto Sans KR wins on delivery:

- Google serves it as 124 `unicode-range` chunks, so a Korean screen fetches
  only the chunks it actually renders. Pretendard Variable ships as one ~2 MB
  file, which a Korean user would pay for in full before any Hangul renders.
- `next/font/google` self-hosts it at build time with no vendored binaries.
  Pretendard would mean committing either one multi-megabyte file or ~250
  chunk files into the repository.
- It has metric-override fallback data in `next/font`, so the swap does not
  move layout.

If Pretendard is ever revisited, it must come with dynamic-subset chunking, not
the single-file build.

### Preload policy

Only the Latin UI face is preloaded. `Geist_Mono`, `Noto_Sans_KR` and
`Noto_Sans_SC` are declared `preload: false` in `lib/fonts.ts`: they are still
self-hosted and still fetched on demand by `unicode-range` matching, but no
route blocks its first render on bytes it may never draw.

Google's font metadata exposes no `korean` or `chinese-simplified` subset, so
`preload: true` on those families could only ever have preloaded their Latin
chunk — a cost with no Korean or Chinese benefit.

The browser never talks to Google's servers: `next/font` downloads at build
time and `font-src 'self' data:` in `lib/csp.ts` blocks the alternative.

Measure with:

```bash
npm run build && node scripts/report-font-preload.mjs
```

Measured on the landing page, before and after:

| | Before | After |
| --- | --- | --- |
| Preloaded files per route | 2 | 1 |
| Preloaded bytes per route | 51.2 KB | 28.6 KB |
| Preloaded face | Geist + Geist Mono | Geist only |
| Self-hosted files emitted | 11 (143 KB) | 236 (7.8 MB) |

The emitted total is a build artifact, not a download: a route fetches only the
`unicode-range` chunks it renders. Actually requested on first load of `/`:
28.6 KB in English (1 file), 494.6 KB in Korean (21 chunks), 807.2 KB in Chinese
(15 chunks). The CJK bytes are new — those locales previously fell back to
system fonts — and they are deliberately non-blocking: `display: swap` plus a
metric-override fallback means text paints immediately and the webfont swaps in
without moving layout. If that download is ever judged too expensive for a
market, the lever is the `:lang()` stack in `app/globals.css`, not the preload
policy.

## Semantic typography roles

Implemented as Tailwind v4 `@utility` rules in `app/globals.css`, so they are
emitted only where used and inherit the locale family automatically.

| Role | Family | Size | Line height | Weight | Letter-spacing | Use for |
| --- | --- | --- | --- | --- | --- | --- |
| `type-display` | `--font-ui` | `clamp(2.25rem, 6vw, 3.5rem)` | 1.05 | 800 | -0.02em | Landing hero, campaign headline |
| `type-page-title` | `--font-ui` | `clamp(1.75rem, 4vw, 2.25rem)` | 1.15 | 700 | -0.015em | The one `h1` of a page |
| `type-section-title` | `--font-ui` | 1.25rem (20px) | 1.3 | 700 | -0.01em | Section and card headings, dialog titles |
| `type-body` | `--font-ui` | 1rem (16px) | 1.65 | 400 | 0 | Chat messages, long-form marketing copy |
| `type-body-compact` | `--font-ui` | 0.875rem (14px) | 1.55 | 400 | 0 | Dense lists, sidebar rows, table cells |
| `type-control-label` | `--font-ui` | 0.875rem (14px) | 1.25 | 600 | 0 | Buttons, tabs, form labels, menu items |
| `type-caption` | `--font-ui` | 0.75rem (12px) | 1.4 | 500 | 0.005em | Helper text, timestamps, badges |
| `type-code` | `--font-code` | 0.8125rem (13px) | 1.55 | 400 | 0 | Code, model IDs, build metadata |

## Size and weight policy

- Customer text is never below 11px, and 11px is limited to supplementary
  information that is never the only carrier of a fact.
- Body copy and primary controls start at 14px.
- Mobile text inputs stay at 16px so iOS does not zoom on focus.
- `font-black` (900) is reserved for headline-sized text (≥18px) and short brand
  expressions. Small buttons, chips, badges and sidebar labels use 500–700.
  At 12–14px the difference between 700 and 900 is close to invisible, so 900
  buys weight noise instead of hierarchy.
- `uppercase` with wide tracking is for short Latin eyebrow labels only. It does
  nothing for Hangul or Han and turns full sentences into a reading cost.
- Monospace is for content that is semantically monospaced: code, model IDs,
  build metadata, verification codes, preserved-formatting input. Not prompt
  examples, not email addresses, not ordinary numbers.

### Documented exception

The admin console still contains 10px text. It is an internal, desktop-only,
authenticated surface; it inherits every token above, and the 11px floor is
enforced for customer surfaces only.

## Email fonts

Email clients do not reliably load webfonts, so `lib/emailTypography.ts` holds
one web-safe stack that every template uses. It names only installed faces,
carries the Korean and Chinese system faces inline, and ends on
`Arial, sans-serif`. Declaring `Inter` without shipping it — the previous
behaviour — rendered as an unpredictable client default.

Verification codes use `EMAIL_MONO_FONT_STACK` so characters are not confusable.

No template introduces webfont loading.

## Automated regression contract

- `tests/typographyPolicy.test.mjs` — the 11px floor, the `font-black` weight
  policy, no hard-coded Arial, the `globals.css` token wiring, the preload
  policy in `lib/fonts.ts`, and the single email stack.
- `tests/e2e/font-system.spec.ts` — computed *and* actually-rasterized font per
  locale (via `CSS.getPlatformFontsForNode`), monospace scope, preload count on
  a marketing route, 320px/200%-scaling reflow in en/ko/zh, light vs. dark
  parity, the 11px floor as rendered, and the 16px composer input.
- `tests/e2e/korean-typography.spec.ts` — Korean and Chinese wrapping.
- `tests/e2e/mobile-composer-contract.spec.ts` — the composer geometry contract
  in `mobile-chat-composer.md`, which a global font change can move.

Tests capture after `document.fonts.ready`, so measurements are taken from the
settled state rather than mid-swap.

## Change checklist

- [ ] Every family still resolves through `--font-ui` / `--font-code`
- [ ] No new hard-coded `font-family`
- [ ] Preload count did not grow (`scripts/report-font-preload.mjs`)
- [ ] No customer text below 11px
- [ ] No `font-black` on ≤16px text
- [ ] Mobile composer contract tests pass
- [ ] en / ko / zh checked in light and dark mode
- [ ] Screenshot baselines reviewed by a human before updating
