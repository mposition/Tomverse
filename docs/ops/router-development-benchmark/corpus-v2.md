# Benchmark v2 corpus and independent answer checks

This bounded slice adds a separate synthetic **development-only** corpus,
whole-family tuning/validation partitions, and deterministic answer checks.
It does not implement a 48-case catalogue plan, collection or Replay bridge.
The [v1 corpus and tools](README.md) and the [execution-contract slice](execution-contract-v2.md)
remain unchanged. No provider is called, no past answer is relabelled, and no
Router score, release gate, runtime flag or spending approval is modified.

## Files and schemas

- [development-v2.json](development-v2.json): `router-development-corpus-v2`,
  corpus ID `tomverse-router-development-v2`, purpose `development-only`.
- [development-v2-partitions.json](development-v2-partitions.json):
  `router-development-partitions-v2`, partition ID
  `tomverse-router-development-v2-family-split-v1`, bound to the complete corpus
  digest, including prompts, expected answers and metadata.
- [Corpus core](../../../lib/routerDevelopmentCorpusV2.ts) and
  [core tests](../../../tests/routerDevelopmentCorpusV2.test.mjs): strict schema,
  coverage, partition binding, prompt-only projection and reused exact grader.
- [Independent oracle](../../../lib/routerDevelopmentCorpusOracleV2.ts) and
  [oracle tests](../../../tests/routerDevelopmentCorpusOracleV2.test.mjs):
  separately authored prompt parsing and expected-value derivation.
- [Local checker](../../../scripts/router-development-corpus-v2.mjs) and
  [CLI tests](../../../tests/routerDevelopmentCorpusV2Cli.test.mjs): bounded
  local verification and optional new-directory artifacts, not a provider runner.

Each case has the v1 fields `id`, `language`, `task`, `prompt`, `expected`,
`grading` and `requirements`, plus `difficulty` and `familyId`. Partition is
deliberately absent from a case: the separate manifest assigns entire families.
The v1 validator still requires its original 24 cases and rejects v2.

## Coverage and partition meaning

The corpus has two tasks, two languages and two engineering difficulty labels:
`basic` and `advanced`. Every task/language/difficulty cell contains six cases.
Each template family contains exactly four cases, one per language/difficulty
combination. Korean and English records and instructions were authored for
their own scenarios, not used as paired translations for statistical comparison.
Difficulty is not a measured model ranking or a calibrated cross-language scale.

| Task | Language | Basic | Advanced | Total |
|---|---|---:|---:|---:|
| Structured extraction | en | 6 | 6 | 12 |
| Structured extraction | ko | 6 | 6 | 12 |
| Grounded calculation | en | 6 | 6 | 12 |
| Grounded calculation | ko | 6 | 6 | 12 |
| Total | both | 24 | 24 | 48 |

Three families per task are tuning and three are development-validation.
Consequently each cell has three tuning and three validation cases, and the
complete split is 24/24. A family never crosses partitions, including across
languages or difficulty levels. The fixed split ID rejects even a balanced
swap of family assignments. A different split needs an explicitly versioned
protocol change rather than reusing this ID after seeing results.

| Template family | Partition | Basic operation | Advanced extension |
|---|---|---|---|
| `extract-active-selection` | tuning | Select a uniquely qualifying record | Compound inclusion predicates, multiple matches, nullable copied fields and preserved order |
| `extract-revision-resolution` | tuning | Latest approved/published numeric revision | Per-request revision choice with an inclusive cutoff and explicit missing records |
| `extract-keyed-join` | tuning | Join a selected record to one lookup table | Two exact-key joins, eligibility filtering and explicit missing lookup semantics |
| `extract-state-fold` | development-validation | Apply ordered patches to one state | Multiple identities, unknown-ID handling, clearing fields and final-state filtering |
| `extract-ordered-membership` | development-validation | Ordered distinct membership with exclusions | Two input sequences, combined allow/exclude sets and separate repeat/rejection counts |
| `extract-literal-projection` | development-validation | Preserve literal data, empty values and instruction-like text | Field-presence precedence and whole nested-object replacement, not sequential event folding |
| `calc-inventory-ledger` | tuning | Accepted stock increases and decreases | Per-item ledgers followed by separate reservations and an aggregate |
| `calc-invoice-adjustments` | tuning | Line totals, one adjustment and a separate fee | Item eligibility, per-line adjustments, ordered discounts and explicit tax rounding where requested |
| `calc-unit-conversion` | tuning | Explicit conversion and remaining quantity | Per-item exclusions and waste followed by a shared reserve |
| `calc-elapsed-windows` | development-validation | Elapsed time minus breaks | Cross-day intervals, per-window breaks and explicit per-window or post-sum block rounding |
| `calc-weighted-capacity` | development-validation | Count-weighted mean and a threshold | Eligibility, adjusted/clamped scores and matched numerator/denominator populations |
| `calc-tiered-allocation` | development-validation | Ordered whole-unit allocation under a protected balance | Per-row caps, closed requests and sequential integer affordability |

These are engineering template boundaries, not a proof of statistical
independence. Filtering, joining, copying, addition and other basic primitives
necessarily recur. The literal-projection family resolves a single precedence
relationship; the state-fold family applies an ordered event history and may
filter on the resulting state. The partition must not be described as a
decision set or a generic independent holdout. Policy tuning and measured
model evaluation have not occurred in this slice.

## Inputs, answers and ambiguity checks

Each prompt provides one `SOURCE_JSON` block, natural-language operations,
units and output keys/types. Only those supplied fictional facts are needed.
Dates, event order, inclusive boundaries, missing/null values, whole-unit
allocation and any rounding rule are specified in the relevant prompt.
Instruction-like text in literal-copy cases is explicitly inert source data.
Search, attachments, tools, external facts and code execution are unsupported.

The model projection is exactly `{ prompt }`: no expected value, case ID,
family, difficulty, partition, grader metadata or private derivation graph is
added. An inspection packet is different: its rows contain `id` and `prompt`
so a verifier can bind a derivation to a case. It is not a provider envelope.
The prompt contains its public task instructions and raw data, not the
author's calculated answer or private operation graph.

The reused `gradeDevelopmentAnswer` compares exact JSON values. Object-key
order and formatting whitespace are irrelevant, while array order, string
contents, missing/extra keys, types and nulls remain significant. Duplicate
keys, invalid JSON, unsafe numbers and precision loss are refused. No model
judge, arbitrary code evaluation or approximate answer tolerance is added.

The independent derivation protocol is:

1. The corpus author fixes prompts and gold, then exports an ID/prompt-only
   packet with a canonical body digest and raw-file SHA-256.
2. A separate Codex agent reads only that packet, independently encodes source
   parsing, task rules and ambiguity checks, and seals its derived results and
   implementation hashes before it reads the corpus gold.
3. Only after that seal are all 48 derived objects compared with the authored
   expected objects. Disagreements require diagnosis; prompts or oracle logic
   must not be changed merely to obtain agreement. Any approved correction
   retains the initial bytes and the mismatch disposition.
4. The local checker reruns the frozen derivation, compares every case and
   reports coverage. A prompt or rule change requires fresh independent
   derivation rather than silent acceptance under an old prompt digest.

This is separate-agent, shared-filesystem **procedural blinding**, not an
access-control guarantee, independent human assessment or provider evidence.
Both agents remain AI. Oracle agreement establishes these deterministic
answers under the declared rules, not broad model quality or lack of all
possible ambiguities. The corpus author's positive grader tests are not
called independent expected-value verification.

### Observed derivation and post-seal comparison — 2026-09-11

The separate oracle agent sealed its 48 prompt-only derivations at
`2026-09-11T06:48:55.725Z`, before reading the authored gold. Its receipt records
that it did not read the author's corpus core or generator either. The parent
checked the preserved packet, source and result hashes before authorizing
gold comparison. The oracle agent's dedicated post-seal comparison receipt
at `2026-09-11T06:50:34.190Z`
recorded **48/48 matching prompt strings and canonical expected objects,
zero mismatches**, without changing the oracle source, authored gold or prompts.
This is a deterministic development observation, not a human quality label.

The retained local evidence directory is
`H:/Project/router-benchmark-v2-corpus-evidence-20260911/`. The filenames and
full digests below identify the observed bytes; local retention does not
promise that these files are available as remote GitHub artifacts. Corpus,
partition and oracle source are separately included in this change so the
local checker can reproduce answer agreement. It cannot reproduce or certify
the historical claim about what an agent had read before the seal.

| Record | SHA-256 / meaning |
|---|---|
| `prompt-only-stageA-extraction.json` | `31c91f704c56bfb61735372215fed29c6012f31f678f3c76536c6e6a45b6bbc0` — first 24 prompts, all preserved in the final packet |
| `prompt-only-round0.json` | `d6bcf61d69ae664f52172a6ffb294219696ec7187838a17e6a87526dcdbfdaf0` — final 48-case file bytes |
| Final packet canonical body | `ec5e8078febd0d79d3b29d4d4ae9f8d8e2ee970e3d7b51dbed8dbeda162f00db` — excludes its own `packetDigest` field |
| Initial and unchanged corpus file | `aee54a75b9ddb7925084993a2a683125accb191a7682bd3ed431bf900379bb16` |
| Corpus canonical digest | `7cb8541f47799b16ca0ce703cfcafc6dca1f576669a2cc1d444335cade1c67e2` — bound by the partition manifest |
| Partition file | `01462e51b8f5fa31feefa626574b4206c2744e00ba22e6e8e1998f443a1a37d3` |
| `oracle-pre-gold-freeze-round0/receipt.json` | `28bd177a49147b128ccd5d48cb5b0a657ef6ea6c9178848681c83893b63d6ad1` |
| Frozen oracle source | `e925fcf88db9dc2629079bb190082d4285ed33ef8082e35f2c0c32e40d1939be` |
| `oracle-pre-gold-freeze-round0/derived-results.json` | `d54d9111d6be6451137e3350e229103e0b560d7b6f99d149e6d1a14c740bbe20` — raw file; canonical digest is `833f750c98d1014c87e18a96dc463661ddaa3746631e335940a0438c42b00d2d` |
| `oracle-postseal-first-comparison-round0.json` | `e1b5030b57763b903b3e0b6d59bc473b2b9e9508920492ab42c0f432ec1409c6` — 48 matches, no mismatch disposition or correction needed |

The seal records 48 derivations, eight direct prompt-rule assertions and 144
unknown-ID, changed-prompt and extra-input-field refusals. These counts are
not the final project's test-suite total. The final commit's scoped test and
Claude review records must be reported separately; this section does not
assert that a Claude review or release approval has occurred.

## Local commands and outputs

Run on the local Windows PC, PowerShell, in the Tomverse worktree root.
Node 22 and the existing installed dependencies are required. No provider or
production credentials are needed. These commands read local files and print
help or a content-free verification report; they do not write or call providers.

```powershell
npm run check:router-development-corpus-v2 -- --help
npm run check:router-development-corpus-v2
```

In the same environment, this command creates only a new output directory
under an existing parent. Existing directories and symlink ancestors are
refused. Preserve the directory for review, or remove only that generated
directory after inspecting it when the evidence is no longer needed.

```powershell
npm run check:router-development-corpus-v2 -- --out=H:/Project/router-corpus-v2-check
```

Here, content-free means no prompt or expected-answer text; case identifiers,
family labels, counts and digests remain available for audit. The optional
files are `coverage.json` (content-free verification counts,
digests and limitations) and `prompt-only.json` (the synthetic ID/prompt
inspection packet, not answers). Standard output remains content-free.
The evidence label is `development_corpus_checks_only`, with
`decisionEvidence: false`, `modelQualityMeasured: false`, and `providerCalls: 0`.
This is not a spend, production-readiness or quality result.

`--mode=verify` is the only mode and is the default. `--corpus=PATH` and
`--partitions=PATH` may read local inputs, but do not bypass strict schema,
frozen family assignment, corpus digest or the oracle's frozen prompt checks.
Mismatched gold is a failure. All values use `--key=value`; unsupported, live
and duplicate arguments are refused. There is no overwrite flag.

On the same local PC/PowerShell/worktree, with the same prerequisites and no
credentials, run the scoped tests. CLI tests create and clean only their own
temporary fixture directories.

```powershell
npm run test:router-development-corpus-v2
```

## Bounds and deliberately absent work

- Corpus: 1 MiB; each prompt: 16 KiB; partition document: 16 KiB.
- The shared parser retains 16 MiB general-document, 32-depth and 200,000-node
  bounds; the exact grader retains its 64 KiB answer bound.
- All 48 cases and all eight cells remain in coverage. A failed verification
  is not removed from the denominator or replaced by a newly convenient case.
- Only bounded corpus and partition data paths may be selected. Executable or
  module paths, custom provider adapters, live flags, credentials and
  historical provider artifacts are not inputs to this checker.
- No new claim that 48 times 256 model rows fit a plan. The inherited shared
  node bound can refuse a large plan before its model-count declaration.
- No change to the existing collector's 1,008-selected-call ceiling or its
  approval, reservation, journal, interruption and zero-retry behavior.
- No 48-case collection, v2 plan/Replay adapter, metric collection, confidence
  interval, policy selection or paid manifest is delivered here.

The next bounded benchmark work is the explicitly versioned v2
planning/mock/Replay bridge while retaining all catalogue rows and the current
execution-contract checks. Actual provider runs still require a new exact
manifest and separate spending approval. Separately, the mobile-web Chat
transcript can be implemented with mocks; it does not need to wait for paid
benchmark observations. See the [Chat progress record](../tomverse-chat-progress.md).
