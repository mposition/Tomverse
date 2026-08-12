# Tomverse Chat Auto Router rollout

- Status: **not started.** All three readiness gates are `pending`, so no
  account can be routed by Auto regardless of configuration.
- Owner: Backend/AI, with Product as rollout owner
- Companion to `docs/ops/tomverse-chat-router-evaluation-set.md` (which
  produces one of the three gates) and
  `docs/policy/tomverse-chat-routing.md` §5

This document is the operational half of the limited Auto cohort. The rules
live in code — `lib/autoRolloutReadiness.ts` and `lib/autoCohort.ts` — because
a rollout boundary written only in a document is a boundary that holds until
somebody is in a hurry.

## 1. The three gates, and why they are three

Auto routes nobody until all three are attested. They are not
interchangeable, and each produces reassuring numbers that look like the
others':

| Gate | Establishes | Is silent about |
| --- | --- | --- |
| `shadow_report` | blast radius: how much would change if Auto were on | whether the change would be an improvement |
| `offline_quality_evaluation` | answer quality vs. the pre-registered baseline, with a 95% interval | whether the dispatch path can record what it sent |
| `attempt_manifest_boundary` | every dispatch carries a finalized, immutable manifest | the quality of the routing choice |

Shadow cannot stand in for the evaluation. It records the model the Router
*would* have chosen and never generated that model's answer, so there is no
pair and no win rate. A Router that echoed the user's own choice would agree
with every shadow row and be worth nothing.

`npm run check:auto-rollout-readiness` prints the current state and fails the
build on an attestation that does not carry a person, a date, an artefact, an
evaluated commit, a written summary, a re-attestation deadline and its known
limitations.

## 2. Attesting a gate

Moving an entry from `pending` to `passed` in `lib/autoRolloutReadiness.ts` is
a human act. An agent may add entries, compute figures and keep the notes
current; `attestedBy` is a person's name, and the commit history is the audit
record.

An attestation expires. Readiness measures a system that keeps changing, and
an attestation with no deadline would outlive what it described — so
`expiresAt` is required, and the check fails once it passes.

## 3. Configuration

Every default is off, so a deployment that sets nothing routes nobody. A
missing variable is never mistaken for a deliberate rollout.

| Variable | Meaning |
| --- | --- |
| `AUTO_ROUTER_KILL_SWITCH` | `on` disables Auto for everybody, unconditionally |
| `AUTO_ROUTER_ROLLOUT_PERCENT` | 0–100, the share of eligible subjects Auto routes |
| `AUTO_ROUTER_ELIGIBLE_PLANS` | comma-separated plans, e.g. `Pro,Max`. Empty means none |
| `AUTO_ROUTER_COHORT_SALT` | names this cohort partition. Unset routes nobody |

**The kill switch is checked before everything else**, including readiness and
the percentage. An operator reaching for it during an incident must not have
to reason about anything else, and a kill switch another setting can outrank
is not a kill switch.

**Changing the salt reshuffles the cohort.** It travels on every decision for
that reason: a silent reshuffle mid-measurement replaces the population under
the metrics without replacing the metrics. Change it deliberately, and treat
the figures either side as separate runs.

## 4. Who is excluded, and why

- **Guests.** Structural rather than commercial: Auto's stickiness and
  hysteresis live on the conversation, and a guest's conversation state does
  not survive. A guest would get a Router that re-decides from scratch every
  turn, which is a different feature from the one being evaluated.
- **Accounts on a plan outside the allowlist.**
- **Conversations left on `manual`.** The mode is per conversation, so an
  account inside the cohort can have manual and Auto conversations at once.
  A manual conversation is not recorded as a cohort refusal — counting it as
  one would make the cohort look smaller than it is.

## 5. Falling back is normal

There are five ways Auto declines a turn — the conversation is manual, the
account is outside the cohort, a gate is outstanding, the kill switch is on,
or the Router found no candidate — and all five behave identically: the user
gets the model they would have had anyway, and is told nothing, because from
their side nothing went wrong.

What must never happen is the reverse. A turn that reported itself as routed
when it fell back would put turns the Router never decided into the metrics
that grade routing, and would advance the sticky streak on a turn nobody
judged. `lib/autoModelSelection.ts` makes that unrepresentable rather than
merely discouraged: `routed` is a tag, and the fallback model id lives on the
refusal branch where nothing can read it as a routing result.

## 6. Rolling back

1. Set `AUTO_ROUTER_KILL_SWITCH=on`. It takes effect on the next request; no
   deploy, no migration, no conversation edit.
2. Conversations stay on `selectionMode: auto` and keep answering with the
   user's own model. Nothing needs to be rewritten, and turning the switch off
   again resumes routing without a backfill.
3. Sticky state left behind is Auto's own and is only read on a routed turn,
   so it cannot affect a conversation while Auto is off.

Returning a conversation to `manual` clears its sticky state, and the database
enforces that — a manual row holding a router model or a challenger streak is
refused by `Conversation_manual_has_no_sticky_state_check`.

## 7. What is not built yet

- **Auto does not yet dispatch.** The seam, the cohort, the mode storage and
  the sticky lifecycle are in place and tested; the chat route still answers
  every turn with the requested model. Turning the dispatch on requires
  reordering the request so the input estimate is computed before the model is
  chosen — today the credit budget is built from `modelConfig`, so the model
  has to be known first. That reordering touches the paid path and is its own
  change.
- **The Auto UI.** Deliberately last, and behind a disabled feature flag until
  the server contract above is fixed and a cohort is actually running.

## 8. Record

| Record | Entered by | Date |
| --- | --- | --- |
| Shadow report attested | | |
| Offline quality evaluation attested | | |
| Attempt/manifest boundary attested | | |
| Cohort salt chosen | | |
| First cohort percentage set | | |
