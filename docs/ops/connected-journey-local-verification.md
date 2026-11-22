# Connected journey conversion observation

Implemented against develop `91ddb8d0ebf4b2b9c20958cffe95c52ea9df9253` after fetching
main `b1e00bfa10886ab4022ab835d2801618c07a1b9f` on 2026-11-15.

## Measurement

`connected_journey_step` reuses ProductAnalyticsEvent and the existing delivery
queue. The denominator is observed CTA attempts by signed-in web users whose
existing regional analytics policy allows collection, in the same tab:

- Review Studio, Classic and Quick Summary, whole result or selected finding,
  including explicit Append into an existing Chat draft.
- Import completed list: create new, open existing, or choose an existing target.
- Import source viewer: opening the disclosure starts the new attempt. Creation
  failure and idempotent replay keep it; explicit cancellation ends it.

Properties are closed: random `journey_key`, kind, entry, continuation kind,
stage and diagnostic reason. The UUID is pseudonymous analytical data, not an
anonymous identifier or an authentication credential. Source IDs, conversation
IDs and first-source IDs exist only in local matching state, never in event
properties. No content, title, URL, digest or raw error enters the new event.
The event is first-party only; client/server GA4 filters and ecommerce fanout
exclude it. Existing retention/deletion and curated account export remain in
use; the export does not expose the properties bag.

## Attribution lifetime

A Review offer carries its attempt into the existing expiring, identity-fenced
packet and receiver. The last explicitly applied connection owns the draft.
Ordinary edits retain it; clearing, replacement, conflict resolution, a new
connection, identity/allowance changes and unrelated target changes invalidate
it. Normal draft consumption and new-conversation adoption preserve the live
first-send candidate. Nothing restores attribution for a pre-send reload.

The canonical user Message receipt is bound only after the final send scope
check. Only ChatApp's actual fetch boundary (including router-location fusion)
emits `send_dispatched` and persists the local marker. Stream, durable polling
and completed hydration observations match the same target and first user
Message. At least one normal nonempty answer emits success. Incomplete, empty,
error, cancellation and timeout do not. Retrying that source may succeed;
follow-up messages or another Review fork cannot do so for the old source.

An account-bound local queue field is never transmitted. Unresolved auth holds
journey delivery. Owner and generation are checked at flush and each retry;
A to B to A cannot revive old work. Revocation/account changes clear local state
without sending a final event under revoked permission or another account; these
attempts can therefore remain unobserved. The server uses authenticated actor + kind +
key + stage through the existing HMAC unique dedupe path. An already in-flight
request cannot be recalled.

Session markers contain only dispatched attempts. Reload recovery requires an
exact source and completed canonical message within the existing history read.
Existing Review conversations do not expose ChatResponseAttempt rows, so a
Review continuation's post-reload success stays unobserved when that exact
relationship is unavailable. No extra scan or inferred nearest answer is used.
Native, another tab/device, tab closure and pre-send reload remain outside P0.

## Admin interpretation

The existing Product analytics panel reads the complete event/time-bounded
30-day started cohort without a row `take`, with one extra day of start lookback
to avoid labeling valid boundary-crossing stages as orphans. Main n/d uses starts at least 24
hours old and matching stages within 24 hours of their start. Pending starts
and early replies are separate. The observation window does not restrict
product execution or cost. Entry and new/existing continuation groups remain
separate. Orphan, missing dispatch, property/time mismatch and reversed evidence
are diagnostics, never inferred success. Issues can precede success. Unobserved
is not abandonment or failure. No mature denominator displays no ratio; a
query failure displays unavailable without hiding unrelated dashboard metrics.
Diagnostics describe the bounded read: a stage more than 24 hours after a start
older than the 31-day lookback can appear as missing-start evidence; it cannot
enter the mature success numerator.

### Attempts without an observed first reply

Each entry/continuation group in the same tile has a folded detail computed in
the same pass and with the same validity, de-duplication and window rules. An
attempt is account + kind + `journey_key`. With M mature starts and R valid
normal replies, N = M − R. N splits into attempts with at least one recorded
`journey_reason` and attempts with none (the existing `unobserved`); the two add
up to N. Each of the N attempts is placed once on its furthest valid stage:
start only, Review preview (Review only; Import shows not applicable), draft
ready, or first dispatch. Reasons are listed per group with two counts: mature
attempts without a reply that carried it, and mature attempts with a reply that
also carried it. One attempt counts once per reason; different reasons overlap,
so reason rows do not sum to N. Only one reason per stage is recorded, so a
second reason at the same stage can be missing. A reason and a reply on one
attempt do not establish order, recovery or motive. Pending starts, early
replies and the event-quality diagnostics stay out of this detail. The response
carries counts only; no account, attempt, conversation or raw error.

## Local verification

Local PC, PowerShell, repository root; installed dependencies and generated
Prisma client required. These checks use mocks and need no production
credentials. The browser harness blocks external network and uses mock answers.

```powershell
node --import tsx --test tests/connectedJourney.test.mjs tests/productAnalyticsShared.test.mjs tests/productAnalyticsDelivery.test.mjs tests/analyticsConsentPolicy.test.mjs tests/reviewToChat.test.mjs tests/continuationQuickAction.test.mjs
node --conditions=react-server --experimental-test-module-mocks --no-warnings=ExperimentalWarning --import tsx --test --test-concurrency=1 tests/server-contract/connected-journey-dashboard.test.mjs tests/server-contract/analytics-events-marketing-touch-route.test.ts
$env:NODE_OPTIONS = "--max-old-space-size=12288"
$env:DATABASE_URL = "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1"
$env:DIRECT_URL = $env:DATABASE_URL
$env:E2E_AUTH_BYPASS = "true"
$env:E2E_DISABLE_DATABASE = "true"
$env:NEXTAUTH_SECRET = "tomverse-e2e-nextauth-secret-only-2026"
$env:NEXT_TELEMETRY_DISABLED = "1"
npm run build
npm run test:e2e:run -- tests/e2e/review-to-chat.spec.ts tests/e2e/external-conversation-continuation.spec.ts tests/e2e/import-list-continuation-quick-action.spec.ts --project=desktop-chromium
```

The additive CHECK migration was also applied to a fresh, dedicated local
PostgreSQL 17 cluster: all 422 migrations applied; existing `marketing_touch`
and new `connected_journey_step` inserts succeeded, and an unknown name was
rejected. Test inserts were rolled back and the cluster stopped. This is
separate from the passing static CHECK tests, and is not a production migration.

The existing-database deployment guard was exercised separately: the isolated
cluster was placed at the preceding CHECK/history state, then `npm run db:migrate`
verified the exact previous constraint through `baseline-check.json` and applied
the pending migration. The sidecar binds the migration SQL checksum, constraint
target and the prior `pg_get_constraintdef` digest. On 2026-11-15, constraint tests (5) and the
migration baseline suite (37) passed. No `migrate resolve --applied` shortcut was
used for the new constraint.

## Verification run: 2026-11-15

- Core event, consent, delivery, journey lifecycle, aggregation, Review packet and
  continuation action tests: 54 passed.
- Authenticated analytics route, dashboard failure isolation and server GA4
  exclusion tests: 16 passed.
- Static CHECK/baseline sidecar tests: 5 passed; migration baseline suite: 37 passed.
- Changed TypeScript/TSX/MJS files: lint passed, including the final browser
  fixture corrections. A focused strict TypeScript check of both changed E2E
  files and their dependencies (with the existing Turnstile global declaration)
  also passed after those corrections.
- Desktop Chromium: 93 distinct scenarios verified. The initial full run passed
  92/93; the new Import scenario submitted before its fixture's draft save.
  After waiting for the actual PUT response, all five connected Import cases
  passed again. The full 18-case desktop Review suite also passed after the
  final shared readiness correction.
- Mobile Chromium: 25 distinct scenarios passed (six continuation cases, three
  list-action cases and all 16 applicable Review cases). Two desktop-only
  Review cases were intentionally skipped. The initial Studio fixture assumed
  a visible composer on the mobile results tab; using the existing analysis CTA
  as the readiness condition corrected it. The final complete desktop/mobile
  Review run passed 34 cases with those two intentional skips.
- Final `npm run build`: passed, including its full TypeScript check and all
  224 static pages. The standalone non-incremental typecheck was stopped to
  reduce memory contention; it is not counted as a separate passing run.

The application bundle was built from `f093a84ae`; subsequent changes only
synchronize browser fixtures with draft saving/mobile readiness and record the
results. No application code changed after the successful build.

The browser run uses the repository Playwright environment and external-network
block, with a local override serving the production build via
`npx next start -H 127.0.0.1 -p 3194` (base URL and allowed request hosts match).
It uses mocked answers and the existing loopback-only fixture switches, with no
production credentials or paid provider execution.

## Independent review and release state

The initial completed-diff review (`r-20261115-104722-ba3d49`) rejected the missing
migration baseline sidecar. The follow-up commit `f093a84ae` adds the verified
sidecar and the GA4 flush/dashboard corrections. Follow-up review
`r-20261115-111014-641d68` received Claude accept, but the other reviewer exited
abnormally (`reviewer_exit_1`), so the aggregate verdict is **unknown**, not accept.
The owner explicitly chose to record unknown without resubmission on 2026-11-15.
No push, PR, production database change, merge or deployment was performed.

## Conflict refresh: 2026-11-16

PR #4011 now includes develop `6e20a17857a213a346f49986ca24bb5b7a137e82`
through the concurrent automatic conflict-resolution commit `1720598f3`.
The resolved submit handler retains both journey capture and the upstream Review
handoff guards; the browser fixture retains the upstream background API mocks.
The local duplicate merge was abandoned in favor of that published commit.

The automatic resolution reintroduced a desktop-composer readiness assertion in
the shared Review fixture. The mobile Studio case reproduced its failure. Removing
that assertion restores the existing analysis-action readiness check, which works
on both layouts. The application code remains exactly as in `1720598f3`.

PR Fast Gate also reported a synthetic dashboard fixture UUID as a generic API
key. The fixture now generates its journey UUID at runtime. Only the original
commit/file/rule/line fingerprint is ignored in history; no scanning rule or path
allowlist was broadened.

Final local verification after adopting the published merge:

- Core journey, consent, delivery, draft, handoff and stream tests: 118 passed.
- Review handoff preflight and reference-loader contract tests: 10 passed.
- Dashboard contract and secret-scanner allowlist tests: 7 passed.
- Complete desktop/mobile Review-to-Chat suite: 34 passed; two desktop-only cases
  intentionally skipped on mobile.
- Focused Import continuation, handoff, stale-response and journey scenarios:
  11 passed on desktop Chromium.
- `npm run build`, including full TypeScript checking: passed.
- Lint of the merged application/browser paths and adjusted dashboard fixture:
  passed. The browser harness used the same isolated production-server setup and
  external-network block described above.
- Gitleaks 8.24.3: the PR's first-parent, non-merge commit range passed using the
  unchanged scanner rules and the single historical fixture fingerprint.

The independent review remains **unknown**, without resubmission, as requested.
The owner's later CI-hold removal and Ready transition were preserved. No CI
workflow was manually started or rerun, and no PR merge, production database
change or deployment was performed during this refresh.
