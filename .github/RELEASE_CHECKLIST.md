# Release checklist

Run through this before promoting a build — except section 5, which runs
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
- [ ] `npm run security:regression`
- [ ] `npm run check:encoding:strict`
- [ ] `npm run build`
- [ ] `npm run verify:smoke-coverage`
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

## 4. Accessibility

- [ ] `.github/ACCESSIBILITY_QA_MATRIX.md` filled in for this release SHA
- [ ] No P0/P1 accessibility blocker outstanding
- [ ] Any row still marked N/V is an accepted, named risk — not an oversight

The automated rows in that matrix run in CI. The screen-reader, Korean-IME,
external-keyboard and real-browser-zoom rows do not, and a green suite says
nothing about them.

## 5. After the release merge — restore shared ancestry

This is the one item here that runs *after* the merge button, and it is the one
most often missed, because nothing fails at the time.

- [ ] The release PR was merged **with a merge commit**, not a squash
- [ ] If it was squashed: `main` was merged back into `develop` immediately
- [ ] Verified: `git fetch origin && git merge-base --is-ancestor origin/main origin/develop`
      exits 0

```
Release merge SHA:  ____________________
Ancestry restored:  ____________________
```

A squash rewrites the release into a single new commit, so `main` and `develop`
end up sharing no commit at all even though their trees are identical. Nothing
is broken by that on its own — the code is released and correct — but the *next*
release PR opens against a base it has no common history with, and every file
the previous release touched arrives as an `add/add` conflict. #195 opened with
14 of them, all in already-shipped code.

Merging `main` back into `develop` puts the release commit in `develop`'s
ancestry and ends the cycle. The merge changes no file content, which is worth
confirming rather than assuming:

```
git diff --quiet <develop-before-the-merge>   # exits 0
```

Recent history shows the pattern clearly: releases through #175 used merge
commits (`939efaa`, `3efb7b9`, `7edb70e` all have two parents), and #186, #195,
#200 and #209 were each squashed and each needed a follow-up
`Merge main into develop` before the next release could open cleanly.

Prefer fixing this at the source. If **Settings → General → Pull requests →
Allow merge commits** is off, or a `main` ruleset requires linear history,
merge commits are not available and this manual step is the standing cost. The
merge strategy is not recorded anywhere in the repository, so it cannot be
enforced by CI — only by this checklist.

## 6. Scope notes

A green visual run is **not** an accessibility result. Screenshot goldens
cannot see focus order, accessible names, announcements or contrast in forced
colors. Accessibility evidence is tracked separately and is not satisfied by
anything in section 2.
