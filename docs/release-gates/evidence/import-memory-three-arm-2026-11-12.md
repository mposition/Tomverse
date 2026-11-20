# Three ways to retrieve evidence for a continued chat

On 2026-11-12 we ran 32 matched synthetic cases in eight interface languages. Each case received three independent local Gemma 4 E4B IT Q4_K_M answers. Cohere Rerank 5 Fast received a real request through the Cohere API for each of its 32 cases. The model received its top three passages in original source order. The oracle received only the annotated original passage, with an empty excerpt for a no-decision control. None of the requests included a user conversation.

| Method | Complete evidence found | Default route correct | Three exception/boundary fields all correct | Entire answer correct | Correct abstention | Mean response | Mean estimated provider USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current #3795 excerpt | 17/24 | 16/24 | 0/24 | 0/24 | 8/8 | 8.53 s | $0 |
| Cohere Rerank 5 Fast | 24/24 | 24/24 | 1/24 | 1/24 | 8/8 | 3.41 s | $0.000165 |
| Reference evidence | 24/24 | 24/24 | 6/24 | 6/24 | 8/8 | 3.67 s | $0 |

Cohere recovered all seven rules absent from the current excerpt. Seeing the rule often did not lead to a fully correct exception decision. Only the Traditional Chinese cross-language case had all four fields right in the Cohere arm. The direct-evidence arm got 2/8 entire answers right for a buried decision, 3/8 for a superseded decision and 1/8 across languages.

Each language below has three evidence-bearing cases and one no-decision control. Cells show evidence retrieved, entire answers correct, mean response time and mean estimated provider fee. The two means include the control.

| Question language | Current | Cohere Rerank | Reference evidence |
| --- | --- | --- | --- |
| ko | 1/3 · 0/3 · 3.74 s · $0.000000 | 3/3 · 0/3 · 3.57 s · $0.000189 | 3/3 · 1/3 · 2.01 s · $0.000000 |
| en | 2/3 · 0/3 · 7.49 s · $0.000000 | 3/3 · 0/3 · 2.90 s · $0.000129 | 3/3 · 0/3 · 2.02 s · $0.000000 |
| zh | 1/3 · 0/3 · 6.13 s · $0.000000 | 3/3 · 0/3 · 3.80 s · $0.000291 | 3/3 · 2/3 · 4.65 s · $0.000000 |
| zh-Hant | 1/3 · 0/3 · 5.89 s · $0.000000 | 3/3 · 1/3 · 4.32 s · $0.000294 | 3/3 · 3/3 · 4.63 s · $0.000000 |
| fr | 3/3 · 0/3 · 9.35 s · $0.000000 | 3/3 · 0/3 · 2.64 s · $0.000102 | 3/3 · 0/3 · 3.07 s · $0.000000 |
| de | 3/3 · 0/3 · 14.90 s · $0.000000 | 3/3 · 0/3 · 2.53 s · $0.000100 | 3/3 · 0/3 · 3.15 s · $0.000000 |
| es | 3/3 · 0/3 · 10.68 s · $0.000000 | 3/3 · 0/3 · 3.69 s · $0.000105 | 3/3 · 0/3 · 5.90 s · $0.000000 |
| pt | 3/3 · 0/3 · 10.05 s · $0.000000 | 3/3 · 0/3 · 3.86 s · $0.000109 | 3/3 · 0/3 · 3.91 s · $0.000000 |

**Method.** The four cases place a final decision amid meeting notes, replace a plausible earlier decision with a changed exception, ask for an answer in a different language from the decision, or provide no final decision. The cross-language cases use an English source for the seven non-English question languages and a Korean source for the English question. All three arms use the same query, source, system instructions, context ceilings and answer model with temperature 0 and a 256-token output limit. Retrieval success requires the complete annotated rule to survive the final rendered excerpt. The grader checks the four action fields against original-source truth. No-decision controls are scored separately. There is one synthetic booking-rule family, with repetitive distractors and three evidence-bearing examples per language.

**Timing and price.** Time includes passage selection and local generation. In the Cohere arm, latency includes the measured webservice-to-Cohere call (mean 442 ms); SSH transport, pacing and scheduling are excluded. Local generations were collected in batches, so cache warmth and collection order may affect latency. Mean answer-prompt sizes were 3,385, 1,084 and 504 tokens respectively. The Cohere API reported 263,756 billable input tokens for the 32 scored requests. At its public rate of $0.02 per million tokens that is **$0.00527512**. This is a list-price estimate, not a provider invoice. Local answer generation incurred no API fee; hardware and energy are excluded. Ten successful setup calls and a rate-limit response precede the scored Cohere run. The table excludes setup traffic. [Cohere Rerank 5 pricing](https://cohere.com/blog/rerank-5).

[Raw questions' digests, ranks, answers, per-request usage and timing](./import-memory-three-arm-2026-11-12.json). The Admin benchmark is generated from this file after replaying the source, excerpt hashes and grade for every response. The daily panel uses independently collected measurements from the model selected in Scout.

To reproduce from the repository root, run a local OpenAI-compatible server serving the same model, set an evaluation Cohere credential in the process environment, and select an unused output path. The commands below use port 39179.

```powershell
node --import tsx scripts/eval-memory-retrieval.mjs http://127.0.0.1:39179 gemma-4-E4B-it-Q4_K_M 2026-11-12 retrieval-results.json
node --import tsx scripts/summarize-memory-retrieval.mjs retrieval-results.json retrieval-summary.json
```
