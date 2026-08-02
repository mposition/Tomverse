# Release checklist

Run through this before promoting a build — except section 4, which an operator
runs against production at the deployed SHA, and section 6, which is checked
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

- [ ] `npm run typecheck`
- [ ] `npm run lint -- app components lib tests scripts`
- [ ] `npm run test:unit`
- [ ] `npm run test:server-contract`
- [ ] `npm run security:regression`
- [ ] `npm run check:encoding:strict`
- [ ] `npm run build`
- [ ] `npm run verify:smoke-coverage`
- [ ] `npm run check:model-pricing`
- [ ] `npm run check:default-models`
- [ ] Chromium E2E: `desktop-chromium`, `desktop-compact`, `mobile-chromium`
      — no unexplained failures

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

## 4. Production schema comparison (operator, at the release SHA)

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
else. The partial unique index that stops two racing plan-change confirms from
both reserving is exactly that shape.

**Do not correct anything found here by hand, and never with `db push`.**
Classify each difference — manual drift, extension-owned object, or a migration
nobody wrote — then fix it with a **new forward migration** and re-run. Editing
an applied migration changes its checksum and breaks deploys on every
environment that already ran it. The schema dump is not a CI artifact and no
connection string goes into the ticket.

## 5. Accessibility

- [ ] `.github/ACCESSIBILITY_QA_MATRIX.md` filled in for this release SHA
- [ ] No P0/P1 accessibility blocker outstanding
- [ ] Any row still marked N/V is an accepted, named risk — not an oversight

The automated rows in that matrix run in CI. The screen-reader, Korean-IME,
external-keyboard and real-browser-zoom rows do not, and a green suite says
nothing about them.

## 6. After the release merge — confirm shared ancestry was restored

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

The workflow refuses to guess. On a merge conflict, or when the push to
`develop` is refused by branch protection, it opens
`automation/back-merge-main-<sha>` as a pull request instead and `verify` fails.
That failure is the signal that a person has to finish the job:

- [ ] If such a pull request exists, it was merged **with a merge commit**

Squashing it accomplishes nothing at all — the second parent is what carries the
ancestry, and a squash discards it. That is not hypothetical: of the three
back-merges opened by hand on 2026-08-01, #203 and #213 were squashed on the way
in and left the gap exactly where it was.

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

## 7. Scope notes

A green visual run is **not** an accessibility result. Screenshot goldens
cannot see focus order, accessible names, announcements or contrast in forced
colors. Accessibility evidence is tracked separately and is not satisfied by
anything in section 2.
