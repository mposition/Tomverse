<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:mobile-chat-composer-invariant -->
## Mobile chat composer invariant

Before changing `ChatInput.tsx`, `MobileChatShell.tsx`, composer styles, tool chips, or mobile bottom-dock layout, read:

- `docs/ui-contracts/mobile-chat-composer.md`

Non-negotiable requirements:

- The mobile textarea must always own a dedicated full-width row with at least one complete visible input line.
- Tool, web-search, deep-research, attachment, billing, and model-status controls must never consume the textarea's horizontal row, overlap it, or float above it.
- Increasing ChatMessageList height must never reduce the textarea to residual horizontal space.
- Do not use absolute positioning, negative margins, transforms, or shared grid cells to place controls beside or over the textarea.
- Any mobile composer layout change must include bounding-box, overlap, horizontal-overflow, Korean IME, 320px-width, and 200% text-scaling regression coverage.
- A change that violates this contract is a release blocker.
<!-- END:mobile-chat-composer-invariant -->

<!-- BEGIN:comparison-action-rail-invariant -->
## Comparison action rail invariant

Before changing `ComparisonActionRail.tsx`, `lib/comparisonReadiness.ts`, the bottom workflow dock in either shell, or the rail's copy, read:

- `docs/ui-contracts/comparison-action-rail.md`

Non-negotiable requirements:

- Desktop and mobile must use the same state-driven disclosure policy: decide with `shouldShowVisualStatus()` in `lib/comparisonReadiness.ts`, never with `layout === "mobile"`, a media query, or any other shell-shaped condition.
- In the normal, all-complete, runnable state the status sentence ("Comparing N completed answers") is visually hidden in both shells, and leaves no row height or bottom gap behind.
- Visually hidden means `sr-only`: the sentence stays in the DOM and in the accessibility tree, and each action keeps the comparison target count in its own `aria-describedby`.
- Generating, too-few-answers, excluded, analysis-running and per-action credit-shortfall states must be visible on screen, with each action describing only its own price and its own reason.
- Any related change must include the desktop *and* mobile state matrix tests (`tests/comparisonReadiness.test.mjs`, `tests/e2e/comparison-action-rail.spec.ts`).
- A change that violates this contract is a release blocker.
<!-- END:comparison-action-rail-invariant -->

<!-- BEGIN:typography-invariant -->
## Typography and font system invariant

Before changing `lib/fonts.ts`, the font tokens or `@utility type-*` roles in `app/globals.css`, `app/layout.tsx`'s font wiring, or `lib/emailTypography.ts`, read:

- `docs/ui-contracts/typography.md`

Non-negotiable requirements:

- Every `font-family` resolves through `--font-ui` or `--font-code`. Never hard-code a family, and never register a font variable that the rendered UI does not actually use.
- Locale families are selected by `:lang()` over the whole subtree, never by per-glyph fallback: `Geist` by default, `Noto Sans KR` for `:lang(ko)`, `Noto Sans SC` for `:lang(zh)`.
- Only the Latin UI face is preloaded. `Geist_Mono`, `Noto_Sans_KR` and `Noto_Sans_SC` stay `preload: false`; verify with `node scripts/report-font-preload.mjs` after a build.
- Webfonts are self-hosted through `next/font`. The browser must never request Google's servers.
- Customer text is never below 11px; body copy and primary controls start at 14px; mobile text inputs stay at 16px.
- `font-black` (900) is limited to headline-sized text (≥18px) and short brand expressions; small buttons, chips, badges and labels use 500–700.
- Monospace is only for code, model IDs, build metadata, verification codes and preserved-formatting input.
- Emails use the single web-safe stack in `lib/emailTypography.ts` and never load a webfont.
- Any related change must keep `tests/typographyPolicy.test.mjs` and `tests/e2e/font-system.spec.ts` passing, and must re-run the mobile composer contract specs.
- A change that violates this contract is a release blocker.
<!-- END:typography-invariant -->
