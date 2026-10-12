# Smart Adaptive model selection — UI contract

- Status: **server-offered blank Chat drafts default to Smart Adaptive intent;
  release authority still requires serving readback.** The three
  readiness attestations in `lib/autoRolloutReadiness.ts` remain `pending`.
  The owner-approved initial release may authorize Auto through
  [its exact-deployment activation](../policy/chat-refiner-initial-auto-release-v1.md),
  while the separate limited-release path requires its exact reviewed artifact
  and runtime tuple. This document is not evidence that either path is active.
  The controls are mounted
  (`ChatInput`, `ModelPickerPanel` and `ChatMessageList`), which is what makes §1 a rule
  something executes rather than a claim about components nothing rendered.
  Coverage: `tests/client/autoRoutingRender.test.tsx` and
  `tests/e2e/auto-routing-toggle.spec.ts`.
- Owner: Product, with Backend/AI as rollout owner
- Server side: `docs/ops/tomverse-chat-auto-router-rollout.md`
- Policy: `docs/policy/tomverse-chat-routing.md` §5

Smart Adaptive is a mode inside Tomverse Chat, not a model and not the product
switch to Tomverse Review. It replaces "which model answers this
conversation" with "a model is chosen for each message", and that is a change
to what the product promises — so what the interface says about it is a
contract, not a styling decision.

## 1. Offered means it would actually route

`autoSelection.offered` in a stored conversation response is one boolean, and
it is the conjunction of the feature flag, **the conversation's product**, and
cohort eligibility (`lib/autoRoutingUi.ts`). A signed-in blank Chat draft may
receive the same single `offered` boolean from the server's read-only Chat
draft capability. That capability means the account may start a stored Chat in
Auto; it does not pretend the blank draft already has a conversation row or a
stored product. An admitted Guest Chat uses the separate, one-turn authority
in
[`chat-refiner-guest-smart-adaptive-v1.md`](../policy/chat-refiner-guest-smart-adaptive-v1.md):
its read-only capability may offer Smart Adaptive without creating an account,
conversation row, financial claim or provider request. The control renders
when its server-owned `offered` value is true and does not exist when it is
false.

```
offered =
    uiFlagEnabled &&
    product === "chat" &&   // written in the order it is decided
    cohortEligible;         // readiness or an exact release authority; kill, plan, bucket
```

The initial authority is verified by the server from its canonical owner
activation pair, current deployment and configuration. The same authority
serves availability, mode changes and turn routing. A browser flag or object
cannot supply it. Missing manifest enforcement or keys closes that exception;
the actual finalized manifest remains mandatory. The historical measurement
attestations retain their real status.

The separate limited-release exception changes only the readiness term when
its policy, reviewed 18-path artifact, deployment, plans and rollout tuple all
match. It grants no substitute initial authority and is omitted from the client
response.

The product condition is not a third clause bolted on — **it is answered
before the cohort is consulted**, and `lib/autoProductBoundary.ts` is the one
place that answers it. Three surfaces ask the question (surface entry,
`offered`, and turn routing), and if each decided separately the screen and
the execution would be free to disagree, which is exactly the control this
section forbids.

The order matters for the numbers as well as for correctness. A Review
conversation is not *outside* the cohort; it was never a subject of the cohort
question. Evaluating it anyway dilutes the rollout percentage with Review
traffic until "what share of Chat users are being routed" stops being
readable — the same argument `lib/autoCohort.ts` already makes about its own
refusal order. So `product_not_chat` is an `AutoSelectionRefusal` and an
`AutoUiRefusal`, never an `AutoCohortRefusal`, and the refusal carries no
cohort at all.

The product is the one stored on the row, read under an ownership check. Never
a request body, a `Referer`, or the surface the client was on. A row whose
`productKey` is still NULL resolves through `PRODUCT_KEY_READ_MODE` — Review
during the transition, a reported defect under `strict` — and Auto refuses it
either way. A turn with *no conversation at all* is a different thing:
`no_conversation`, not a product refusal.

A server-offered blank Chat draft paints Smart Adaptive ON as its default
**draft intent**. That display is not a claim that a conversation row or stored
mode already exists: merely entering Chat creates no row and performs no paid
call. Before the first Send, the client must create the owned Chat row, read
its canonical detail, store `selectionMode: auto`, and adopt that confirmed
row. Send waits for this sequence.

If a signed-in user has chosen manual on the blank draft and explicitly switches Smart
Adaptive back on, the same server-confirmation sequence runs immediately. In
that explicit transition only, the switch remains pending or returns to manual
until every step succeeds. These network steps are deliberately not described
as one database transaction. An unknown outcome stops for readback and is never
retried blindly. Review and other product surfaces do not gain this account
draft capability, and account routing itself still requires the stored owned
row.

Guest Chat follows a narrower one-turn contract. Entry and the visible default
remain rowless and free. Immediately before Send, the client obtains a fresh
opaque authority bound to the signed Guest principal and exact activated
release. The server claims that authority and the logical client turn once,
runs the Refiner at most once, and routes one answer inside the existing Guest
allowance. The authority stays in request memory and never enters a URL,
browser storage or transcript. Guest attachments remain manual-only; when an
attachment is present the server refuses Auto before any hold, Refiner or
provider call. An unknown Guest Auto outcome is read back as a content-free
financial receipt, exposes no retry or restore action for that turn, and never
silently obtains a fresh authority or client-turn id.

There is no disabled state, no "coming soon", no greyed row. A control that
flips, saves and changes nothing is worse than an absent one: the user cannot
tell "Auto chose my model again" from "Auto never ran", and neither can
support. `AutoRoutingToggle` returns `null` on `offered: false` for that
reason, and the server refuses to store `auto` on the same condition.

## 2. The client is never told why not

`offered: false` crosses the wire alone. Which bucket the account landed in,
what share is enabled, which readiness gate is outstanding, **and whether the
refusal was the product at all** — none of it is disclosed, because a client that could read its own bucket could work out the
rollout percentage, and one that knew the salt could work out anyone's. The
operator-facing reason is logged server-side by `describeAutoCohortRefusal`.

## 3. What the copy may promise

Smart Adaptive picks a model per message. It does **not** promise the pick is good, and
no locale may say better, best, optimal, smartest or their translations —
`tests/autoRoutingUi.test.mjs` fails the build on any of them.

The reason is that a user who reads "Tomverse picks the best model" will read
every answer they dislike as the router's fault, and the product has no
defence: `ROUTE-01` measures non-inferiority, which is a much weaker claim than
the copy would be making.

## 4. The answering model is always visible

The toggle's copy says the model that answered is shown on the reply, and that
sentence is only keepable because `AutoRoutedByBadge` exists. Without it Auto
silently changes what the user is talking to, and the first time an answer is
worse than usual there is nothing to look at.

The badge renders only on a turn Auto actually routed. A turn in an Auto
conversation that fell back to the user's own model gets no badge, because a
badge there would claim a routing decision that did not happen — the same
mistake `lib/autoModelSelection.ts` makes unrepresentable on the server.

The reason line is optional and drops silently: `autoRoutingReason` returns
`null` for an identifier the locale has no sentence for, rather than rendering
`fallback_order` into somebody's chat.

## 5. Turning it off is always available

An account can leave the cohort while its conversations are still marked
`auto` — the percentage drops, the plan changes, an attestation expires.
Returning to `manual` is therefore accepted unconditionally, including when
Auto is no longer offered. Refusing it would strand conversations in a mode the
account cannot act on, and `manual` is also what clears Auto's sticky state,
which the database expects gone
(`Conversation_manual_has_no_sticky_state_check`).

While Auto is on, the model list stays visible and selectable. Turning Auto off
has to return the conversation to a model the user recognises, and hiding what
that would be makes the switch a door with no handle on the other side.
The stored manual model is shown as a neutral return choice rather than as the
model currently answering. Selecting any model first waits for the server to
confirm `manual`; only a successful response may paint that model as selected.
A refused, failed or identity-stale write leaves the confirmed Auto UI intact.

## 6. Accessibility

- The switch carries its state on `aria-checked` and in the knob's position,
  never in colour alone — the same rule `ModelSelectionBadge` follows.
- The mode change is announced through a polite live region, so a screen reader
  is told what happened rather than re-reading the control.
- The composer switch is a separate 44px control, not nested inside the model
  picker trigger. Each action has one accessible name and remains operable when
  the action row wraps on a narrow screen.
- The badge's icon is `aria-hidden`; the model name is text.

## 7. Non-negotiable requirements

- Auto never appears as a row in the model catalogue. It has no context window,
  no price and no provider, and the credit estimate under the picker would have
  nothing to show for it.
- No surface may derive availability from the flag alone. `offered` is the only
  input, and it is computed server-side for the owned stored conversation, the
  signed-in blank Chat capability, or the separately signed Guest one-turn
  capability described in §1.
- No user-facing string may name a bucket, a percentage, a salt, a cohort or a
  readiness gate.
- A change that violates this contract is a release blocker.
