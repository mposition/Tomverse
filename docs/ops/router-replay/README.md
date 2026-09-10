# Router Replay v1

Replay compares two static model-selection policies using one existing
development collection and its saved answers. It does not generate answers,
dispatch production requests, call a provider or an LLM judge, or change the
original score. It is not evidence of an optimal Router or improved production
quality. The [60-call pilot diagnosis](pilot-60-diagnostics.md) explains the
limited observation set used during development.

The [v1 synthetic corpus and exact grader](../router-development-benchmark/README.md)
and [collector contract](../router-development-benchmark/collector-v1.1.md)
remain unchanged. The original 24 cases and full catalogue-by-case population
are retained, including refusals and unobserved rows. Four observed synthetic
cases cannot establish a whole-catalogue ranking, representative traffic
performance, `ROUTE-01`, statistical significance, or a quality-band promotion.

## Observation source and Replay source

The observation manifest, answers, and their original source are immutable.
`--observation-source-ref` must independently identify the original full
40-character Git commit; it is not inferred from an untrusted manifest. The
CLI reads a fixed trusted source-file list from Git, not file paths or code
chosen by the manifest. It does not import or execute archived source code.

Validation reuses the existing corpus, plan, manifest, and result validators.
The original source-file bytes, model identity, catalogue, pricing, settings,
and reconstructed plan must match. A changed reconstruction fails closed;
editing a digest or replacing the observation source with the Replay HEAD
does not make an old answer compatible. The package compatibility exception
is limited to removing the exact added `benchmark:router:replay` script and
then comparing the entire remaining package object. It does not permit other
scripts, dependencies, configuration, or pricing changes.

Reports keep `observationSource` separate from `replaySource`. The first binds
the historical collection; the second identifies the new comparison code.
Candidate policy identity and content are separate from both. Source hashes
provide local integrity and reproducibility, not provider authentication or
proof that a policy author never inspected the development answers.

Only one manifest and one answer bundle are supported. Answers must belong to
the manifest's selected rows as well as the original plan. Duplicate, unknown,
refused, stale, or identity-mismatched results are rejected. Replay does not
merge collections or move an answer to another prompt, API model, output cap,
or generation setting. It neither reads nor rewrites the collector journal,
registration witness, spending approval, or historical score.

## Data-only candidate policy

[default-model-control.v1.json](default-model-control.v1.json) is an
exploratory control, not an adopted routing policy. It prefers the existing
`DEFAULT_MODEL_ID`, `gpt-5-6-luna`, for `general` tasks. This choice follows the
existing default, not the four pilot answers. Internal catalogue IDs are not
provider API identities; both must retain their original binding.

The strict policy has schema `router-development-replay-policy-v1`, purpose
`development-only`, a `policyId`, `preferences`, and
`fallback: "original-router"`. Preference keys are existing task kinds:
`general`, `coding`, `writing`, `research`, `documents`, and `multilingual`.
Each list orders catalogue model IDs. The first model that also passes the
original Router's hard eligibility is selected. If none qualifies, selection
falls back to the original Router baseline. Empty `preferences` is an
identity control. A preference never weakens an eligibility filter.

The selection path receives no case ID, fixture-language override, saved
answer, expected answer, or grade. There is no JavaScript policy import or
expression evaluator. This limits programmatic answer leakage; it does not
turn development fixtures into a blind or human-adopted decision set.

## Read the two comparison domains separately

`benchmarkDomain` compares saved answers for the same case while requiring
each selected model's observation to match its own frozen benchmark prompt,
provider/API identity, cap, and settings. It does not require different models
to have identical API names or output caps. Missing or incompatible
observations are unavailable, not losses. Acquisition failures remain separate
from incorrect returned answers.
Corrected, regressed, unchanged, and unavailable counts must be read with their
common-observation denominator and the full 24-case denominator. An incomplete
common set cannot produce a whole-corpus quality delta.

In `benchmarkDomain.paired`, `commonObservedCases` includes recorded acquisition
failures. `observedSubset.correctOutcomeShareDelta` uses that denominator, not
only successful answers. `correctedCases` and `regressedCases` apply only when
both choices returned an answer; acquisition recovery/failure is counted
separately. These categories are not an additive partition. The full-population
`wholePopulationCorrectOutcomeShareDelta` stays `null` until every case has
both observations. The `observationBundle` separately preserves the original
full-matrix score summary and imported/selected row counts.

`productCompatibility` preserves differences between the original product
Router's eligibility, search requirements, and output cap and the fixture
collection's settings. A successful benchmark-domain comparison is not proof
that the same response would occur under product dispatch conditions. Do not
combine the two sections into a product-quality score.
`comparedFieldsCompatible` describes only the listed static checks;
`productExecutionVerified` stays false and `productPerformanceDelta` stays null.

Missing token, latency, and cost metrics stay `null`, never zero. Replay uses
the saved answer metrics, not the collection reservation or a separate ledger
cost estimate. Historical whole-call latency is not counterfactual provider
latency, end-to-end product latency, or an invoice. Reports omit prompt,
answer, and expected-answer text.

## Offline operating interface

Use the local Replay checkout with its matching installed dependencies and
the original observation commit available in Git. No provider credentials,
collector approval, or network access are needed. Do not copy credentials into
arguments or inputs. The example reads the existing pilot files and creates
only a new comparison report; it does not run the collector or scorer again.

```powershell
Set-Location -LiteralPath 'H:/Project/tomverse-router-replay-v1-20260910'
npm run benchmark:router:replay -- --help
New-Item -ItemType Directory -Path 'H:/Project/router-replay-v1-results-20260910'
$replayArgs = @(
  '--manifest=H:/Project/router-development-pilot-final-60calls-e9ba719e-20260910/pilot-60-manifest.merged-e9ba719e.json'
  '--answers=H:/Project/router-development-pilot-final-60calls-e9ba719e-20260910/answers.v1.json'
  '--candidate=H:/Project/tomverse-router-replay-v1-20260910/docs/ops/router-replay/default-model-control.v1.json'
  '--observation-source-ref=e9ba719e1941302efe626be6987f953e40de608d'
  '--output=H:/Project/router-replay-v1-results-20260910/replay.default-model-control.v1.json'
)
npm run benchmark:router:replay -- @replayArgs
```

All value flags use `--key=value`; the four input flags are required and the
source ref is full lowercase hexadecimal. Unknown or duplicate flags fail;
`--help` must stand alone. Omitting `--output` prints JSON to stdout.
The CLI does not create the output parent directory and opens the output with
exclusive creation (`wx`), so an existing file is refused.
The example explicitly creates a separate new output directory; if that path
already exists, inspect it and choose a new report filename without replacing
existing evidence. Keep new reports outside the immutable observation folder.
The absolute paths avoid npm package-root versus direct Node working-directory
ambiguity.
The package script is exactly
`node --import tsx scripts/router-development-replay.mjs`.

These commands document the interface, not an execution result or permission
for further paid collection. Verification and actual independent review are
recorded separately against their exact source and diff digest. Earlier
benchmark, collector, or launcher approvals and review-preflight/on-hold
exceptions do not approve this Replay change.

Implementation references: [comparison core](../../../lib/routerDevelopmentReplay.ts),
[source compatibility](../../../lib/routerDevelopmentReplaySource.ts), and
[offline CLI](../../../scripts/router-development-replay.mjs).
