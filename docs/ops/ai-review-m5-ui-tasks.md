# AI Review M5 UI implementation

Scope: the two user-approved completion mockups, implemented sequentially. Local implementation and verification are separate from merge, deployment and measured M5 eligibility. Existing paid actions keep their current explicit execution paths.

| Task | Deliverable | Implementation | Verification |
|---|---|---|---|
| 1 | User evidence workspace, source identity and exact quote navigation | Implemented | 2 projection tests + 3 rendered component tests; focused ESLint passed |
| 2 | Per-item feedback, optional web verification and reviewer switching | Implemented | 26 existing contract tests; real-component Chromium flow passed, including state preservation, explicit web action and 320px |
| 3 | Shared stored-run reader for CLI and Admin | Implemented | 15 file-flow regressions and focused ESLint passed; shared result and read-only inputs verified |
| 4 | Admin metrics, arms, evidence drill-down and export | Implemented | 3 rendered component tests; real-component Chromium run selection, arms, search/filter, evidence dialog and exact JSON export passed |
| 5 | Missing evidence, refusals and separate operational readiness | Implemented | 16 file-flow regressions including forged scores; 6 rendered UI cases including empty, refusal, missing original and missing quote |
| 6 | Responsive, keyboard, dark-mode and integration checks | Implemented | 30 scoped app-browser tests; both real-component browser harnesses; 450 related server tests and 453 client tests passed |

Completion is six implemented and locally verified tasks. It does not approve thresholds, adopt evaluation candidates, freeze datasets, enable paid runs, merge, deploy or certify M5.

## Delivered surfaces

- User: `/review` → AI Review. The existing dialog now contains a finding/source workspace, exact quote navigation, persistent per-item feedback and opt-in web verification. The complete report remains available in a disclosure.
- Admin: `/admin/analytics?tab=ai-review`. Select an evaluation run, inspect metrics and groups, search/filter cases, inspect recorded judgements and original answers, and export the report as JSON. Operational scorecards remain separate below it.
- The CLI and Admin use `readAiReviewJudgedRunReport()`. Neither writes or changes the approval gate.

## Report input

Set `AI_REVIEW_JUDGED_RUNS_DIR` on the server to an existing report directory. Each child run directory contains `run.json`, `run.journal.jsonl`, `dataset.json` and `judgements/<caseId>/{case,observation,record,artifact}.json`. The directory is configured by the server, never accepted from a request. The latest 20 directory names are inspected in descending name order.

The page shows an honest empty state until reports are connected. It does not generate evaluations, fill in missing signatures, replace failed evidence with sample scores or enable paid calls. Exported JSON includes evaluation source text and judgement records.

## Verification scope

Local Windows verification used isolated worktree dependencies, synthetic evidence and mocked provider endpoints. No production credentials or paid model calls were used.

- Related server tests: 450/450.
- Client test lane: 453/453.
- App browser flows: comparison review 6/6, item feedback 9/9, source grounding 9/9, guest attachment/review journey 6/6.
- Real-component harnesses: `npm run verify:ai-review-workspace` and `npm run verify:ai-review-admin`. Both cover 320px/390px, dark mode and keyboard focus. User coverage includes long-source quote scrolling; Admin coverage includes exact JSON export and refusal without metrics.
- Full project TypeScript checking, ESLint, document references, policy section references (23/23), and the existing evaluation check passed.

The broader, unchanged `comparison-action-rail` suite was also attempted. Some cases failed during fixture entry or low-credit overlays before reaching the changed review UI. Temporary changes to that suite were discarded; its remaining failures are not reported as passed. Canonical screenshot baselines were not regenerated on Windows. CI and deployment remain unverified.

## Delivery status

All six local implementation tasks are complete. This branch has not been merged or deployed to Dev or Production. Remaining operational work is report-data configuration and the separately authorized review/merge/release process; measured M5 qualification still depends on the outstanding evaluation and policy decisions.
