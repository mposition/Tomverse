# code-eval

Runs the same small coding tasks through several execution routes and records
whether each task's hidden tests pass. The point is to compare the Tomverse
coding agent with Codex CLI and Claude Code CLI on equal terms, and to compare
two versions of the Tomverse engine before and after a change.

No dependencies beyond Node.js 22 and `git`. Everything in this folder is plain
JavaScript (ES modules).

## Quick start

```powershell
# From the repository root. These two are free and make no model request.
npm run code:eval -- --route fake        # applies each task's solution: must be 30/30
npm run code:eval -- --route noop        # changes nothing: must be 0/30

npm run code:eval:test                   # the tool's own tests (also: node --test tools/code-eval/tests/)
```

`fake` and `noop` are self-checks. `fake` proves every check can pass, `noop`
proves no task starts out passing. The run exits with 1 if either expectation is
violated.

Options of `run.mjs`:

| Option | Meaning |
|---|---|
| `--route <name>` | `fake`, `noop`, `tomverse`, `codex`, `claude`. Repeat it or use commas to run several routes in one go. Required. |
| `--task <id>` | Only this task (repeatable). `--list` prints the ids. |
| `--category <name>` | `bugfix`, `feature`, `refactor`, `test-writing`, `multi-file` (repeatable). |
| `--out <dir>` | Where `results.json` and `summary.md` are written. Default: a new folder under the OS temp directory. |
| `--concurrency <n>` | Jobs at the same time (default 1). Real routes talk to rate-limited services; raise it with care. |
| `--allow-paid` | Required for `tomverse`, `codex` and `claude`. Without it the run stops before doing anything and says what would be billed. |
| `--model <id>` | Model for the real routes (default: each tool's own default; `smart-adaptive` for `tomverse`). |
| `--max-requests <n>` | Model requests per task for the `tomverse` route (default 40). |
| `--keep-workdirs` | Keep the temporary working folders (they are git repositories, so `git diff` shows what the agent did). |

## What a run does

For every route and task:

1. Copies the task's `repo/` into a new folder under the OS temp directory, runs
   `git init` and makes one commit.
2. Runs the route's adapter with the task prompt and a time limit
   (`timeoutSeconds`).
3. Counts the files the agent changed (`git status`).
4. Only now copies the task's hidden `check/` folder into the working folder as
   `__check__/` and runs the task's check command. The agent never sees it.
5. Records the result and deletes the folder.

A task **passes** when its check command exits with 0. The adapter's own status
(`ok`, `error`, `timeout`, or the Tomverse agent's `limit_reached` and so on) is
recorded next to it but does not decide the result: an agent that hit a limit
after writing a correct fix still passes. Look at the `Agent not ok` column of
the summary to see how often that happened.

Each run is a single attempt. Model output is noisy, so differences of a task or
two between runs are not evidence of anything; compare rates, and repeat runs
when it matters.

## Routes

| Route | What it runs | Paid |
|---|---|---|
| `fake` | Copies `solution/` over the working folder. | no |
| `noop` | Does nothing. | no |
| `tomverse` | The repository's own agent (`apps/tomverse-cli`), headless, through its runtime API. | yes: Tomverse credits |
| `codex` | `codex exec --json --sandbox workspace-write --ephemeral ...` | yes: the account Codex is logged in to |
| `claude` | `claude -p --output-format json --permission-mode acceptEdits ...` | yes: the account Claude Code is logged in to |

Running the real routes needs, and spends, real money. Do it deliberately:

```powershell
$env:TOMVERSE_API_KEY = "<a key with a credit cap you accept>"   # tomverse only; never put it in a file
npm run code:eval -- --route tomverse --allow-paid --task bf-pagination   # one task first
npm run code:eval -- --route tomverse,codex,claude --allow-paid --out ./eval-2026-11-25
```

What each real route needs and what it costs:

- **tomverse**: `TOMVERSE_API_KEY` in the environment (the only place it is read
  from). One model request per agent step, up to `--max-requests` per task, at
  the credits of the chosen model. Set a credit limit on the key in Tomverse
  Settings > API keys: that is the only hard cap. Optional `TOMVERSE_ENDPOINT`.
  The agent runs in a child process (`routes/tomverse-worker.mjs`) that removes
  the key from its environment at once, never writes it anywhere and does not
  pass it to commands. The harness answers the agent's approval requests
  itself: file changes whose paths are inside the temporary folder and commands
  that run inside it are approved; commands that look like network access,
  package installs, publishing or deleting outside the folder are denied
  (`routes/tomverse-approval.mjs`). This is a harness policy for throwaway
  folders, not a sandbox: an approved command still runs with your account's
  permissions, exactly as the Tomverse CLI warns on its approval screen. Run
  measurements on a machine where that is acceptable.
- **codex**: the `codex` CLI on `PATH` (or `CODE_EVAL_CODEX_BIN`), already logged
  in. There is no spending cap flag: only the per-task time limit bounds the
  cost. The sandbox is `workspace-write`, which does not allow network access.
- **claude**: the `claude` CLI on `PATH` or in `~/.local/bin` (or
  `CODE_EVAL_CLAUDE_BIN`), already logged in. Capped at 1.5 USD per task with
  `--max-budget-usd` (change with `CODE_EVAL_MAX_BUDGET_USD`). Only file tools,
  `node`, `npm test` and read-only `git` are allowed; anything else is denied,
  because prompts are answered with "no". Runs with `--safe-mode`, so your own
  CLAUDE.md, hooks, skills and MCP servers do not influence the result.

The prompt always travels on stdin, never in the command line, and the Tomverse
key is removed from the environment of the Codex and Claude processes.

## Outputs

`--out` gets two files:

- `results.json`: one record per route and task: `passed`, `agentMs`, `checkMs`,
  `totalMs`, `changedFiles`, `adapterStatus`, `adapterError`, `checkExit`,
  `checkOutputTail` (only when the check failed), and `metrics` when the adapter
  reports them (`inputTokens`, `outputTokens`, `cachedInputTokens`, `turns`,
  `costUsd` from Claude, `credits` from Tomverse). Codex reports tokens but no
  price, so its cost shows as `n/a`. `n/a` always means "not reported", never 0.
- `summary.md`: success rate per route, success rate per category, median agent
  and total time, median number of changed files, summed cost, credits and
  tokens, and a pass/fail table per task.

### Comparing runs

`compare.mjs` puts several runs side by side. The first one is the baseline; for
every later run it lists which tasks were fixed and which regressed. Use it
before and after each change to the agent engine:

```powershell
npm run code:eval -- --route tomverse --allow-paid --out ./eval/before
# ... change the engine ...
npm run code:eval -- --route tomverse --allow-paid --out ./eval/after
node tools/code-eval/compare.mjs ./eval/before ./eval/after            # prints markdown
node tools/code-eval/compare.mjs ./eval/before ./eval/after --out compare.md --route tomverse
```

Arguments are `--out` folders or `results.json` files.

## The tasks

30 tasks, each a small dependency-free Node.js project (5 to 10 files):

| Category | Tasks | What is judged |
|---|---|---|
| bugfix | 7 | Hidden tests for the reported symptoms and their edge cases. |
| feature | 7 | Hidden tests for a feature specified in the project's README. |
| refactor | 5 | Hidden tests for unchanged behaviour plus the required new structure (a new module, no callbacks, nothing left in the old place). Behaviour tests alone would pass before the refactor, so the structure checks are what make these tasks start out failing. |
| test-writing | 5 | The agent writes `test/<name>.test.mjs`; the judge runs it against the real code (must pass) and against 7 to 10 deliberately defective copies (each must make a test fail). |
| multi-file | 6 | A change that has to touch 4 to 7 files consistently. |

| Id | Category | Title |
|---|---|---|
| `bf-cart-totals` | bugfix | Cart totals are off by a few cents |
| `bf-csv-parser` | bugfix | CSV parser mangles quotes and trailing newlines |
| `bf-date-ranges` | bugfix | Back-to-back bookings reported as conflicts |
| `bf-event-emitter` | bugfix | Event emitter skips handlers |
| `bf-lru-cache` | bugfix | LRU cache evicts the wrong entries |
| `bf-pagination` | bugfix | List pagination reports the wrong page count |
| `bf-semver-order` | bugfix | Version sorting puts pre-releases in the wrong place |
| `ft-cli-arguments` | feature | Extend the argument parser |
| `ft-ini-sections` | feature | Add sections, typed values and stringify to the INI parser |
| `ft-inventory-reservations` | feature | Add expiring stock reservations |
| `ft-retry-policy` | feature | Add backoff, jitter and abort to the retry helper |
| `ft-router-params` | feature | Add path parameters and wildcards to the router |
| `ft-sliding-window` | feature | Add a sliding-window rate limiter |
| `ft-template-blocks` | feature | Add each and if blocks to the template engine |
| `mf-config-layers` | multi-file | Add environment and command-line layers to the config loader |
| `mf-error-layers` | multi-file | Introduce typed errors across repo, service and HTTP layers |
| `mf-i18n-plurals` | multi-file | Add plural rules, locale fallback and number formatting to i18n |
| `mf-note-hooks` | multi-file | Add lifecycle hooks to the notes service |
| `mf-rename-compute-total` | multi-file | Rename calcTotal to computeTotal everywhere |
| `mf-todo-due-dates` | multi-file | Add due dates to the todo app end to end |
| `rf-callbacks-to-async` | refactor | Convert a callback-style record store to async functions |
| `rf-dedupe-formatters` | refactor | Share row building between three report formatters |
| `rf-extract-validators` | refactor | Extract duplicated order validation into one module |
| `rf-split-utils` | refactor | Split the utils grab-bag into focused modules |
| `rf-strategy-pricing` | refactor | Replace the tier switch with a strategy registry |
| `tw-expression-eval` | test-writing | Write tests for an arithmetic expression evaluator |
| `tw-money-allocate` | test-writing | Write tests for a cent allocation function |
| `tw-priority-queue` | test-writing | Write tests for a stable priority queue |
| `tw-slugify` | test-writing | Write tests for slugify |
| `tw-word-wrap` | test-writing | Write tests for a word wrapper |

Python tasks are deliberately absent: the Windows machines this runs on have
only the Microsoft Store stub.

### Layout of a task

```
tasks/<task-id>/
  task.json     id (= folder name), title, category, prompt, check (argv), timeoutSeconds
  repo/         what the agent receives (package.json with "type": "module", src/, visible test/)
  solution/     files copied over repo/ by the `fake` route (may include updated visible tests)
  check/        hidden material; never visible to the agent
```

`check` is an argv array run in the working folder, with `node` replaced by the
running Node. The default is `["node", "--test", "__check__/*.test.mjs"]`: the
hidden tests import the project with `../src/...` because they are copied to
`<work>/__check__/`. A glob is needed because Node 22 does not accept a bare
directory for `--test`.

### Adding a task

1. Create `tasks/<task-id>/` with the layout above. The id is lower case with
   dashes; start it with the category prefix (`bf-`, `ft-`, `rf-`, `tw-`, `mf-`).
2. Write `repo/` so that its visible tests pass (`npm test` = `node --test`)
   while the behaviour the prompt asks for is missing or wrong. The prompt must
   describe the symptom or the specification without naming the file to change,
   say that tests run with `npm test`, and contain everything the hidden tests
   rely on (put long specifications in a README inside `repo/`).
3. Write `solution/` with the files that make the task pass, and `check/` with
   hidden `*.test.mjs` files that fail on `repo/` and pass on `repo/` plus
   `solution/`. For a refactor, add checks for the new structure, otherwise the
   task passes before anyone touches it.
4. For a test-writing task use `"check": ["node", "__check__/check.mjs"]` and put
   in `check/`: `check.mjs` (`import { runMutationCheck } from "./mutation-check.mjs"`,
   then `process.exit(runMutationCheck({ minTests: 4 }).ok ? 0 : 1)`),
   `correct/<path>` (the pristine file) and `mutants/<name>/<path>` (a defective
   version). Ship no tests in `repo/test`. Avoid mutants that loop forever.
5. Run `npm run code:eval -- --route fake,noop --task <task-id>` (the fake route
   must pass, noop must fail) and `npm run code:eval:test`, which also checks
   that every visible test passes before and after the solution.

## Known limits

- The `codex` and `claude` adapters were written from `--help` output
  (codex-cli 0.171.0, Claude Code 2.1.278) and exercised only against stand-in
  programs. The JSONL events of `codex exec --json` and the JSON result of
  `claude -p --output-format json` are parsed from memory of their formats;
  unknown shapes are ignored, so a changed format shows up as missing metrics
  (`n/a`), not as a wrong pass rate. The `-c approval_policy=never` override of
  the codex adapter is accepted silently when unknown. Run one cheap task with
  each real route first and read `results.json`.
- The `tomverse` route was exercised end to end only against the CLI's own
  wire-level fake of the Tomverse API (`apps/tomverse-cli/tests/fakeGateway.ts`).
- The three tools do not see identical conditions: each has its own system
  prompt, tools and context handling, and the Tomverse agent has its own request
  limit while Codex and Claude only have the time limit. That is the comparison
  being made, but keep it in mind when reading the numbers.
- Tasks are small and public in this repository. Treat results as a regression
  signal and a rough comparison, not as a benchmark score.
