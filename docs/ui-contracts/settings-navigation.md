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

Each is presented as a **row inside the group its tab owns** — not as a stacked
full-width card. A row states three things and keeps them distinguishable: its
name, what it does, and where it currently stands.

Which group a row belongs to is decided by what the feature *does*, not by
which tab happened to exist first:

| Section | Tab | Tab name on screen | Group |
|---|---|---|---|
| `assistants` | `assistants` | `settingsNav.assistantsTab` | the tab itself |
| `memory` | `ai` | `settingsNav.aiPersonalization` | `settingsNav.profilesAndMemory` |
| `external-import` | `data` | `auth.dataTab` | `settingsNav.dataAndPersonalization` |
| `account-data` | `data` | `auth.dataTab` | `settingsNav.dataAndPersonalization` |

**A tab is a home, not a signpost.** The assistants tab renders the collection
— its list, its states and its create action — rather than one row linking to a
page. A tab whose entire content is a link to somewhere else is a redirect with
a label, and it made assistants the only settings collection a user could not
see without leaving settings. The list is one component
(`AssistantProfileListContent`), rendered by the tab and by
`/settings/assistants` alike, so a 403 cannot come to mean two different things.

**Old deep links keep working.** `settings=ai&settingsSection=assistants` was
minted while assistants lived in the AI tab, and `settings=data&...` before
that. The section decides the tab, so both open the assistants tab today. This
is the reason `parseSettingsDeepLink` resolves the tab from the section rather
than trusting the pair.

## 2.0 Product vocabulary

| Surface | Word |
|---|---|
| anything a user reads | **AI assistant** / AI 어시스턴트 |
| code, database, routes, policy | **assistant profile**, `AssistantProfile`, `/api/assistant-profiles`, `/settings/assistants` |

The two are the same object. The rename covers what a user reads and stops at
the boundary: table names, ids, URLs, analytics events and the
`accent-assistant-profile-*` tokens keep the implementation word, because
renaming those is a migration and not a copy change. "Profile" also still means
*account* profile elsewhere in settings, and that use is untouched.

**The tab id and the deep link are stable identifiers; the tab's name is not.**
`ai` and `settings=ai` are what a bookmark carries and never change with the
wording. The AI tab is called **AI personalization** on screen, and the group
inside it is called **Profiles and memory** — named for what it holds, because
a group repeating its tab's name says nothing.

One key, not two: `SETTINGS_TAB_LABEL_KEY` is read by the tab strip *and* by
the breadcrumb. Giving the tab its own `auth.aiTab` is what once put "AI
settings" in the tab strip and "AI personalization" in the trail beneath it.

## 2.1 Ancestry

A page's ancestors are declared as data (`SettingsHierarchy`), and both the
back link and the breadcrumb read that one array — the back link is its last
entry, the trail is all of it. They cannot drift apart, because there is
nothing to drift.

| Page | Ancestors, nearest last |
|---|---|
| settings entry page (imports, memory, profile list) | settings panel |
| a single assistant profile | settings panel → AI personalization → profile list |
| create a profile, from the list | settings panel → AI personalization → profile list |
| create a profile, from a conversation | the conversation (not a settings ancestor: rendered as a plain back link, never as a crumb) |

Each ancestor carries **two** locale keys: `labelKey` for its crumb and
`backLabelKey` for the whole back sentence. The sentence is not assembled from
"Back to {name}" — Korean's particle changes with the noun before it, and every
locale has some version of that problem.

A profile detail page must not offer a link straight to the settings panel. It
sits inside a list, and skipping the list is the mismatch this section exists
to prevent.

`SETTINGS_SECTION_TAB` in `lib/settingsNavigation.ts` is the single source of
that mapping. Three things read it and must never be allowed to disagree: the
row's deep link (`settingsSectionHref`), the panel that opens from it, and the
detail page's breadcrumb (`settingsSectionGroupLabelKey`). A breadcrumb that
hard-codes one group name is a violation — it was correct only while every
section lived in one tab, and it silently mislabels every page the moment one
does not.

Returning from a profile to the list may ask the list to restore a row, through
a query parameter. The id is looked up **against the list's own loaded
profiles** and never interpolated into a selector, so a value naming nothing
restores nothing and a crafted one has nowhere to go. An id that no longer
matches — a profile deleted from its own page — focuses the list heading rather
than leaving focus on `<body>`.

## 2.2 The model finder CTA

The recommendation CTA belongs **inside** `settings-new-conversation-models`,
below a divider, as a secondary action. It is not a setting of its own: it is
another way to decide the combination directly above it, and standing between
two cards as a full-width primary button is what made it read as a third
top-level entry.

Its wording must not assume a previous run — the settings screen cannot know
whether this visitor has ever opened the finder. It uses `Sparkles`, the
suggestion vocabulary, not the `Bot` that means a profile.

If the combination has unsaved edits, the CTA states that they will be lost and
offers continue or cancel. Saving on the visitor's behalf is **not** the
handling: this panel's save sends every dirty field, so it would also persist a
theme or language change nobody agreed to yet.

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
