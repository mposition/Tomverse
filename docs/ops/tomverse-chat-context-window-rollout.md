# Context-window verification and rollout

- Status: draft for Phase 0
- Owner: Backend/AI
- Register: `docs/policy/tomverse-chat-context-window-register.yaml`
- Validator: `npm run check:context-window-register`
- Gate this serves: `ESTIMATE-03` in `docs/release-gates/tomverse-chat-v1.yaml`

## Filling the catalogue is not a no-op

The chat route's guard is

```ts
if (modelConfig.contextWindowTokens && estimated + budget.maxOutputTokens > limit)
```

so a model with no declared window is not clamped to a safe default — it is not
checked at all. Declaring a window therefore *switches on* a check that was
previously skipped, and long requests that used to reach the provider start
being rejected. Any plan that treats "just fill in the values" as a safe,
behaviour-preserving change is wrong.

That is why verification, impact measurement and enforcement are three separate
stages, and why the register exists apart from the executing code.

Current position: 30 enabled models, **1 verified** (`kimi-k3`, verified while
fixing the fault below). 16 declare no window at all; another 13 declare one
with no recorded source, so they are unverified too. The gap is larger than
"16 missing".

## A discrepancy resolved (was: to resolve in stage 2)

The guard compares `estimatedInputTokens`, but the credit reservation uses
`budget.inputTokens`, which `createChatBudget` sets to
`estimatedInputTokens + estimateToolInputTokenOverhead(...)`
(`lib/chatSecurity.ts`). With a provider-native search attached that overhead is
6,400 tokens — 6,000 for the retrieved result text, 400 for the tool definition
— and those tokens are really sent.

So the guard under-counted a searching turn by up to 6,400 tokens against the
very limit it was protecting. It now measures `budget.inputTokens`, and
`createChatBudget` derives that figure through `toReservedInputTokens` so the
active calibration's safety margin and framing overhead cannot be skipped by a
caller doing its own arithmetic. Once a Context Builder exists this becomes the
actual built token count rather than an estimate.

## A capability is not a request budget

Fixing the comparison surfaced a second, worse fault in the same expression.

`maxOutputTokens` was doing two jobs: the provider's settable ceiling and the
cap this application asks for on a turn. For most models the two happen to be
close enough that nothing showed. For Kimi K3 the ceiling **is** the entire
1,048,576-token context window, and Moonshot refuses a request whose input plus
its output cap exceeds that window — so asking for the ceiling every time meant
`1 + 1,048,576 > 1,048,576` at one token of input. Every Kimi K3 request was
refused, at every size, before it reached the provider. A shipped Pro model
nobody could use, and no test said so.

The two numbers are now separate. `providerMaxOutputTokens` records the
verified ceiling; `maxOutputTokens` is what this application asks for (131,072
for Kimi K3, Moonshot's documented default); and the request actually sends

```text
min(request cap, provider ceiling, contextWindowTokens - budget.inputTokens)
```

computed by `lib/chatContextWindow.ts`. A request is refused only when that
leaves nothing — when the input alone fills the window — rather than because
the model's own maximum would not have fitted beside it. The credit and cost
reservation deliberately keeps the unfitted cap: over-reserving is refunded at
settlement, and reserving less than the answer might cost protects nothing.

Two catalogue-wide tests now stand where the missing one was: no enabled model
may refuse a one-token request, and every enabled model with a declared window
must leave a guest filling their whole input allowance at least 1,024 tokens to
answer in. The shape of the mistake — a capability used as a request budget —
is available to every future entry, so it is asserted over the catalogue rather
than for the one model that hit it.

Note the interaction with the estimator's own error
(`npm run report:token-estimate-accuracy`): the estimate currently *over*-counts
Korean by roughly 110%, which has been masking this under-count. Correcting the
estimator without also correcting the comparison would expose it.

## Stage 1 — verify and record (this stage)

Record in the register, per Tomverse model:

- Tomverse `modelId` and the real `apiModel`;
- the official context window;
- whether that window covers input only or input plus output;
- separate maximum input and output limits, where the provider states them;
- the official source URL and document title;
- the verification date and verifier;
- whether `apiModel` is an alias or `latest` pointer.

Rules the validator enforces:

- an unverified row may not carry a window, a max input or a max output — no
  estimating, no inferring from a sibling model;
- a verified row needs a source URL, a source title, a date and a verifier;
- `contextWindowIncludesOutput` must be stated explicitly, never assumed;
- `catalogueDeclaredTokens` must match `lib/models.ts`, so a window added
  straight to the catalogue fails until its evidence is recorded;
- `apiModel` and `provider` must match the catalogue, since a renamed upstream
  model invalidates the verification;
- every enabled model needs a row.

Models sharing one upstream model keep separate rows referencing the same
source — `gpt-5-5` and `gpt-5-5-thinking` are the current example. A model whose
window cannot be confirmed in official documentation stays `unverified`; that is
a finding, not a blocker to record.

## Stage 2 — shadow impact analysis, before connecting values

For each verified value, compute against recent traffic:

```text
budget.inputTokens + budget.maxOutputTokens > proposedContextWindowTokens
```

Report per model:

- how many requests would have been blocked, and what share;
- the split across Guest, Free and Pro;
- the effect on turns with attachments, native web search, and long histories;
- p95 and p99 context size for the highest-traffic models;
- how often the provider itself already returns a context error today.

Connect values per provider, not all at once, and only after the numbers are
read. A model whose shadow analysis shows material blocking needs a decision
before enforcement, not after.

## Stage 3 — fail closed, once every enabled model is verified

Only after stage 2 is complete for all enabled models, and production database
values reconcile with the register:

- `contextWindowTokens` becomes required for an enabled model;
- Admin refuses to enable a model without a verified window;
- production readiness fails when any enabled model is missing one;
- the Auto Router excludes unverified models from its candidate set;
- if a missing value still reaches runtime, the request is rejected with
  `MODEL_CONTEXT_WINDOW_UNVERIFIED` **before** any provider call or credit
  reservation;
- CI for new model registration fails without a source, a verification date and
  a window;
- database reconciliation confirms zero enabled models with a NULL window.

**Rejection, not a conservative default.** Providers differ on whether the
published window covers output, and `maxOutputTokens` varies widely, so one
invented default is either low enough to block healthy traffic or high enough to
be no safety net at all. Refusing a request the system cannot bound is the only
honest option.

## Regression tests this needs

- a model with an unverified window produces zero provider calls and zero credit
  reservations;
- a request over the combined limit produces zero provider calls and zero credit
  reservations;
- boundary cases exactly at, just under and just over the limit;
- the combined check includes tool overhead, not just the raw estimate;
- Admin refuses to enable a model without a verified window;
- database reconciliation leaves catalogue and database values in agreement;
- Router and fallback candidate selection both exclude unverified models;
- the 14 models that already declare a window keep their current behaviour
  through the change.
