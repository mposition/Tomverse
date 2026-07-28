# Comparison Action Rail UI Contract

## Status

- Contract type: Non-negotiable product invariant
- Applies to: The comparison action rail in both shells — desktop and mobile — and every compact/responsive variant of them
- Severity when violated: Release blocker
- Owners: Product Design, Frontend, Accessibility, QA
- Last reviewed: 2026-07-28

## Scope

| Area | File |
| --- | --- |
| Rail markup, actions, status sentence, per-action descriptions | `components/chat/ComparisonActionRail.tsx` |
| State derivation and the visibility policy (pure functions) | `lib/comparisonReadiness.ts` |
| Desktop bottom workflow dock | `components/chat/DesktopChatShell.tsx` |
| Mobile bottom dock and keyboard/landscape compaction | `components/chat/MobileChatShell.tsx` |
| Pre-run scope and run metadata | `components/chat/ComparisonReviewDialog.tsx` |
| Copy | `locales/*.ts` (`chat.comparisonRail*`) |

## Purpose

`Comparing 3 completed answers` describes what a comparison will run against. In
the steady state that fact is already carried by the model panels/tabs above and
by the two enabled action buttons with their own credit badges, so keeping it on
screen is repetition that costs a row of answer canvas. The moment the state is
anything other than steady, the same sentence is the only thing telling the user
what will happen and what to do — so it comes back.

## One policy, both shells

**The visible/hidden decision must never be made from `layout === "mobile"`, a
media query, or any other shell-shaped condition.** Both shells call the same
pure function:

```ts
// lib/comparisonReadiness.ts
shouldShowVisualStatus({ readiness, isBusy, isAnyActionUnaffordable, isCollapsed })
```

`isCollapsed` is a *viewport* fact (the rail is behind its disclosure button
because an on-screen keyboard or landscape left no room), not a desktop/mobile
one. "The desktop has space for it" is explicitly not a reason to show more.

## Steady state (status hidden)

All of the following hold:

- `readiness.state === "ready"` and `readiness.canRun`
- `generatingCount === 0`
- `excludedCount === 0`
- `pausedCount === 0`
- `readyCount === comparableCount === selectedCount`
- no comparison analysis is in flight (`isBusy === false`)
- neither action is blocked by credits

Then, in **both** shells:

- the status sentence is visually hidden (`sr-only`), never removed from the DOM
  and never `display:none`/`hidden`/conditionally unrendered;
- the rail keeps **no** leftover row height and no orphaned bottom gap — the
  padding the sentence carried moves onto the section instead;
- `Quick difference summary`, `AI answer cross-review`, both credit costs and
  the help control stay visible;
- the comparison target count stays reachable through each action's own
  `aria-describedby` description.

## Visible state (status on screen)

Any one of these puts the sentence back on screen, in both shells:

- some answers still generating — `2 of 3 complete · 1 still generating`
- too few completed answers — `one more completed answer is needed`
- a failed/stopped/paused answer excluded — `Comparing 2 completed answers · 1 unfinished excluded`
- selected model count ≠ actual comparison target count (a paused panel)
- a comparison analysis running — `Running the AI analysis...`
- the quick summary blocked by credits — `Differences · 1 credits needed · 0 available`
- the cross-review blocked by credits — `AI review · 4 credits needed · 2 available`
- any other reason an action cannot run

In these states the status element must have a genuinely readable bounding box
— not the 1×1 clipped box of `sr-only`.

## Collapsed rail exception

While the rail is collapsed behind its disclosure button (on-screen keyboard,
landscape, or any viewport too short for the full rail):

- the status row may stay visually hidden;
- the disclosure button must carry the exact state through its own
  `aria-describedby`;
- expanding must put the sentence back on screen when the state is an exception.

## Accessibility requirements

- The comparison target count is available **once** per action, through that
  action's `aria-describedby` — not duplicated into its accessible name.
- Each action's accessible name is the action alone: `Quick difference summary`,
  `AI answer cross-review`.
- The two actions cost different amounts, so they must never share one
  "not enough credits" sentence. Each description names its own price, its own
  balance and its own reason for being unavailable.
- A disabled/blocked reason must never live only in a `title` attribute.
- Blocked actions stay focusable and keep their description on focus.
- `aria-live="polite"` announces changing progress only (generating, running).
  The static steady-state target count must never be re-announced on render.

## Commercial UX requirements

- Hiding the steady-state sentence must not reduce the discoverability of the
  comparison feature: both actions stay on screen, never behind a "more" menu.
- Both credit costs stay visible on the buttons themselves.
- The pre-run setup/confirmation screen names the scope explicitly
  (`Comparing 3 completed answers.` — `comparison-review-scope`).
- A finished analysis keeps the number of answers it actually covered as
  metadata (`ai-review-compared-count`).
- When answers are excluded, the exclusion is always on screen, so nobody can
  believe every model was compared when it was not.

## Layout requirements

Desktop:

- No empty row and no leftover bottom padding once the sentence is hidden.
- The rail keeps the composer's alignment axis (`max-w-4xl`, same left/right
  edges) at 768/1024/1280/1440/1920px.
- One seam only: the rail owns the top border; the composer must not draw a
  second one.

Mobile:

- The steady rail stays a compact, button-first row.
- Vertical space returned to `ChatMessageList` must not be spent again on
  padding.
- At 320px the labels, credit badges and help control must not overlap.
- The composer's own contract (`docs/ui-contracts/mobile-chat-composer.md`) is
  unaffected: the textarea keeps its dedicated full-width row.

Both:

- Reading and DOM order stays answers → comparison actions → composer.
- The bottom dock must not cover the last message.
- Hiding the sentence must not shift the action row or cause visible layout
  jumps (the actions keep their position and size; only the sentence goes).

## Required state test matrix

Verified for **both** desktop (1440×900) and mobile (390×680):

| # | State | Status row |
| --- | --- | --- |
| 1 | 3 answers complete | hidden (`sr-only`), a11y-only |
| 2 | 2 complete, 1 generating | visible |
| 3 | 2 complete, 1 excluded by error | visible |
| 4 | 1 usable answer (needsMore) | visible |
| 5 | quick summary running | visible |
| 6 | quick summary short of credits | visible, names the quick action |
| 7 | only the cross-review short of credits | visible, names the review action only |
| 8 | both actions short of credits | visible, names both prices |
| 9 | replayed (cached) quick summary, 0 credits | hidden (still steady) |
| 10 | guest cross-review locked | hidden in the steady state; the lock stays visible |
| 11 | rail collapsed by the mobile keyboard | hidden, carried by the disclosure |
| 12 | expanded again after collapse | visible when the state is an exception |

## Automated regression contract

A change touching the rail must verify, not merely grep for a string:

- visual exposure (`data-status-hidden`, plus a measured bounding box);
- accessibility-tree presence of the same sentence in the steady state;
- the rail's leftover height/gap under the actions when hidden;
- each button's own `aria-describedby` target and its content;
- desktop and mobile reaching the same decision for the same state;
- no horizontal overflow;
- the collapsed and re-expanded states.

Primary tests:

- `tests/comparisonReadiness.test.mjs` — the policy matrix as unit tests
- `tests/e2e/comparison-action-rail.spec.ts` — both shells, states 1–12
- `tests/e2e/mobile-message-visibility.spec.ts` — the rail's share of the mobile shell
- `tests/e2e/chat-state-visual-regression.spec.ts` — desktop/mobile goldens

```bash
npm run test:unit
npx playwright test --project=desktop-chromium tests/e2e/comparison-action-rail.spec.ts
```

## Change checklist

- [ ] The visible/hidden decision still comes from `shouldShowVisualStatus`
- [ ] No shell-specific copy of the condition was introduced
- [ ] Steady state hides the sentence on desktop **and** mobile
- [ ] The sentence is still in the DOM and in the accessibility tree
- [ ] No empty row or bottom gap remains when hidden
- [ ] Every exception state is visible with a readable box
- [ ] Each action's credit-shortfall reason names only its own action
- [ ] Collapsed rail carries the state on its disclosure button
- [ ] Unit + e2e state matrix passes for both shells
- [ ] Visual goldens reviewed

## Release blocker criteria

`NO-GO` if any of the following is true:

- desktop and mobile disagree about showing the status for the same state;
- the steady-state sentence is visible in either shell;
- the sentence is removed from the DOM/accessibility tree instead of being
  visually hidden;
- a hidden sentence still costs a visible row or leaves a bottom gap;
- an exception state (generating, needsMore, excluded, busy, insufficient
  credits) is not visible;
- one action's credit shortfall is described on the other action;
- a blocked reason is reachable only through `title`;
- the comparison actions or their prices become less discoverable.
