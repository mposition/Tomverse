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
| `:lang(ko)` | `Noto Sans KR → Noto Sans KR Korean Fallback → Apple SD Gothic Neo → Malgun Gothic → system-ui → sans-serif` |
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
- It has metric-override fallback data in `next/font`. That data alone does not
  stop the swap moving layout, though -- see "Known CJK fallback-metric
  limitation" below.

If Pretendard is ever revisited, it must come with dynamic-subset chunking, not
the single-file build.

### Known CJK fallback-metric limitation

**This applies to both CJK families, and only one of them has been remediated.**

`next/font` generates one metric-override face per family. Both CJK ones are
built on `local(Arial)`:

```css
@font-face {
  font-family: "Noto Sans KR Fallback";
  src: local(Arial);
  ascent-override: 110.73%;
  descent-override: 27.49%;
  size-adjust: 104.76%;
}
/* "Noto Sans SC Fallback" is the same shape, also src: local(Arial). */
```

**Arial provides neither Hangul nor Han glyphs.** So the generated
`size-adjust`, `ascent-override` and `descent-override` never apply to the
fallback rendering of CJK glyphs at all. On a cold load, `:lang(ko)` paints in
Apple SD Gothic Neo or Malgun Gothic and `:lang(zh)` paints in PingFang SC or
Microsoft YaHei — none of which carry those overrides — and each is then
replaced by Noto Sans KR/SC. **The prior guarantee that "a metric-adjusted
fallback means the CJK font swap does not move layout" does not hold.** It holds
for the Latin run inside a mixed string and for nothing else.

Measured on the Korean landing hero before remediation: median CLS 0.1082 at
320px and 0.1061 at 360px, from `h1` and `p` reflow, against a 0.1 budget.

| Locale | Status |
| --- | --- |
| `:lang(ko)` | Remediated — see below. Verified only in a Linux container; the three real platform faces still need device confirmation |
| `:lang(zh)` | **Known Risk / platform coverage limitation.** `/zh` passes the CLS budget in the current verification environment (0.0076 cold, 0 with fonts blocked). The structural gap is unchanged, and no real Chinese OS font environment has been measured |

Scope rules that follow from this, and must not be blurred:

- The Korean remediation is **locale-specific**. It does not close the Chinese
  case, and no Korean result may be generalised to `:lang(zh)`.
- `:lang(zh)` stays `Known Risk / platform coverage limitation`. `/zh` cold-load
  CLS has since been measured — 0.0076 at 320px, 0 with every webfont blocked,
  rasterizing `Noto Sans SC` — so it passes the budget *in this verification
  environment*. What has not been measured is a real Chinese OS font
  environment: `PingFang SC`, `Microsoft YaHei` and Android's Han face are
  absent here, exactly as the Korean platform faces are. The risk is that the
  fallback metrics differ there, not that a user impact is confirmed.
- **Never describe Chinese as `Pass` or "unaffected" without its own raw CLS
  numbers.** Per-locale font download size, system fallback and wrapping all
  differ, so an English or Korean measurement says nothing about it.
- Applying `display: "optional"` to Korean alone would not fix Chinese either;
  applying it to both without per-locale measurement is equally unsupported.
- **A Korean font change must run the Chinese regression tests**
  (`tests/e2e/font-system.spec.ts`, `tests/e2e/korean-typography.spec.ts` — the
  latter covers Chinese wrapping too).

### The Korean remediation

The fix is a second override face that can actually draw Hangul,
`Noto Sans KR Korean Fallback` in `app/globals.css`, placed in the stack
immediately after `var(--font-noto-sans-kr)`. Its values are derived from Noto
Sans KR's own metrics rather than chosen:

| Value | Derivation | Result |
| --- | --- | --- |
| `size-adjust` | Noto's Hangul advance ÷ the fallback's | `92%` |
| `ascent-override` | Noto's ascent ÷ `size-adjust` | `126.09%` |
| `descent-override` | Noto's descent ÷ `size-adjust` | `31.52%` |
| `line-gap-override` | matches the `next/font` face | `0%` |

Noto Sans KR's Hangul is 8% narrower than a full-width Korean system face; that
ratio is the horizontal half of the mismatch and the ascent/descent pair is the
vertical half.

Two constraints on changing it:

- `src` is a list of `local()` entries so each platform resolves to the Korean
  face it actually has. This assumes those faces share the full-width (1em)
  Hangul advance that is standard for Korean and CJK text faces. **If a platform
  is found not to, give it its own family with its own `size-adjust` rather than
  changing this one** -- a single value cannot serve two different advances.
- The values above were verified in a Linux container whose only Korean-capable
  face is `WenQuanYi Zen Hei`. The mechanism is proven there; **`Apple SD Gothic
  Neo`, `Malgun Gothic` and Android's Korean face still need real-device
  confirmation**, and until they have it the Korean CLS result is
  environment-scoped evidence.

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
system fonts — and they are deliberately non-blocking: `display: swap` means text
paints immediately and the webfont swaps in afterwards. Whether that swap moves
layout depends on the fallback having metrics for the script being drawn --
`next/font`'s own override is Arial-based and covers only the Latin run, so
Hangul needs the extra face described in "Known CJK fallback-metric limitation"
and Han has no equivalent yet. If that download is ever judged too expensive for
a market, the lever is the `:lang()` stack in `app/globals.css`, not the preload
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
- [ ] Swap-driven layout shift measured, not assumed. A metric-override face only
      helps the script it can draw, so measure CLS on a locale's own page with a
      cold cache — `:lang(ko)` and `:lang(zh)` each need their own number, and a
      green English result says nothing about either
