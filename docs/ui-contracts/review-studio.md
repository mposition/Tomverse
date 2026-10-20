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

## Verification

- `tests/reviewRouting.test.mjs`
- `tests/server-contract/review-routing.test.ts`
- `tests/e2e/review-studio.spec.ts`
- Existing mobile composer, drawer, comparison rail, image workspace and
  typography checks, plus updated credit presentation regressions.
