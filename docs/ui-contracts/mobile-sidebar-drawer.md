# Mobile sidebar drawer: reachability on a short viewport

Owner contract for `SHORT-VIEWPORT-001`. Read this before changing
`components/chat/MobileChatShell.tsx`'s drawer, `components/chat/ChatSidebar.tsx`'s
`isMobileDrawer` layout, `components/chat/useVisualViewport.ts`, or the account
footer inside the drawer (`AuthButton`, `UserUsageSummary`, `FeedbackButton`).

## The problem this encodes

The drawer's pinned layout -- fixed header, fixed account footer, a scrolling
conversation list between them -- has a minimum height. Measured on the build at
`cb57c8d`, guest, organizer collapsed:

| Band | Height |
|---|---|
| Sidebar header + New Chat + search/organizer | 245px |
| Conversation list floor (`min-h-[10rem]`) | 160px |
| Account footer (usage + language + login + analytics + feedback) | 233-253px |
| **Total** | **638-658px** |

Below that the footer does not shrink and the list does not go under its floor,
so the footer simply left the bottom of the panel. The only scroller in the
drawer was the conversation list, and the footer is not inside it, so there was
no scroll path to the footer at all. At 382x560 the guest analytics/cookie
button's box was `542..582` against a 560px viewport with a list scroll range of
0: on screen in the DOM, invisible and unreachable to the user.

## Non-negotiable requirements

1. Every drawer control is either visible or reachable by **one** vertical
   scroll: close, New Chat, chat search, Organizer tools, conversation items and
   their menu, guest/account usage, the language control, the account action for
   the current state (login / account menu), analytics-cookie settings, and
   feedback.
2. Reachable means measurable: after scrolling, the control's **centre point**
   is inside the *visible* viewport and `document.elementFromPoint` at that
   centre returns the control or one of its descendants. `toBeAttached()` and a
   programmatic `.click()` both pass on a build where the control is off-screen,
   so neither is evidence.
3. **One scroll owner at a time.** When the drawer scrolls, the conversation
   list must not also be a scroller. Whichever region owns the scroll must
   contain every control listed above.
4. The switch is driven by the **visible** viewport (`visualViewport.height`
   via `useShortViewport()`), never by `window.innerHeight`, a CSS
   `max-height` media query, a device name, or a user-agent string. A phone
   whose bottom 320px is under the keyboard still reports 844px of layout
   height, and that is precisely the case that must switch.
5. A drawer that is fixed to the layout viewport must subtract
   `useKeyboardInset()` from its bottom, or its footer sits underneath the
   keyboard no matter how well it scrolls.
6. Nothing here may be paid for by hiding a control, moving one behind a
   "more" affordance, shrinking a touch target, going below the 11px text
   floor, or dropping an accessible name or focus ring.
7. The footer may not be floated over conversation content with
   `position: absolute` / `fixed`, and the page behind the drawer must never
   scroll in its place.
8. `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` stay as padding
   on the drawer panel, so the scroll region ends above the home indicator.
9. `Escape`, backdrop dismiss, the close button, focus trapping and focus
   return all keep working, including after the drawer has been scrolled.
10. Zero horizontal overflow, in the document and inside the drawer, at 100%
    and 200% root text size.

## How it is implemented

- `useShortViewport()` (`components/chat/useVisualViewport.ts`) is true when the
  visible viewport is under `MIN_PINNED_DRAWER_HEIGHT` (700px: the 658px
  measured above, rounded up for locale, font and rounding slack).
- Tall enough: unchanged. The conversation list is the scroller; header and
  footer stay pinned; the drawer itself never overflows.
- Shorter: the conversation list becomes `flex-none overflow-visible` and the
  organizer panel drops its own `max-height` scroller, so the drawer
  (`aside[data-testid="chat-sidebar"]`, `overflow-y-auto overscroll-contain`)
  is the single scroll region -- header, list and footer all inside it.
  `flex-none` rather than a smaller floor: a shrinkable item with visible
  overflow would paint its rows over the footer.
- The sidebar header is `sticky top-0` in the drawer, because the panel-anchored
  close button floats over that row; without it the button would come to rest on
  top of scrolled conversation rows.
- The account footer carries `mt-auto` in the drawer, so a drawer whose content
  is shorter than the panel still puts the footer at the bottom. Auto margins
  resolve to 0 when the content overflows, so this can never push the footer out
  of the scroll region.
- The drawer panel takes `bottom: useKeyboardInset()` while the keyboard is up.

## Regression coverage

`tests/e2e/mobile-short-viewport-drawer.spec.ts` is the contract's test. It must
keep covering, in one run:

- 320x480, 360x520, 382x560, 320x568, 390x568, 568x320, 667x375 (short) and
  390x844 (normal height, no regression)
- guest en/light, guest ko/dark and authenticated, each with its own account
  action
- 0/1/many conversations, organizer collapsed and expanded, 100% and 200% root
  text size
- height shrink and rotation with the drawer already open, and a raised
  on-screen keyboard
- focus walk through the whole trap, backdrop / Escape / close-button dismissal,
  body scroll position, and horizontal overflow

A change that violates this contract is a release blocker.
