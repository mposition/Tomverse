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
query failure displays unavailable.

## Local verification

Local PC, PowerShell, repository root; installed dependencies and generated
Prisma client required. These checks use mocks and need no production
credentials. The browser harness blocks external network and uses mock answers.

```powershell
node --import tsx --test tests/connectedJourney.test.mjs tests/productAnalyticsShared.test.mjs tests/productAnalyticsDelivery.test.mjs tests/analyticsConsentPolicy.test.mjs tests/reviewToChat.test.mjs tests/continuationQuickAction.test.mjs
node --conditions=react-server --experimental-test-module-mocks --no-warnings=ExperimentalWarning --import tsx --test --test-concurrency=1 tests/server-contract/connected-journey-dashboard.test.mjs tests/server-contract/analytics-events-marketing-touch-route.test.ts
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
target and the prior `pg_get_constraintdef` digest. Constraint tests (5) and the
migration baseline suite (37) passed. No `migrate resolve --applied` shortcut was
used for the new constraint.
