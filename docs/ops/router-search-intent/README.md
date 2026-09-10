# Router search-intent v1

This development change corrects identified incidental source/search-intent and
recency cues in the deterministic task profiler. It is not a new model ranker,
a quality-score adjustment or evidence of a better production Router. The full
model catalogue and the Router's hard capability filters are unchanged; the
profile values supplied to those filters can change.

## Versioned, bounded behavior

`TASK_PROFILE_VERSION` changes from `task-profile-v2` to `task-profile-v3`.
The two public predicates in `lib/webSearchSuggestion.ts` keep their interface.
They replace only these incidental cue spans with equal-length spaces before
applying the existing research/recency rules:

- Source-order/sequence wording, such as `source order` or `order in the source`.
- Marked `current` boolean fields, including quoted JSON-style keys and the
  explicitly supported Korean marker forms.
- `current` record/version/row/entry reads in recognized supplied-record
  contexts. An inherited subject requires a clause-leading reading imperative;
  explicit `of`/`for` subjects and prefixed requests are retained. The matching
  `recorded/listed/shown/stored in/on` relationships are also recognized. An
  external-request cue in the clause prevents this contextual masking.
- Direct prohibitions on using today's date, including the supported Korean
  date-noun/direct-prohibition forms. The English comma-separated prohibition
  list is bounded to four preceding items, each with at most 80 trailing
  characters. Longer or ambiguous lists retain their cue. A prohibition is not
  allowed to consume an unrelated later affirmative request.

There is no generic quoted-text removal, whole-turn closed-book override or
general fix for substrings embedded in other words. `RECENCY_KEYWORDS` and the
model finder's shared `RESEARCH_PATTERN` are unchanged. The four-character
recency floor and the existing short-input recent-year rule are also unchanged.

Explicit `webSearchRequested` still outranks inferred wording. Short explicit
requests such as `출처`, `근거` and `웹검색` still have no length floor. Source
intent and inferred freshness remain separate content-free signals, not
calibrated probabilities. The source predicate is evaluated once and reused
for the source-intent signal and research-kind rule.

The profile evaluates source intent before inferred freshness. Suppressing a
source cue can expose the recency predicate; the regressions therefore inspect
the combined profile and independent affirmative cues, not just each predicate.

## Offline evidence and its limits

The independently executed comparison used base commit
`7fb3315fea786bb5313c0cf32191c6ef75118f57` and the changed runtime bytes below.
The candidate was still a worktree change when measured; its metadata's HEAD
alone is not its source identity. The eventual package records the committed
reviewed change separately.

| Runtime file | Candidate SHA-256 |
| --- | --- |
| `lib/webSearchSuggestion.ts` | `67547e0be1575ba08a4c0ced3e6988d6c47f3aa72de791ebfd5cb2ec34a5c3d7` |
| `lib/taskProfileCore.ts` | `905f57b37fc7d3002462dee24c6912488c0a704daec26e3a3fc3569dc2d34c0c` |

| Static diagnostic | Base v2 | Candidate v3 |
| --- | --- | --- |
| Original synthetic cases | 24 | 24 |
| Catalogue models / case-model rows | 42 / 1,008 | 42 / 1,008 |
| Search-inference mismatch cases | 8 / 24 | 0 / 24 |
| Router/benchmark eligibility mismatch rows | 80 / 1,008 | 0 / 1,008 |
| Benchmark eligible / refused rows | 360 / 648 | 360 / 648 |

Six cases changed task kind. The 80 Router eligibility changes were all
`false` to `true`; eight selected-model decisions changed from `gpt-5-6-luna`
to `deepseek-v4-flash`. Corpus, catalogue and every non-Router row field,
including benchmark refusals and call configuration, compared equal. The full
42-model catalogue was considered in both runs; the changed selections are
not evidence that DeepSeek gives better answers.

These mismatches are relative to the fixed corpus's declared closed-book
requirements, not human traffic labels or measured answer quality. The separate
12-file native regression run passed **225/225** tests, with zero failures,
skips or TODOs. This is a focused run, not a full repository unit-suite claim.
The instrumented diagnostic and regression processes reported zero network
attempts; that observation is not an OS-level network-isolation guarantee.

External evidence is retained at
`H:/Project/router-search-intent-v1-evidence-20260910`: `baseline.metadata.json`,
`baseline.plan.json`, `baseline.profiles.json`, `candidate-r1.metadata.json`,
`candidate-r1.plan.json`, `candidate-r1.profiles.json`, and
`candidate-r1.regressions.json` with its native TAP and stderr logs.
`final-independent-verification-r1.json` records the cross-run comparison and
preservation checks. These record the actual commands, timing, source hashes
and results. Earlier candidate attempts remain separate; no failing run is
overwritten or relabeled as passing.

The extra, non-random 17-prompt diagnostic had **14 matching expectations and
3 remaining false positives**. It is neither a representative accuracy estimate
nor a hidden all-pass gate. The retained failures are:

- A `Use only this register ... Return the current version without external
  information` instruction: the supplied-record context and external-cue
  rules deliberately recognize a narrower set of forms.
- Extracting a `source` URL already present in supplied text: source-URL
  extraction is not one of the masked spans.
- A short `Do not use today's date ... cutoff 2026-06-03` instruction: removing
  the `today` cue does not disable the existing recent-year rule for inputs of
  at most 200 characters.

Other linguistic variants can also remain ambiguous. This change makes no
claim of complete intent recognition. A changed eligible set or selected model
says nothing by itself about the quality of a response that was not generated.
Sixteen additional mixed-boundary probes matched their stated expectations.
Some were shared with the author during development; they are regression
evidence, not a blind holdout or a representative accuracy estimate.

## Historical observations are not reinterpreted

The existing corpus, answers, grader and historical scores are not rewritten.
The prior [Replay contract](../router-replay/README.md) binds saved observations
to their original profiler/source version. Those answers cannot be relabeled
as observations under this changed profiler. No provider call, new collection,
quality-band promotion, `ROUTE-01` pass or production deployment is part of this
development change.

Two existing test expectations are adapted without altering those observations.
The benchmark mismatch-reporting test now creates an intentionally conflicting
test-local prompt clone instead of depending on a corpus misclassification.
The Replay unit fixture creates a new synthetic plan and answers under the
current code; its strict expected selections, counts and injected latency totals
therefore follow v3. Those synthetic numbers do not replace the historical
60-call report or establish a measured latency improvement. The fixture
generator, Replay core and source validators remain unchanged.
The final preservation check matched all 17 original observation/journal files,
27 active terminal-review files and their 27 archived copies by size and SHA-256.

## Review record

This is a new `router-search-intent-v1` task, not a continuation or reopening of
the terminated Replay exchange. The prior
[bounded documentation/residual follow-up](../router-replay/review-followup-20260910.md)
remains unchanged. An actual read-only Claude review must name this task's own
source diff digest; a prior approval or preflight exception cannot substitute
for it.

The independent Claude review is pending. The offline results above are not an
approval, and this README does not claim that a reviewer examined these bytes.
The actual package, reviewer verdict and controller outcome must be retained
against their own digest before this task is reported as independently reviewed.
