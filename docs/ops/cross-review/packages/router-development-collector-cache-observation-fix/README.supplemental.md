# Supplemental offline evidence after the first format failure

Recorded on 2026-09-10 for unchanged source commit
`dcabb4e3e130781de5819d2639ea4ab0e7f0df0f`, base
`886ea27f852a7d00c6cccbba26ec0002f2086d16`.
These are **new follow-up observations**, not the original package's truncated
test output. No task, source, package, prompt or controller was changed.

The first actual Claude invocation returned explanatory prose plus fenced
JSON. The unchanged controller rejected it as `invalid_json`; no verdict was
accepted and the exchange remains `awaiting_review`. Its two observations
about test-count evidence and independently checking file hashes are retained
in the raw response. This supplement neither imports that JSON nor declares
the observations dismissed or the review passed.

## Preserved first actual attempt

Both root records still exist. Exact byte copies were added under
`failed-attempt-1/`, without deleting, rewriting or resetting anything:

| Preserved copy | Bytes | SHA-256 |
| --- | ---: | --- |
| [review-round0.events.jsonl](failed-attempt-1/review-round0.events.jsonl) | 6,432 | `b5ec83814f3a1370f7849260cad774320fedad1481c6482cfb03eeb4ee6d3aac` |
| [review-round0.failure.json](failed-attempt-1/review-round0.failure.json) | 1,821 | `63f1e725907419915f812b57ee77c5b6db95c76c5e90e2d9b6e80ebbe44a6c50` |

This is attempt preservation in the same round/exchange, not a new round,
history reset, manual approval or retry execution. A separate earlier auth
preparation stopped before model invocation when the child key-name census
was nonzero; that was not another actual review.

## Full raw test logs

The unchanged tests were run again, offline, with Node v22.22.2's built-in
reporters writing complete TAP output directly to new files. The ordinary
collector npm script's four files, `react-server`, `tsx` and serial test
conditions were copied exactly; only a second reporter/destination was added
so the controller's five-line output tail would not discard counts. Local
`node --help` and the [Node 22 reporter documentation](https://nodejs.org/docs/latest-v22.x/api/test.html#multiple-reporters)
were consulted. No custom logger, test runner or controller patch was added.

| Raw follow-up log | Bytes | Actual result | SHA-256 |
| --- | ---: | --- | --- |
| [collector-tests.supplemental.raw.tap](collector-tests.supplemental.raw.tap) | 18,540 | 80 tests, 80 pass, 0 fail/skip/cancel/todo; exit 0 | `22e5c2f2ac23a9abd05e0f0472616b2d9345529793467c4c628302bf6405d622` |
| [wiring-target.supplemental.raw.tap](wiring-target.supplemental.raw.tap) | 331 | 1 test, 1 pass, 0 fail/skip/cancel/todo; exit 0 | `9effab684ecd221bcf7423e92b96188a005aec80970f103ae0fab1edacd6565c` |

At `2026-09-10T06:02:10.313Z`, a direct assertion over these raw files checked
the anchored `# tests`, `# pass`, zero-failure/skip/cancel/todo summaries and
the number of `ok` result lines. The target file contains the exact line
`ok 1 - every place that harvests cacheReadTokens harvests cacheWriteTokens too`.
Zero matched tests would fail these assertions.

The wiring source declares 12 tests; exactly one literal title matches the
positive anchored pattern. The other **11 tests were intentionally not
executed**, not counted as passes. This Node invocation reports `skipped 0`
because the filtered-out tests do not appear in this run's TAP count. It is
not a whole-wiring-suite pass. The prior full Windows wiring result remains
11/12, exit 1, with its pre-existing path-separator failure. Fresh full Linux
CI on the actual published fix head is still a separate mandatory gate.

Executed locally in PowerShell, in
`H:/Project/tomverse-router-collector-v1-1-20260910`, with existing Node 22 and
installed dependencies; no credentials or live-execution permission were
needed. Before each command the destination was checked absent. These are
execution records, not instructions to overwrite the current logs:

```powershell
node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec --test-reporter=tap --test-reporter-destination=stdout --test-reporter-destination=H:/Project/tomverse-router-collector-v1-1-20260910/artifacts/cross-review/router-development-collector-cache-observation-fix/collector-tests.supplemental.raw.tap tests/routerDevelopmentCollector.test.mjs tests/routerDevelopmentCollectorProvider.test.mjs tests/routerDevelopmentCollectorCli.test.mjs tests/routerDevelopmentCollectorAdversarial.test.mjs
node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=tap --test-reporter=tap --test-reporter-destination=stdout --test-reporter-destination=H:/Project/tomverse-router-collector-v1-1-20260910/artifacts/cross-review/router-development-collector-cache-observation-fix/wiring-target.supplemental.raw.tap '--test-name-pattern=^every place that harvests cacheReadTokens harvests cacheWriteTokens too$' tests/anthropicPromptCachingWiring.test.mjs
```

## Separate Codex byte/hash observations

Codex read each working file with `fs.readFileSync` and the corresponding
committed bytes through `git show dcabb4e3e130781de5819d2639ea4ab0e7f0df0f:<path>`.
Direct byte equality and independently hashing each buffer with Node's
SHA-256 produced the following matching values:

| Path | Working/committed bytes | Working and committed SHA-256 |
| --- | ---: | --- |
| `lib/routerDevelopmentCollectorProvider.ts` | 13,201 / 13,201 | `d4b3cdd679835166d723bad804ee20fe92c82436d31584596c1c3eb3c8539ab8` |
| `tests/routerDevelopmentCollectorProvider.test.mjs` | 12,157 / 12,157 | `ec3501b010870efe3343f91dca0b10b3e2e693557560699ad2229f5d954c6444` |

These are Codex tool observations, **not an independent hash calculation by
Claude**. Claude's Read/Grep/Glob-only review could not run a hash program;
that limitation is acknowledged, not erased by this supplement.

The frozen package SHA-256 remains
`b3fc60ffba3934000ec6e7f5b6a8ee51eb2296799b8ba7dbd8407020c954972e`;
the reviewed change digest remains
`sha256:eed64ad80aac2977a59b50570d2d8245b2251262328e9c4bac5f53199e07a33e`.
No source edit, commit, repackaging, verdict extraction/import, second Claude
call, push, branch change, merge or paid benchmark call was performed while
preparing this supplement.
