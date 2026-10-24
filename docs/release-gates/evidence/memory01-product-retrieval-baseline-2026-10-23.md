# MEMORY-01 product retrieval baseline — 2026-10-23

`MEMORY-01` evidence reference. Recorded on 2026-10-23 at the owner's request
in chat, together with the decision below.

## Decision

Account memory launches at its current retrieval quality, and the memory
quality agent (`tools/memory-quality`) improves it daily. `MEMORY-01` is
therefore `blocking: false`: the 85% Korean Recall@5 target is unchanged and
remains the bar the improvement work is measured against, but missing it does
not hold the release. The gate stays `status: pending`.

This does not turn on any flag. `memoryExtractionEnabled` starts paid
extraction calls and still needs its own owner approval.

## What was measured

| | |
| --- | --- |
| Path | Product retrieval: `memoryRetrievalTerms` + `selectMemoryContext` (algorithm v2) |
| Command | `node --import tsx tools/memory-quality/cli.ts retrieval` |
| Code | `commit:ffe0a5fb71a1fda239add0b80087dee57d7f50d4` (#2930) |
| Dataset | `memory-quality-retrieval-ko-v1`, sha256 `3d85612d432cbcd5d8feb42bb9d833dc83f24dc42ced8bab2b9bcc6980f88b9e` (git blob bytes) |
| Model calls | 0 |

The dataset is 32 synthetic Korean queries over one 22-memory account pool
(3 core, 1 style, 16 ordinary, 1 superseded, 1 forbidden). Recall@5 is read off
the prompt order, in which core memories come first.

## Result

Recall@5 **20/29 = 69%** (target 85%).

| Tag | Recall@5 |
| --- | --- |
| particle | 5/5 |
| spacing | 3/3 |
| nfd | 2/2 |
| mixed_script | 3/3 |
| core | 1/1 |
| compound | 3/4 |
| ending | 2/3 |
| one_syllable | 1/4 |
| synonym | 0/4 |

- Term-matched irrelevant selections: 5 of 24. Examples: "운동 계획" selected
  the trip-planning memory, "커피 말고" selected the coffee-shop memory.
- A forbidden row was selected twice. Nothing on the read path removes it; the
  product's defence is the write-time validator.
- No inactive (superseded) row was selected.

## How to read it

This is not a decision-grade result. The set was authored to exercise known
weak spots, so its overall number follows its composition rather than real
traffic; the per-tag rows are the signal. The two weakest are structural:
one-syllable nouns miss because the index stores Hangul as character bigrams
("집에서" → 집에, 에서), and synonyms miss because matching is lexical.
Re-running the same command on later code gives a comparable number against
the same pinned dataset.
