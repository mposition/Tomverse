# Review Studio

Korean mode controls display `간편` / `전문가` for Easy / Professional; persisted
values remain `easy` / `professional`. Korean product links display `채팅` / `비교`
while their accessible names retain the Tomverse Chat / Review brands and roles.

Owner approved Concept B on 2026-10-20: Figma file
`fM4d8G9lqL8xZjFk22IQwC`, desktop frame `14:2`, mobile frame `14:4`.

- Studio is the new default appearance. Classic retains the previous desktop
  and mobile shells. Appearance and light/dark are independent of Easy or
  Professional, and switching appearance preserves the controlled draft.
  Classic mobile exposes mode, appearance and theme in the conversation drawer,
  preserving the answer canvas instead of reserving another permanent row.
- Desktop uses a navigation rail, persistent question/participant panel and
  adaptive result canvas. Focus and side-by-side keep the same live panels;
  changing the view must not resubmit a prompt. Mobile has Write/Results and
  provider tabs, full-width text input, scrollable controls and safe-area space.
- History, search, sorting, account, settings, language, feedback, attachments,
  voice, web search, Deep Research, generated files, memory and AI Review reuse
  the existing components and execution paths. Starter cards reuse the existing
  visibility/lock/seed handlers and never send on selection.
- Easy selects up to three eligible providers within the existing plan cap.
  Its default-off `REVIEW_EASY_ENABLED` gate is independent of appearance and is
  enforced again on the authenticated routing endpoint and service. The same
  configured Chat router, live routing guidance, image criteria and provider
  cost holds select each provider's model. Invalid/failed choices preserve the
  draft and stop; they never silently invoke a manual fallback.
- Easy history follows the provider across model changes. Professional retains
  the existing direct model picker and transcript behavior. Neither changes a
  conversation's stored product or grants a new plan entitlement.
- Easy's provider rows mark each provider with an active image model with an
  image badge (`review-provider-image-badge`), read from the image catalogue
  the page was served with (Admin model catalogue), never a fixed list. No
  badge is shown where image generation is off for the deployment or the
  conversation.
- The new-review image card ("one sentence, several images") is v2's
  multi-model image comparison entry (`docs/policy/image-generation.md` §1, §11).
  It seeds the composer and arms image mode: Easy routes the sentence once per
  selected provider; Professional starts on an active catalogue model of a
  provider already answering, else the first active one, and never on a fixed
  default model.
- Unsupported image providers have a local notice and no execution. Other
  supported providers retain the existing image execution/consent flow. An
  all-unsupported image request never substitutes a provider or calls text.

## Desktop answer analysis (owner direction, 2026-10-27)

PC Review Studio puts one Tomverse answer analysis entry below the composer.
Results open in a wide modal with Summary and Detailed review tabs. Original
model answers stay in the canvas; analysis never starts automatically while
those answers are being generated. Classic and mobile retain their existing
entry points. The new entry and modal show no credit figures or review-mode
options.

Both tabs project the same balanced comparison review (without synthesis), not
two paid requests. Dismissal leaves pending work alive. Reopening and switching
tabs reuse the result and preserve evidence/feedback state. The authenticated
GET with the explicit review mode restores server-saved results after reload;
guest results remain in the current mounted workspace session, not server
storage. Question/answer changes select a different input; identity changes
discard the local session. Existing API authorization, quotas and verification
remain enforced. A progress bar is indeterminate, not an invented percentage.

Verification: `npm run verify:studio-answer-analysis` mounts the real component
against loopback responses (no provider/DB). It covers one execution across
reopens, background completion, tabs and evidence, saved reload, changed input,
identity scope, guest reuse, dark mode and mobile exclusion.

## Classic and mobile AI Review while answers finish (2026-11-27)

Classic and mobile keep their entry rule: two completed answers can be
reviewed while another model is still generating (state 2 of
`docs/ui-contracts/comparison-action-rail.md`). Their dialog is keyed by
identity and conversation only. A newly finished answer refreshes the setup
step, but never remounts or reloads a review that is running or being read:
that run is billed for the answers it started with, and its saved result is
looked up by that turn. Returning to the setup step catches up with the latest
turn; for a guest it re-reads the page's latest local turn, so the preview and
the run include an answer that finished on the setup step. Coverage:
`node --import tsx scripts/verify-ai-review-dialog.mjs` (real dialog, loopback
fixtures) and `tests/comparisonReviewDialogMount.test.mjs`.

One account review runs at a time per input. The signed-in POST claims
`(account, input hash)` before its cache read, Free quota and reviewers, and
answers a second request for the same input with `409 DUPLICATE_REQUEST`
without running, charging or reserving anything -- unless a fresh saved row
of that input already exists (the other request is a cache hit, or a run that
has saved), which it then returns as the usual 0-credit cache answer. The
claim is released on every outcome. A live run renews it every 5 minutes (a
third of the TTL; the renewal only moves the holder's own row forward), so a
run of any length keeps it; it expires 15 minutes after its process dies
(`lib/comparisonReviewInFlight.ts`; it uses the existing `ChatUsageBucket`
table, no migration). A run whose claim was taken over anyway logs
`comparison_review_claim_lost` and still finishes. Classic, mobile web and Studio
answer that 409 with one localized notice (`chat.aiReviewAlreadyRunningRetryLater`:
the review of these answers is already running; once it finishes, running it
again returns the saved result at no extra charge, and if answers are added
meanwhile it runs as a new review) instead of a failure or the server's
message. They do not poll. In the dialog the notice belongs to the mode and
synthesis option that were refused: another choice is a different review and
does not show it. Neither the notice nor a run failure is cleared by a setup
refresh -- only by the next run or by closing -- and the setup's scope line
shows how many answers a run would now cover. The run button stays available;
Studio's entry reads "check for the result" rather than a failure and retry.
A refused attempt is not counted as `comparison_review_started`: an account
start is counted when the server answers (or never does), a guest start on the
click as before. The GET is unchanged: the latest turn and the chosen
criteria. Coverage: `tests/server-contract/comparison-review-route.test.ts`,
`tests/server-contract/comparison-review-run-claim.test.ts`,
`tests/comparisonReviewInFlight.test.mjs` and both browser harnesses.

Known limitation (unchanged by this work): the GET serves the latest turn
only, so a saved review of an earlier turn shape (two answers, before a third
finished) has no way back into view once the latest turn has moved on.

## Continue a saved analysis in Chat (2026-11-14)

Signed-in owners can preview a completed normal Review's current reviewer or
one finding, then open it as an editable new Chat draft. Studio's balanced
result needs no synthesis. Classic, mobile web and Quick Summary use the same
handoff. Quote-match status, original question, model provenance, unresolved
matters and limitations stay in the reference; separate web checks do not.
The preview explains that the text is an independent copy of the source.

The handoff makes no model call, reservation, Conversation or Message. It
rechecks the captured result through the existing owner/unlock GET and passes
a five-minute, one-use, account/epoch-bound packet in tab memory. Only its
opaque marker enters the URL. Chat suppresses recent-conversation restoration,
waits for successful durable `new` draft hydration, and uses the normal draft
writer. Existing text or attachments require explicit Add or Cancel; CAS and
sync recovery remain unchanged. Identity changes, expiry and cancellation
discard the pending packet. Guest, imported continuations, public sharing,
native analysis entries and Deep Research execution are outside this slice.

Coverage: `tests/reviewToChat.test.mjs` and
`tests/e2e/review-to-chat.spec.ts` (real route navigation and draft hydration).

Native (Android/iOS) since PR #4183, completed 2026-11-23: the same formatter and
item selection (whole reviewer result, or one AI Review item with the server's item
ID, or one Quick Summary item in its own sections) with `locales/nativeReviewChat.ts`
labels in all eight Native languages. It is a direct in-shell callback, not the web
packet/URL: the readback goes through the native bearer transport, is cancellable,
and only a signed-in `surface === "workspace"` Review offers it. The target is the
owner's new-Chat draft held in memory first (device storage is optional); text or
attachments need explicit Add, a draft changed during the check asks again, and an
over-limit result is refused rather than truncated. Coverage:
`tests/native-mobile/native-workspace-parity.spec.ts`,
`tests/nativeReviewAnalysis.test.mjs`, `tests/nativeMobileTransport.test.mjs`.

## Analysis progress and report actions (2026-11-15)

Studio consumes the existing review progress stream and displays the first
validated review while the additional reviewer and durable save finish. This
does not add model calls or change execution budgets. An interrupted stream
recovers through the saved-result GET; only a terminal server failure permits
an explicit retry after another cache lookup.

Studio, Classic, mobile web and Quick Summary put Continue in Chat immediately
before Close in their result footer, alongside Share and Export. Transfer
actions require a completed saved result. The report preview preserves the
selected reviewer's full analysis, question, model mapping, quoted excerpts,
quote-match status, source-grounding counts and unresolved matters. Export
uses the existing deterministic PDF, DOCX, TXT and Markdown writers, with no
model call or generated-artifact persistence. Unsupported PDF glyphs offer
the other formats instead of silently dropping text.

Sharing requires explicit publication after a public-content preview and
explains replacement of the conversation's existing share link. It reuses the
existing owner/unlock, plan, operational, expiry, revocation and atomic snapshot
checks, adding an exact saved-review version check. The snapshot contains only
the selected report, including its quotes; full model answers, attachments and
separate web checks stay out. Unknown publication outcomes require revocation
before another attempt. Existing transcript sharing is unchanged.

Coverage: `tests/reviewAnalysisReport.test.mjs`,
`tests/server-contract/review-analysis-actions.test.mjs`,
`tests/e2e/review-analysis-actions.spec.ts` and the existing Studio/handoff
regressions. These local checks use no paid provider execution.

## In-conversation image answers (owner direction, 2026-10-23)

Image prompts stay in the current Review conversation, as in Chat. Easy routes
once for the selected providers and gives each panel only its own image model;
unsupported panels show their notice without a text or image provider call.
Professional keeps explicit image-model choices in the composer, and they are
all-or-nothing (owner direction 2026-11-25): picking one image model in the
catalogue's image tab turns every answering panel into an image model -- the
picked one, then an active model of each other panel's provider, then other
owners -- up to the number of answering panels, and each panel hosts one of
them. The composer row (`review-image-mode`) names them, and **Back to chat
models** (`composer-image-mode-exit`) returns to the selected conversation
models with the draft intact; picking a chat model does the same. Its automatic
image-intent check uses the existing Chat image-triage switch; text decisions
retain the manually selected text models. When enabled, this adds one existing
budgeted router call per eligible Professional prompt, as Chat's image triage
does. Only an explicit `review` product identity grants Review image hosting;
unclassified rows gain no image execution or retry exception. Image turns reuse Chat's transcript
cards, saved-question path, image reservation and idempotent retry. Supported
panels share one atomic group and workflow lease per question; each card and
restored message shows only its own target. They neither
open an image workspace nor change the conversation kind or product identity.
There is no image mode: no launcher item or other control opens a new image
workspace (`docs/ui-contracts/image-generation-workspace.md`).

## Chat Studio and interactive focus (owner approval, 2026-10-20)

Chat reuses Studio's navigation, palette and rounded conversation canvas.
Desktop keeps a question panel beside a single transcript; mobile keeps the
existing bottom composer and drawer. Canonical product navigation, Smart
Adaptive/manual selection, starters, attachments, tools and history keep their
existing handlers. Chat and Review appearance preferences are independent
(`tomverse_chat_appearance` and the existing `tomverse_review_appearance`).
Both default to Studio; Classic stays selectable without losing the draft.
Light/Dark is independent of either appearance preference.

Chat and Review share `ChatInput` for local/Drive attachments, upload status,
paste/drop, voice, web search, memory, assistants and image/research handoffs.
Studio search controls use the same handlers as the tools menu; Research is
available through the existing gated tools menu rather than a second shortcut.
Easy retains its existing research restriction. Product-specific model selection
and submission stay with the workspace. All composer menus portal outside the
scrolling panels so attachment sources remain reachable in either product.
Analytics consent sits after the composer and AI disclaimer, at the bottom of
the Studio question panel or mobile dock, without changing the consent actions.
The mobile dock reserves the bottom safe area after its last visible footer.

With two selected models, desktop Review Studio shows equal-width, full-height
answers side by side. Only three selected models expose the Focus/Side-by-side
view switch. Model chips and the view switch share one toolbar row, without
the redundant Edit question action; the existing Write/Results control remains.
The hint describes focusing in Focus and reordering in Side-by-side. Removing a
model from a focused trio immediately restores the two-column comparison without
resending or losing answers. Narrow screens retain the existing active-answer
tabs.

In side-by-side view, dragging a model chip or answer header onto another panel
moves that answer to the target position. This changes display order only and
preserves each panel's transcript, follow-up draft and pending stream without
resending.

With three selected models in Review Studio, drag a model card or answer header
into the large answer panel to focus that model. The same cards support click,
tap, Enter and Space in Focus; selecting a card in Side-by-side keeps that view.
Changing focus or switching to side-by-side only changes the live layout:
answers, pending streams and selected models stay intact, and no request is
sent. Narrow screens use the same cards to select the visible answer. Opening
a stored conversation with content shows Results rather than hiding answers
behind the Write view.

Easy has no manual Deep Research expansion offer, shortcut or tools action.
The initial model choice uses the shared Chat research criteria and the
eligible provider-scoped catalogue: it may choose a research model when the
question needs it and that provider/plan supports it. No second paid expansion
or substitution of an unselected provider is added. Providers without such a
model continue through an eligible regular model. Professional retains the
existing manual expansion. Existing admission, entitlement and execution
limits apply to any selected research model.

## Credit presentation (owner direction, 2026-10-20)

Text composers show no credit estimate or variable-cost badge, including their
Send accessible name. Request estimates, budget admission and usage-limit
handling continue to run. Model catalog pricing and the image generation
quote/consent flow remain available for the decisions they support.

Profile and compact account usage use monthly usage as a percentage of the
monthly allowance, clamped to 0–100. A real daily allowance has a separate daily
gauge in the profile menu. Unknown/unbounded denominators show no invented
percentage. Purchased balances remain in billing details rather than receiving
a fabricated percentage. Guest usage uses the existing guest allowance.
When a purchased allowance remains, the menu indicates that extra usage is
available without displaying a credit count or treating the monthly gauge as
an execution gate.

Answers omit quiet no-search/refund labels and search surcharges. Executed
search, research, source links, failed-search notices and normal error handling
remain. Accounting metadata, reservations and refunds are unchanged.

## Shared Composer controls and provider defaults (2026-10-23)

The owner requested consistent Chat/Review controls. The editable proposal is
[Composer and default settings](https://www.figma.com/design/FbqVoHReAan0aFSkLTorCX?node-id=2-2)
(settings frame `2:71`). Reuse `ChatInput`, `ChatProductSwitcher` and the shared
`ReviewModeSwitcher`; do not maintain a separate Review action rail.

- Both products expose canonical Chat/Review links in the regular composer.
  Existing navigation admission and compact mobile drawer fallbacks remain.
- Studio Review's Easy/Professional control and participant/model chooser precede
  the prompt. Classic uses an inline mode select in the existing product row and
  the model picker in its tools row ([Figma compact variant](https://www.figma.com/design/FbqVoHReAan0aFSkLTorCX?node-id=8-2)),
  preserving the answer canvas. The header does not duplicate the mode switch; the Classic mobile
  drawer retains the shared switch as a compact fallback.
- Voice stays immediately left of Send/Stop in the shared action group. The
  action row reserves at least 12px above it. Both products omit the persistent
  research shortcut; their existing gated `+` menu still offers Deep Research
  where supported. Chat's model picker occupies its own footer row; Review's
  Studio Professional chooser above the prompt avoids a second footer model picker.
- The model picker presents Low, Default and High when the server offers
  reasoning effort. An explicit choice is shown beside the model or Smart
  Adaptive in the existing composer control and applies to the next text
  question. Smart Adaptive selects the model for the question and uses its
  default effort if the chosen level is unsupported. The answer shows the
  applied level. Review Professional offers a common level only when every active
  model supports it. Review Easy uses the routed models' default settings.
- The prompt uses an inset neutral focus underline, including forced colors,
  instead of outlining the whole composer in blue.
- Easy defaults are separate from Professional's default model combination.
  `UserSettings.reviewEasyDefaultProviders` is nullable: null inherits
  `AppSetting["review.easy.defaultProviders"]`, whose absent value defaults to OpenAI.
  New Easy Reviews use these configured defaults rather than deriving providers
  from the Professional selection; stored conversations keep their selection.
  An explicit current Review selection wins. Defaults initialize a new Review
  only; preference saves and history navigation never rewrite existing choices.
- The profile's AI tab owns the personal setting. Admin Console > Platform
  settings owns the platform setting, under the existing ops-write and recent
  authentication checks. The platform write and audit append commit together.
  Neither setting enables Easy, changes a plan cap, sends a prompt or grants
  execution authority. Eligible providers and the plan's count cap still apply.

## Verification

- `tests/reviewRouting.test.mjs`
- `tests/reviewProviderPreferences.test.mjs`
- `tests/server-contract/review-provider-defaults-storage.test.ts`
- `tests/e2e/composer-feature-parity.spec.ts`
- `tests/server-contract/review-routing.test.ts`
- `tests/e2e/review-studio.spec.ts`
- `tests/e2e/chat-studio.spec.ts`
- Existing mobile composer, drawer, comparison rail, image workspace and
  typography checks, plus updated credit presentation regressions.
