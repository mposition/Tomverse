# Settings navigation contract

Scope: the settings list (the Data tab inside `components/auth/AuthButton.tsx`),
the two entries that own a detail page — external conversation import and
account memory — and the upward navigation on those detail pages.

Owning modules:

- `lib/settingsNavigation.ts` — the destination, the deep link, the row ids
- `lib/accountSettingsEvents.ts` — the open request and its handoff
- `components/settings/SettingsEntryRow.tsx` — one row in the settings list
- `components/settings/SettingsDetailNav.tsx` — a detail page's upward nav

Coverage: `tests/settingsNavigation.test.mjs`,
`tests/e2e/settings-information-architecture.spec.ts` (desktop *and* mobile
projects, same assertions).

## 1. Settings is a panel, not a route

The settings surface is the modal that lives in the sidebar's account card. It
has no URL of its own. Two consequences the rest of this document rests on:

- **Leaving settings entirely is the panel's close action.** A detail page must
  not carry its own link to the chat. Adding a second, chat-bound link at the
  top of a detail page is a contract violation.
- **A detail page cannot navigate up by history.** `router.back()` points at
  whatever the visitor saw last, and at nothing at all on a directly-opened
  URL. Upward navigation names its destination:
  `settingsSectionHref(section)` from `lib/settingsNavigation.ts`.

The browser's own Back button is not part of this and is never overridden. The
deep link is removed from the address bar with `history.replaceState` — the
current entry is rewritten, no entry is pushed.

## 2. Grouping

Import and memory are **separate features**: separate rows, separate detail
pages, separate state, separate APIs. They are **not merged**, and neither is
promoted into the other.

Each is presented as a **row inside the group its tab owns** — not as a stacked
full-width card. A row states three things and keeps them distinguishable: its
name, what it does, and where it currently stands.

Which group a row belongs to is decided by what the feature *does*, not by
which tab happened to exist first:

| Section | Tab | Group |
|---|---|---|
| `assistants` | `ai` | `settingsNav.aiPersonalization` |
| `memory` | `ai` | `settingsNav.aiPersonalization` |
| `external-import` | `data` | `settingsNav.dataAndPersonalization` |
| `account-data` | `data` | `settingsNav.dataAndPersonalization` |

`SETTINGS_SECTION_TAB` in `lib/settingsNavigation.ts` is the single source of
that mapping. Three things read it and must never be allowed to disagree: the
row's deep link (`settingsSectionHref`), the panel that opens from it, and the
detail page's breadcrumb (`settingsSectionGroupLabelKey`). A breadcrumb that
hard-codes one group name is a violation — it was correct only while every
section lived in one tab, and it silently mislabels every page the moment one
does not.

Adding an entry with a detail page means adding it to `SETTINGS_SECTION_IDS`,
naming its tab in `SETTINGS_SECTION_TAB`, and putting it in that tab's group —
not a new card beside it.

## 3. Naming

- Every action label names its own purpose. A generic label repeated across
  entries ("Open settings") is a violation: the two rows' accessible names
  would then differ only by their title.
- The same thing is called the same name everywhere — the group name in the
  panel and the breadcrumb crumb come from the same locale key, so they cannot
  drift.
- **A "back" label must match where the link actually goes.** The two detail
  pages go to settings, so they say so, in every locale. The chat-bound
  wording is removed from the bundle rather than left unused.

## 4. Same hierarchy on both shells

Desktop and mobile use the same information architecture, the same row order
and the same words. Desktop additionally renders the breadcrumb trail
(`설정 / 데이터 및 개인화 / <page>`); mobile shows the back link alone. The back
link is the only interactive element in either layout, so the two can never
disagree about what a control does.

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

## 6. Reaching the panel from a cold URL

The panel only exists inside the *expanded* sidebar — not in the collapsed
desktop rail, and on mobile not until the drawer is open. A request made while
it is unmounted is therefore held in `lib/accountSettingsEvents.ts` and claimed
by the panel on mount; the shells expand/open in response. "Back to settings"
must work from a directly-opened detail-page URL on every shell, in every
sidebar state.

A change that violates this contract is a release blocker.
