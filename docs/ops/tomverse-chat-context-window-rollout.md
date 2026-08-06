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

Current position: 30 enabled models, **0 verified**. 16 declare no window at
all; the other 14 declare one with no recorded source, so they are unverified
too. The gap is larger than "16 missing".

## A discrepancy to resolve in stage 2

The guard compares `estimatedInputTokens`, but the credit reservation uses
`budget.inputTokens`, which `createChatBudget` sets to
`estimatedInputTokens + estimateToolInputTokenOverhead(...)`
(`lib/chatSecurity.ts`). With a provider-native search attached that overhead is
6,400 tokens — 6,000 for the retrieved result text, 400 for the tool definition
— and those tokens are really sent.

So the guard today under-counts a searching turn by up to 6,400 tokens against
the very limit it is protecting. The safety check should compare at least
`budget.inputTokens + budget.maxOutputTokens`, and once a Context Builder
exists, the actual built token count rather than an estimate.

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

Run `npm run report:context-window-impact` (`--days=`, `--limit=`, `--json`).
It is read-only and computes, against real reservations:

```text
budget.inputTokens + budget.maxOutputTokens > proposedContextWindowTokens
```

Windows come from the register when a row is verified, and otherwise from what
`lib/models.ts` declares today — labelled `catalogue`, because a number with no
recorded source measures current behaviour rather than a verified limit. That
fallback is what makes the report useful before stage 1 finishes: the 14 models
whose guard is already live are the ones where the under-count below is not
hypothetical.

**What the report cannot tell you, and says so.** The reservation stores the
estimate and the tool overhead as one `inputTokens` sum. For a blocked row it
can therefore say "over the limit even with the whole 6,400-token overhead
removed" — the current guard refuses it too — or "inside that band", where
today's outcome depends on whether the turn carried search. The second number
is an upper bound on new rejections, not a count of them. Closing the band
means recording the estimate and the overhead separately in the reservation
payload, which is a schema change and a separate decision.

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
