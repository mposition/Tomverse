# Mobile Chat Composer UI Contract

## Status

- Contract type: Non-negotiable product invariant
- Applies to: Mobile chat shell and responsive compact layouts
- Severity when violated: Release blocker
- Owners: Product Design, Frontend, Accessibility, QA
- Last reviewed: 2026-07-28

## Purpose

The message canvas may be optimized for additional vertical space, but the primary message-composition task must remain fully usable. The composer must always provide one complete, full-width input line before secondary controls are considered.

## Scope

| Area | File |
| --- | --- |
| Composer markup, tool chips, actions row | `components/chat/ChatInput.tsx` |
| Mobile shell, bottom dock, portal placement | `components/chat/MobileChatShell.tsx` |
| Comparison action rail above the composer | `components/chat/ComparisonActionRail.tsx` |
| Mobile AI/security disclosure below the composer | `components/chat/AiDisclaimerNotice.tsx` |
| Guest verification bottom sheet | `components/chat/GuestVerificationSheet.tsx` |
| Keyboard/landscape compaction signal | `components/chat/useCompactBottomDock.ts` |
| Mobile shell detection | `components/chat/useIsMobileShell.ts` |

The contract binds the mobile shell (`useIsMobileShell()`) and every compact/responsive layout that renders the same composer, including landscape phones, keyboard-open states and browser zoom levels that produce a phone-width layout viewport.

## Required anatomy

The mobile composer must preserve this vertical structure:

1. Optional tool/status row
2. Dedicated full-width textarea row
3. Actions, model selection, credit estimate, and send row
4. Required safety or privacy disclosure

Optional rows may be compacted or conditionally hidden. The textarea row may not be merged with another row.

As implemented, that is:

```
[tool-status-chip-row]        ← optional; web search / deep research chips, flex-wrap
[web-search-exception-detail] ← optional; expands under the chip that opened it
[composer-textarea-row]       ← always; the textarea alone, width: 100%
[actions row]                 ← attach, model picker, credit estimate, send
[chat-ai-disclaimer-mobile]   ← always; AI + sensitive-data notice with "details"
```

## Non-negotiable invariants

- The textarea owns a dedicated row.
- The empty textarea provides at least one complete visible line.
- The textarea uses the available inner width of the composer.
- A status chip may not reduce the textarea to remaining horizontal space.
- A chip, badge, scrollbar, icon, or button may not overlap the textarea or placeholder.
- Korean IME composition text and caret must remain visible.
- The layout must work at 320px, 360px, 390px, and 430px widths.
- The contract must remain valid at 200% text scaling.
- Mobile keyboard and safe-area changes must not collapse the textarea.
- ChatMessageList optimization is subordinate to composer usability.

## Allowed patterns

- A separate, compact status row above the textarea, wrapping with `flex-wrap` when several chips are present.
- Shorter chip labels on mobile (`웹 검색 2/3`, `웹 검색 불가`, `심층 조사`), as long as the accessible name and description keep the full meaning.
- Chips whose visual height is compacted (32px on mobile) while their controls keep a ≥44×44px hit area through `::before` insets.
- Rows below the textarea that wrap when they no longer fit, so no control is pushed outside the composer.
- `min-h` / `max-h` expressed in `rem` so the input grows with OS/browser text scaling.
- Auto-growing the textarea from `rows={1}` up to its own maximum, then scrolling vertically inside it.
- A modal guest-verification sheet, portalled to `<body>` rather than rendered inside the composer: it never takes part in the composer's height calculation, consumes no layout while closed, and stops at the composer's top edge while open so the user can still read the message they are about to send.

## Forbidden patterns

- Tool chip and textarea in the same horizontal flex row
- Tool chip and textarea in the same grid cell
- Absolute or fixed controls positioned over the textarea
- Negative margins or transforms used to visually reclaim textarea space
- Placeholder padding used to imitate space beside an overlapping chip
- Horizontal scrolling inside the composer
- A textarea whose width is merely the space left after status controls
- Hiding partial-support, unavailable, cost, security, or billing warnings without an accessible replacement

## Allowed optimization order

1. Remove redundant stable-state descriptions visually while preserving accessible semantics.
2. Compact duplicate mobile-header information.
3. Reduce nonessential padding and margins.
4. Compact the comparison action rail.
5. Shorten tool-chip visual labels while preserving accessible descriptions.
6. Wrap optional status chips onto their own row when required.
7. Never reclaim space from the textarea's full-width line.

ChatMessageList height may never be bought with any of these:

- placing chips and the textarea on one row,
- overlaying chips on the textarea,
- padding the placeholder to dodge an overlapping chip,
- hiding primary controls on scroll direction,
- overlapping the bottom dock onto messages and compensating with padding,
- shrinking touch targets or body text.

## Web search and deep research status

- Never hide the web-search state, and never reduce it to a bare icon.
- The chip carries the state itself (`data-tone`, `data-supported-count`, `data-unsupported-count`); the visual label may be shortened on mobile, which the row declares as `data-label-variant="compact"`.
- The full sentence — how many models can search, how many cannot, the credit ceiling, the refund rule for a search that never ran, and the action the user can take — stays available through `#web-search-state-description` and `aria-describedby`.
- A partial-support exception expands under the chip that opened it, never over the input.
- A fully blocked state keeps its full-width notice and its way out (`web-search-unavailable-notice`).
- Several chips wrap onto another chip row; they never scroll sideways and never enter the input row.

## Accessibility requirements

- The textarea must have a persistent accessible name independent of its placeholder.
- Tool-state details must remain available through `aria-label`, `aria-describedby`, or an accessible disclosure.
- Disabled actions must expose their specific reason (not through `title` alone).
- Focus indicators must remain visible and must not be clipped by the composer's `overflow-hidden`.
- Interactive targets must be at least 44×44px.
- Status updates must not repeatedly interrupt typing through an excessively noisy live region.
- Quick-comparison and AI cross-review must each carry their own `aria-describedby`, so two different credit costs are never described by one shared sentence.

## Security UX requirements

- The user must be able to review the text being entered without obstruction.
- Sensitive-information warnings may be visually compacted but not removed.
- Tool capability and billing exceptions must be visible before submission.
- Reduced textarea visibility must not increase the risk of accidental submission of hidden or unreviewed text.

## Responsive contract (320px – 430px)

| Width | Expectation |
| --- | --- |
| 320px | Textarea keeps the full inner width; chips wrap rather than scroll; no horizontal overflow. |
| 360px | Same as 320px. |
| 390px | Same as 320px; the reference viewport for the golden screenshots. |
| 430px | Same as 320px. |
| 195px (200% page zoom) | Contract still holds; the actions row wraps and the model button truncates rather than pushing Send outside the composer. |

Landscape and keyboard-open viewports may compact the comparison rail, but not the composer's input row.

## Korean IME and 200% text scaling contract

- Committed Korean text, in-flight composition text and the caret must all stay inside the visible box (`scrollHeight - clientHeight ≤ 1`, `scrollLeft = 0`).
- Focus, composition and typing must not change the textarea's width or x-position.
- At 200% text scaling (`html { font-size: 32px }`) the textarea must still show one complete line: its min/max heights and the auto-grow cap are expressed in `rem`, not px.
- At 200% page zoom (a ~195px layout viewport) no composer control may be clipped by the composer's own `overflow-hidden`.

## Automated regression contract

Every change affecting the mobile composer must verify:

- textarea height is at least one line;
- textarea width is at least 90% of the composer’s inner available width;
- intersection area between textarea and every tool/status chip is zero;
- composer horizontal overflow is zero;
- Korean input and IME composition remain visible;
- keyboard-open layout remains usable;
- 200% text scaling does not cause overlap;
- 320px through 430px mobile widths pass;
- screenshots cover the 3-model and web-search partial-support state.

These are measured, not eyeballed: the specs compute the rectangles themselves (intersection area, left/right alignment, `scrollWidth > clientWidth`, width before/after focus, height before/after typing) rather than relying on screenshot diffs alone.

Primary tests:

- `tests/e2e/mobile-composer-contract.spec.ts` (the geometry contract itself)
- `tests/e2e/mobile-message-visibility.spec.ts` (composer vs. answer-canvas budget)
- `tests/e2e/chat-keyboard-policy.spec.ts`
- `tests/e2e/chat-tools.spec.ts`
- `tests/e2e/web-search-composer-state.spec.ts`
- `tests/e2e/comparison-action-rail.spec.ts`
- `tests/e2e/guest-turnstile-verification.spec.ts` (the verification sheet vs. the composer)
- `tests/e2e/mobile-header-spacing.spec.ts`
- relevant mobile visual-regression coverage (`tests/e2e/chat-state-visual-regression.spec.ts`)

A change to the font system moves text metrics across the whole composer, so it
is a composer change for the purposes of this contract: see
`docs/ui-contracts/typography.md` and re-run the specs above.

Run them with:

```bash
npm run build
npx playwright test --project=desktop-chromium tests/e2e/mobile-composer-contract.spec.ts
```

The geometry specs pin explicit viewports, so they run on one engine (`desktop-chromium`, `hasTouch`) and skip elsewhere.

## Change checklist

Before approving a mobile composer change:

- [ ] Textarea still owns a dedicated full-width row
- [ ] At least one complete input line is visible
- [ ] No chip or control intersects the textarea
- [ ] No composer horizontal scrollbar exists
- [ ] Korean IME was tested
- [ ] 320px viewport was tested
- [ ] 200% text scaling was tested
- [ ] Keyboard-open state was tested
- [ ] Partial and unsupported web-search states were tested
- [ ] Automated regression tests pass
- [ ] Before-and-after screenshots were reviewed

## Release blocker criteria

A change is `NO-GO` for commercial release, regardless of whether other tests pass, if any of the following is true on a mobile viewport between 320px and 430px:

- the textarea does not own a full-width row of its own;
- the empty textarea shows less than one complete input line (< 36px at default text size);
- the textarea's width is under 90% of the composer's inner width;
- any chip, badge or control has a non-zero intersection with the textarea or its placeholder;
- the composer overflows horizontally or exposes a horizontal scrollbar;
- Korean composition text or the caret can be hidden while typing;
- a web-search capability, credit or security warning was removed without an accessible replacement;
- the required regression coverage above is missing from the change.
