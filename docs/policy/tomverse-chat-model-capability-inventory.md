# Tomverse Chat model capability inventory

- Status: Phase 0 baseline, proposed
- Decision owner: Backend/AI
- Required reviewers: Product/QA, Security/Privacy
- Binds: `docs/policy/tomverse-chat-routing.md` (candidate filters, execution budgets)
- Canonical thresholds: `docs/release-gates/tomverse-chat-v1.yaml`

## Why this exists

Router Pass 1 filters candidates on capability, context, attachments, policy,
availability, region, health and credits *before* a Context Builder runs, and
the Estimator has to predict tokens per model well enough to keep `ROUTE-04`
(Pass 2 under 5%) and `ESTIMATE-01/02` honest. Both are only as good as the
per-model facts available at decision time.

Tomverse already carries most of those facts. This document records exactly
which ones exist, where they live, and which are missing — so the Router is
built against the catalogue that exists rather than an assumed one, and so the
gaps are scheduled rather than discovered during Router implementation.

## What the Router needs, and where it comes from today

| Router/Estimator input | Source today | Shape |
| --- | --- | --- |
| Context window | `ModelRegistryEntry.contextWindowTokens` | DB, **nullable** |
| Max output / reservation output | `maxOutputTokens`, `reservationOutputTokens` | DB, **nullable** |
| Image input, native PDF, image limits | `supportsImage`, `supportsNativePdf`, `maxImages`, `maxBase64ImagePayloadBytes` | DB |
| Reasoning behaviour | `reasoning` | DB, nullable |
| Price basis | `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens`, `cachedInputPriceMultiplier` | DB, **nullable** |
| Plan entitlement and credit cost | `minimumPlan`, `usageClass`, `creditWeight` | DB |
| Operational status | `enabled`, `status`, `publiclyListed`, `catalogDeleted`, `operationalReason`, `replacementModelId` | DB |
| Web search capability | `lib/webSearchCapability.ts` | code, per catalog model id |
| Search backend reachability | `lib/webSearchBackendRuntime.ts` | environment, per deployment |
| Provider health | `ProviderHealthState`, `ProviderProbeResult`, `ProviderErrorEvent` | DB |
| Model lifecycle vs the provider's own catalogue | `ProviderModelCatalogEntry` | DB |
| Prompt token estimate | `lib/chatTokenEstimate.ts` | code, **model-agnostic** |

Two of these are stronger than a greenfield Router would assume and should be
reused rather than re-derived:

**Web search capability is already per model and already fails closed.**
`lib/webSearchCapability.ts` is keyed by catalog model id, not by provider,
because two models from one provider differ; anything not confirmed against
provider documentation is `unverified` rather than assumed supported. Router
capability filtering should read this module, not re-infer support.

It carries three routes, not one, and they are deliberately separate values of
`support` rather than shades of "native" (2026-08-27):

| `support` | Who runs the search | Who is billed | Ceiling comes from |
| --- | --- | --- | --- |
| `native` | the model's own provider | that provider | a request parameter the provider honours |
| `app-managed` | this application, through `searchBackend` | a search vendor, separately | a counter in this process |
| `search-model` | inside ordinary completion | already in the response cost | not applicable |

The register is compiled in and identical everywhere. **Whether an
`app-managed` capability can search *here* is a second fact**, resolved from
this deployment's credentials and search budget by
`resolveWebSearchBackendReadiness()`, and every surface -- composer, picker,
credit estimate, Router candidate filter, preflight, availability, dispatch --
must be given that same map. `webSearchIsDispatchable(capability, readiness)`
takes it as a required argument for exactly that reason: a default of "assume
reachable" would let a surface offer a search this deployment cannot run.

A Router candidate rejected on either ground reports `web_search_cost_unbounded`.
The two causes are told apart downstream by `resolveAttemptSearchPath`, whose
`cost_unbounded` and `backend_unavailable` gaps are fixed in different places --
one by a provider shipping a parameter, the other by an environment variable.

**Provider health already separates its evidence streams.**
`ProviderHealthState` keeps real-user-traffic, synthetic-probe and
operator-verification evidence in distinct fields precisely so one cannot
overwrite another, and recovery is tied to a verification row that authorised
it. The Router's health filter consumes this; it must not add a fourth
implicit stream by treating its own routing failures as health truth without
going through the same recording path.

## Gaps

Each gap is stated with what breaks if it is not closed before the Router
ships. None of them are blocked on Router code, so all can be closed in
parallel with it.

### G1. No tokenizer identity or per-model calibration — highest risk

`lib/chatTokenEstimate.ts` is one shared heuristic: ~1.5 tokens per
Hangul/Han/Kana character, UTF-8 bytes ÷ 4 for everything else, plus fixed
overheads for a native search tool (6,000) and a tool definition (400). It was
written to stop four surfaces carrying four different `byteLength / 4` copies,
and for that job it is correct and worth keeping.

It is not a per-model tokenizer. `ESTIMATE-01/02` require **tokenizer-stratified**
median error ≤5% and p95 ≤15%. That has now been measured rather than assumed —
`npm run report:token-estimate-accuracy`:

| Tokenizer | Median absolute error | p95 |
| --- | --- | --- |
| `o200k_base` (GPT-5 family) | 97.4% | 117.1% |
| `cl100k_base` (GPT-4 family) | 25.0% | 52.2% |

The error is systematic, one-directional, and worst in Korean. The heuristic
assumes 1.5 tokens per CJK character; `o200k_base` actually spends about 0.74
to 0.79, so Korean prose is overestimated by roughly 110%. English prose is
overestimated by about 29% — the assumed 4 bytes per token measures closer to
5.6. Only code and JSON land near the budget, and those undershoot.

The constants are not so much wrong as *aged*: against `cl100k_base` the CJK
ratio is 1.16 to 1.37, so 1.5 was a fair approximation when it was written.
Newer tokenizers became far more efficient on CJK and the constant did not
follow.

Two consequences, one already live and one waiting on the Router:

- **Today** the estimate drives credit reservation and the context-window
  guard. Overestimating is the safe direction for billing, since reservations
  settle at actual usage — but it means a Korean conversation can be refused
  for credits it would not have spent, and can hit
  `MODEL_CONTEXT_WINDOW_EXCEEDED` while it would still have fit.
- **With Auto routing** the same overestimate inflates the Pass 1 context
  estimate, so Korean conversations get routed to unnecessarily large-context
  models and trigger the Pass 2 escape hatch spuriously, against `ROUTE-04`'s
  5% cap.

For a Korean-first product this is the gap that most directly mis-serves the
primary language.

The measurement covers the OpenAI families only. Anthropic and Google tokenize
differently and expose counting over the network, so their error is still
unmeasured; `ESTIMATE-01/02` evidence is not decision-grade until they are
included.

Needed: a tokenizer family per model, and a calibration factor per family that
the measured `estimatedInputTokens` / `actualInputTokens` delta on
`RoutingAttempt` can tune. The routing policy already plans to record that
delta; there is nowhere to write the correction it produces.

### G2. Health is keyed by provider, filtering is per model

`ProviderHealthState` has `provider String @id`, while `ProviderProbeResult`
is per `(provider, modelId)`. Router candidate filtering is per model, so
without a rollup it can only over-block (one model degraded blocks the whole
provider) or under-block (a broken model stays eligible while its provider
looks healthy).

**Closed** by `lib/modelHealthRollup.ts`. It derives a per-model verdict from
the probe rows the existing health path already writes, and reuses
`evaluateProviderFailureHealth` rather than inventing a second set of
thresholds for the same judgement. Nothing in it reads routing outcomes, so it
does not become the fourth evidence stream the routing policy forbids.

Three rules the rollup encodes:

- a provider outage takes every model with it, because a model cannot be
  reachable through an unreachable provider;
- a model can be individually unavailable while its provider is healthy, which
  is the case the provider-keyed signal could never express;
- a provider that is degraded but not out degrades its models too, because the
  shared path between them is what is misbehaving and a model's own probes
  cannot see it.

`unknown` is a distinct status, not a synonym for healthy: a model that has
never been probed, or whose probes are stale, is excluded from Auto while a
deliberate manual choice still goes through. That is the same discipline
`lib/webSearchCapability.ts` applies by leaving unconfirmed models
`unverified` rather than assuming support.

### G3. No failure domain

The routing policy prefers a fallback candidate in a *different failure
domain* from the primary. `provider` is the only proxy available, which
conflates same-vendor-different-region and any gateway shared across
providers. An explicit failure domain per model is needed, or the fallback
policy's diversity preference is unimplementable as written.

**Closed** by `lib/failureDomain.ts`, which derives the domain from the
mechanism rather than the label: the host a model is reached through and the
credential it authenticates with. Those are the two things a real outage runs
along -- a shared endpoint fails as one endpoint, a shared credential fails as
one account.

Measured against today's catalogue, provider was already an accurate proxy: 11
providers, 11 distinct hosts, 11 distinct credentials, no credential shared
across providers. But it was *accidentally* accurate, with nothing keeping it
that way. Two ordinary changes would have broken it silently — an
OpenAI-compatible gateway put in front of several vendors, or one credential
reused across them.

Two tests state the property rather than enumerate the domains, so adding a
model cannot fail them while merging two providers must. If they do fail, the
derived domain has already done the right thing; the failure is the
notification that a merge happened, not a bug.

### G4. No regional availability

`docs/policy/tomverse-chat-routing.md` §4 lists regional availability as a
hard candidate filter. No field records it. Either the field is added or the
policy drops the claim — it should not stay in the policy as an unenforceable
filter.

### G5. Router-critical capability fields are nullable

`contextWindowTokens`, `maxOutputTokens` and the price fields are `Int?` /
`Float?`. `ESTIMATE-03` is zero tolerance: no over-limit request may reach a
provider. A model with a null context window cannot be filtered on at all.

The repository already has the right pattern for this — `check:model-pricing`
fails the build when an enabled premium model has no explicit billing profile,
because generic fallback pricing mispriced production models by 3x-7.5x. The
same fail-closed treatment is needed for the fields Auto routing depends on:
either the values are required for an Auto-eligible model, or that model is
ineligible for Auto. Silence must not resolve to a default.

### G6. No tool-calling or structured-output contract

The Planner emits structured instructions per provider and the Adapter
serialises them, but nothing records which tool-calling or structured-output
format a model accepts. Adapter failure is expected to be model-specific and
is the one `not_dispatched` class that may trigger a different-model fallback,
so this is a routing input, not just an implementation detail.

### G7. No latency baseline for routing

`ROUTE-02`/`ROUTE-03` budget routing latency and TTFT overhead.
`ProviderProbeResult.latencyMs` exists per probe, but there is no per-model
rollup the Router could weigh a candidate against. Without it, latency-aware
routing has no input and the budgets can only be measured after the fact.

## Inventory schema

The inventory is the Router-facing view over the facts above. It is derived,
never a second catalogue: `ModelRegistryEntry` stays the model source of
truth, `lib/webSearchCapability.ts` stays the web-search source of truth, and
`ProviderHealthState` / `ProviderProbeResult` stay the health source of truth.

```text
ModelCapabilitySnapshot
  modelId                       catalog id, joins ModelRegistryEntry.id
  provider
  failureDomain                 G3 -- distinct from provider
  tokenizerFamily               G1
  tokenizerCalibrationVersion   G1 -- which correction factor produced an estimate
  contextWindowTokens           required for Auto eligibility (G5)
  maxOutputTokens               required for Auto eligibility (G5)
  reservationOutputTokens
  supportsImage / supportsNativePdf / maxImages / maxBase64ImagePayloadBytes
  webSearchSupport              read from lib/webSearchCapability.ts, never re-inferred
  toolCallingFormat             G6
  structuredOutputFormat        G6
  reasoningMode
  inputUsdPerMillionTokens      required for Auto eligibility (G5)
  outputUsdPerMillionTokens     required for Auto eligibility (G5)
  cachedInputPriceMultiplier
  minimumPlan / usageClass / creditWeight
  regions                       G4
  autoEligible                  false whenever a required field is missing
  autoIneligibleReason          why, so the exclusion is explainable
  snapshotVersion               so a RoutingRun can name the facts it decided on
```

Two properties matter more than the field list:

**`autoEligible` is computed, not authored.** A model missing any field the
Router must filter on is excluded from Auto with a recorded reason, rather
than routed on a default. This is the `check:model-pricing` lesson applied to
routing inputs.

**`snapshotVersion` is referenced by `RoutingRun`.** Router evaluation compares
versions; a decision whose inputs cannot be reconstructed cannot be compared
against a later Router. This mirrors how `ContextManifest` references immutable
versions rather than copying content.

## Sequencing

G1 and G5 gate the Estimator and therefore `ESTIMATE-01/02/03` and `ROUTE-04`;
they are the first work. G2 and G3 gate fallback candidate selection
(`FALLBACK-01`, `FALLBACK-03`). G4 and G6 gate Pass 1 filters. G7 is
measurement rather than safety and may follow the first Auto cohort.

Closing G4 by deleting the claim from the routing policy is an acceptable
outcome, decided deliberately. Leaving it stated but unenforced is not.
