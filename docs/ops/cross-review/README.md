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
- Two executors agreeing is not a pass: the control program's own checks
  must pass as well -- at least one test run and every run passed, at least
  one guard rule run and every rule passed. Nothing run is a failed check
  (an empty test list is not a passing one, and neither is an empty guard
  list), and so is a diff that names a file the author did not report. A
  failed check sends the approved change back to the author.
- An actionable finding is never passed over: with a revision left it goes
  back to the author, and in the last round it puts the change on hold even
  under an approval.
- The cap is fixed at two fix rounds (`MAX_REVISIONS`). `--max-revisions`
  may lower it for a run and cannot raise it.
- The scope check reads the diff as well as the author's file list: a file
  the diff touches outside `writableScope` is refused before review,
  whatever was reported. `package` mode reads the whole working tree for
  the same question, so nothing hides behind the scoped diff.
- A finding is acted on only with a reproduction, whatever its basis:
  `evidence` names something checkable and the reproduction is how to check
  it; a `judgement` likewise. A `preference` is settled by the project's
  rules. A finding with no reproduction keeps the current version. All are
  recorded, none dropped.
- After the fix rounds are spent, an unresolved change is put on hold with
  its findings and reproductions. It is not retried.
- Invalid JSON, a missing result, a timeout, a failed execution and a digest
  mismatch are each a named failure, never a pass.

## Running it

```
npm run cross-review -- --task=<task.json> --mode=mock --fixture=<fixture.json> --out=<dir>
npm run cross-review -- --task=<task.json> --mode=dry-run --out=<dir>
npm run cross-review -- --task=<task.json> --mode=package --test-command="..." --guard-command="..." --diff-exclude=<generated> --out=<dir>
npm run cross-review -- --task=<task.json> --mode=preflight --out=<dir> [--i-have-authorised-live-execution]
npm run cross-review -- --task=<task.json> --mode=review --out=<dir> [--i-have-authorised-live-execution]
```

`mock` runs the whole loop from a fixture. `dry-run` builds the command-line
executors and proves they do not run. `package` calls no executor: it takes
the diff against the task's base commit (or `--base`), digests it, runs the
test command and every `--guard-command`, and writes the round's package and
the reviewer prompt. `review` runs only the reviewer on a packaged round,
writes `verdict-round<N>.json` next to it, and rewrites `exchange.json` as
the control program's replay of every round so far
(`replayExchange` in `lib/crossReviewCore.ts`); without
`--i-have-authorised-live-execution` it shows the exact command and runs
nothing. `--mode=live` runs both executors in the loop and is refused without
the same flag.

The checks are the control program's, so they are named on the command line:
`--test-command` is the test run (its exit status decides) and
`--guard-command` (repeatable) is a guard rule, run once per round and
recorded with its result (a non-zero exit is a failed rule). In `live` mode
the diff of record is the working tree's diff against the base after the
author ran -- what the author returned is kept only as its claim -- and one
guard rule always checks that the tree holds nothing that diff cannot show.

What a package may leave out of the reviewed diff is fixed before the
exchange, and the allow list is exact: `--diff-exclude` accepts only a path
that, resolved to one spelling, *is* one of the task's `generatedPaths` or
*is* the package's own `--out` directory -- and never a path that is, or
contains, an entry of the writable scope, whatever else it is named as. So
a scoped source, `.`, a parent of the package directory, a file under it,
a path above the repository, and `--out=.` are all refused by name
(`packageExclusionProblems`). Every path is normalised once -- forward
slashes, no trailing slash, `.` and `..` segments resolved -- before it is
checked, digested or handed to git, so neither a Windows spelling nor a
`..` written under an allowed directory can pass one check and mean
another path to git: `<out>/../../README.md` is checked as the
`README.md` it resolves to, and refused. A name git would read as a
pattern or as pathspec magic (`*`, `?`, `[`, `]`, or a leading `:`, `!`,
`^`) is refused wherever it appears -- `lib/[c]rossReviewCore.ts` is a
pattern that matches `lib/crossReviewCore.ts`, not a file -- and every
scope entry and exclusion is handed to git with `:(literal)` magic, so a
name is never read as a pattern. An excluded generated file still counts
as changed; what it is at packaging -- its content digest, or `absent` --
is recorded in the package, and a review refuses to run if it has
changed, appeared or disappeared since.

### Before a review is paid for

`--mode=preflight` runs the reviewer's own invocation -- same command, same
overrides, same sandbox -- on a prompt that is not a review: read the HEAD
commit, then try to write a probe file under `--out` with one shell
command that names the probe's path. It passes only when the read produced
the commit this script knows, the probe did not land, the tool's own
output shows a write *at the probe path* being refused (a command naming
the path whose output says it was denied, a failed file change there, a
permission denial naming it -- `writeRefusalEvidence`, and the evidence is
written into the record), and the reviewer does not report the write as
done. Naming the path means the exact relative path, or the same path
under the working directory, as a whole path: a denial at
`shadow/<probe>` or at `<probe>.bak` is a denial of some other file. A
refusal that names no path -- Codex's own "patch rejected" line -- or a
denial of some other file shows that something was refused, not that the
probe was, and does not count; nor does what the reviewer *says*, which
is recorded and is not evidence by itself. The record
(`preflight-<stamp>.json`, version `cross-review-preflight-v3`: command,
working directory, sandbox signature, tool version, usage -- read from
Codex's `turn.completed` event or Claude Code's JSON envelope -- evidence
and result) is an environment result, kept apart from any finding about
the change. The Claude Code reviewer is pinned to have no shell and no
write tool, so a preflight of it cannot show a refused write; a review
with it needs `--skip-preflight`, recorded as such.

`--mode=review` then refuses to start on a package whose tests or guards
failed, and unless the *newest* preflight for the same sandbox signature
(the command line with the model choice taken out, the directory, and the
shell choice) is a pass under the current rule (`preflightGate`): none at
all, a newer failure, or a pass judged under an older record version each
refuse, and an older pass is never picked past a newer failure -- the
answer is to run the preflight again. Either refusal can be overridden on
the command line (`--review-despite-check-failures`, `--skip-preflight`);
an override is a person's decision and is written into the verdict record
with the reason it overrode.

### Continuing a concluded exchange

A task may name the exchange it continues (`supersedes: { taskId,
exchange }`). Round 0's package then records the lineage and the findings
the prior exchange left open, and the reviewer of round 0 is shown them as
the previous findings. Only an exchange on hold or failed can be continued
-- never one that passed or is still open -- and the chain is capped at
`MAX_SUPERSESSIONS` (2), so starting a new task is not a way to reset the
revision cap. Beyond the cap a person decides.

The person-driven loop is `package` → `review` → (fix) → `package --round=1`
→ `review` …, and `exchange.json` carries `awaiting_review` or
`awaiting_revision` between steps and the control program's own `passed`,
`on_hold` or `failed` once it has decided. The script refuses what would make
the record untrustworthy: a change outside the scope anywhere in the tree or
an untracked file the diff would not show; a package or review of round N
unless the replay of rounds 0..N-1 is `awaiting_revision` (after `passed`,
`on_hold` or `failed` the exchange has concluded, and a further change is a
new task or a new `--out`); a second verdict on a reviewed round; and a
review of a package the working tree does not match, where matching means
the tree's diff against the base, scoped and excluded as the package was,
digests to the package's digest.

### The reviewer's invocation

`CLI_INVOCATIONS` in `lib/crossReviewExecutors.ts` records the intended
invocations. They were checked on 2026-09-09 against codex-cli 0.146.0 and
Claude Code 2.1.261 (`--help` of both; the `codex` source at tag
`rust-v0.146.0` for the JSONL event shape, the headless approval policy and
the config layers). What the check changed:

- The Codex reviewer runs `codex --sandbox read-only exec --ignore-user-config
  --json -`. The sandbox bounds shell commands only; MCP servers, plugins and
  hooks from `~/.codex/config.toml` run outside it, and `-c mcp_servers={}`
  merges rather than replaces, so the user layer is left out altogether. The
  stored login is still used. `codex exec` sets the approval policy to
  `never`, so a command the sandbox refuses is rejected, not escalated.
- What a run still needs from configuration is passed with
  `--codex-config=key=value` (repeatable) and recorded with the verdict. A
  reviewer accepts only `REVIEWER_CONFIG_OVERRIDE_KEYS` -- the model, its
  reasoning effort, and the Windows sandbox backend -- so an override cannot
  widen what it may do. Give values without quotes (`model=gpt-5.6-sol`).
- On Windows, with the user layer ignored, `windows.sandbox` is unset, and
  unset resolves to no backend, under which `codex` rejects every command
  rather than running unsandboxed. Pass `--codex-config=windows.sandbox=elevated`
  (or `unelevated`) to keep the sandbox the machine already has set up.
- `--codex-auth=login` (the default) drops `OPENAI_API_KEY` and
  `CODEX_API_KEY` from the child environment so the run uses the stored
  login; `env` keeps them.
- `--codex-shell=windows-powershell` drops the app-execution-alias directory
  (`…\Microsoft\WindowsApps`) from the child's PATH. The Windows sandbox
  starts its shell under a restricted token, and the Store-installed
  PowerShell 7 lives under WindowsApps, whose ACLs deny such a token
  (`CreateProcessAsUserW failed: 5`); with the alias out of the way codex
  falls back to Windows PowerShell in System32. The choice is part of the
  sandbox signature and is recorded in the preflight and the verdict.
- The Claude Code reviewer runs `claude --print --safe-mode --output-format
  json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
  --strict-mcp-config`: the user's, project's and local customisations --
  hooks above all, which run with the user's full permissions -- do not
  load, only the read tools are built in, nothing prompts, and no MCP server
  is loaded. `--safe-mode` keeps the stored login; `--bare` would drop it,
  so it is not the flag used. Managed policy hooks still apply, as the
  documentation says. It has not been run.

Neither author invocation has been run. The check is due again whenever
either tool is upgraded.

`fixtures/` holds a demo task and three fixtures: a fix-then-approve pass, an
exhausted-revisions hold, and a digest-mismatch failure.

## The exchange record

`exchange.json` carries the task ID, the original requirement and completion
criteria, the digest and commit of the change reviewed, the change summary,
the test results, the review conclusion, every finding with its location,
severity, basis, reproduction and disposition, and the next action.
