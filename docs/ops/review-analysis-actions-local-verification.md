# Review analysis actions: local verification

Date: 2026-11-15. Isolated implementation based on fetched `origin/develop`
`f54fd4d4a7ac7deba960584ecc25a25d23e16412`; fetched `origin/main` was
`6ecf32496d3fc13a935981a1ec0b47d6d574511f`. The previous Review-to-Chat
implementation was already present in develop. The original checkout and its
unrelated edits were preserved. This checkout used its own fresh `npm ci`,
without the audit checkout's dependency junction.

## Implemented behavior

- Studio reads the existing NDJSON transport and exposes the first validated
  reviewer before the additional reviewer and durable save finish. All transfer
  actions wait for a completed saved result. Closing/reopening does not execute
  again. Interrupted/partial execution recovers through the saved-result GET;
  a terminal refusal without partial output permits an explicit retry after a
  cache lookup. An error is never labelled as a completed result.
- Studio, Classic, mobile web and Quick Summary share a footer with Continue in
  Chat directly before Close. The mobile Quick Summary panel scrolls as a whole
  so a large header cannot hide the footer at 320px and 200% text size.
- Preview and report generation project the selected saved reviewer or Quick
  Summary, preserving the complete question, model mapping, quotes, quote-match
  status, source-grounding counts and unresolved matters. PDF, DOCX, TXT and
  Markdown reuse the existing deterministic writers. No model call, artifact,
  Conversation or Message is created. Unsupported PDF characters fail with
  guidance to choose another format; they are not silently removed.
- Sharing previews the exact public content and explicitly confirms replacement
  of the conversation's existing share link. Existing owner/unlock, plan,
  operational, expiry, revocation, transcript and share-generation checks remain.
  Publication also atomically compares the captured saved review version.
  Full model answers, attachments and separate web checks are not published.
  No publication occurs merely by opening the preview.
- Download and publication callbacks are fenced by identity, eligibility,
  selection and request generation. Export checks the full byte count and digest
  before downloading. Unknown publication outcomes block another attempt until
  explicit revocation. Existing transcript sharing remains unchanged.

## Executed checks

Local PC, PowerShell, isolated checkout, Node 22.22.2 and Next.js 16.4.6. The
installed Next route-handler guide was read before implementation. Browser
checks used this checkout's production build on loopback port 3188 with
`reuseExistingServer: false`, two Chromium workers and the existing network
guard. No production credentials, paid provider run or real publication was used.

| Check | Result |
| --- | --- |
| Focused Node unit/regression suite | 44 passed |
| New server-contract suite | 8 passed |
| Broad Review/Classic/mobile/evidence/action-rail regressions | 182 passed; 114 project-conditional skips |
| Final targeted browser run after responsive fix | 68 passed; 4 desktop-only cases skipped in the mobile project |
| Distinct browser scenarios across the eight suites | 208 passed; 116 project-conditional skips, excluding repeated executions |
| `npm run verify:studio-answer-analysis` | Passed |
| `npm run check:locale-translation` and locale parity | Passed |
| Changed-file ESLint with `--max-warnings=0` | Passed |
| `npm run build:local`, including TypeScript | Passed |
| Independent review | Accepted after the partial-failure recovery correction |

The unit run covered `reviewAnalysisReport`, `studioAnswerAnalysisSession`,
`reviewToChat`, `comparisonReviewProgress`, `sourceGrounding` and `localeParity`.
The server suite exercised the actual export/share/public-read handlers with
mocked session/DB boundaries: ownership, locks, entitlements, continuations,
regeneration, late deletion, byte integrity, legacy transcript behavior and the
publication SQL guards. It is not a live PostgreSQL integration test. Actual
PDF bytes were opened in an independent PDF reader; actual DOCX bytes were
unzipped and checked for Unicode content and absence of active content.

Browser suites: `review-analysis-actions`, `review-to-chat`,
`comparison-review-progress`, `source-grounding`, `comparison-review`,
`ai-review-item-feedback`, `comparison-action-rail` and `review-studio`.
They covered early output and finalization failure, saved-result recovery,
four-format downloads, publication confirmation/double click/revocation,
unknown publication outcome, incomplete download refusal, A/B/A identity
changes, reviewer selection, Quick Summary, focus return, 320px/enlarged text,
and the existing draft conflict/hydration/Send behavior.

Independent review `r-20261115-050519-126478` identified a partial-result retry
defect. The correction and regression were accepted in
`r-20261115-051245-77027f` at `39ac0b0661d9a2760635085103ad43cf1196e57b`.
Subsequent changes only adjusted responsive scrolling, test selectors and this
record; the reviewed publication, authorization and budget boundaries did not
change.

## Limits and release state

The controlled stream proves earlier usable display, not a production latency
percentage. Total provider completion time was not measured with paid runs.
The existing optional parallel-review switch remains off by default and no
operational settings, model budgets or retry limits were changed.

Analysis sharing retains the existing full-transcript snapshot size limits
(5 MB / 10,000 messages) as part of its concurrency guard. Unknown execution
outcomes remain read-only recovery within the current session when no saved
result can be found. Guest, imported continuations, public-page continuation,
native analysis wiring and Deep Research execution remain excluded.

PR #3987 targets develop and stays Draft with `ci:hold`. Automated PR checks
were skipped; no CI dispatch, restart, rerun or ready transition was requested.
Merge, deployment and paid live evaluation were not performed.
