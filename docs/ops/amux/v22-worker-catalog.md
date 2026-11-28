# v22 Task worker metadata

The resident AMUX roster, the assignment catalog and v22 Task profiles are
different inventories. A running session is not execution permission; neither
its name nor its CLI model alias proves a served model.

The assignment catalog is derived from the worker registry (orchestration
policy version 35, section 3; every assignment path reads it since stage R2c).
A worker is an entry when its desired state is `active`, no automatic stop
latch is open and a capability is recorded; `engineering-runner` is a code
constant. Stage R2e removed `TOMVERSE_AMUX_WORKER_CATALOG_JSON` and
`TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON` from the app: neither is read, so
setting either changes nothing, and Admin no longer imports from them.

A worker's v22 one-shot profile is part of its recorded capability: model,
Task roles and tools. Only the owner records a capability, one worker at a
time, through `POST /api/admin/amux/workers/capabilities` (owner role, R2a's
code latch, a recent step-up, and the human audit `amux.worker.capability` in
the same transaction). AMUX › Operations settings › Workers shows what is recorded.

Only the existing Anthropic one-shot path is supported: `design`, `implement`,
`review` and `investigate`, on a Claude worker and a supported model.
Read-only roles require `repo_read`; `implement` requires `repo_write`. A role
the worker's role ceiling does not allow is refused when written and dropped
when the catalog is derived, so a narrowed ceiling takes effect without a new
capability. An unprofiled worker stays in the assignment catalog but is not a
v22 candidate.

Task readiness, automatic admission capacity and worker claim all use this
same profile subset. Holding a worker back is the registry's desired state and
stop latch; a profile cannot set runtime liveness or dispatch readiness.
Existing approval, approved cost receipt, runtime lease, role/tool match,
quota, dependency, reserved-capacity and review-independence checks still
apply.

A worker leaves the v22 candidates when the derived catalog stops listing its
profile: its desired state is no longer `active`, a stop latch opens, or its
newest capability has no v22 profile. Each of those is an operational change
requiring the usual approval; this document opens no switch. Do not replay an
in-flight or unknown-outcome request during such a change. Reconcile its app
receipt first through the existing owner path.

## Task-profile quota reporting

Implementation repair approved by mposition on 2026-10-12 for end-to-end
verification. This completes the existing quota comparison, not a new
worker permission, role, graduation exception or cost allowance.

The fixed sidecar reads subscription quota from the same `CLAUDE_CONFIG_DIR`
used for its Task process. The native roster's account reading is not a
substitute. API-key helpers, alternate-backend/auth settings, unsafe or
expired credentials, unsupported/malformed windows and failed provider
reads produce no observation. No model call, login or token refresh occurs.
Both the fixed CLI profile's global settings and its fixed HOME global
settings are checked; project and managed settings cannot select another
authentication path either. Settings reads are bounded at 256 KiB and the
credential file at 64 KiB. An explicitly reported zero/no-reset optional
model window is inactive, not a fabricated availability measurement; the
weekly account window still needs a valid future reset. An explicit null
five-hour window means no session has started and counts as unused (an
idle account answers that way; before 2026-11-06 it dropped every reading).
The OAuth token is used only for one bounded HTTPS GET to Anthropic's usage
endpoint; it never enters the bridge, app, audit, error output or journal.

### Sign-in copies (`tomverse-amux-v22-auth-stage.timer`)

The worker profiles hold copies of the operator's own CLI logins, refreshed by
`scripts/amux-v22-stage-auth.mjs` (logic in `lib/amux/v22WorkerAuthStage.mjs`)
running as the operator user. Each copy keeps only the access credential;
the refresh secret is replaced, so a worker CLI can never rotate the
operator's login. The operator's own CLI use keeps the source fresh.
Antigravity is the one exception (below).

Claude (`anthropic:<worker>`, from `~/.claude/.credentials.json` to
`<worker>/cli/.credentials.json`) is staged whenever its access token has not
expired; the login keepalive refreshes it about 4 minutes before expiry and
restages the copies (the former 2 h minimum only left the same token in place
and failed the unit for two hours of every token, 2026-11-16). Until 2026-11-06 the timer staged Codex and Copilot only; the
Claude copies made on 2026-10-12 expired that night, the quota reading
stopped, and the claim admitted no Anthropic route from then on. The timer
therefore runs hourly, and its `ExecStart` lists the Claude workers too, with
each `/var/lib/tomverse-amux-v22-<worker>/cli` in `ReadWritePaths`. A refused
login leaves the current copy unchanged and the unit fails; check it with
`journalctl -u tomverse-amux-v22-auth-stage.service`.

The operator's Claude login refreshes only when the operator's own Claude CLI
is used near the access token's expiry, and its refresh token also expires
(`refreshTokenExpiresAt`). On 2026-11-15 nobody had used it on the box: the
refresh token ran out at 04:05Z, the CLI cleared the login at 05:10Z, and every
Claude worker and the anthropic Decision Maker stopped. The operator user's
`amux-v22-claude-login-keepalive.timer` (user unit, every 5 min,
`scripts/amux-v22-claude-login-keepalive.mjs`, units and `.env.example` in
`scripts/systemd/`) closes that gap: when the access token has 10 min or less
left it waits until 4 min are left (the CLI refreshes only inside its own
5-minute buffer; asking earlier logged a `refresh_failed` every 8 h that paged
as `AMUX_WORKER_REFRESH_FAILED`, 2026-11-20), then runs `claude auth status`,
then if that did not refresh it a one-line `claude -p` on Haiku, and on a
refresh restages the Claude copies at once. A refresh does not extend
`refreshTokenExpiresAt`; only `claude auth login` does. It
reads only `expiresAt`/`refreshTokenExpiresAt` and never prints a token. A
cleared login logs `login_required` and fails the unit; that one still needs
the operator's `claude auth login` as the operator user. Install as that user
(no sudo): copy `scripts/amux-v22-claude-login-keepalive.mjs` under the same
name to `~/.local/lib/tomverse-amux-v22/`, the `.service` and `.timer` to
`~/.config/systemd/user/`, and the `.env.example` as
`~/.config/tomverse-amux-v22/claude-login-keepalive.env` (mode 0600), then
`systemctl --user daemon-reload && systemctl --user enable --now
amux-v22-claude-login-keepalive.timer`; read it with
`journalctl --user -u amux-v22-claude-login-keepalive.service`.

Cursor (`cursor:<worker>`, from `~/.config/cursor/auth.json` to
`<worker>/cli/cursor/auth.json`, added 2026-11-10) keeps the access token and
the v19 channel's fixed refresh placeholder, and is staged only with at least
6 h left. The operator's Cursor login is long-lived (about 60 days) and is
renewed only by the operator's own Cursor CLI use; after it expires the copy
is refused until the operator signs in again. The Cursor sidecar runs the CLI
from a root-owned copy under `/opt/tomverse-amux-v22/` (measured 2026-11-10,
Cursor 2026.11.05: a read-only install signs in with the cut-down copy).

Antigravity (`antigravity:<worker>`, from
`~/.gemini/antigravity-cli/antigravity-oauth-token` to
`<worker>/cli/antigravity/antigravity-oauth-token`, owner decision 2026-11-10)
keeps the refresh token, and drops only the account e-mail. Google's access
token lasts an hour, so a copy without it could not finish a Task. agy
refreshes inside the run home, and the operator's own login stays as it was
(measured on agy 1.5.4 with an expired copy). Google refresh tokens are not
rotated by a refresh. The refresh token stays with the CLI process: the
implement shell runs in the sidecar's jail, which has no run home.

Kimi (`kimi:<worker>`, from `~/.kimi/credentials/kimi-code.json` to
`<worker>/cli/kimi/kimi-code.json`, owner request 2026-11-28) keeps only
the access token: a Kimi refresh rotates the refresh token, so the copy's
refresh token is emptied and the CLI never refreshes it. A run gets the
access token as `KIMI_API_KEY` in its environment only (no OAuth reference in
its configuration and no sign-in file in its run home), and its bubblewrap
view has no `/proc` to read that environment back. The copy is refused
once `expires_at` has passed, so how long a Kimi Code access token lasts on
the box decides how often the stage timer must run.

The Kimi sidecar is off unless its unit sets `TOMVERSE_AMUX_V22_KIMI=enabled`.
It takes every role, implement by editing files and never with a shell
(owner request 2026-11-28): `--print` approves every tool call, its file tools
reach any absolute path, and Shell runs without a sandbox, so the whole CLI
runs inside the bubblewrap view below. Each run home holds an agent file
(`extend: default`, `tools` = ReadFile, Glob, Grep, plus WriteFile and
StrReplaceFile for implement) and an empty `--skills-dir`; the whole
configuration (Kimi Code platform, OAuth key `oauth/kimi-code`, the route's
model) comes from `--config`, so no user `config.toml` or hook is read. The
CLI runs only inside a bubblewrap view (network kept): `/usr`, only the
`/etc` files TLS and name resolution read (certificates, `resolv.conf`,
`hosts`, `nsswitch.conf`, `localtime`; the rest of `/etc` is empty), its own
install directory `/opt/tomverse-amux-v22/<dir>` (the CLI and its Python must
be installed there), the guard's node and script, the checkout (writable for
implement with its `.git` read-only, read-only otherwise), the checkout read-only and the run home; nothing else of the
box is visible, and where bwrap cannot start the CLI does not either. A
`PreToolUse` hook (`lib/amux/v22KimiToolGuard.mjs`) also blocks, before a tool
runs, any path that resolves outside the checkout (symlinks and a pattern's
fixed directories included) and logs each decision; a run with more tool
calls than logged decisions is refused. The
parser refuses any other tool, any undocumented argument and any path or path
pattern that is absolute outside the checkout, has `..`, `~` or a
backslash. A checkout with `.kimi/`, or with any symlink (`.git` included)
that is dangling or resolves outside the checkout, is refused before the CLI
starts, and again after the base sync. Kimi's stream-json carries no
usage, so the sidecar reads the session's `wire.jsonl` in the run home
(StatusUpdate `token_usage`, one step each) before the home is removed; a
run without exactly one readable session has unknown usage and does not
settle. No quota reading exists for Kimi yet (`/usage` is interactive only),
so the office card shows its row without a number.

Qwen (`qwen:<worker>`, from `~/.qwen/settings.json` to
`<worker>/cli/qwen/coding-plan-key`, owner request 2026-11-28) copies only
`env.BAILIAN_CODING_PLAN_API_KEY`, the Alibaba Cloud Coding Plan key that
`/auth` stores there (Qwen OAuth's free tier ended 2026-04-15). The key has
no expiry and reaches the CLI only as `OPENAI_API_KEY` in its environment,
with `OPENAI_BASE_URL` the plan's international endpoint
(`https://coding-intl.dashscope.aliyuncs.com/v1`; the China endpoint is out
of scope) and `--auth-type openai`. The Qwen sidecar is off unless its unit
sets `TOMVERSE_AMUX_V22_QWEN=enabled`. It takes every role, implement by
editing files and never with a shell (owner request 2026-11-28), and runs
whole inside the same bubblewrap view as Kimi (its install directory under
`/opt/tomverse-amux-v22/`, node from `/usr/bin`, the checkout writable for
implement only). A read role runs `--approval-mode plan --safe-mode
--extensions none --core-tools read_file glob grep_search`; implement runs
`--approval-mode auto-edit` with `edit` and `write_file` added; the prompt is
on stdin, `QWEN_HOME` in the run
home and `general.enableAutoUpdate: false`. Qwen's read tools resolve paths
with realpath and ask for one outside the workspace, and a headless run
refuses every ask. The parser refuses an `init` in another approval mode, any
other tool, a subagent's message, any path outside the checkout and a write
into its `.git`. A checkout with `.qwen/` or a symlink out of itself is
refused. Usage is the stream's `result.usage`; its input
includes cache reads, so cache reads are priced as input (Copilot's rule).
Qwen has no headless quota or model-list command yet.

Z.ai (`zai`, owner decision 2026-11-28) runs Claude Code against Z.ai's
Anthropic-compatible endpoint on the owner's GLM Coding Plan, which Z.ai
documents as a supported tool. It is off unless its unit sets
`TOMVERSE_AMUX_V22_ZAI=enabled`.

The run is a Claude run (Claude's arguments, tools, jailed shell and result),
so it implements as a Claude worker does. Its environment adds:

- `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, the global endpoint
  (open.bigmodel.cn is out of scope);
- `ANTHROPIC_AUTH_TOKEN` and `API_TIMEOUT_MS=3000000`;
- every model alias set to the route's GLM model;
- Claude Code's non-essential traffic and updater turned off.

The key is not staged from the operator's home. The operator puts it in
`<worker>/cli/zai/coding-plan-key`, owned by root and group-readable by the
worker. The sidecar refuses a link, any other owner or mode, and a malformed
key. The run passes Claude Code deny rules (`--disallowedTools`) for `Read` and
`Edit` on the worker's CLI directory (the key's), its home (unless the
checkout is inside it) and `/proc` (the CLI's environment holds the key);
Claude Code applies them before a file tool runs, and the jailed shell never
gets the key.

Each run gets a fresh `HOME` with an empty `CLAUDE_CONFIG_DIR` (removed after
the run), so no profile setting, hook or plugin of the worker's own applies to
a run that holds the key. A host with Claude Code managed settings
(`/etc/claude-code/managed-settings.json`) is refused. A checkout that
contains `.claude/settings.json` or `.claude/settings.local.json` is refused
too, because either file could point the endpoint elsewhere or add a hook.

Receipts are Claude Code's result counts recorded under `zai` (source
`zai_claude_result`) and settled as the selected model. Z.ai documents no
quota endpoint, so its quota stays unknown.

The Antigravity sidecar runs agy (a single Go binary) from a root-owned copy
under `/opt/tomverse-amux-v22/`, with `AGY_CLI_DISABLE_AUTO_UPDATE=true` (agy
ignores `1`). Each run home holds a custom agent (`amux-v22-read` or
`amux-v22-implement`) whose `tools` list is the role's tools. In agy 1.5.4
that list is the only limit applied before a tool runs: `search_web` ran
under a permission deny. Session `--settings` deny URL and MCP actions, and
for a read role commands and writes too. A checkout with `.agents/` or
`.gemini/` is refused before the CLI starts, and again after the base sync.
The file tools run in the CLI process, not in the jail. They stay inside the
workspace only in agy's default `request-review` mode: a read outside it
(absolute path, `../`, or a committed symlink, which agy resolves first)
asks, and print mode refuses the ask. This was measured on agy 1.5.4 with a
canary beside the sign-in copy, and all three reads were denied. The parser
therefore refuses a stream whose `init` reports any other `permission_mode`.
The Antigravity quota is `agy -p "/usage" --output-format json` (no model
turn, zero tokens). agy groups models: "Gemini Models" is Gemini Flash and
Pro, and Gemini 4 Argon has its own group with a weekly bucket only
(measured 2026-11-13). The sidecar reads the group named by
`TOMVERSE_AMUX_V22_ANTIGRAVITY_QUOTA_GROUP` (default "Gemini 4 Argon", the
model `antigravity-impl` runs); a panel without that group is
`quota_unavailable`, never another group's number.

The bridge asks its fixed worker socket at most every five minutes, after
renewing active execution leases. It forwards only the worker, provider,
remaining/confidence basis points, exhaustion, source, observed/reset times
and a new observation UUID. The app validates the v22 catalog, time window
and strict schema, serializes that UUID, and commits the observation and
existing canonical system audit together. A duplicate with identical facts
returns the original row; a different payload cannot replace it. Late
transaction commits remain subject to the existing DB deadline fence.
The canonical audit-chain lock precedes observation locks/inserts. The
bridge uses the existing fifteen-second lifecycle transport limit, covering
the normal app connection/transaction budget without an artificial five-
second cutoff; this is not a guarantee of the durable COMMIT phase.

A lost POST reply permits exact authenticated GET lookup only, never another
POST. A matching row resolves the outcome; absent/conflicting/unreadable
evidence stops new bridge assignments. An unavailable read is unknown, not
zero quota or invented availability. The existing fifteen-minute freshness
rule remains unchanged. Restarting a bridge makes a new provider observation,
not a replay of an old write or execution.

Boundary checklist: no Chat, Memory, finance or user-credit access; existing
AMUX sync identity/system actor only; no human approval is minted; fixed
numeric external data only, never model instructions; no product credential
in the sidecar/CLI; existing observation schema/single writer/90-day retention;
no LLM spend; existing stop/claim switches and worker exclusions remain;
UUID-bound exact lookup for uncertain writes; same vendor account usage
channel, no idea or repository transmission; canonical audit has identifiers
only; no geographic or data-processing expansion; synthetic checks then
review/CI before installation; existing Ubuntu sidecar/bridge split; app DB
and Admin remain authoritative. Publishing and deployment of Task results
are outside this repair.

## Local CLI flow (owner decision 2026-11-15)

A v22 one-shot run behaves like a local CLI session, always. The switch that
restored the earlier behaviour (`TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW=disabled`)
was removed on 2026-11-16 together with that behaviour; delete the variable
from Railway and from the box's sidecar and bridge unit drop-ins. Only the
risk-accepted read-only retry keeps its exact earlier launch. Source:
`lib/amux/v22LocalCliFlowCore.ts`; policy: `docs/policy/development-agent-orchestration.md`
"v22 worker 실행: 로컬 CLI 흐름".

What a worker gets:

- Every role (`design`, `implement`, `review`, `investigate`, and `verify`,
  which runs as investigate) has the jailed shell and can run tests: Claude
  `Read,Grep,Glob,Bash` (implement adds `Edit,Write`), Codex's workspace-write
  sandbox, Copilot's shell tools, Antigravity's `run_command`. The jail, the
  network block and the credential isolation are unchanged. Cursor keeps its
  read-only ask mode (its shell cannot be jailed); `operate` stays a person's
  step. A read role's checkout change is reported in its result and kept as a
  preserved patch, then the checkout goes back to its base; it is never
  published. Profiles still name roles and tools as before.
- Every role installs the checkout's locked dependencies (30 minutes); a
  failure is told to the worker and recorded in the result's `dependencies`.
- The brief, the owner's answer, the previous patch (already applied for
  implement), prior conclusions and review findings are files under
  `.amux/context/` in the checkout, kept out of Git by `.git/info/exclude`.
- No time limit: a run stops only at the operator's stop, or when it shows no
  sign of life for 3 hours: no new output, no checkout change and no CPU
  time used by the CLI's process tree (children and its process group
  included, read from `/proc/<pid>/stat`). A quiet test or build that uses CPU
  is never stopped; where `/proc` cannot be read, the first two signals
  decide. Its change and output are kept.

What the sidecar keeps in its state directory (mode 0600, beside the journal,
never in it): `<attempt>.transcript.jsonl` (the CLI's whole stdout; Claude
runs `--output-format stream-json --verbose`) and `<attempt>.preserved.patch`
(the diff of the change a stopped or failed run, or a read role, left). Both
are removed 30 days after they were written, when a later run starts. The
change itself is also a commit under `refs/amux-v22-preserved/<attempt>` in
the worker clone (an earlier run's leftovers under `leftover-<attempt>`,
taken before the base sync); recover one with
`git -C <worktree> diff HEAD refs/amux-v22-preserved/<name>`. Those refs are
not pruned yet. The app does not store transcripts yet.

Operator stop of a live run: send `{"op":"stop","attemptId":"<id>"}` on the
worker's sidecar socket as the bridge account, or `systemctl stop` the sidecar
unit (SIGTERM stops every live run the same way and writes its terminal
before the process exits; give the unit a `TimeoutStopSec` of at least 120 s).

Box rollout order: build and install the bridge binary and the sidecar bundle
from the same commit before the app release that carries this flow reaches
production. An earlier bridge refuses prompts over 64 KiB and does not review
a lower grade's kept contract change; an earlier sidecar refuses prompts over
32 KiB. Either way the content is never lost (the app keeps the result and
patch rows), but such runs go to a person until the box is updated.

## Box health signals and infrastructure failures (owner decision 2026-11-15)

The sign-in stage (`scripts/amux-v22-stage-auth.mjs`) and the Claude login
keepalive (`scripts/amux-v22-claude-login-keepalive.mjs`) now also write one
small file each next to the worker's sign-in copy:
`/var/lib/tomverse-amux-v22-<worker>/cli/amux-health-auth_stage.json` and
`amux-health-login_keepalive.json` (mode 0600, written atomically). A file
holds `version`, `source`, `signal` (`ok`, `auth_stage_failed`,
`relogin_soon`, `login_required`, `refresh_failed`, `login_missing`,
`login_unreadable`), `observedAt` and, for the keepalive,
`expiresAt` (the refresh token's expiry). Never a token. A failed write
leaves the round's outcome as it was; the journal line is still written.

The worker's sidecar answers a new `health` operation with those signals
(`lib/amux/v22WorkerHealthFile.mjs`), and the bridge forwards them every five
minutes, with the quota probe, to `/api/internal/amux/v22/worker-health`. An
old sidecar refuses the operation and an old bridge never asks; either way
nothing else changes. The app keeps the newest signal per worker and source
(`AmuxWorkerHealthSignal`), shows it on Admin › AMUX settings › Workers, and
raises `login_required`, `refresh_failed`, `auth_stage_failed` and
`relogin_soon` as an operational incident the first time each arrives.

The sidecar also adds the CLI's exit code and run time to an unreadable result
(`invalid_result`), and the bridge sends the sidecar's failure code with an
unverified settlement. The app classifies the run as an infrastructure
failure (no card attempt used, another worker first, the worker quarantined
after three in a row) or as the card's own; see
`docs/policy/development-agent-orchestration.md`, "v22 인프라 실패, 워커 격리,
멈춘 이유". Before the new bridge is installed the app still classifies a run
with no usage at all as `no_result` and a partial one as `usage_unreported`.

Installation (operator, after the app is deployed; nothing here changes
until it is):

1. Rebuild and install the bridge binary from `apps/tomverse-orchestrator`
   (`/usr/local/libexec/tomverse-wsl-bridge`), then restart each
   `tomverse-amux-bridge@<worker>`. Install the updated
   `scripts/systemd/tomverse-amux-bridge@.service` too (comment only; exit 3
   stays in `RestartPreventExitStatus`, exit 75 now restarts).
2. Rebuild and install the v22 sidecar bundle (it carries
   `lib/amux/v22OneShotSidecar.mjs`, `lib/amux/v22WorkerHealthFile.mjs` and
   `scripts/amux-v22-task-sidecar.mjs`), then restart each
   `tomverse-amux-v22-sidecar@<worker>`.
3. Install the updated `scripts/amux-v22-stage-auth.mjs` with its
   `lib/amux/v22WorkerHealthFile.mjs` where the stage timer runs it.
4. As the operator user, copy the updated
   `scripts/amux-v22-claude-login-keepalive.mjs` to
   `~/.local/lib/tomverse-amux-v22/` (it stays self-contained).
5. Check: `ls -l /var/lib/tomverse-amux-v22-<worker>/cli/amux-health-*.json`
   after the next stage or keepalive round, and the worker's row on Admin ›
   AMUX settings › Workers.

The change is always on: the `TOMVERSE_AMUX_INFRA_FAILURE_ROUTING` switch that
turned it off was removed on 2026-11-16, and the worker-health route no longer
answers 409 `disabled`.
