# Router search-intent v1

This development change addresses identified incidental source/search-intent and
recency cues used by the deterministic task profiler, web-search retry topic
classifier and DeepResearch topic classifier. It is not a new model ranker,
a quality-score adjustment or evidence of a better production Router. The full
model catalogue and the Router's hard capability filters are unchanged; the
profile values supplied to those filters can change.

## Versioned, bounded behavior

`TASK_PROFILE_VERSION` changes from `task-profile-v2` to `task-profile-v3`.
The two public predicates in `lib/webSearchSuggestion.ts` keep their interface.
Separate source-only and recency-only passes replace the relevant incidental
cue spans with equal-length spaces before applying the existing rules. Neither
pass caches turn text. The split avoids applying the other vocabulary's masks;
no runtime performance or cost improvement has been measured.

- Source-order/sequence wording, such as `source order` or `order in the source`.
  The forward form accepts spaces/tabs or one directly attached compound hyphen
  (`source-order`); a spaced dash, repeated hyphens or line break remains a boundary.
- Marked `current` boolean fields, including quoted JSON-style keys and the
  explicitly supported Korean marker forms. English uses assignment syntax,
  `marked`/`flagged`, or supported local fields in supplied-record contexts.
  English and Korean values must end at a field separator or the input end;
  truth-like prefixes in prose are retained.
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

`hasExplicitSourceOrSearchIntent` also feeds `classifyWebSearchTopic` in
`lib/webSearchRetrySuggestion.ts`, which separately reads the task profile.
For `Keep the rows in source order.`, the deliberate downstream change is from
a suggested search with `explicit_search_request` and `recency` signals to
`suggested: false`, `refusal: no_recency_signal`. The classifier still has its
own minimum-length, writing/translation and live-lookup rules; this is not a
claim that every retry suggestion is unchanged or that search is globally
disabled. Consumer-level assertions and the existing retry-suggestion test
suite are included in the revision 1 checks below; that classifier's source
file itself is unchanged.

`classifyDeepResearchTopic` in `lib/deepResearchSuggestion.ts` is another live
consumer of the profile's `research:vocabulary` and freshness signals. For
`Keep the names in source order.`, its deliberate change is from an
`explicit_research_request` suggestion to `no_depth_signal`. Its own depth and
refusal rules remain unchanged: a recency cue alone is not a depth request.
The existing dedicated DeepResearch and `answerSuggestionArbitration` suites
are included in revision 2. They exercise the real classifiers and derive
functions, including offer priority; both consumer modules, the arbitration
module and their existing test files are unchanged.

## Round 0 offline evidence and its limits

The independently executed comparison used base commit
`7fb3315fea786bb5313c0cf32191c6ef75118f57` and the changed runtime bytes below.
That candidate was still a worktree change when first measured; its metadata's
HEAD alone is not its source identity. These bytes were later committed as
`1e3231ee6f74dfddad9330cb2be29b9d10c56a8c` and packaged for round 0. The numbers
in this section are historical evidence for that candidate, not a fresh result
for its subsequent revision or a claim that Claude approved it.

The earlier [dated v2 profiler-disagreement diagnosis](../router-development-benchmark/README.md#known-profiler-disagreement-preserved-for-diagnosis)
is the historical baseline for this comparison; its original table remains
unchanged rather than being rewritten as a v3 observation.

| Runtime file | Candidate SHA-256 |
| --- | --- |
| `lib/webSearchSuggestion.ts` | `67547e0be1575ba08a4c0ced3e6988d6c47f3aa72de791ebfd5cb2ec34a5c3d7` |
| `lib/taskProfileCore.ts` | `905f57b37fc7d3002462dee24c6912488c0a704daec26e3a3fc3569dc2d34c0c` |

| Static diagnostic | Base v2 | Round 0 candidate v3 |
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
12-file round 0 native regression run passed **225/225** tests, with zero failures,
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

## Revision 1 verification (historical candidate)

The final pre-commit revision was measured separately under
`revision1-final`, with helper SHA-256
`416b7bf8aaecf76b2396a08b79761620e56bd2db3bdb56e77b12aef351050fdc`.
The `taskProfileCore.ts` hash is unchanged from the table above. Its metadata
honestly records dirty HEAD `1e3231ee`; the changed bytes, not that HEAD alone,
identify this measurement. The fresh 13-file native run passed **260/260**,
with no failures, cancellations, skips or TODOs. The 27 targeted/mixed
boundaries and 12 direct retry-classifier comparisons also matched their
expectations, including the Korean `참고자료`/`예외규정` prefix regressions and
a complete-boolean control. These are development regressions, not holdout
quality evidence.

The full 24-case/42-model comparison retained the round 0 diagnostic counts:
8 to 0 search mismatches, 80 to 0 eligibility discrepancies, and 360 eligible /
648 refused benchmark rows. Six kinds and eight selections changed versus v2;
non-Router row fields, corpus and catalogue still compared equal. The same three
limitations in the 17-prompt diagnostic remain. The instrumented runs observed
zero network attempts. `final-independent-verification-revision1-final.json`
and the separate `revision1-final.*` metadata, plan, profile and native logs
retain the fresh evidence; earlier results were not overwritten. Preservation
checks retained the original 71 files and 67 subsequent evidence pins. These
checks are not approval; the actual round 1 review is recorded below.

## Revision 2 verification

The separate `revision2-final` observation binds helper SHA-256
`eed056e52ca68814ddb3b41bf178ec386a00c724ec418fd8084662974f2b15eb`;
the profiler hash and `task-profile-v3` remain unchanged. Its pre-commit
metadata records dirty HEAD `c5c82f5f`, not an invented revision commit. The
fresh 15-file run passed **303/303** tests, with zero failures, cancellations,
skips or TODOs. The external `run-regressions-revision2.mjs` runner adds the
unchanged `tests/deepResearchSuggestion.test.mjs` and
`tests/answerSuggestionArbitration.test.mjs` to the prior 13-file set.
The 33 targeted/mixed boundaries, 17 retry comparisons and
7 DeepResearch comparisons matched their expectations. The earlier 41
helper/profile outputs and 27 mixed profile/retry outputs also compared equal
after the pass split. This is development regression evidence, not a holdout
or a measured performance improvement.

The complete 24-case/42-model comparison still has 8 to 0 search mismatches,
80 to 0 eligibility discrepancies, and 360 eligible / 648 refused rows; the
six kind changes, eight selected-model changes and three known diagnostic
limitations remain the same. Instrumented runs reported zero network attempts.
`final-independent-verification-revision2-final.json` and the separate
`revision2-final.*` outputs retain commands, hashes and native results. The
original 71 files and 113 subsequent preservation pins were checked without
overwriting earlier evidence. The revised bytes still require the final
independent Claude review.

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
The round 0 preservation check matched all 17 original observation/journal files,
27 active terminal-review files and their 27 archived copies by size and SHA-256.

## Review record

This is a new `router-search-intent-v1` task, not a continuation or reopening of
the terminated Replay exchange. The prior
[bounded documentation/residual follow-up](../router-replay/review-followup-20260910.md)
remains unchanged. An actual read-only Claude review must name this task's own
source diff digest; a prior approval or preflight exception cannot substitute
for it.

The actual read-only Claude round 0 review returned `request_changes` for commit
`1e3231ee6f74dfddad9330cb2be29b9d10c56a8c`, digest
`sha256:2a7a05cd409bf25c0c8ea5e036a125fbb4d05781ee9d602802309c0c811d4696`.
The recorded controller outcome was `awaiting_revision`, not approval. Its
dedicated package, raw response and verdict remain under
`artifacts/cross-review/router-search-intent-v1`; shared-file snapshots are
retained separately rather than rewritten as a review of later source bytes.

Independent offline reproduction confirmed two regressions in that candidate:
bare `current true` / `current no-claims` prose lost its recency cue, and a
source request followed by `Order` on the next line lost its source cue.
`claude-round0-independent-reproduction.json` in the external evidence directory
records both, as well as the second consumer's source-order behavior. Revision 1
narrows those spans and verifies the restored cues; it also closes the same
boolean-prefix boundary in Korean. Consumer assertions and the retry suite
cover finding 3, and the historical backlink addresses finding 4. Those were
the author's corrective dispositions, not a changed round 0 verdict.

The actual Claude round 1 review returned `request_changes` with three findings
for commit `c5c82f5ff33fb2eeffb9a12f30c352f688c68bbf`, digest
`sha256:24dcf88c08206a2c1d44686f7d20fd31b73ae8746e229bbc1bedb2edd2c9ebf9`.
Independent reproduction confirmed the spaced-dash boundary regression and
the DeepResearch decision change. One review claim needs qualification:
DeepResearch was not wholly unexecuted, because the existing retry weather
test already calls its classifier. The missing coverage was its dedicated
suite and the new source-order boundaries, alongside the missing scope
documentation. The original verdict remains intact with that independent
qualification recorded, not silently edited.

Revision 2 addresses the dash boundary, adds the dedicated consumer coverage
and documentation, and separates the two masking passes. These are corrective
dispositions, not independent acceptance. The last allowed Claude round 2
review is pending; none of the 225-, 260- or 303-test runs substitutes for it.
Round 0 and 1 shared-file snapshots remain in the external
`round0-before-revision1-c5c82f5f` and `round1-before-revision2-c5c82f5f`
directories. No finding is waived here.
