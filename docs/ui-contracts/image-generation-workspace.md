# Image Generation Workspace UI Contract

## Status

- Contract type: Non-negotiable product invariant
- Applies to: The image generation workspace, its four entry points, and the catalogue's image tab — desktop and mobile alike
- Severity when violated: Release blocker
- Owners: Product Design, Frontend, Accessibility, QA
- Last reviewed: 2026-08-05

The product rules behind this contract live in
`docs/policy/image-generation.md` (v2, §11–§15). This document is the UI
half: what must be on screen, in what shape, and what a change may not do.
Where the two overlap the policy wins; where the policy is silent about
rendering, this contract is the answer.

## Scope

| Area | File |
| --- | --- |
| Workspace: composer, option rows, timeline, comparison grid | `components/images/ImageGenerationWorkspace.tsx` |
| Unified new-conversation launcher (split button / menu rows) | `components/chat/NewConversationLauncher.tsx` |
| Catalogue `Chat \| Image` tabs | `components/chat/ModelPickerPanel.tsx` |
| Image tab rows, hold state, "from" pricing | `components/chat/ImageModelTabPanel.tsx` |
| Composer tools-menu entry and the picker wiring | `components/chat/ChatInput.tsx` |
| Draft carry-over/restore, lock derivation, workspace mounting | `app/(site)/(application)/chat/ChatPageClient.tsx` |
| Sidebar placement of the launcher | `components/chat/ChatSidebar.tsx` |
| Which models exist, their prices and their holds | `lib/imageModelRegistry.ts` |
| Group polling endpoint the timeline reads | `app/api/images/groups/[groupId]/route.ts` |
| Current-attempt and group-status derivation | `lib/imageGenerationStateCore.ts`, `lib/imageGenerationRead.ts` |
| Timeline merge rules (stale answers, asset URL churn) | `lib/imageTimelineMerge.ts` |
| Copy | `locales/*.ts` (`chat.imageGeneration*`, `chat.imageModel*`, `chat.modelPickerTab*`, `sidebar.newImage*`) |

## Purpose

Image generation is a **multi-model comparison** surface that happens to
support one model as its degenerate case. Every rule below exists so that the
user knows, before spending anything, *which* models will run and *what* the
run costs — and so that a viewer who cannot use the feature learns that at the
entry point rather than at the submit button.

## Entry points

There are exactly four, and no standalone "New image" button:

1. Desktop sidebar **split button** — the primary click stays "new chat"; the
   caret opens the menu that holds image generation.
2. Mobile drawer — the same launcher, rendered as **full-size menu rows**. The
   caret is never shrunk into a sub-44px target to fit a phone.
3. Chat composer **tools menu** → image generation, which switches to the image
   draft client-side.
4. Model catalogue → **image tab** (see below).

Requirements:

- The launcher renders once per shell. A second image button anywhere is a
  contract violation, not a convenience.
- The menu is a real menu: `role="menu"`/`role="menuitem"`, focus moves into it
  on open, Escape closes it and returns focus to the trigger.
- Switching to the image draft creates **no server row**. The conversation only
  exists once a generation is actually reserved (policy §6).

## Locked exposure, everywhere

Guest and Free viewers **see** every image entry point. They are never hidden,
never disabled-with-no-explanation, and never allowed to reach a prompt box
that will refuse them.

| Viewer | Entry renders | Click goes to |
| --- | --- | --- |
| Guest | visible, `data-locked="true"`, sign-in requirement stated | the sign-in prompt |
| Free | visible, `data-locked="true"`, plan requirement stated | `/pricing` |
| Pro/Max | visible, unlocked | the workspace |
| Flag off | **absent** — the feature does not exist for anyone | — |

Requirements:

- The requirement is stated **before** entry, in the row itself — not after a
  click, and not as the reason a submit button is disabled.
- A locked row keeps its full touch target, label and focus ring. "Locked" is
  not a reason to make a control smaller or quieter.
- UI exposure is not the security boundary: the server re-checks entitlement on
  every request regardless of what the client rendered.

## Two catalogues, never one list

In the chat catalogue, "image" already means the model accepts image **input**
(`modelSupportsImageInput`). Image **generation** models are a different
capability with different pricing, so:

- they live behind their own tab (`model-picker-tab-image`), never as a filter
  or a section inside the chat model list;
- switching to the image tab removes the chat-shaped chrome that does not
  describe it — the model search box and the `n/3 models` selection count;
- the chat tab's credit estimate is never shown over the image list.

Tab requirements:

- `role="tablist"` with roving `tabIndex`, automatic activation, and focus
  following the selection (Arrow keys, Home, End).
- Escape steps back to the chat tab before it closes the dialog — the same
  level the back arrow returns to.
- Both tabs stay visible in both tabs' panels; the image tab is not a one-way
  door.

## The image tab's rows

- **Every registered model is listed**, including the ones the
  price-verification rule holds disabled. A model the product has decided about
  but cannot yet run is stated as a hold (`image-model-hold-note`), never
  silently absent — otherwise the catalogue answers "why is this model
  missing?" with nothing. The e2e assertion counts holds from the registry
  rather than hard-coding a number, so registering another candidate is not a
  test failure.
- A held row is `disabled` and carries no clickable path to a run. Only the
  verification state changes that; never a click.
- Prices are quoted as **"from N credits"** — the cheapest option — because the
  tab does not know which quality and size the composer will land on. The
  composer, which does know, is the only place an exact price is stated.
- Provider names are brands (`OpenAI`, `Google`, `xAI`) and are never translated.

## Workspace layout

The workspace obeys the mobile composer contract's *shape*
(`docs/ui-contracts/mobile-chat-composer.md`), even though it is a different
component:

- The textarea owns a dedicated full-width row (`image-composer-textarea-row`)
  with at least one complete visible input line.
- Model selection, quality and size each get their **own** row above or below
  it. None of them may share the textarea's horizontal row, overlap it, or
  float above it.
- No absolute positioning, negative margins or transforms are used to place a
  control beside the textarea.
- Model selection sits **above** the textarea: the price the composer quotes is
  decided before the prompt is written.

### Model disclosure threshold

With **three or fewer** enabled image generation models the composer exposes
every one of them as an inline choice. From **four**, only the selected models
stay inline and the unselected ones move into the model picker
(`shouldUseCompactImageModelPicker()`, `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`).

In **either** mode the composer keeps, uncollapsed and outside any picker:

- each submitted model's own label and its **exact** credit price;
- the group total;
- in compact mode, the fact that more models exist and how many.

The switch is decided by the **number of enabled models**. Never by viewport,
never by how many are selected, never by measuring wrapped lines. A
viewport-driven switch gives one account a different information structure per
device and re-shapes the composer mid-rotation; a selection-driven one changes
structure while the user is still choosing; a measurement-driven one makes the
same state render differently for reasons no test can pin. Desktop and mobile
get the same structure.

The threshold is three because at two and three a viewer discovers the second
and third model without a click, and multi-model comparison is the product — a
feature nobody is shown is a feature nobody uses. It is **not**
`IMAGE_GROUP_MAX_MODELS`: that bounds how much provider work one request may
start and is deployment-tunable, this bounds one row of UI. Neither may be
derived from the other.

A chip may show `shortName`; the accessible name always carries the full
`name`. Abbreviating the label must not abbreviate the model's identity.

## Chat surfaces stay out

An image conversation must never mount `ChatInput`, `ChatApp`, or the
comparison action rail (policy §1). The result grid borrows the rail's
**principles** — state-driven disclosure through pure predicates, no
shell-shaped conditions, per-action reasons on the action itself — but must not
import `ComparisonActionRail` or `shouldShowVisualStatus()`.

AI Review and the comparison summary stay disabled in image conversations.
Comparing images is not a reason to enable them.

## Group and attempt rendering

Group state is **derived from the latest attempt of each target, never
stored** — the same rule the server follows (policy §11). Therefore:

- one `image-comparison-card` per target, never per attempt;
- a retry replaces that target's card in place; the group keeps its shape and
  its `image-generation-entry` count does not change;
- older attempts stay in the payload as audit history and must not render as
  extra cards;
- the prompt is shown once per group, not once per model;
- a succeeded target offers no re-run control (double charging is refused
  server-side, and the UI must not invite it).

The grid is two columns from `sm` upward when a group has more than one target,
and stacked below that. Each card names its model when the group has more than
one target.

### Polling is per group, never per model

The workspace polls `GET /api/images/groups/{groupId}` — one request per
unsettled group, whatever the model count (policy §11). Polling per generation
is a contract violation, not a style preference:

- The read cost of watching a comparison would scale with the number of models
  compared, which is the feature itself. At the 5s cadence a five-model group
  spends its own 60/minute status allowance exactly, and a group stuck until
  the stale sweep spends thousands of the daily allowance.
- A refused poll reads to the client as "no update", so exhausting that
  allowance surfaces as a workspace that silently stops refreshing — the user
  is told nothing and the generation they paid for looks stuck.

`GET /api/images/generations/{generationId}` stays, for one job only:
re-reading a single card whose signed asset URLs expired. It is not a polling
path.

**A settled card keeps the asset URLs it already has.** Signed URLs are minted
fresh on every read, so a group poll answers with a *different* URL string for
an image that has not changed — and taking it rewrites the `<img>` src, so the
browser downloads the same bytes again on every tick, for every target that
finished before the slowest one in its group. Per-generation polling never hit
this because it only read unsettled rows; reading the whole group is what put
finished cards in every answer. `mergeImageTimelineRow()` in
`lib/imageTimelineMerge.ts` owns the rule, and the single-card recovery read is
the only caller permitted to replace the URLs — it exists because they expire.

Which attempt is a target's current state is decided by
`currentImageAttempt()` in `lib/imageGenerationStateCore.ts`, and the group's
status by `deriveImageGroupStatusFromTargets()`. Neither the route nor the
client may re-derive it: handing every attempt to the derivation would let an
already-retried failure report `partial_success` while the retry is running.

## Price and credit display

- Per-model price and the group total are shown **before** submitting, never
  only after.
- A selected model with no resolvable price disables submission rather than
  quoting a guess.
- The last selected model cannot be removed: a composer that looks ready must
  not refuse on submit.
- Refunds are visible on the failed card (`data-refunded`), and the failure
  reason is distinguished structurally (`data-error-kind="moderation"` vs
  `"generic"`) rather than only in prose.
- Raw internal USD never appears. Credits are the only unit the user sees.

## Draft carry-over

Switching from the chat composer carries the typed text into the image prompt,
and cancelling restores the chat draft **in the conversation it belonged to**.

- Attachments are never silently dropped: image generation is text-only, so the
  attachments stay on the restored chat draft.
- The back control (`image-generation-cancel-draft`) exists only when there is a
  draft to go back to.
- Arriving from the image tab seeds the picked model; an id the registry does
  not list as enabled is dropped rather than trusted.

## Assets and provenance

- Asset URLs are short-TTL signed URLs (`IMAGE_ASSET_URL_TTL_SECONDS`, 300s),
  never persisted client-side, and re-read **once** when an `<img>` fails after
  expiry.
- Raw R2 keys never leave the server.
- Every rendered image carries the AI-generated label in both its `alt` text and
  a visible caption. Removing either is a contract violation.
- Assets exist only for a succeeded generation; a failed attempt must not
  surface a partially written object.

## Accent colour role

The workspace, the launcher and the image tab use `accent-image-*` tokens only
(fuchsia, per `AGENTS.md`). Raw accent utilities are forbidden in these files
and `npm run check:accent-tokens` enforces it. The AI Review gradient
(`cyan → blue → purple`) is reserved and must not appear on any image surface.

## Required state matrix

Verified for **both** desktop and mobile projects:

| # | State | Expected |
| --- | --- | --- |
| 1 | flag off | no entry point renders anywhere |
| 2 | Guest | entries visible and locked; click reaches the sign-in prompt |
| 3 | Free | entries visible and locked; click reaches `/pricing`, never a prompt box |
| 4 | Pro, single model | end-to-end run; price quoted before submit |
| 5 | Pro, multiple models | one POST carrying every `modelIds`; total = sum of per-model prices |
| 6 | moderation failure | reason and refund both stated on the card |
| 7 | failed target retried | one entry, one card per target after the retry |
| 8 | over-limit prompt | submission disabled before any request is made |
| 9 | reload | timeline rebuilt from the server, not from client memory |
| 10 | image tab | separate list; no chat rows, no chat selection count |
| 11 | held models | every one listed, disabled, hold stated |
| 12 | picked from the image tab | workspace opens seeded with that model |
| 13 | composer draft carry-over | text carried; cancel restores it exactly |
| 14 | multi-model group polling | one `/api/images/groups/*` request per tick, not one per model |
| 15 | two providers in one group | both prices quoted, total is their sum, one POST carrying both ids |
| 16 | option one selected model cannot price | submission disabled; re-enabled when the option changes back |
| 17 | draft promoted to a conversation | model selection, quality and size survive; the prompt clears and does not come back |
| 18 | switch to a different image conversation | timeline and poll loop do not follow |
| 19 | Enter on desktop / mobile / mid-IME | submit / newline / never submit |
| 20 | enabled model count 2, 3, 4 | inline, inline, compact — with every selected price still visible |

## Automated regression contract

A change touching any file in Scope must run:

```bash
npm run test:unit
npm run check:accent-tokens
npm run check:image-pricing
npx playwright test tests/e2e/image-generation-workspace.spec.ts \
  --project=desktop-chromium --project=mobile-chromium
```

and, because the launcher and the picker live inside the chat shells, the
neighbouring contracts' specs:

```bash
npx playwright test tests/e2e/mobile-composer-contract.spec.ts \
  tests/e2e/mobile-short-viewport-drawer.spec.ts \
  tests/e2e/model-picker.spec.ts \
  --project=desktop-chromium --project=mobile-chromium
```

Assertions must be structural (`data-locked`, `data-error-kind`,
`data-refunded`, `data-held`, element counts, URLs), not copy matches: the
authenticated fixture pins a language, so a copy assertion tests the fixture
rather than the behaviour.

## Change checklist

- [ ] No standalone "new image" button was reintroduced
- [ ] Every entry point still renders for Guest/Free, locked and stated up front
- [ ] Flag off still removes the feature entirely
- [ ] Image generation models are still a separate catalogue from chat models
- [ ] Held models are still listed with their hold, and still not selectable
- [ ] The textarea still owns its own full-width row
- [ ] No chat-only surface (ChatInput, ChatApp, comparison rail, AI Review) mounts
- [ ] Group state is still derived from the latest attempt per target
- [ ] Polling is still one request per group, through the group endpoint
- [ ] A settled card still keeps its asset URLs across polls
- [ ] Composer settings survive draft promotion, and remount still isolates a real conversation switch
- [ ] Enter behaviour comes from `getChatEnterKeyAction()` with the IME guard
- [ ] Selected models' exact prices are inline in both disclosure modes
- [ ] A retry still replaces its card in place
- [ ] Prices are quoted before submit, per model and in total
- [ ] `accent-image-*` tokens only; no reserved gradient
- [ ] The state matrix passes on desktop **and** mobile

## Release blocker criteria

`NO-GO` if any of the following is true:

- an image entry point is hidden from a viewer who could upgrade into it, or
  blocks them only at the last step;
- the feature renders at all while the flag is off;
- image generation models appear inside the chat model list, or the chat list's
  image-input filter is reused to mean generation;
- a held model is selectable, or is silently absent;
- the textarea loses its dedicated row, or a control overlaps it;
- an image conversation mounts a chat-only surface, or enables AI Review;
- a retry adds a card instead of replacing one, or a succeeded target can be
  re-run from the UI;
- a price is quoted after submission instead of before, or a model with no
  resolvable price can be submitted;
- a generated image renders without its AI-generated label;
- a signed asset URL is persisted client-side, or an R2 key reaches the client;
- raw internal USD appears in any user-visible surface.
