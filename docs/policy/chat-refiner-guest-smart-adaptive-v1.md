---
status: approved_scope_not_activated
policyVersion: 1
workId: CHAT-01
approvedBy: mposition
approvedAt: 2026-10-12T03:22:52Z
approvalTimezone: Australia/Brisbane
scope: CHAT_GUEST_SMART_ADAPTIVE_REFINER
activationAuthority: exact_deployment_owner_action_after_required_checks
currentActivation: none
guestQuotaIncrease: none
refinerDailyCostCapUsd: 100
refinerMonthlyCostCapUsd: 3000
refinerPerRequestCeilingMicroUsd: 29918
refinerRetryCount: 0
---

# Guest Chat Smart Adaptive and Refiner v1

## 1. Owner decision and boundary

On 2026-10-12 the operator selected **Smart Adaptive for Guest Chat while
keeping the existing Guest limits**. This decision extends the Guest Chat
product beyond its manual single-answer intermediate state. It does not turn a
Guest into an account, create an account-owned Conversation, increase a Guest
allowance, or authorize a second logical answer.

This policy records product scope and implementation constraints. It grants no
present dispatch authority. Guest Smart Adaptive and its Prompt Refiner remain
closed until the final exact source, migration and deployment pass applicable
CI and independent review, the financial phase contract in section 10 is
verified, and an
owner with recent administrator authentication records the exact-deployment
activation described in section 9. Existing authenticated Chat activation does
not activate Guest Chat by implication.

The initial-release exception in
`docs/policy/chat-refiner-initial-auto-release-v1.md` remains the source for the
Refiner quality and evaluation deferral. B08, the unresolved evaluation audit
items, and the Router attestations retain their recorded states. This Guest
scope does not turn any of them into a pass.

## 2. Product and caller authority

Guest Smart Adaptive is available only on the canonical Chat product surface.
Review keeps its explicit model-selection and multi-answer semantics. A client
body, URL, local-storage key, feature flag or product label is never authority
to cross this boundary.

The server identifies a Guest through the existing signed, HttpOnly Guest
cookie and derives the existing hashed subject key. It does not mint a `User`,
write an account-owned `Conversation`, or treat the caller as authenticated.
The existing Turnstile, Guest model allowlist, attachment restrictions, abuse
limits and Chat availability checks remain effective.

A read-only Chat capability response may return an opaque, signed Guest Smart
Adaptive authority. It must be:

- bound to the exact hashed Guest subject, Chat product, policy version and
  exact activated deployment;
- short-lived and fail closed when missing, expired, malformed, foreign,
  replayed outside its one-turn claim, or inconsistent with current kill,
  rollout or activation state;
- domain-separated from the comparison admission token, which grants only a
  concurrency slot and no financial or product authority; and
- free of raw prompts, model prices, candidate scores, internal refusal
  reasons, secrets and personally identifying cookie material.

Reading the capability creates no conversation, attempt, budget hold, audit
row or provider request. A refreshed capability is another read, not a paid
retry. The server repeats all authority checks on Send.

## 3. One-turn execution order

One Guest Auto Send is one logical answer and follows this order:

1. verify the signed Guest principal, Turnstile, Chat-only authority, exact
   activation, rollout, kill switches and stop latches;
2. freeze one client turn id, original authored bytes, attachments, tool state,
   current Guest-eligible registry view and current Guest allowance windows;
3. claim the turn once and reserve the model-agnostic Guest hold in section 4;
4. reserve the existing separate Refiner budget and run the Refiner once;
5. keep the authored message unchanged while giving the Router the validated
   refined execution view, or the original view only for a known undispatched
   Refiner refusal permitted by the initial release policy;
6. select one model from the frozen, currently reachable Guest-eligible pool;
7. convert the Guest hold to that exact model and acquire the remaining normal
   Chat financial, token, rate and concurrency guards in one transaction;
8. finalize the immutable Router/provider manifest for that same execution
   view; and
9. dispatch one provider attempt and settle both ledgers once.

The Refiner never sends a Chat turn. The Router and provider see the same
authorized execution view. The browser's Guest transcript retains the authored
message, not the Refiner proposal. Direct model selection remains manual
Review behavior and cannot silently enable Guest Chat Auto.

There is no provider fallback in this initial Guest scope. A failed or unknown
attempt cannot buy a second Refiner call or provider dispatch.

## 4. Existing Guest allowance, reserved in two stages

This policy changes no Guest quota value, credit weight, token ceiling, price,
provider budget or cost guardrail. The implementation reads the existing
runtime model registry and the same Guest limits and period windows used by the
ordinary Chat access path.

Before the Refiner call, the server first filters the frozen Guest-eligible
candidate pool by the Guest's current day and month allowance. A candidate is
reachable only when its current runtime `usageCredits` fits both remaining
windows. The model-agnostic hold is then:

- one unit in the existing Guest minute-request bucket; and
- the greatest `usageCredits` among those currently reachable candidates in
  each existing Guest day and month bucket.

The maximum is taken after reachability filtering. An expensive inaccessible
candidate therefore cannot hide a cheaper candidate the Guest can still use.
The server does not reserve every candidate as a separate turn and does not
run the Router before the Refiner.

After the Router selects a model, one transaction verifies that the model is
still in the frozen eligible and reachable pool, converts the day/month hold to
that model's exact `usageCredits`, releases the difference, and creates the
ordinary exact-model token, cost, provider-budget, rate and concurrency
reservation. The minute unit is not charged twice. The conversion never
increases the held Guest amount and never borrows from an account, add-on lot or
another product.

A refusal proved before the Refiner service is entered releases both the
request unit and the financial hold. Once that service has been entered, a
later known undispatched refusal refunds the day/month financial credit because
no Chat answer ran, but retains the already consumed subject and IP minute
request units. Those are the existing Guest request-throttle buckets, not a new
allowance. Guest day/month buckets remain weighted answer entitlement and are
not repurposed as a hidden request counter.

Chat and Review continue sharing the same existing Guest allowance. The
product label does not create a second quota namespace.

## 5. Refiner budget and accounting

Refiner spend remains a product operating budget, separate from Guest usage
entitlement and Chat provider budgets. Its Brisbane limits remain US$100 per
day, US$3,000 per month and 29,918 micro-USD per request. The Refiner retries
zero times.

The Refiner reserves its verified worst-case amount before its provider call,
settles known cost once, and preserves the worst-case hold on unknown billing.
The reservation must use the same bounded execution view, model/price pin,
output cap and adapter configuration that the existing authenticated product
path validates. Guest eligibility or a cheap final Chat model cannot reduce the
Refiner reservation below that existing bound.

Guest allowance settlement and Refiner settlement are separate ledgers. A
known Refiner spend may remain settled when a later Chat guard refuses the
provider dispatch. Neither ledger rewrites the other.

## 6. Idempotency, unknown outcomes and recovery

The server claims one exact Guest subject, client turn id, authority version
and release identity before any paid work. Repeating the HTTP body, losing a
response, opening another tab or changing the local conversation id cannot
claim another attempt.

A known refusal before the Refiner service is entered releases the deterministic
Guest hold. A known undispatched failure after that boundary follows the
separately defined settlement for the work that actually ran: it returns the
unused Guest financial credit while retaining the existing subject/IP request
throttle unit. An unknown Refiner, Guest-hold conversion, manifest,
provider-dispatch or settlement outcome stops the request. It retains the
relevant Guest and Refiner holds, performs a read-only receipt check and never
retries blindly.

Expiry is not evidence that an unknown operation did not run. No expiry sweep,
TTL or ordinary Guest-session reset may automatically refund or delete an
unknown hold. Reconciliation requires a separate reviewed contract and
positive evidence.

## 7. Data and privacy boundary

The server-side source snapshot, Refiner proposal, attachment contents and
effective execution view remain in request memory for this initial design.
They are not written to the authenticated `PromptRefinerChatScope`,
`PromptRefinerChatSuggestion` or `PromptRefinerProductAttempt` tables, to local
or session storage, to a URL, to an audit event, or to routing telemetry. The
existing browser-owned Guest transcript is a separate boundary: it continues
to retain the user's authored message and provider answer in the product-scoped
local-history namespace. It never receives the Refiner proposal, execution
view, authority token or finalized-manifest material.

Durable Guest records are content-free. The two-stage Guest hold reuses
`ChatCreditReservation`, which already supports a nullable account relation,
the signed Guest subject key, an idempotency key, financial settlement and the
existing Guest retention and privacy treatment. It may contain only opaque
request identifiers, the hashed Guest subject, closed phase/status values,
release/config identities, numeric reservation and settlement amounts,
provider/model ids, timestamps and immutable audit references. It must not
contain prompts, answers, filenames, attachment ids, prompt hashes, free-text
errors, cookie values or reversible cookie material.

No new Guest subject table is introduced. If a later design adds one, it must
first be added to the public data-domain registry and to deletion, export and
protected-writer checks. Every write uses a named server writer and the
existing transactional hash-chained audit API. Direct audit-table writes are
forbidden.

## 8. Deterministic decision and execution boundary

Candidate eligibility, reachability, maximum-hold arithmetic, exact-model
conversion, replay classification, kill/latch decisions and manifest checks
are deterministic code. Refiner and Router model output are signals inside
those boundaries and cannot change limits, grant product authority or write
their own audit state.

The Guest Auto candidate pool is a subset of the existing Guest-eligible model
allowlist. A model disabled or unavailable to ordinary Guest Chat cannot be
selected by Smart Adaptive. The server records the same finalized execution
manifest for Router and provider dispatch and refuses when it cannot prove that
identity.

## 9. Activation and verification

Implementation, verification, review, merge, deployment and activation are
separate facts. Before activation, the exact source and migration must pass
applicable policy, pricing, accent, enum, privacy, protected-writer, financial
reservation and no-provider integration checks, plus independent review.

Activation is a new owner-authenticated, recent-auth, same-origin action. It
binds this policy's exact bytes, the exact serving commit and deployment,
migration identity, candidate/model/price/adapter identities, capability token
version, Guest reservation writer and finalized-manifest configuration. It
does not modify a quota, enable Review Auto, clear a stop latch or reuse the
authenticated release pair as proof.

Rollout and kill controls remain separate. Missing or ambiguous activation,
source drift, invalid audit integrity, stale deployment, price/config drift,
missing manifest enforcement or keys, an unknown financial outcome, or a
broken one-turn claim closes Guest Smart Adaptive. The product must fall
closed to manual Guest Chat or refuse the turn according to the known failure
boundary; it may not claim Auto or Refiner ran when it did not.

## 10. Existing financial row and phase contract

The Guest turn claim and model-agnostic credit hold reuse one
`ChatCreditReservation`; there is no new Guest attempt or subject table and no
new retention period. The row continues under the existing
`chatCreditReservation` data-domain entry, including its nullable account,
Guest subject key, financial retention, anonymisation and filtered export
treatment.

The additive schema identifies one of two phases:

- `exact` is the existing default for every historical and ordinary Chat or
  Review reservation. Its provider, model and price snapshot have their
  existing meaning and no current reader changes behavior.
- `guest_auto_prehold` is a content-free, undispatched Guest Chat row. Its
  provider and model name only the reachable candidate whose runtime
  `usageCredits` supplied the maximum credit basis. They do **not** claim that
  the Router selected that candidate or that a provider was called. Its token,
  provider-cost and provider-budget holds are zero. Its payload records the
  closed phase and frozen candidate/release identities needed to validate one
  conversion, without prompt content.

Every audit, report and read API that exposes the prehold must label the
provider/model as a **basis**, never as selected, dispatched or settled usage.
No dispatch is permitted while the phase is `guest_auto_prehold`.

One transactional conversion changes `guest_auto_prehold` to `exact`, proves
the selected model is in the frozen reachable set, releases only the
max-minus-exact Guest credit difference, and writes the selected provider,
model, price snapshot and ordinary exact financial holds. The transition is
one-way and at most once; the immutable subject, trace, idempotency key and
original period starts cannot change. The exact amount cannot exceed the
prehold. A deterministic application refusal raised before the conversion
transaction commits, including the normal Chat access refusals and a validated
prehold mismatch, proves that PostgreSQL rolled the conversion back. It may
release the unused financial prehold once under the request-throttle rule in
section 4. A database, transport or commit result without that rollback proof
is an unknown conversion: the row remains non-dispatchable and held for
read-only recovery.

This reuse is a financial contract change and requires migration, generated
client, protected-writer and local no-provider transition tests before review.
It does not authorize a paid Guest Refiner call, production activation or a
claim that Guest Smart Adaptive is complete by itself.

## 11. Common agent foundation checklist

1. **Policy and approval.** This version records the operator, timestamp,
   work item and exact Guest scope; section 10 fixes the reused-ledger phases.
2. **Product and ledgers.** Guest entitlement, Chat provider budgets and the
   Refiner operating budget remain distinct and use existing limits.
3. **Irreversible actions.** One provider dispatch follows verified Send and
   the finalized manifest; no autonomous second attempt is allowed.
4. **Deterministic authority.** Code owns eligibility, reservations, routing
   boundaries and stops. Model output grants no authority.
5. **External text.** Authored text and a Refiner proposal are data. Neither is
   executed as policy or instruction to the application.
6. **Credentials.** Existing server adapters and secrets are reused within
   their current boundary. No credential enters a capability or browser log.
7. **Schema and writers.** Account tables stay account-only; Guest Auto reuses
   the content-free financial row through writer/audit-restricted phases.
8. **Budgets.** Existing Guest limits and Refiner 100/day, 3000/month and
   29,918-micro-USD ceiling are unchanged and reserved before paid work.
9. **Stop controls.** Activation, rollout, Refiner kill, Router kill and the
   durable stop latch remain independent and fail closed.
10. **Unknown and idempotency.** One exact turn is claimed before cost;
    unknown retains holds and stops without blind retry.
11. **Audit and privacy.** Audit writes are transactional and content-free;
    server source snapshots and Refiner proposals remain request-memory only,
    while the existing product-scoped Guest transcript retains the authored
    user message and provider answer.
12. **Review and release.** Author and reviewer are distinct; CI, independent
    review, exact deployment readback and owner activation are all required.
