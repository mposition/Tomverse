# Auto model selection — UI contract

- Status: **built, not shipped.** `TOMVERSE_AUTO_ROUTER_UI_ENABLED` is off, and
  every readiness gate in `lib/autoRolloutReadiness.ts` is `pending`, so no
  account is offered Auto today.
- Owner: Product, with Backend/AI as rollout owner
- Server side: `docs/ops/tomverse-chat-auto-router-rollout.md`
- Policy: `docs/policy/tomverse-chat-routing.md` §5

Auto is a mode, not a model. It replaces "which model answers this
conversation" with "a model is chosen for each message", and that is a change
to what the product promises — so what the interface says about it is a
contract, not a styling decision.

## 1. Offered means it would actually route

`autoSelection.offered` in the conversation response is one boolean, and it is
already the conjunction of the feature flag and cohort eligibility
(`lib/autoRoutingUi.ts`). The control renders when it is true and does not
exist when it is false.

There is no disabled state, no "coming soon", no greyed row. A control that
flips, saves and changes nothing is worse than an absent one: the user cannot
tell "Auto chose my model again" from "Auto never ran", and neither can
support. `AutoRoutingToggle` returns `null` on `offered: false` for that
reason, and the server refuses to store `auto` on the same condition.

## 2. The client is never told why not

`offered: false` crosses the wire alone. Which bucket the account landed in,
what share is enabled, which readiness gate is outstanding — none of it is
disclosed, because a client that could read its own bucket could work out the
rollout percentage, and one that knew the salt could work out anyone's. The
operator-facing reason is logged server-side by `describeAutoCohortRefusal`.

## 3. What the copy may promise

Auto picks a model per message. It does **not** promise the pick is good, and
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

## 6. Accessibility

- The switch carries its state on `aria-checked` and in the knob's position,
  never in colour alone — the same rule `ModelSelectionBadge` follows.
- The mode change is announced through a polite live region, so a screen reader
  is told what happened rather than re-reading the control.
- The badge's icon is `aria-hidden`; the model name is text.

## 7. Non-negotiable requirements

- Auto never appears as a row in the model catalogue. It has no context window,
  no price and no provider, and the credit estimate under the picker would have
  nothing to show for it.
- No surface may derive availability from the flag alone. `offered` is the only
  input, and it is computed server-side.
- No user-facing string may name a bucket, a percentage, a salt, a cohort or a
  readiness gate.
- A change that violates this contract is a release blocker.
