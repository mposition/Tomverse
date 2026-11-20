# Imported-chat continuation: actual model evidence, 2026-11-12

A local Gemma 4 E4B IT (Q4_K_M) received the actual product continuation seed, followed by a question in the corresponding interface language. We ran 40 independent completions for the baseline and 40 for one prompt candidate, at temperature 0 with a 256-token answer limit and no tools. No account transcripts, provider key, user credits or production model were used.

| Scenario (8 languages each) | What success means | Baseline | Candidate |
| --- | --- | ---: | ---: |
| Later decision supersedes draft | All four routes match the final rule | 2/8 | 2/8 |
| Counterfactual: swap the qualifying group in the source only | All four routes change or stay put as required | 2/8 | 1/8 |
| Long message, automatic seed | Final decision available to the model | 0/8 | 0/8 |
| Same long message, owner selects final passage | All four routes match the original | 3/8 | 3/8 |
| No source | Answers UNKNOWN for all four | 8/8 | 8/8 |

For the long automatic case both prompts correctly abstained in 8/8: **grounded abstention is not successful retrieval**. The source planner kept the beginning of the long turn, which did not contain the final decision. "Visible" means the exact final sentence survived the production planner and seed formatter. The picked case uses the same production passage selection helper as the user-facing feature.

| When the rule was visible (3 cases per language) | ko | en | zh | zh-Hant | fr | de | es | pt | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline: all four routes correct | 3 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 7/24 |
| Candidate: all four routes correct | 2 | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 6/24 |

The baseline got the ordinary booking right in 24/24. It missed the answer for a different group before noon in 11/24 (including the counterfactuals). In the English recent-decision case the source said “all bookings” use the default except qualifying members before noon. The model applied the member exception at 11:00 and the default at exactly noon but returned UNKNOWN for a different group at 11:00. Two baseline answers and three candidate answers with visible rules contained at least one unscorable route field; the strict score includes these as misses. The optional free-text reason was retained, not graded.

The candidate explicitly told the model to apply the default unless every exception condition held. This small paired experiment gives no reason to ship it; it is **not** enabled. First investigate preserving the end of a long turn within the existing excerpt budget, then repeat the same matched cases and add independent scenarios and the approved production model. This is one quantized model on one synthetic rule family; it measures neither population accuracy nor the end-to-end Chat router, account-memory extraction/retrieval or different provider stacks.

[Baseline answers and usage](./import-memory-quality-2026-11-12.json) · [Candidate answers and usage](./import-memory-quality-candidate-2026-11-12.json). Both contain raw responses, expected actions and hashes of the message arrays. The candidate report includes the exact extra system sentence. To reproduce locally from the repository root with a loopback OpenAI-compatible inference server serving the indicated model:

```powershell
node --import tsx scripts/eval-import-memory-quality.mjs http://127.0.0.1:39176 gemma-4-E4B-it-Q4_K_M baseline.json 2026-11-12 baseline
node --import tsx scripts/eval-import-memory-quality.mjs http://127.0.0.1:39176 gemma-4-E4B-it-Q4_K_M candidate.json 2026-11-12 candidate
```
