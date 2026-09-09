# Cross review: an author, an independent reviewer, and a control program

Offline development tooling. It is not a product path: no user request calls
either executor, and nothing here runs unless a person runs the script.

## Roles

| role | does | writes |
|---|---|---|
| author | produces a change for a task: diff, summary, files touched, its own assessment kept apart | inside the task's `writableScope` only |
| reviewer | reads the original requirement and the diff first, then the tests, then the author's account; returns a verdict bound to the change's digest | nothing |
| control program (`lib/crossReviewCore.ts`) | computes the digest itself, runs the tests, applies the handling rules, counts rounds, decides the outcome | the exchange record |

Which model plays which role is configuration (`--author`, `--reviewer`;
default Claude authors and Codex reviews). The executors are injected, so the
same loop runs against scripted mocks and against command-line tools.

## Handling rules the loop applies

- An approval names the digest it reviewed; a verdict on another digest,
  task or round fails the run. Round n's approval is never reused for n+1.
- Two executors agreeing is not a pass: the control program's tests and guard
  rules must also pass, or the approved change goes back to the author.
- A finding with `basis: evidence`, or a `judgement` with a reproduction, is
  acted on. A `preference` is settled by the project's rules. A `judgement`
  with no reproduction keeps the current version. All are recorded.
- After `--max-revisions` (default 2) fix rounds, an unresolved change is put
  on hold with its findings and reproductions. It is not retried.
- Invalid JSON, a missing result, a timeout, a failed execution and a digest
  mismatch are each a named failure, never a pass.

## Running it

```
npm run cross-review -- --task=<task.json> --mode=mock --fixture=<fixture.json> --out=<dir>
npm run cross-review -- --task=<task.json> --mode=dry-run --out=<dir>
npm run cross-review -- --task=<task.json> --mode=package --base=<commit> --test-command="..." --out=<dir>
```

`mock` runs the whole loop from a fixture. `dry-run` builds the command-line
executors and proves they do not run. `package` calls no executor: it takes
the diff against `--base`, digests it, runs the test command, and writes the
exchange record and the reviewer prompt for a person to hand over.

`--mode=live` is refused without `--i-have-authorised-live-execution`. The
intended invocations are in `CLI_INVOCATIONS` in `lib/crossReviewExecutors.ts`
and were not verified against an installed `codex`; check them against
`--help` before the first live run.

`fixtures/` holds a demo task and three fixtures: a fix-then-approve pass, an
exhausted-revisions hold, and a digest-mismatch failure.

## The exchange record

`exchange.json` carries the task ID, the original requirement and completion
criteria, the digest and commit of the change reviewed, the change summary,
the test results, the review conclusion, every finding with its location,
severity, basis, reproduction and disposition, and the next action.
