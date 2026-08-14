# Release checklist

Run through this before promoting a build — except §7.6, which an operator runs
against production at the deployed SHA, and section 5, which is checked
immediately after the merge. Every item needs either evidence tied to the
**release SHA** or a written waiver — an unticked box is a release blocker, not
a formality.

Record the release SHA once and reuse it everywhere below; evidence produced
against a different SHA does not count.

```
Release SHA:        ____________________
Staging deployment: ____________________
Date / timezone:    ____________________
```

## 1. Automated gates

- [ ] `npm ci` (lockfile installs cleanly)
- [ ] `npm audit --omit=dev` — **0 vulnerabilities**
- [ ] `npm audit` — 0, or every remaining advisory has a waiver recorded in §8
- [ ] `npm run typecheck`
- [ ] `npm run lint -- app components lib tests scripts`
- [ ] `npm run test:unit`
- [ ] `npm run test:server-contract`
- [ ] `npm run security:regression`
- [ ] `npm run check:accent-tokens`
- [ ] `npm run check:model-pricing`
- [ ] `npm run check:image-pricing`
- [ ] `npm run check:image-executor-budget`
- [ ] `npm run check:db-integration-coverage`
- [ ] `npm run check:error-detail-cost`
- [ ] `npm run check:data-domain-registry`
- [ ] `npm run verify:package-build-matrix` — builds both shared packages with
      Vite, with no Next.js anywhere, then runs the bundle. It is PACKAGE-01's
      second piece of evidence; it does not by itself satisfy the gate, which
      is approved by a person against recorded evidence.
- [ ] `npm run check:prompt-injection` — PLANNER-03's report. Runs the
      adversarial corpus through every builder that puts untrusted text in a
      prompt and fails on a non-zero violation count.
- [ ] `npm run check:shared-packages` — reports PACKAGE-01's metric
      (`forbidden_nextjs_imports_in_shared_packages`) and proves every
      workspace package still type-checks with no DOM, no Node types and no
      app alias
- [ ] `npm run check:push-scope` — reports PUSH-01's metric
      (`unapproved_push_infrastructure_components_in_v1`). The gate is met by an
      absence, so this is the artefact that states it; approving a use case is
      still a decision recorded on the gate itself
- [ ] `npm run check:default-models`
- [ ] `npm run check:encoding:strict`
- [ ] `npm run check:locale-translation` — proves no locale is still showing an
      English sentence where a translation is owed
- [ ] `npm run check:api-cache-control` — proves the proxy's `/api/*` default
      does not silently replace a route's own caching decision
- [ ] `npm run check:unconsumed-response-bodies` — the other half of that
      default: `private, no-store` leaves the browser no cache entry to write,
      so a client fetch that ignores an error body keeps the request in flight.
      Blocks browser-capable code on the one target that was measured, and says
      so; the server-side candidates are reported, not gated
- [ ] `npm run check:enum-constraints` — proves every closed list the schema
      enforces still matches the list the application validates against, and
      that a new one was registered rather than left undecided
- [ ] `npm run check:context-window-register`
- [ ] `npm run check:router-context-window`
- [ ] `npm run check:router-quality-eval`
- [ ] `npm run check:auto-rollout-readiness`
- [ ] `npm run check:usage-bucket-range`
- [ ] `npm run check:memory-extraction-eval`
- [ ] `npm run check:tomverse-chat-release-gate-view`
- [ ] `npm run verify:tomverse-chat-release-gates`
- [ ] `npm run verify:review-parity-coverage`
- [ ] `npm run check:doc-references` — proves AGENTS.md and every contract and
      policy document under it, and every source comment that names a path,
      still point at files that exist. A comment naming a test file is a claim
      about coverage: one said its cadences were asserted against the Railway
      cron files by a test that had never existed
- [ ] `npm run check:policy-section-references` — the same argument one level
      down: proves every `§NN` points at a section that exists. Release C
      shipped 105 citations of sections 31, 32 and 42 to 46, none of which any
      policy document has, each one beside a path the reference check found
      perfectly valid
- [ ] `npm run check:ui-tier-coverage` — proves the merge-blocking `@ui-risk`
      tier and the document that records it still describe the same set
- [ ] `npm run check:release-gate-coverage` — proves this list still matches
      what CI enforces. It is the reason the list above can be trusted: the
      repository grew to twelve CI-enforced checks while this section named
      five, and nothing failed.
- [ ] `npm run build`
- [ ] `npm run verify:smoke-coverage`
- [ ] `npm run test:e2e:ui-risk`
- [ ] `npm run test:e2e:admin` (needs `ADMIN_E2E_DATABASE_URL` — a dedicated,
      disposable database; the harness truncates every table between tests)
- [ ] `npm run test:db:integration` (needs `TEST_DATABASE_URL`, whose name must
      carry a test marker and must differ from the application database URL)
- [ ] `npm run check:model-pricing-db` (needs the deployed database) — proves a
      `NULL` price column still means "inherit the code profile" rather than an
      administrator override. No CI job can run this, so this line is the only
      thing that does.
- [ ] `npm run check:openai-model-access` (needs a production key) — per-account
      model visibility only. It is **not** a price source; nothing in
      `lib/modelPricing.ts` may be derived from its response.
- [ ] Chromium E2E: `desktop-chromium`, `desktop-compact`, `mobile-chromium`
      — no unexplained failures

A suite that could not run is **not** a pass. Record it as N/V in §8 with the
reason, the owner and what is needed to run it.

## 2. Visual regression gate (required)

`tests/e2e/chat-state-visual-regression.spec.ts` is deliberately outside PR
Fast Gate, so a drifting golden can otherwise go unnoticed for up to a day
(see the header of `.github/workflows/nightly-visual-regression.yml`). That
trade is only acceptable if the suite is reviewed before a release rather
than merely before a merge.

- [ ] A **Nightly Visual Regression** run exists for the release SHA. Trigger
      it on demand via `workflow_dispatch` against the release ref if the
      scheduled run predates the SHA.
- [ ] The run was reviewed by a person, not just observed to be green.
- [ ] For any diff: the change was intentional, and the actual/expected/diff
      artifacts were inspected before accepting.

```
Workflow run URL:   ____________________
Reviewed by:        ____________________
Artifacts checked:  ____________________
```

No CI job that *judges* a golden ever rewrites one — `scripts/security-regression-check.mjs`
asserts that PR Fast Gate, Main Chromium Regression, Nightly Visual Regression
and the daily audit carry no snapshot-updating flag. Updating a baseline is a
separate, manual act: dispatch the `Record Visual Baseline` workflow at the ref
that changed the pixels, review its diff artifact, and merge the throwaway
`visual-baseline/<run id>` branch it pushes as a pull request of its own —
never as part of a release. Recording it anywhere but that workflow's canonical
environment produces a baseline that is itself the defect (see
`docs/qa/canonical-visual-baseline.md`).

### Waiver

Shipping without this gate requires an explicit, recorded waiver:

```
Waived by:          ____________________
Reason:             ____________________
Follow-up issue:    ____________________
```

A waiver is a decision someone owns, not a silent skip. It also does not carry
over: the next release needs its own reviewed run or its own waiver.

## 3. Staging verification

- [ ] `/api/build-info` reports the release SHA
- [ ] local, `origin/develop` and staging SHAs agree
- [ ] `/status` and `/api/models/status` queried in the same window, with no
      per-provider contradiction between them
- [ ] Model picker, provider banner and chat send agree with both of the above

## 4. Accessibility

- [ ] `.github/ACCESSIBILITY_QA_MATRIX.md` filled in for this release SHA
- [ ] No P0/P1 accessibility blocker outstanding
- [ ] Any row still marked N/V is an accepted, named risk — not an oversight

The automated rows in that matrix run in CI. The screen-reader, Korean-IME,
external-keyboard and real-browser-zoom rows do not, and a green suite says
nothing about them.

## 5. After the release merge — confirm shared ancestry was restored

This is the one item here that runs *after* the merge button. **Do not perform
the back-merge by hand.** Since #232 it is automatic, and a manual one now races
the automation for the same ref.

`.github/workflows/back-merge-main-to-develop.yml` fires on every push to
`main`. It merges `main` into `develop` as a real merge commit, reports whether
the merge changed any file, and a separate `verify` job asserts the invariant
with `if: always()`. Your job here is to confirm it did, not to do it.

- [ ] The **Back-merge main into develop** run for this release finished, and
      its `verify` job passed
- [ ] Independently checked: `git fetch origin && git merge-base --is-ancestor origin/main origin/develop`
      exits 0
- [ ] The run's "Report what the merge changed" step says the merge changes no
      file — or, if it does not, the extra content is understood (that means
      `main` carries work `develop` never had, such as a hotfix landed directly)

```
Release merge SHA:  ____________________
Back-merge run URL: ____________________
Ancestry verified:  ____________________
```

### When it does not land on its own

The workflow refuses to guess, and it fails in two different ways depending on
*why* it could not land. `verify` fails on both, so neither is silent — but only
one of them leaves you a pull request.

**The push to `develop` was refused** (branch protection, typically). The merge
itself succeeded, so there is nothing to judge: the workflow pushes
`automation/back-merge-main-<sha>` and opens a pull request carrying the merge
commit it already made.

- [ ] If `automation/back-merge-main-<sha>` exists, its pull request was merged
      **with a merge commit** — never squash, never rebase

Squashing it accomplishes nothing at all — the second parent is what carries the
ancestry, and a squash discards it. That is not hypothetical: of the three
back-merges opened by hand on 2026-08-01, #203 and #213 were squashed on the way
in and left the gap exactly where it was.

**The merge conflicted.** The workflow aborts and fails the job. **It does not
open a pull request, and it pushes no branch** — a machine cannot know which
side to keep (the `eslint.config.mjs` conflict in #217 was `develop` adding an
ignore entry `main` lacked), and a pull request full of a guess is worse than
none. There is nothing to review; there is work to do:

- [ ] Branch from `origin/develop`, merge `origin/main`, resolve the conflict,
      open a pull request and merge it **with a merge commit**

```
git fetch origin
git switch -c back-merge-main-$(git rev-parse --short origin/main) origin/develop
git merge --no-ff origin/main      # resolve, then commit
```

Do not resolve by taking one side wholesale, and do not `--strategy=ours`: the
conflict exists because both branches changed the same lines, and discarding
`develop`'s side silently reverts released work.

### Why this exists, and why the repository setting is not the fix

A squash rewrites the release into a single new commit, so `main` and `develop`
end up sharing no commit at all even though their trees are identical. Nothing
breaks at the time — the code is released and correct — but the *next* change
`develop` makes to already-released code has no common base, and every file the
release touched arrives as an `add/add` conflict. #195 opened with 14 of them;
#200 cost eighteen.

Turning on **Settings → General → Pull requests → Allow merge commits** was the
obvious fix and is the wrong one: GitHub's merge-method setting is
repository-wide and cannot be scoped to one target branch, while squash is
wanted for feature pull requests into `develop`. #232 makes the release's merge
method stop mattering instead, which is why this section now verifies rather
than instructs.

First real trigger, for calibration: #233 was merged as a squash (`2e0eff2`,
one parent) and the workflow produced `b172d0b` (two parents) unattended —
run `30723157564`, `verify` green, merge changed no file.

## 6. Scope notes

A green visual run is **not** an accessibility result. Screenshot goldens
cannot see focus order, accessible names, announcements or contrast in forced
colors. Accessibility evidence is tracked separately and is not satisfied by
anything in section 2.

### 6.1 Automated fix PRs (feedback auto-fix, Phase 3)

Only applicable while `FEEDBACK_AUTOFIX_ENABLED` is set anywhere
(docs/policy/trace-feedback-automation.md §9.1); otherwise mark N/A.

- [ ] List every `feedback-autofix/**` PR included in this release
- [ ] Each one carries a validated Red→Green proof on its case
      (`FeedbackAutoFixCase.redGreenProof`) and a human approval —
      an unreviewed auto-fix PR in a release is a blocker
- [ ] Each merged case's staging verification (`staging_verified`) happened
      against its read-back merge SHA
- [ ] No auto-fix diff touches an excluded area
      (lib/feedbackAutoFixPolicy.ts is the authority)

## 7. Database and deployment configuration

Every box needs evidence captured against the release SHA — a command and its
output, or a screenshot of the setting. "Looks right" is not evidence, and a
value nobody could read is N/V in §8, never a tick.

### 7.1 Migrations

- [ ] `prisma migrate deploy` run against the target database
- [ ] No pending migration remains (`prisma migrate status` is clean)
- [ ] `20260730120000_add_user_sessions_revoked_at` is applied
- [ ] `User.sessionsRevokedAt` is nullable, so the previous release still runs
      against this schema and a rollback does not need a down-migration
- [ ] A backup or restore point exists from **before** the migration ran

```
Migrate output:     ____________________
Backup / snapshot:  ____________________
```

### 7.2 Environment

- [ ] `CSP_MODE=enforce`
- [ ] `REQUIRE_CLOUDFLARE_ORIGIN_SECRET=true`
- [ ] `CLOUDFLARE_ORIGIN_SECRET` is at least 32 characters
- [ ] `TRUSTED_PROXY_IP_HEADER=cf-connecting-ip`
- [ ] `NEXTAUTH_URL` is exactly the public HTTPS origin. Session cookies lose
      `Secure` and the `__Secure-` prefix when it is not `https://`, and the
      Playwright short-circuits are gated on it not being a loopback address
- [ ] `E2E_AUTH_BYPASS` and `E2E_DISABLE_DATABASE` are unset, or at least not
      `"true"`, in production
- [ ] `DATABASE_URL` and `DIRECT_DATABASE_URL` are private hosts, or carry
      `sslmode=verify-full` / `verify-ca`

### 7.3 Edge

- [ ] Cloudflare strips or overwrites client-supplied `cf-*` headers.
      **Spoof test**, from outside the edge, against the release deployment:

      curl -s -o /dev/null -w '%{http_code}\n' https://<origin>/chat \
        -H 'cf-ipcountry: XX' -H 'purpose: prefetch'

      The billing market and client IP must not reflect the forged values.
      `purpose: prefetch` is included deliberately: the proxy matcher is
      unconditional, and a request carrying it must still be host-checked.
- [ ] A request that reaches the origin directly, without the Cloudflare origin
      secret, is rejected with 421

### 7.4 Readiness and liveness

- [ ] `/api/ready` is wired into pre-promotion checks and into the external
      readiness monitor
- [ ] The Railway container healthcheck stays on **`/api/health`**.
      `/api/ready` reports dependency state, so wiring it to container liveness
      makes a database blip restart healthy processes and turns a degradation
      into an outage.

### 7.5 Legacy conversation-lock passwords

SEC-011. `Conversation.password` rows written before scrypt hashing hold the
password in plaintext, and `verifyConversationPassword` still accepts them by
comparing `sha256(candidate)` against `sha256(stored)` — which only works
because `stored` *is* the password. Unlocking upgrades a row opportunistically,
so this only ever closes for conversations someone happens to open. The rest
need the migration.

**Stage 1 — this release.** Migrate the data. The verifier stays.

- [ ] A backup or restore point exists from **before** the migration ran
      (§7.1's snapshot covers this if the migration runs after it)
- [ ] Dry run first, count recorded:

      npm run migrate:conversation-lock-passwords -- --dry-run

      Prints a JSON summary. `migrated` is the number of rows still holding
      plaintext; nothing is written. The script never prints a password value.
- [ ] Migration executed:

      npm run migrate:conversation-lock-passwords -- --confirm-production

      `--confirm-production` is mandatory when `NODE_ENV=production`; the
      script refuses to write without it. Re-running is safe — an already
      hashed row is counted, not touched.
- [ ] A follow-up query confirms **0** remaining plaintext rows:

      SELECT count(*) FROM "Conversation"
      WHERE "password" IS NOT NULL AND "password" NOT LIKE 'scrypt$1$%';

- [ ] Locked conversations still unlock with their existing password (spot
      check at least one real account, or the `@ui-risk` lock specs against a
      restored copy of the migrated database)

**Stage 2 — a later release.** Only after production has been *observed* at 0
rows for a full release cycle, delete `compareLegacyPassword` and the
`needsUpgrade: true` branch in `lib/conversationLock.ts`, and drop the
opportunistic re-hash in `app/api/conversations/[conversationId]/verify/route.ts`.

Removing the verifier in the same release as the migration is what this
ordering exists to prevent: a row missed by the migration — a batch that
errored, a conversation created from a stale replica, a restore from a
pre-migration backup — stops being *insecurely* unlockable and starts being
*permanently* unlockable, locking the owner out of their own conversation with
no recovery path.

```
Dry-run count:      ____________________
Post-run count:     ____________________
Stage 2 tracked in: ____________________
```

### 7.6 Schema comparison against the migration history

`prisma migrate diff` cannot see either of the two things this repository's
migration baseline had to reconstruct by hand — CHECK constraints and
partial/expression indexes — so "the baseline reproduces production" is a claim
nothing in CI can settle. `npm run db:compare-schema` reads both catalogues and
settles it, and it has never been run against production: the connection
details are not obtainable from inside the repository.

Run it **from the deployed release SHA**, against a **direct** production URL
with a read-only role, and a scratch database that is empty and disposable.

```bash
COMPARE_SOURCE_DATABASE_URL="$PRODUCTION_DIRECT_URL" \
COMPARE_SCRATCH_DATABASE_URL="postgresql://.../tomverse_compare_scratch" \
npm run db:compare-schema
```

- [ ] Run at the release SHA (the command prints the commit it ran at)
- [ ] Source was a direct URL, not a pooler, on a read-only role
- [ ] Scratch database was empty, disposable and not the source
- [ ] PostgreSQL major version matched — a version warning invalidates the
      comparison rather than qualifying it
- [ ] **All three classifications reviewed**, not just the total:
      `only_in_source`, `only_in_database`, `definition_mismatch`
- [ ] Output attached to the operations ticket with secrets removed

```
Ran at SHA:         ____________________
only_in_source:     ____________________
only_in_database:   ____________________
definition_mismatch:____________________
```

`definition_mismatch` is the dangerous class: the name exists on both sides, so
every "does it exist" check passes while the object behind it means something
else. `PlanChangeRequest_userId_active_key` — the partial unique index that
stopped two racing plan-change confirms from both reserving — was exactly that
shape before `20260801190000_plan_change_pending_slot` moved the same invariant
onto a generated column.

**Do not correct anything found here by hand, and never with `db push`.**
Classify each difference — manual drift, extension-owned object, or a migration
nobody wrote — then fix it with a **new forward migration** and re-run. Editing
an applied migration changes its checksum, and every environment that already
ran it then disagrees with the repository. The schema dump is not a CI artifact
and no connection string goes into the ticket.

### What an edited applied migration actually costs

Not a failed deploy. On Prisma 7 `migrate deploy` (`ApplyMigrations`) does not
compare checksums of already-applied migrations — it applies what is pending and
carries on. The check lives in `diagnose_migration_history`, which is what
`migrate status` runs, and it reports `<name> was modified after it was applied`.
So the damage is to release integrity, not to availability: §1 asks for a clean
`migrate status`, and this makes it dirty on every environment that ran the
earlier bytes. It also means the drift is silent in a deploy log and has to be
looked for.

It cannot be repaired with `prisma migrate resolve` — that is for failed and
rolled-back migrations, not successful ones — and rewriting `checksum` in
`_prisma_migrations` by hand is not a supported recovery path. A staging
database that can be recreated should be recreated; production needs a decision
of its own.

Decide from the recorded checksums, not from the file, because staging and
production can disagree and the repository can only hold one version:

```sql
SELECT id, migration_name, checksum, started_at, finished_at,
       rolled_back_at, applied_steps_count
FROM "_prisma_migrations"
WHERE migration_name = '<name>'
ORDER BY started_at;
```

| Production | Staging | Action |
|---|---|---|
| original | original / unapplied | restore the original file |
| edited | edited / unapplied | keep the edited file |
| original | edited | restore the original, then recreate staging |
| edited | original | keep the edited, then recreate staging |
| unapplied | unapplied | choose the version that is semantically right |

Where an edited version was applied first, also check the edit against a
pre-migration backup: a widened allowlist can have cleared a value an operator
had set deliberately.

### 7.7 Purchased-credit lot invariants (post-deploy, owned, time-boxed)

`20260812070000_credit_lot_non_negative` added two CHECK constraints to
`CreditLot` — `remainingCredits >= 0` and `remainingFundedCostMicroUsd >= 0` —
as `NOT VALID`. From that deploy onward Postgres enforces both on every INSERT
and UPDATE; what `NOT VALID` defers is only the check against rows that already
existed, so that the deploy could not fail on data nobody had surveyed.

`npm run report:credit-lot-invariants` is that survey. **It is not a gate.** It
exits 0 whether it finds zero violating rows or fifty, so nothing anywhere will
fail because this was skipped — it has to be run by a named person against a
deadline, not left to be "caught by the next release".

```
Owner:              ____________________
Due (within 7 days of the deploy): ____________________
```

Run **from the deployed release SHA**, against production on a read-only role.

- [ ] Production deploy SHA and the timestamp of the run recorded
- [ ] Both constraints exist and are reported `NOT VALID`
- [ ] `violationCount` and `readyToValidate` recorded

```
Deploy SHA:         ____________________
Ran at (UTC):       ____________________
violationCount:     ____________________
readyToValidate:    ____________________
```

**The full row output does not go in a pull request, an issue, or an ordinary
log.** The report prints account identifiers alongside financial balances; only
the two figures above are safe to circulate. Keep the rows themselves in the
restricted operations store.

Then, by outcome:

- **Zero violations** — add a forward migration that runs
  `ALTER TABLE "CreditLot" VALIDATE CONSTRAINT ...` for both. That is the only
  way to validate them; hand-validating production leaves
  `pg_get_constraintdef()` disagreeing with the migration history, which §7.6
  then reports as drift.
- **Any violations** — **do not raise the balance.** A negative lot is the
  visible end of a specific reservation or settlement that went wrong; find it,
  establish what the account was actually entitled to, and correct it with a
  compensating `CreditLedgerEntry` so the lot and its ledger state the same
  financial fact. The correction needs the same approval any credit adjustment
  needs. Validation waits until the count reaches zero.

### 7.8 Tables nothing removes rows from

`npm run report:unswept-tables` lists every table the application writes and
never deletes from, minus the ones registered as bounded by a key space or as
deliberately retained. **It is not a gate.** It exits 0 with any number of
findings, because whether a table should be swept, kept, or is bounded by
something the script cannot see is a decision a person makes — the failure it
prevents is nobody being asked.

Three tables were found this way and now have policies: `ProviderProbeResult`
(a row per probed model every ten minutes, read by nothing), `ScheduledJobRun`
and `ProviderModelCatalogRun`. None of them broke anything, which is why they
lasted: a table with no ceiling costs disk, backup time and query planning long
before it costs an outage.

- [ ] Run it and read the list. A new name on it is a table added since the
      last release with no retention decision.
- [ ] Anything acted on is either a policy in `lib/retentionPolicyCore.ts` or a
      registry entry in `scripts/report-unswept-tables-core.mjs` with the reason

The reservation tables (`ChatCreditReservation` and its image and memory
siblings) are on the list deliberately and are **not** to be swept until the
decision below is recorded. A settled reservation is the record linking a
request to the credits it spent, so a sweep is a decision about billing
evidence rather than about disk — but "billing evidence" justifies keeping a
row for a stated period, never keeping it forever by default. The row also
carries a user link, so how long it is kept is a privacy question as much as a
finance one.

**Both finance-ops and privacy/legal own this decision**, and it is not made
until all three of these are written down:

- [ ] **Retention period per status.** A `reserved` row that expired, a
      `settled` row and a `refunded` row do not have the same evidential life;
      one period for all three is a decision by omission
- [ ] **What happens at the end of it** — deletion, or anonymisation that keeps
      the aggregate and drops the user link. If anonymisation, name the columns
- [ ] **Account deletion, disputes and backups.** Whether a deletion request
      removes these rows or the retention period outlives it, what a live
      chargeback or refund dispute freezes, and how far the period extends into
      restorable backups

Until then the tables stay on the report with no policy, which is the honest
state: a table nobody has decided about should read as undecided, not as kept.

## 8. Unverified items and waivers

Anything above that could not be verified from this environment goes here with
a named owner. N/V is an accepted, tracked risk; a silent tick is neither.

| Item | Why not verified | Owner | Command / evidence needed |
| --- | --- | --- | --- |
|  |  |  |  |

### Carried forward from the 2026-08 go-live review

Everything below was reached during that review and could not be closed from a
development container. Each row names what would close it, so the next person
runs a command rather than re-deriving the gap. Copy a row into the table above
for the release you are cutting, with a real owner, rather than treating this
list as already accepted.

| Item | Why not verified | Owner | Command / evidence needed |
| --- | --- | --- | --- |
| §2 Nightly Visual Regression for the release SHA | The workflow cannot be dispatched from a development container | Release manager | `workflow_dispatch` on **Nightly Visual Regression** at the release ref; record the run URL and who reviewed the diffs |
| §3 Staging verification (build-info SHA, `/status` vs `/api/models/status`) | No staging deployment reachable | Release manager | `curl https://<staging>/api/build-info`, then `/status` and `/api/models/status` in the same window |
| §4 Screen reader, Korean IME, external keyboard, real browser zoom | Not automatable; the E2E suite emulates viewport, not zoom or AT | Accessibility owner | `.github/ACCESSIBILITY_QA_MATRIX.md` rows, filled against the release SHA |
| §7.1 `prisma migrate deploy` / `migrate status` | No production or staging database | Release manager | Migrate output and the pre-migration snapshot id |
| §7.2 Production environment values | Environment variables are not readable from here | Infrastructure owner | A screenshot or `railway variables` output for each row in §7.2 |
| §7.3 Cloudflare header spoof test and the 421 direct-origin rejection | Requires a request from outside the edge, against a real deployment | Infrastructure owner | The two `curl` commands in §7.3, run against the release deployment |
| §7.5 SEC-011 production migration and its zero-row verification | The migration must run against the production database | Release manager | `npm run migrate:conversation-lock-passwords -- --dry-run`, then `--confirm-production`, then the count query in §7.5 |
| WebKit (`mobile-safari`) E2E project | WebKit is absent from this container's Playwright bundle; only Chromium is installed | QA | `npx playwright install webkit && npx playwright test --project=mobile-safari` on a runner that has it |
| UX-020 Chinese, French, German, Spanish and Portuguese translations | 182 Chinese keys and ~225 keys per preview locale answer in English. Translating them needs a reviewer per language, not a machine pass into the product's core interface | Localization owner | Lower the per-locale ceiling in `tests/localeParity.test.mjs` as strings land; the test measures the remaining gap |
| ~~UX-024 Conversation switching during a streaming response~~ **Closed.** `mockAuthenticatedApi` gained `extraConversations`, which made the switch reproducible, and the measurement settled it: nothing is lost. The request is not aborted on a switch, `app/api/chat/route.ts` persists the assistant message against the `conversationId` captured at send time, and the client never writes one itself, so the stream cannot follow the user. Decided **allow**; the dead guard and the `isSending = false` constant behind it were removed rather than wired up, since blocking would refuse every sidebar click for the length of a response. Held by `tests/e2e/conversation-switch-during-stream.spec.ts`. Hoisting `modelStatuses` out of the two shells was not needed and was not done. | — | — | — |
| Dependency currency (not vulnerabilities) | `npm audit` and `npm audit --omit=dev` both report **0** as of this review. `npm outdated` lists semver-compatible updates and three major jumps (eslint 10, openai 7, typescript 7) that are their own pieces of work | Platform owner | `npm audit --omit=dev` at the release SHA; schedule the majors separately |
