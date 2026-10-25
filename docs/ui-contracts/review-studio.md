# Review Studio

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
- Unsupported image providers have a local notice and no execution. Other
  supported providers retain the existing image execution/consent flow. An
  all-unsupported image request never substitutes a provider or calls text.

## In-conversation image answers (owner direction, 2026-10-23)

Image prompts stay in the current Review conversation, as in Chat. Easy routes
once for the selected providers and gives each panel only its own image model;
unsupported panels show their notice without a text or image provider call.
Professional keeps explicit image-model choices in the composer. Its automatic
image-intent check uses the existing Chat image-triage switch; text decisions
retain the manually selected text models. When enabled, this adds one existing
budgeted router call per eligible Professional prompt, as Chat's image triage
does. Only an explicit `review` product identity grants Review image hosting;
unclassified rows gain no image execution or retry exception. Image turns reuse Chat's transcript
cards, saved-question path, image reservation and idempotent retry. Supported
panels share one atomic group and workflow lease per question; each card and
restored message shows only its own target. They neither
open an image workspace nor change the conversation kind or product identity.
The separate new-image launcher remains an explicit image-workspace entry.

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

In Review Studio, drag a model card or answer header into the large answer
panel to focus that model. The same cards support click, tap, Enter and Space.
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
