# Review parity baseline (`@review-parity`)

- Status: shadow (non-blocking), pending promotion
- Owner: Web/UI
- Canonical gate: `UI-01` in `docs/release-gates/tomverse-chat-v1.yaml`
- Manifest: `scripts/verify-review-parity-coverage.mjs`
- Workflow: `.github/workflows/review-parity-shadow.yml`

## What this is

`UI-01` requires that Tomverse Review behaviour stays stable after the
`chat-core` / `chat-ui` extraction. That promise is only meaningful against a
baseline frozen *before* the refactor, so this tier names the chat state
contracts an extraction can break and pins them to a reviewed manifest.

It is a purpose tier, not a size tier. The repository already has `@smoke`
(merge-blocking user contracts), `@ui-risk` (layout and accessibility),
the visual snapshot suite, and nightly. Parity does not re-run those; it
freezes the behaviour that moves when send/stream state, composer locking,
retry isolation, and attachment identity leave the current components.

## In scope

| Area | Contract |
| --- | --- |
| Send and stream lifecycle | message appears immediately and merges with the provider answer; Enter sends exactly once; a switch mid-stream does not drag the stream to the new conversation |
| Composer lock and release | repeated Enter while sending does not duplicate the request; the composer is released when an abandoned stream finishes |
| Failure isolation and retry | one failing model leaves other answers intact; retry re-requests only that model; an empty provider response is reported rather than left blank or falsely successful |
| Late-response races | a history response landing after the send does not erase the message, in both the desktop and narrowed layouts |
| Comparison and review wiring | preflight rejection reaches no provider; completed answers all run; a failed answer is excluded without blocking the rest; the review tab switcher and agreement summary survive |
| Attachment identity | image and PDF attachments survive send; image input blocks text-only models |

Six of the seventeen contracts also carry `@smoke`, so the PR gate already runs
them. The overlap is recorded per entry as `alsoSmoke` and verified, because a
contract silently gaining or losing `@smoke` changes which gate runs it.

## Two checks, because tags are not execution

`verify:review-parity-coverage` reads Playwright's `--list` output, so it sees
exactly what `--grep @review-parity` will select: a renamed, deleted, untagged
or untracked contract, and `@smoke` overlap drift, all fail there.

What `--list` cannot see is a runtime `test.skip()` inside a `beforeEach`. A
contract can stay tagged, stay listed, stay in the manifest, and still never
execute. `scripts/run-review-parity.mjs` closes that hole by failing the run
when any parity test is skipped or when the tier executes nothing at all.

This is not hypothetical. The composer's *failure-path* release ("a failed send
still clears the composer and surfaces a retryable error") was proposed for this
baseline and then dropped, because it lives in this file's
`mobile chat keyboard policy` block, which skips outside `mobile-*` projects.
Tagging it would have added a contract the desktop tier never ran.

## Deliberately out of scope

These matter, but another tier owns them and duplicating them here would turn
a baseline into a second regression suite:

- the full visual snapshot matrix (`UI-01` release evidence and nightly);
- the 320px / 200%-zoom / IME composer matrix (`@ui-risk`, mobile composer contract);
- every action-rail layout and accessibility combination (`@ui-risk`);
- marketing, analytics, settings and pricing surfaces;
- tests that call real external providers;
- settlement, lease and ledger invariants, which server-contract and unit
  tests check more precisely and far more cheaply.

The manifest enforces this: the visual regression and mobile composer suites,
and the marketing/pricing/analytics files, may never carry the tag.

## Known gaps

Both belong in the baseline and should be closed before the extraction starts.
They are listed here rather than mapped onto a nearby test, so the gap stays
visible instead of being papered over by adjacent coverage.

1. **Attachment identity across retry.** No test covers attachment references
   surviving a retry or a stream refresh.
2. **Composer release on the failure path, on desktop.** The only coverage
   lives in the mobile-only keyboard-policy block, so the desktop tier has the
   abandoned-stream release path but not the failed-send one.

## Promotion criteria

The workflow runs on every PR and blocks nothing. It becomes a required check
only after all of:

1. 20 consecutive green runs on develop-bound PRs;
2. zero flaky failures unrelated to the change under test;
3. wall-clock inside the PR-tier budget (the fast gate's own e2e job is the
   reference point).

On promotion, add the job to branch protection and move
`verify:review-parity-coverage` into the fast gate's static tier, so a shrunken
baseline fails on the same required check as the tests themselves.

Until then, a red parity run is a signal to investigate, not a merge block —
but it must be investigated, because after promotion the same failure stops
every merge.

## Changing the baseline

Adding, removing or renaming a contract means editing the manifest in
`scripts/verify-review-parity-coverage.mjs` in the same PR. The check fails on
a renamed or deleted test, a lost tag, an untracked tagged test, and `@smoke`
overlap drift, so the baseline cannot shrink quietly — which is the whole point
of having a manifest rather than a tag count.
