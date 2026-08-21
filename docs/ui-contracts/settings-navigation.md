# Settings navigation contract

Scope: the settings list (the Data tab inside `components/auth/AuthButton.tsx`),
the entries that own a detail page — external conversation import, account
memory, assistant profiles and account data — the upward navigation on those
detail pages, and the control that leaves the settings hierarchy.

Owning modules:

- `lib/settingsNavigation.ts` — the destinations, the deep link, the row ids
- `lib/accountSettingsEvents.ts` — the open request and its handoff
- `components/settings/SettingsEntryRow.tsx` — one row in the settings list
- `components/settings/SettingsDetailNav.tsx` — a detail page's upward nav
- `components/settings/SettingsReturnToChat.tsx` — the exit control
- `components/settings/SettingsExitBar.tsx` — the strip that carries it
- `app/(site)/(application)/settings/layout.tsx` — the route shell that
  renders that strip for every `/settings/**` screen

Coverage: `tests/settingsNavigation.test.mjs`,
`tests/e2e/settings-information-architecture.spec.ts` (desktop *and* mobile
projects, same assertions).

## 1. Two movements, two controls

The settings surface is the modal that lives in the sidebar's account card. It
has no URL of its own, but its detail screens are real pages and they nest —
`/settings/imports/conversations/<id>` is three levels below the list. So a
visitor inside settings can want to move in two different directions, and each
one gets its own control. They coexist; neither replaces the other, and
neither may be merged into the other.

**Hierarchical back — one level up, inside settings.** Rendered at the start of
the page by `SettingsDetailNav` (to the settings list) or by the page's own
link (to the import list, to the memory settings). It names its destination:
`settingsSectionHref(section)` from `lib/settingsNavigation.ts`.
`router.back()` is never used — it points at whatever the visitor saw last,
and at nothing at all on a directly-opened URL.

**Global exit — out of settings, in one click, from any depth.** Rendered at
the end of the same top area by the route shell, for every `/settings/**`
screen. Its destination is `settingsExitHref()`, which is exactly `/chat` with
no query string: a `settings=` parameter here would reopen the panel the
visitor just asked to leave, and the bare route is what lets the chat page
restore the tab's own last conversation from its existing `sessionStorage`
state. It never creates a conversation and never clears a selection.

This edge exists because the panel's close button is on the chat surface, and
the chat surface is precisely what a visitor three levels into settings cannot
reach. Requiring them to walk back up one level at a time made the cost of
leaving proportional to how far in they had gone.

Consequences:

- **The exit control belongs to the route shell, not to a page.** It is
  rendered once, in `app/(site)/(application)/settings/layout.tsx`. A new
  `/settings/**` segment inherits it by construction; a detail component that
  renders its own copy is a violation, and so is a shell that renders none.
- **The two controls stay visually and verbally distinct.** Hierarchical back
  reads "back to settings" / "back to imports" and sits on the left; the exit
  reads `settingsNav.backToChat` and sits on the right. A hierarchical link
  must never adopt chat-bound wording, and the exit must never be relabelled
  as a generic "back".
- **The exit is not an `X`.** These are pages, not modals; a close glyph would
  claim to discard or cancel something the control does not touch. It uses a
  `MessageSquare`-family icon and states the destination in words.

The browser's own Back button is not part of this and is never overridden. The
deep link is removed from the address bar with `history.replaceState` — the
current entry is rewritten, no entry is pushed.

## 2. Grouping

Import and memory are **separate features**: separate rows, separate detail
pages, separate state, separate APIs. They are **not merged**, and neither is
promoted into the other.

They are presented under **one group** in the settings list
(`settingsNav.dataAndPersonalization`), as rows — not as two stacked full-width
cards. A row states three things and keeps them distinguishable: its name, what
it does, and where it currently stands.

Adding a third entry with a detail page means adding it to
`SETTINGS_SECTION_IDS` and to that group, not a new card beside it.

## 3. Naming

- Every action label names its own purpose. A generic label repeated across
  entries ("Open settings") is a violation: the two rows' accessible names
  would then differ only by their title.
- The same thing is called the same name everywhere — the group name in the
  panel and the breadcrumb crumb come from the same locale key, so they cannot
  drift.
- **A "back" label must match where the link actually goes.** The detail pages
  go to settings, so they say so, in every locale. Chat-bound wording lives in
  exactly one key, `settingsNav.backToChat`, on the one control that goes to
  the chat; the per-feature `backToChat` strings the detail pages once carried
  stay deleted, so no page can quietly reintroduce a link that says one thing
  and does another.
- **`backToSettings` keeps its meaning.** It is not repurposed, retargeted or
  removed by anything in §1; a locale that changes what it names is changing a
  different control's label.

## 4. Same hierarchy on both shells

Desktop and mobile use the same information architecture, the same row order,
the same words and the same two controls. Desktop additionally renders the
breadcrumb trail (`설정 / 데이터 및 개인화 / <page>`); mobile shows the back link
alone.

The exit control renders on both, with the same destination and the same
accessible name. Only its **visible** label shortens on a narrow viewport
(`settingsNav.backToChatShort`), and that is a width decision made in CSS: the
`aria-label` carries the full phrase at every width, so its name never changes
under a screen reader, and the short form stays part of the full one — what is
on screen is always in the name (WCAG 2.5.3).

Nothing in this navigation may be decided by `layout === "mobile"`, a UA
string, or a device name.

## 5. Accessibility

- The whole row is one link. Its accessible name is stated explicitly
  (`aria-labelledby`: title + action); the description and status ride in
  `aria-describedby` so they never run into the name.
- Every row keeps a visible focus ring and is reachable and activatable from
  the keyboard.
- Returning from a detail page restores the row it was opened from: scrolled
  into view and focused, after the dialog's own initial focus has landed.
- The exit control is a link with a 44×44px minimum target, a visible
  `focus-visible` ring, hover feedback, and light and dark renderings. Its
  strip is sticky, so it stays reachable on a long settings page without
  scrolling back up, and it wraps rather than clipping or overlapping when a
  translation is long or the viewport is narrow.

## 6. Reaching the panel from a cold URL

The panel only exists inside the *expanded* sidebar — not in the collapsed
desktop rail, and on mobile not until the drawer is open. A request made while
it is unmounted is therefore held in `lib/accountSettingsEvents.ts` and claimed
by the panel on mount; the shells expand/open in response. "Back to settings"
must work from a directly-opened detail-page URL on every shell, in every
sidebar state.

The exit control has the same cold-start requirement and meets it more
simply: it is an ordinary link to a static path, so it depends on no history
entry, no referrer and no prior state. It works identically on a URL opened
from a bookmark and on one reached by five clicks.

A change that violates this contract is a release blocker.
