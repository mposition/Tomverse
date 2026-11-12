# Imported-chat closing decisions across eight languages

On November 12, 2026, Gemma 4 E4B IT Q4_K_M answered 40 matched synthetic questions twice, once with each production excerpt planner. In the 24 sources where a decision appeared near the end, the original planner supplied the complete decision in 0 cases and the updated planner supplied it in all 24. Correct individual actions increased from 0/96 to 66/96. Fully correct four-action answers increased from 0/24 to 6/24.

| Question placement | Complete rule in excerpt, before → after | All four actions correct, before → after | Individual actions correct, before → after |
| --- | ---: | ---: | ---: |
| Final decision in the closing paragraph | 0/8 → 8/8 | 0/8 → 1/8 | 0/32 → 21/32 |
| Changed qualifying group, decision and exception split across lines before a footer | 0/8 → 8/8 | 0/8 → 3/8 | 0/32 → 22/32 |
| Decision before a subsequent short reply in a 23-turn conversation | 0/8 → 8/8 | 0/8 → 2/8 | 0/32 → 23/32 |
| Decision at the opening of a long turn | 5/8 → 8/8 | 0/8 → 3/8 | 14/32 → 26/32 |
| No final decision anywhere, all four actions should be UNKNOWN | — | 8/8 → 8/8 | 32/32 → 32/32 |

**Closing-decision cases by language.** Each language contributed three prompts and twelve independently scored fields. A whole answer passes only when all four fields match the source rule exactly.

| Language | Correct individual actions, before → after | Fully correct answers, before → after |
| --- | ---: | ---: |
| Korean | 0 → 10/12 | 0 → 1/3 |
| English | 0 → 9/12 | 0 → 0/3 |
| Simplified Chinese | 0 → 10/12 | 0 → 2/3 |
| Traditional Chinese | 0 → 12/12 | 0 → 3/3 |
| French | 0 → 9/12 | 0 → 0/3 |
| German | 0 → 6/12 | 0 → 0/3 |
| Spanish | 0 → 4/12 | 0 → 0/3 |
| Portuguese | 0 → 6/12 | 0 → 0/3 |

The rule applied a default booking route with an exception based on group membership and a strict before-noon cutoff. In the updated English closing case the model selected the right routes for an ordinary booking, a qualifying member at 11:00 and the same member exactly at noon. It answered UNKNOWN for a different group at 11:00 despite the applicable default. Across the 24 closing cases, that fourth field had 11 correct responses. Three responses contained an unscorable field, counted as a miss for that field and for the whole answer.

The endpoint ran locally on the same model instance, with temperature 0, reasoning disabled, a context size of 8,192 and up to 256 output tokens. Both arms received identical source rows and questions and the same product system instructions. The order of the two arms alternated by language. The trial used the existing localized synthetic booking task and deterministic exact-match grader. An UNKNOWN answer earns credit for the no-decision control. When the original contains a rule that the excerpt omitted, a grounded UNKNOWN still misses the original answer. These results cover one task family and model. They do not estimate production Chat accuracy.

Both planners used the same ceilings of 4,000 Unicode code points per excerpted message and 3,000 estimated tokens for all source text in a request. Actual input length can differ between the two arms. The updated planner also counts the gap marker, and can use the budget that was previously left unused when a dense turn was dropped. Prompt framing is additional in both arms.

[Paired raw answers, usage, input hashes and excerpt sizes](./import-memory-excerpt-comparison-2026-11-12.json) · [Earlier prompt-only experiment](./import-memory-quality-2026-11-12.md).

To reproduce from the feature checkout in local PowerShell, start a loopback inference server with the model above, then export the unchanged original planner from the comparison commit. The comparison runner imports that module and the current product planner. The output contains one row per real completion.

```powershell
git show fed8bb512:lib/externalContinuationSeedCore.ts | Set-Content -Encoding utf8 -LiteralPath .baseline-excerpt.local.ts
node --import tsx scripts/eval-import-memory-quality.mjs http://127.0.0.1:39178 gemma-4-E4B-it-Q4_K_M excerpt-comparison.json 2026-11-12 compare-excerpts .baseline-excerpt.local.ts
```
