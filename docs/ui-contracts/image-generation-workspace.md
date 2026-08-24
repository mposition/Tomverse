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
| Operations view (budget, registry, invariants) | `components/admin/AdminImageGenerationPanel.tsx`, mounted at `/admin/providers` |
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

There are exactly five, and no standalone "New image" button:

1. Desktop sidebar **split button** — the primary click stays "new chat"; the
   caret opens the menu that holds image generation.
2. Mobile drawer — the same launcher, rendered as **full-size menu rows**. The
   caret is never shrunk into a sub-44px target to fit a phone.
3. Chat composer **tools menu** → image generation, which switches to the image
   draft client-side.
4. Model catalogue → **image tab** (see below).
5. Chat composer **image-request handoff chip** — offered while the draft is
   being typed, when the draft is an unmistakable raster-generation request.

Requirements:

- The launcher renders once per shell. A second image button anywhere is a
  contract violation, not a convenience. The chip is not a second launcher: it
  is state-driven, appears at most once per draft, and offers the same handoff
  the tools menu already performs.
- The menu is a real menu: `role="menu"`/`role="menuitem"`, focus moves into it
  on open, Escape closes it and returns focus to the trigger.
- Switching to the image draft creates **no server row**. The conversation only
  exists once a generation is actually reserved (policy §6).

### The handoff chip is an entry point, not an execution

Non-negotiable, and the reason this entry point was allowed to exist at all
(policy §13):

- **The user must press it.** Switching to the image draft without a press —
  because the text "looked like" an image request — is forbidden. The chip
  changes nothing until it is clicked.
- **Submitting a generation without confirmation is forbidden.** Price and
  model selection stay where they are: quoted in the workspace composer before
  submission.
- **A visible chip never blocks an ordinary chat submit.** Ignoring it and
  pressing send sends the chat turn.
- **Guest and Free see the requirement inside the chip**, before the click, and
  the click routes to sign-in or `/pricing` — the same locked-exposure rule the
  table below states for every other entry point.
- **With the flag off the chip does not render**, like every other entry point.
- The chip is offered only for unmistakable raster generation. A text-dense
  chart or infographic, a request to edit or reference an attached image, and a
  request to describe an attached image are all **out of scope** and get no
  chip — routing them to a text-to-image workspace would be a wrong answer, not
  a helpful one.
- It obeys the mobile composer contract: its own full-width row above the
  textarea, never sharing, overlapping or floating above it, and it is
  suppressed during IME composition so a chip cannot resize the composer
  mid-word.

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

### Composer state lifecycle

The composer's settings belong to the conversation, not to a React mount.

- **A draft becoming the conversation it just created is not a switch.** The
  model selection, quality and size survive it; only the prompt clears, and the
  entry point's seed is dropped so it cannot re-fill the box with a prompt the
  user has already paid to generate.
- **A real conversation switch still remounts.** The workspace owns a timeline
  and a poll loop that belong to one conversation, and neither may follow the
  user. The remount key is explicit state, never derived from the conversation
  id — deriving it is what made promotion look like a switch.
- **Re-entering an image conversation restores its last comparison**, from
  `composerRestore` on the history read (`deriveImageComposerRestore()`). One
  round trip, one server moment: the timeline and the composer's starting state
  must not come from two different reads.

What restore may and may not do:

| Rule | Why |
| --- | --- |
| The latest group is chosen by the **group's** `createdAt`, id as tiebreak | retrying an older group's failed target writes the newest generation row in the conversation |
| A target's current attempt is `currentGenerationId`, falling back to the highest `attemptNumber` | the same contract `currentImageAttempt()` already owns |
| Models come back in **registry order** | selection order is recorded nowhere and carries no product meaning |
| Options come back **only if every current attempt agrees** | one request carries one quality and size, so a disagreement is a bug — picking one target's values would present corrupt data as the user's last choice |
| A model that is now held, or has no price at the restored option, is excluded **and named** | a silently different selection is the failure this path exists to end |
| The default model is the **last** resort | it is right only when nothing the user chose can be offered back |
| The prompt is **never** restored | it is timeline history, not the next draft |

A restore answer that arrives after the user has touched a model, quality or
size is discarded. The user's newer choice wins a race with the network.

### The submit control is the progress

While a comparison is running the button **is** the progress indicator: a
spinner, "Generating N model(s)" counted by target rather than attempt, and
disabled. A separate sentence beside a button still reading "Generate" at full
contrast said the same thing twice and left it ambiguous whether the button
could be clicked.

- The price badge is dropped while a run is in flight — it describes a request
  the user can still start, and there is none.
- The busy sentence stays in the accessibility tree as a visually hidden
  `role="status"` (the same idiom as the comparison action rail): a spinner is
  no signal at all to a screen reader. Visually hidden means it paints no row —
  `sr-only`, never `display: none`.
- Per-model progress stays on the timeline cards. That is where a comparison's
  state belongs; the composer says only whether a new run can start.

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

### Selection limit

`IMAGE_GROUP_MAX_MODELS` is the second, unrelated number: how many models one
request may actually fan out to. **The composer must never offer a selection
admission would refuse.**

- The limit is resolved **on the server, per request**
  (`imageGroupMaxModels()`, `lib/imageGroupLimits.ts`) and handed to the
  composer as a prop. The client never reads `process.env` and never carries
  its own copy: in a Client Component that is a build-time substitution, so it
  would keep offering the previous limit after a deployment changed one.
- The composer and admission call the **same function**. A number written into
  a component is a violation even when it currently agrees.
- At the limit an unselected model **stays visible, stays focusable and keeps
  its price**. Discovery is not what a limit costs.
- An attempt to exceed it **changes nothing**: no automatic deselection, no
  silent replacement of an older choice. The refusal is stated instead, in a
  persistent `role="status"` notice that every blocked chip points at through
  `aria-describedby`, and the chips carry `aria-disabled`. The state is never
  conveyed by colour alone, and a keyboard activation is refused the same way a
  click is, with the same reason.
- An **already selected** model is always deselectable, including at the
  limit — that is how a user gets out of it. The one selection that cannot be
  emptied is the last remaining model.
- The current count is shown as `{n}/{max}` **at all times**, not only once the
  ceiling is reached: a rule first mentioned at the moment it becomes
  inconvenient was never disclosed.
- Per-model prices and the group total stay visible throughout.
- Seeded and restored selections are cut to the limit **deterministically**, in
  registry order, and the models that did not fit are named. Nothing stored is
  rewritten: a group that ran four models keeps saying so.
- Because the client's limit can be stale, the server's refusal has its own
  message. `IMAGE_MODEL_SELECTION_INVALID` renders `details.maxModels` — the
  number admission actually applied — falling back to the client's runtime
  limit only when that detail is missing or malformed. A generic "try again" is
  a violation: retrying re-sends the same selection and fails identically.

Desktop and mobile use the same information structure. Server admission remains
the only boundary; none of the above may replace it.

The rule lives in `imageComposerModelLayout()` in the registry, not in the
component, and it is tested there. **This deployment cannot render the compact
mode**: two models are enabled and the threshold is three, so an end-to-end
test has no way to reach it — and activating the three held Google models takes
the count from 2 straight to 5, skipping 4 entirely. A branch first exercised
on the day it starts mattering is a branch nobody can trust on that day. What
the browser tests instead is the reachable half: at two enabled models the
picker toggle and panel are absent from the DOM, not merely hidden.

The picker panel renders in normal flow, in its own row. It is never absolutely
positioned, floated or overlaid — the mobile composer contract forbids any
control overlapping the textarea's row, and a panel opening over it would do
exactly that. A chip is the same control in both containers: same price, same
accessible name, same target size. Selecting a model moves which container it
is in and changes nothing else, registry order preserved in both lists, so a
chip never jumps position under the pointer that just picked it.

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
| 20 | enabled model count 2, 3, 4, 5 | inline, inline, compact, compact — with every selected price still visible (`imageComposerModelLayout()`, unit) |
| 20b | today's two enabled models, in the browser | every model inline; no picker toggle and no picker panel in the DOM at all (e2e) |
| 21 | re-entering a conversation | last comparison's models and options restored; prompt empty |
| 22 | restore drops a model or cannot restore options | both stated on screen, never silently applied |
| 23 | comparison running | button shows the spinner and the model count, is disabled, drops the price; busy sentence hidden but present |

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
- [ ] Re-entry restores from the latest group, and says what it could not restore
- [ ] The running state lives on the button, not in a second sentence beside it
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
