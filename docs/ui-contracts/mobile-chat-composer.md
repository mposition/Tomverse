# Mobile Chat Composer UI Contract

## Status

- Contract type: Non-negotiable product invariant
- Applies to: Mobile chat shell and responsive compact layouts
- Severity when violated: Release blocker
- Owners: Product Design, Frontend, Accessibility, QA
- Last reviewed: 2026-09-17

## Purpose

The message canvas may be optimized for additional vertical space, but the primary message-composition task must remain fully usable. The composer must always provide one complete, full-width input line before secondary controls are considered.

## Scope

| Area | File |
| --- | --- |
| Composer markup, tool chips, actions row | `components/chat/ChatInput.tsx` |
| Attachment capabilities (who may attach what, from where, and for how long) | `lib/guestAttachmentPolicy.ts` |
| Mobile shell, bottom dock, portal placement | `components/chat/MobileChatShell.tsx` |
| Comparison action rail above the composer | `components/chat/ComparisonActionRail.tsx` |
| Mobile AI/security disclosure below the composer | `components/chat/AiDisclaimerNotice.tsx` |
| Guest verification bottom sheet | `components/chat/GuestVerificationSheet.tsx` |
| Keyboard/landscape compaction signal | `components/chat/useVisualViewport.ts` (`useCompactBottomDock`) |
| Mobile shell detection | `components/chat/useIsMobileShell.ts` |
| Visible-viewport measurement (keyboard inset, visible height) | `components/chat/useVisualViewport.ts` |
| Provider outage banner above the composer | `components/chat/ProviderStatusBanner.tsx` |
| New-chat welcome surface above the dock (holds no composer) | `components/chat/ChatWelcomeScreen.tsx` |

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
- An attachment chip, its filename, and any attachment error occupy their own
  rows; none of them may narrow, cover or shorten the textarea's row.

## Scroll ownership and the visible viewport

The composer is only usable if the user can reach it, so reaching it is part of
this contract, not a separate concern.

- **The composer is in the bottom dock in every state, a new chat included.**
  It is never portalled into the welcome screen (amended 2026-09-15,
  `docs/ui-contracts/chat-starter-catalog.md` section 6), and it keeps
  `variant="bar"` before and after the first send, so sending does not move or
  restyle it.
- **At most one active scroll owner on the way to the composer.** There must
  never be a second scrolling ancestor between the composer and the shell. Two
  nested scrollers means the user has to work out which surface to drag, and a
  test (or a user) that drags the inner one can leave the composer under the
  keyboard. A scroller that is *not* the composer's ancestor — the answer list,
  or the new-chat welcome region — is not on that path.
- **The page behind the shell is never that path.** `document`/`body` scrolling
  is not an acceptable substitute for the shell's own scroll region.
- **Nothing that can shrink may contain the composer.** When the composer lived
  in the welcome surface, a flex rule that let that surface collapse
  (`min-h-0 flex-1` under `shrink-0` siblings that overran the viewport) removed
  the composer from the page entirely — clipped to a zero-height box, with
  `elementFromPoint` returning the element painted behind it (REFLOW-P1-01).
  The welcome region may now shrink and scroll inside itself precisely because
  the composer is no longer in it; moving the composer back into any shrinking
  region reopens that defect.
- **Anything sized as a fraction of "the screen" measures the visible viewport,
  never `dvh`, `vh` or `window.innerHeight`.** With the on-screen keyboard up,
  iOS Safari and Android Chrome's default mode keep the layout viewport at the
  phone's full height, so `45dvh` of an 844px phone is 380px — 73% of the 524px
  the user can actually see. `useVisibleViewportHeight()` in
  `components/chat/useVisualViewport.ts` is the single source for this, and it
  shares one subscription with the keyboard inset and the compact-dock flag.
- **The provider outage banner's cap is a measured budget.** The mobile shell
  subtracts the header, the bottom dock, the composer (wherever it currently
  lives) and a rem-based minimum for the conversation area from the visible
  viewport, and caps the result at 45% of the visible viewport. The banner keeps
  a rem-based floor and scrolls inside itself beyond it; it is never shrunk to a
  caption, reduced to an icon, or hidden.
- **Every sentence and action the banner carries stays.** "No eligible
  replacement model is available" and its "Choose another model" action are the
  user's only recovery path when nothing can replace the model they are standing
  on. They may scroll inside the banner; they may not be dropped, truncated,
  demoted behind a disclosure, or resized below the 44px touch floor.

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

## Attachment capabilities

Who may attach what is four independent facts, passed in as
`attachmentCapabilities` (`lib/guestAttachmentPolicy.ts`) and never derived
from `isGuestMode` at the point of render:

| Capability | Guest | Signed-in |
| --- | --- | --- |
| `canAttachLocalFiles` | yes — one file per message | yes — up to 5 |
| `canConnectGoogleDrive` | no; the row states the reason and offers sign-in | yes |
| `maxAttachmentBytes` | 5 MB | 10 MB |
| `attachmentPersistence` | `ephemeral` | `account` |

Requirements:

- A capability the caller lacks is *named*, never a dead disabled control:
  Google Drive says why and offers the one action that changes it.
- Every guest limit here is re-enforced server-side; the client's copy of it
  exists to pre-empt a rejection, never to define one.
- `ephemeral` persistence is stated where the file is picked: guest files are
  held briefly for that chat only, and never saved, shared or exported.
- Attachment errors are distinguishable — unsupported type, too large, could
  not be processed, and over the guest input limit are four different
  sentences, because they have four different fixes.
- Changing attachment state must not disturb an in-flight IME composition.

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

## Page zoom and short screens (COMPOSER-REFLOW-01)

Browser page zoom (Edge and Chrome "Default zoom") shrinks the layout viewport
in CSS pixels, so a phone at 150%, 200% and 300% is a 275px, 206px and 137px
wide screen, and only a few hundred pixels tall. These are narrower than the
320px the responsive table guarantees, but they are how low-vision users read,
and staging found the composer unusable there (2026-09-17). These hold at the
viewports in the table below, which the regression tests pin, in addition to
the 320–430px contract:

- **Send is reachable with one vertical drag started on the empty textarea**,
  the largest target in the dock at these sizes. The empty textarea has no
  vertical overflow (`scrollHeight - clientHeight ≤ 1`), and it is refitted
  when its width or its placeholder changes, not only when the draft changes.
  A box one line tall under a two-line placeholder cuts the placeholder off and
  becomes a scroller of its own that takes the drag meant for the shell. The
  drag scrolls the shell, never the document.
- **The safety notice is not truncated.** It wraps when it does not fit, and
  "Details" stays inside the notice's box.
- **The model button and its chevron stay inside the composer's clip box**
  (pinned at 137px and 120px). The button's label may wrap to two lines rather
  than setting the button's minimum width to the whole label, which pushed the
  chevron past the composer's `overflow-hidden` edge.
- **The conversation section keeps `MIN_CONVERSATION_AREA_REM`.** `min-h-0`
  alone let it reach 0px when the header and the dock outgrew the screen,
  leaving the starters, or the answers, nowhere to be drawn. The floor is a
  `min-height`, so it adds nothing on a screen with room. The shell, which is
  the composer's one scroll owner, scrolls past the section to the dock, and a
  starter is reached by dragging inside the section.
- **The floor never follows focus.** Anything that changes layout when a dock
  control gains or loses focus moves that control between press and release,
  so the release lands elsewhere. The test pins it for the tools button at
  300%, and checks that a focused textarea is on screen there.

| Viewport | Stands for |
| --- | --- |
| 275×493 | 150% page zoom on a ~390px phone |
| 206×370 | 200% page zoom |
| 137×247 | 300% page zoom, the maximum (the model button is also checked at 120px) |
| 568×320 | A landscape phone |

Reachability is measured as in the sidebar drawer contract: the control's
centre point through `elementFromPoint`, after a real touch drag dispatched as
touch points under mobile emulation, with the drag's start point hit-tested
too. A starter card is the one exception: at 300% it is taller than the 4rem
section, so its centre can never be on screen, and the test hit-tests the
middle of the part of the card the section shows.

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
- screenshots cover the 3-model and web-search partial-support state;
- the composer is reachable through at most one scroll owner, and never through
  `document`, with the keyboard open;
- at 150%, 200% and 300% page zoom and on a landscape phone, Send is reached by
  one drag started on the empty input, the safety notice is not truncated, and
  the conversation section keeps its floor;
- every provider-banner fallback state is covered — no banner, a healthy
  replacement, a degraded replacement, and *no* replacement — because the last
  of those is the tallest the banner ever gets and is where the composer runs
  out of room first.

These are measured, not eyeballed: the specs compute the rectangles themselves (intersection area, left/right alignment, `scrollWidth > clientWidth`, width before/after focus, height before/after typing) rather than relying on screenshot diffs alone.

Primary tests:

- `tests/e2e/mobile-composer-contract.spec.ts` (the geometry contract itself)
- `tests/e2e/mobile-composer-banner-reflow.spec.ts` (reachability under the
  provider banner, every fallback state, keyboard and safe areas)
- `tests/e2e/mobile-message-visibility.spec.ts` (composer vs. answer-canvas budget)
- `tests/e2e/chat-keyboard-policy.spec.ts`
- `tests/e2e/chat-tools.spec.ts`
- `tests/e2e/web-search-composer-state.spec.ts`
- `tests/e2e/comparison-action-rail.spec.ts`
- `tests/e2e/guest-turnstile-verification.spec.ts` (the verification sheet vs. the composer)
- `tests/e2e/guest-attachment-ai-review-flow.spec.ts` (the guest journey, 320/390/desktop)
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
- [ ] Korean IME was tested, including while attachment state changes
- [ ] Guest attachment states were tested (attached, long filename, upload error)
- [ ] 320px viewport was tested
- [ ] 200% text scaling was tested
- [ ] Keyboard-open state was tested
- [ ] The composer was reached through one scroll owner, not two
- [ ] The provider banner's no-fallback state was tested with the keyboard open
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
- reaching the composer requires scrolling more than one surface, or scrolling
  the page behind the shell;
- a notice above the composer is capped as a fraction of the layout viewport
  rather than the visible one;
- a web-search capability, credit or security warning was removed without an accessible replacement;
- the required regression coverage above is missing from the change.
