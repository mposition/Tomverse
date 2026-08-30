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
- [ ] `npm run check:e2e-copy-selectors` — a copy-based locator that steers a
      branch (`isVisible()`, `count()`) resolves instead of retrying, so when
      the copy is renamed the branch is silently never taken. A brand rename
      left one such guard in `openSidebarOnMobile`, and the mobile suite failed
      on every commit to main for ten runs while production deploys waited on
      that check suite.
- [ ] `npm run check:model-pricing`
- [ ] `npm run check:image-pricing`
- [ ] `npm run check:image-executor-budget`
- [ ] `npm run check:fal-smoke-evidence` — recomputes the run that
      `fal-ai/nano-banana-2` was enabled on, and compares the request it proves
      against the one the builder produces now. Needs no credential; its
      sibling `check:fal-image-pricing` does, and is listed below.
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
- [ ] `npm run check:capacitor-local-bundle` — scans every `capacitor.config.*`
      for `server.url`, `server.cleartext` and `server.allowNavigation`. All
      three are documented by Capacitor as not for production, and a remote
      `server.url` is refused by the delivery plan (§2) and the mobile
      authentication policy ("Deliberately excluded") because it changes the
      origin the bearer-token boundary is defined against. Read as text, so a
      URL supplied through an environment variable is still a finding
- [ ] `npm run check:push-scope` — reports PUSH-01's metric
      (`unapproved_push_infrastructure_components_in_v1`). The gate is met by an
      absence, so this is the artefact that states it; approving a use case is
      still a decision recorded on the gate itself
- [ ] `npm run check:retired-product-name` — the Insight -> Review rename is
      held by an absence, so this is the artefact that states it. Audit,
      evidence and staging-verification paths keep the old name on purpose and
      are allowlisted with a reason each; the bare word "Insight" is never a
      signal (product boundary decision record v1.2, decision 1)
- [ ] `npm run check:conversation-writers` — every production Conversation
      write goes through `lib/conversationCreation.ts`, which takes productKey
      as a required argument. The three NOT VALID CHECKs all pass
      `productKey IS NULL`, so they stop wrong combinations and not omissions;
      this is what stops omissions (decision record v1.2 §6)
- [ ] `npm run check:default-models`
- [ ] `npm run check:encoding:strict`
- [ ] `npm run check:locale-translation` — proves no locale is still showing an
      English sentence where a translation is owed
- [ ] `npm run check:ai-review-eval` — proves the AI Review evaluation dataset
      is structurally sound (a case with an unstated `goldCompleteness` or a
      `prompt_injection` case with no marker produces numbers over the wrong
      denominators rather than an error) and that no reviewer pair is marked
      `approved` without the evidence
      `docs/policy/ai-review-m5-quality-contract.md` §3 requires. Passing with
      nothing approved is the expected state, not a gap
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
- [ ] `npm run check:sending-identity` — proves nothing hard-codes the address
      mail is sent from. Four senders each carried their own variable and their
      own literal, so moving the sending domain moved one of them and no health
      check could tell: a check only sees the senders that ask it
      (docs/ops/email-sending-domains.md §1.2)
- [ ] `npm run check:email-provider-port` — proves the provider seam is still
      two methods over one implementation, and that nothing posts to the send
      endpoint around it. Templates, contacts and segments stay in our own
      database; a port that grew them would put the copy in the provider's
      account, which is the lock-in the port exists to avoid
      (docs/policy/email-notifications.md §8.2)
- [ ] `npm run check:context-window-register`
- [ ] `npm run check:router-context-window`
- [ ] `npm run check:router-quality-eval`
- [ ] `npm run check:router-decision-preregistration` — `n` is still the
      number that was frozen before the run, under the version it was
      frozen as, and no more than one registration is active
- [ ] `npm run check:router-human-review` — the human sample that
      calibrates the model judges holds the shape it was drawn with:
      four primary and two reserve per cell, no pair in both, no
      substitution recorded against a verdict, and no diagnostic pair
      inside the primary sixty
- [ ] `npm run check:auto-rollout-readiness`
- [ ] `npm run check:usage-bucket-range`
- [ ] `npm run check:memory-extraction-eval`
- [ ] `npm run check:memory-eval-freeze` — the eval dataset's freeze is
      three constant edits, and a frozen dataset is what a decision-grade
      verdict is cited against. Fails only when
      `MEMORY_EVAL_DATASET_FROZEN` claims a freeze the conditions of
      docs/ops/memory-extraction-eval-dataset.md §7.1 do not support;
      while the dataset is still being authored it reports progress
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
- [ ] `npm run check:staging-verification-records` — proves the staging
      checklist still holds no results and every signed run record still
      hashes to what it was signed as. The previous shape kept an approval
      table inside the checklist, which could not say which commit it covered
- [ ] `npm run check:release-records` -- proves this file still holds no
      results and every recorded run names the build it covers, with an owner
      for each box it left unticked. Written after a run reached a signed
      state with its build unnamed and two owner cells reading `(이름)`
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
- [ ] `npm run check:router-context-window-db` (needs the deployed database) —
      proves no registry row cleared a context window the catalogue declares.
      `getRuntimeModels` builds each model from its row alone, so a `NULL`
      there is an unguarded model however `lib/models.ts` reads, and
      `check:router-context-window` cannot see it. No CI job can run this.
- [ ] `npm run check:openai-model-access` (needs a production key) — per-account
      model visibility only. It is **not** a price source; nothing in
      `lib/modelPricing.ts` may be derived from its response.
- [ ] `npm run check:fal-image-pricing` (needs `FAL_KEY`) — fal publishes
      "Pricing is subject to change" beside the number `fal-ai/nano-banana-2`'s
      fixed 120 credits were computed from, so this is the only thing standing
      between a price move at fal and a settlement report nobody reads weekly.
      The **fal Price Drift** workflow runs it daily against `main` and
      `develop`, so this line is a re-check at the release SHA rather than the
      only run. `matched` is the pass. `not_registered` is the correct answer
      on a branch that does not carry the model -- which is `main` until the
      activation reaches it -- and `lookup_failed` and `skipped` are neither a
      pass nor a failure.
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

### 7.7a Assistant knowledge invariants (post-deploy, owned, time-boxed)

`20260823090000_assistant_package_import` added
`AssistantKnowledgeFile_extractedCharacters_non_negative_check` as `NOT VALID`,
for the same reason 7.7's constraints were: from that deploy onward Postgres
enforces it on every INSERT and UPDATE, and what is deferred is only the check
against rows that already existed.

The column changed job in that migration. It had been close to a display value;
it is now a quota input, because a file with no `extractedBytes` — every file
written before the migration — is counted by its character count instead. A
negative number there stops being cosmetic and starts granting allowance.

`npm run report:assistant-knowledge-invariants` is that survey. **It is not a
gate.** It exits 0 whatever it finds, so nothing will fail because this was
skipped.

```
Owner:              ____________________
Due (within 7 days of the deploy): ____________________
```

Run **from the deployed release SHA**, against production on a read-only role.

- [ ] Production deploy SHA and the timestamp of the run recorded
- [ ] `AssistantKnowledgeFile_extractedCharacters_non_negative_check` exists and
      is reported `NOT VALID`
- [ ] `violationCount` and `readyToValidate` recorded

```
Deploy SHA:         ____________________
Ran at (UTC):       ____________________
violationCount:     ____________________
readyToValidate:    ____________________
```

Unlike 7.7, this report prints **no identifiers at all** — it answers with
counts, because the recommended action for a violating row is not to edit it.
The four figures above are the whole record, and the report's own output does
not go into a pull request or an issue either.

Then, by outcome:

- **Zero violations** — add a forward migration that runs
  `ALTER TABLE "AssistantKnowledgeFile" VALIDATE CONSTRAINT ...`. That is a
  separate submission and a separate deploy from the one above: `prisma migrate
  deploy` applies every pending migration in one run, so shipping both together
  would validate without the survey ever happening. Hand-validating production
  instead leaves `pg_get_constraintdef()` disagreeing with the migration
  history, which §7.6 then reports as drift.
- **Any violations** — **do not edit the rows.** A negative extraction count is
  a processing result, so the question is what wrote it. Find that first;
  validation waits until the count reaches zero, and the fix belongs in the
  extractor rather than in the data.

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
siblings) are **held**, not unswept: `report:unswept-tables` reports them in
their own section with an owner and a date rather than in the list of tables
nobody has looked at. A settled reservation is the record linking a request to
the credits it spent, so a sweep is a decision about billing evidence rather
than about disk -- but "billing evidence" justifies keeping a row for a stated
period, never keeping it forever by default. The row also carries a user link,
so how long it is kept is a privacy question as much as a finance one.

**Both finance-ops and privacy/legal own this decision, jointly, by
2026-08-28 (AEST).** That is the date a policy is *approved* by, not a date
anything is deleted on: the hold is "no deletion before approval", and it does
not lapse when the date does. What lapses is the promise to decide, after
which the report stops calling it a current hold and reports it as an overdue
policy question -- a deadline that printed the same thing on either side of
itself would not be one.

All three tables are one decision. They differ only in which workflow reserved
the credits, every question below has the same answer for all three, and
answering them separately is how two get a policy and the third is found years
later.

- [ ] **Retention period per status.** A `reserved` row that expired, a
      `settled` row and a `refunded` row do not have the same evidential life;
      one period for all three is a decision by omission
- [ ] **What happens at the end of it** -- deletion, or anonymisation that
      keeps the aggregate and drops the user link. If anonymisation, name the
      columns
- [ ] **Account deletion, disputes and backups.** Whether a deletion request
      removes these rows or the retention period outlives it, what a live
      chargeback or refund dispute freezes, and how far the period extends
      into restorable backups

## 7.9 How a change reaches production

Everything above assumes the build being released came through `develop` and
was deployed to staging. On 2026-08-15 four changes did not, in one day,
against one release that did. That is not four people being careless; it is
one structural gap, and the gap was never staging itself.

**The gap was selective release.** `develop` sat 36 commits ahead of `main`.
Every one of the four needed a subset of that shipped without promoting the
rest, and the only mechanism the repository offered for "some of develop, now"
was a merge straight to `main`. Widening the exception would have made that
official; the fix is to give the need its own path.

Three lanes. Which one a change takes is decided by what it is, not by how
inconvenient the alternative feels.

| Change | Lane | Verification |
|---|---|---|
| Ordinary work | `develop` | staging, then a release cut from `develop` |
| Part of `develop`, needed sooner | `release/**`, cut from `main` | the exact RC SHA verified on staging or a scratch environment, then merged to `main` |
| A declared incident or a security advisory | `hotfix/**` | §7.9.2, and the incident or advisory is named |

The branch prefix is the declaration. `*-main` in a name says where somebody
meant it to go and proves nothing about urgency or approval, which is why it
is not one of the three. `scripts/auto-pr-branch-policy.mjs` already refuses
`release/**`, `hotfix/**` and anything with a `to-main` segment an automatic
develop pull request, so these names carry no automation of their own -- their
pull requests are opened and merged by a person on purpose.

### 7.9.1 Selective release: `release/**`

For a change that is finished, is already on `develop`, and should not wait for
everything else on `develop`. This is not an exception and needs no waiver; it
is a smaller release with the same evidence.

```
git fetch origin main develop
git checkout -b release/<date>-<subject> origin/main
git cherry-pick <the commits, and only those>
```

- [ ] The branch starts at `origin/main`, so what is verified is what is merged
- [ ] Only the intended commits are on it. If a cherry-pick needs a conflict
      resolution the original never had, that resolution is new code and is
      reviewed as such
- [ ] **The RC SHA is deployed to staging or a scratch environment**, and
      `/api/build-info` is read back to confirm it names that SHA. Not the
      current `develop`, which is further ahead and would measure a different
      build
- [ ] Whatever the change touches is exercised there: a provider turn, a Stripe
      path in test mode, a signed asset URL, an admin flow -- CI reaches none
      of these
- [ ] A rollback SHA is named
- [ ] The back-merge to `develop` is confirmed, or the next release reverts it

```
RC SHA:             ____________________
Verified on:        ____________________
Verified by / how:  ____________________
Rollback SHA:       ____________________
Back-merge run:     ____________________
```

Done this way, a selective release is a release. It gets a record under
`.github/audits/release-<date>__<sha>.md`, not a deviation record.

### 7.9.2 The exception: `hotfix/**`

Staging is skipped entirely here, so the bar is what makes it an exception
rather than a faster lane. All six apply, and the first is the one that
qualifies it:

- [ ] **A security advisory, or a declared production incident.** Named, with
      its link. Dependabot security updates arrive on the default branch
      whatever `target-branch` says, and belong here. A change that is merely
      finished, or merely wanted sooner, is §7.9.1
- [ ] **A person approved it before the merge**, and recorded that staging is
      being skipped. A record written afterwards is not this: it describes the
      skip, it cannot authorise it retroactively
- [ ] **The new release SHA is recorded** -- the merge commit production will
      serve, not the PR head
- [ ] **Verified beyond PR CI**, at whichever boundary the change touches. CI
      reaches no provider, no payment processor, no object store, and no
      database in anger
- [ ] **A rollback SHA is named**: the newest build a checklist actually covers
- [ ] **The back-merge to `develop` is confirmed**

```
Incident / advisory: ____________________
Approved by:         ____________________
New release SHA:     ____________________
Verified by / how:   ____________________
Rollback SHA:        ____________________
Back-merge run:      ____________________
```

**"All checks passed" is not on this list, and must not become the bar.**
A rule that admits anything with a green suite is a continuous-deployment
policy wearing an exception's name, and it would have admitted all four of the
2026-08-15 changes -- every one of them was green.

### 7.9.3 When it happens anyway

If a change reaches `main` outside all three lanes, or takes 7.9.2 without its
six, it is a **deviation**: recorded at the time, in
`.github/audits/release-deviation-<date>__<sha>.md`, not deferred to the next
release checklist, which covers a different SHA and cannot speak for this one.
The four records dated 2026-08-15 are the worked examples.

A deviation record describes; it does not authorise and it does not control.
If they accumulate, the answer is a lane the work actually fits, not a
shorter record.

### 7.9.4 Wait for CI

Railway's **Wait for CI** (`checkSuites`) is on for both environments as of
2026-08-15. It holds a deployment until the pushed commit's check suite
finishes, which removes the race where production deployed while its own checks
were still running.

It is a floor under every lane above and a substitute for none of them: it
answers "did the checks finish", never "was this exercised anywhere real".
https://docs.railway.com/deployments/github-autodeploys#wait-for-ci

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
