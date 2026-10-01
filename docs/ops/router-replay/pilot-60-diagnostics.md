# Frozen 60-call pilot: diagnostic limits

This is an offline diagnosis of the existing collection at source
`e9ba719e1941302efe626be6987f953e40de608d`, not another run or a revised score.
It uses four synthetic cases per statically eligible model: one extraction
and one calculation case in each of Korean and English. No answer, prompt,
or gold text is reproduced here.

## Observed result and denominator

The frozen plan contains 42 models and 24 cases: 1,008 rows, including 360
statically eligible rows and 648 refusals. The pilot selected 60 rows across
15 models. It recorded 60 intents and 60 terminals, with 56 returned answers,
four acquisition failures, no unknown rows, and no automatic retry. The
remaining 300 eligible rows were not run; the 648 refusals remain present.

The unchanged exact grader recorded 54 correct answers, two `value_mismatch`
answers, and four `provider_http_error` acquisition failures. Blank, invalid
JSON, and timeout counts were zero. Coverage is 60/360, not full coverage;
the historical headline `correctnessRate` is `null`. Thirteen models passed
all four sampled cases, so these observations do not distinguish their
overall quality. This is a smoke sample, not a ranking or an optimal-selection
guarantee for all 42 models or real traffic.

## Two incorrect answers and four acquisition failures

Both incorrect answers belong to internal model ID `gemini-2-5-flash`.
The frozen [catalogue](../../../lib/models.ts) maps that ID to provider
`google`, API identity `gemini-3.5-flash-lite`, and display name Gemini 3.5
Flash-Lite. An internal ID is not a claim that the provider served the API
model suggested by the ID's spelling. Do not rename historical rows.

- `dev-en-calc-01`: the returned numeric field disagrees with the explicit
  arithmetic in the fixture. The arithmetic-mismatch diagnosis has high
  confidence; the record does not establish why the model made it.
- `dev-ko-extract-01`: the only mismatch concerns whether an identifier's
  descriptive prefix belongs in the returned string. The exact grader's
  mismatch is reproducible, while the prompt has a weak ambiguity about that
  prefix boundary. This is a moderate-confidence wording concern, not grounds
  to change the frozen expected value or retrospectively count a pass.

The four failures belong to `grok-4-5`, API identity `grok-4.5`. They are
acquisition failures, not incorrect answers. Complete HTTP-response observation
does not imply a successful response. The allowlisted records retain a safe
failure code but not the HTTP status or raw error payload, so authentication,
quota, model availability, request parameters, and provider-server causes
cannot be distinguished from these files. No retry or live access probe was
performed for this diagnosis.

## Costs and product compatibility

All 60 exported answer rows have `providerCostUsd: null`. Separately, the
collector recorded a conditional committed reservation of 272,208,060
micro-USD. That reservation is not actual spending or an invoice. A separate
journal-based frozen-rate token estimate is known for 27 rows and sums to
43,925 micro-USD
($0.043925); 33 rows remain unknown, including missing required cache-write
usage observations. The whole-run estimate and actual billed amount therefore
remain unknown. Replay does not import this separate estimate to fill the
answer bundle's null costs.

The original product Router profile can require search or a different output
cap from the validated fixture collector. Static fixture eligibility also
does not certify account access, quota, or runtime health. Replay must retain
those compatibility differences separately from benchmark-domain comparisons;
the sampled answers are not a replay of production dispatch.

An independent pre-implementation projection of the 60 selected rows found
10 originally Router-ineligible rows, 15 inferred-current-information versus
fixture-no-search mismatches, and 37 original-versus-benchmark output-cap
mismatches. These conditions overlap and must not be added. Eighteen rows
match those three checks, which does not establish complete product equivalence
of their settings and request construction. The original baseline has saved
answers for four cases, all correct, but each of those four differs in search
or output-cap conditions. They remain benchmark-domain observations, not
product-equivalent response evidence.

## Evidence and provenance

The original files remain in
`H:/Project/router-development-pilot-final-60calls-e9ba719e-20260910`.
The following SHA-256 values identify the unchanged inputs and score:

| File | SHA-256 |
| --- | --- |
| `pilot-60-manifest.merged-e9ba719e.json` | `2e6be4bfd68804b639897b1fab8bb9c8a6439217a6340118d82204c4d2d64cfc` |
| `answers.v1.json` | `c31a88244f804ad975a8fb351ad29d6295894891166e36249c21ce43c94ae43d` |
| `score.v1.json` | `c88b04c5dda60306fc40c27ed221a68bc028b5f93762a63491d8d4e15db0b691` |

A separate Codex verifier reported exact canonical score reproduction with
the existing validators/grader at 2026-09-10T10:27:23.472Z, exit 0 and zero
network-trap calls. Its subsequent safe-projection diagnosis was observed at
10:46:22.127Z; preservation checks at 10:47:46.072Z retained the 15 original
artifacts, two journal/witness files, and clean e9b source. These are local
verification observations, not a new Claude verdict or provider attestation.
No separate score-audit report file was created for that verification.

The [Replay interface](README.md),
[original exact-grader contract](../router-development-benchmark/README.md),
[collector retention/export contract](../router-development-benchmark/collector-v1.1.md),
[grader implementation](../../../lib/routerDevelopmentBenchmark.ts), and
[provider observation adapter](../../../lib/routerDevelopmentCollectorProvider.ts)
define the relevant boundaries. This diagnosis changes no source fixture,
historical outcome, quality band, runtime flag, pricing, or production policy.
