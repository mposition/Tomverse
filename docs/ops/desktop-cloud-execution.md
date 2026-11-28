# Tomverse Desktop: cloud execution and managed credits

Status (2026-11-28): **built, off by default, not deployed.** A Desktop Code task can run on a Tomverse runner service
instead of the person's computer. The server routes, the job table, the runner service and the Desktop screen exist and
are tested locally end to end with a fake model. No runner is deployed: creating the runner service is paid
infrastructure and needs the operator. Until a runner runs and the switch below is on, Desktop shows the cloud location
as not offered.

## How a cloud task runs

1. **Snapshot (Desktop).** The main process makes a git bundle of the open project's tracked files as they are now:
   HEAD's tree with the working copy's changes to tracked files, minus files that look like credentials (the CLI's own
   `isSecretPath` list), as one commit with no parent. Untracked and ignored files and the history are not in it.
   Nothing in the person's repository changes (a temporary index and object folder with the repository's objects as
   alternates; `apps/desktop/src/host/cloud-bundle.ts`). At most 8 MiB, under the 10 MB request body the server's
   proxy buffers.
2. **Create and upload (Desktop to server).** `POST /api/code/cloud` `create` with the instruction, the two models from
   the coding catalogue, the credit cap the person approved and the bundle's size, SHA-256 and commit; then
   `PUT /api/code/cloud/bundle?job=` with exactly those bytes. Both are idempotent. The bundle goes to object storage
   (`code-cloud/<job>/bundle`, the same R2 bucket as attachments and generated files) and the job is `queued`.
3. **Claim (runner to server).** The runner polls `POST /api/code/cloud/runner` `claim` with the runner secret. The
   server takes the oldest queued job, **reserves the credits on the managed Code path** (`handleCodeManaged` `reserve`
   with the job id as the task id, the approved cap, and the two pinned models) and answers with a per-claim job token.
   A queued job holds no credits; a refused reservation fails the job with the managed refusal code.
4. **Run (runner).** The runner fetches the bundle with the job token, checks its size and digest, fetches it into a
   pristine bare repository (never mounted in the sandbox) and into the agent's working copy, and starts the Tomverse
   CLI engine (`apps/tomverse-cli/src/runtime.ts`) in a sandbox. The engine's model endpoint is a local socket: each of
   its Chat Completions requests becomes one managed `complete` call (a structured "assistant turn": text and tool
   calls), sent to `POST /api/code/cloud/runner` `model`. The server forwards it with the job owner's id, the job's
   reservation and the reservation's executor model; the runner can name none of them. The socket treats an
   `Idempotency-Key` as the coding API does (`services/code-runner/model-adapter.mjs`): one key is one managed call with
   one call id. Another request with the key makes no second call while the first is in flight or its outcome is
   unknown (409 `idempotent_request_in_progress`), gets the stored answer once it completed, and with another body is
   refused (422 `idempotency_key_reused`). Only a refusal before dispatch frees the key, and the retry keeps the call id,
   so the managed path refuses it as already dispatched if that call was recorded after all.
5. **Report.** Every 15 seconds the runner sends new progress lines (`heartbeat`); the server extends the claim, keeps
   the reservation alive (managed `heartbeat`) and answers whether the person asked to stop, whether the reservation
   ended and whether the hour is up.
6. **Finish.** The runner computes the patch against the snapshot commit from the pristine repository (system and
   global git configuration ignored, no hooks, no external diff or text conversion), sends `finish` with the outcome,
   a summary and the patch (at most 6 MiB), and deletes the job folder. The server stores the patch
   (`code-cloud/<job>/result.patch`), **releases the reservation** (unused credits returned), and deletes the bundle.
7. **Review and apply (Desktop).** The person opens the task, reads its files and hunks (parsed with the review panel's
   own `parseUnifiedDiff`; `git apply --check` says whether it still fits the folder) and applies it to the same folder.
   A patch with any change the panel cannot show (a binary or too large file, a name it cannot read, more files than
   it lists, or a header such as a mode change, a symbolic link or a rename) is not offered for applying.
   It becomes uncommitted changes, which the review panel shows and can revert. Nothing is pushed from the cloud.
   Desktop records the folder a task started from before creating it (`apps/desktop/src/host/cloud-origins.ts`: a hash
   of the folder's real path and file-system identity, by task id, in the app's data folder), so the check survives a
   restart or a new sign-in. Reviewing and applying both need the open folder to be that origin, and applying also
   needs it to be the folder the review was made in. A task this computer has no origin for (started on another
   computer or before origins were recorded) is neither reviewed nor applied: `git apply --check` only shows the
   content fits, not that the folder is the one the task came from.

States: `uploading`, `queued`, `starting` (claimed, reserving), `running`, `completed`, `failed`, `cancelled`. Desktop
reads them by polling every three seconds while a task is active.

## Money

- Model calls: the managed Code reservation and settlement, unchanged (`lib/codeManagedService.ts`,
  `docs/policy/code-task-cost-guardrails.md`). The person's approved credits are the cap; each call is reserved from its
  prompt bytes and the model's output bound and settled from the provider's verified usage; release returns the rest.
  A call whose outcome is unknown keeps its hold, exactly as on the managed path.
- Compute time on the runner: **not charged.** There is no compute price and no credit weight for it. This is a
  feature that is off, not a price of zero; a compute price needs an operator decision and touches pricing and credits.
- Concurrency: a cloud job counts against the managed path's per-account task limit (`CODE_USER_CONCURRENT_TASKS`,
  default 8) from creation, and its reservation counts against it while it runs (`docs/policy/code-concurrency.md`).

## Isolation (as built; services/code-runner/README.md)

Under bubblewrap each job has its own user, PID, mount, IPC, UTS and network namespaces: an empty environment (the runner
secret and the job token stay in the supervisor), no network but loopback (the model adapter is a Unix socket bound
in), read-only system folders and engine, and only the working copy, a home and an io folder writable. prlimit bounds
CPU seconds, file size, open files and processes per process; the supervisor bounds wall-clock time (one hour) and the
engine's heap. The runner refuses to start where it cannot create the namespaces.

Not bounded per job: memory of commands the agent runs and total disk use (they need cgroups, which an unprivileged
container does not get; the container's limits bound all jobs together). Commands have no network, so installing
dependencies fails unless they are in the repository. The Windows and macOS development runner has no sandbox and runs
only with `CODE_RUNNER_ALLOW_UNISOLATED=true`, which only local tests set.

## Data

`CodeCloudJob` (`docs/policy/tomverse-chat-data-domain-registry.yaml`, `lib/accountDataExportDomains.ts`): the
instruction, models, cap, states, up to 400 progress lines, a summary, and the object keys. The bundle is deleted when the
job ends; the row and its patch are deleted seven days after the job ends by the fifteen-minute maintenance sweep
(`sweepCodeCloudJobsQuietly`, which also ends jobs whose runner stopped reporting and fails uploads and queue waits that
ran out). Account deletion deletes the rows and queues both object keys of every job on the shared object cleanup queue
(`lib/codeCloudDeletion.ts`). Bundles and patches are written only while their job row is locked, so a deletion
that starts during a write waits for it and its tombstones always follow the object. As a backstop for any write
that outlives its transaction or any failed delete, the same sweep removes objects under `code-cloud/` older than one
hour whose job row no longer exists. The account export includes the job rows without the token digest, runner name, storage
keys and reservation link.

## Switches and variables

| Where | Variable | Default | Effect |
| --- | --- | --- | --- |
| Server | `TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED` | off | Cloud jobs and the `desktopCloudExecution` capability. Also needs `TOMVERSE_DESKTOP_AUTH_ENABLED`, `TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED`, `CODE_MANAGED_EXECUTION_ENABLED` and the secret below (`lib/desktopCloudExecutionSwitch.ts`). |
| Server | `CODE_CLOUD_RUNNER_SECRET` | unset | The runner's shared secret, 32 or more characters. Unset keeps the feature off. |
| Runner | `TOMVERSE_ORIGIN`, `CODE_CLOUD_RUNNER_SECRET` | unset | The server address and the same secret. |
| Runner | `CODE_RUNNER_SLOTS` | 1 | Jobs at once per runner, 1 to 8. |
| Desktop | none | | The cloud location and the Cloud tasks section appear only when the server names `desktopCloudExecution`. |

The managed credits screen (`TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED`, below) is separate and not needed for cloud tasks.

Authentication: Desktop reaches the job routes with the account settings session, as billing and the managed screen do;
no Desktop bearer route was added. The runner route is bearer-only (runner secret plus job token) and is the one path
added to the mutation-Origin exemption (`lib/requestOrigin.ts`); `tests/codeCloudBoundary.test.mjs` pins that it reads
no session or cookie.

## Deploying a runner (operator; not done)

- **Service:** build `services/code-runner/Dockerfile` from the repository root and run it as a worker with no public
  port. The host must allow unprivileged user namespaces for bubblewrap; the runner checks at start and refuses to run
  jobs otherwise. Whether Railway's container runtime allows them is not verified; if it does not, a VM-based host is
  needed.
- **Variables:** runner `TOMVERSE_ORIGIN`, `CODE_CLOUD_RUNNER_SECRET`, optionally `CODE_RUNNER_SLOTS`; server
  `CODE_CLOUD_RUNNER_SECRET` (same value) and `TOMVERSE_DESKTOP_CLOUD_EXECUTION_ENABLED=true`.
- **Migration:** `20261128080000_desktop_cloud_execution` (one new table).
- **Expected cost factors:** the runner's CPU and memory while jobs run (a job can use a full core and about 2 GB for an
  hour), its disk for working copies, egress of bundles and patches between the server, R2 and the runner, and R2
  storage for seven days of patches. Model calls are charged to the person through the reservation as on the managed
  path, and are a provider cost to Tomverse like any managed call.

## Managed credits screen (unchanged, separate)

Desktop > Settings > Execution and limits > **Cloud and managed credits** also has the managed credits screen, visible
only when the server reports `desktopManagedCode` (`TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED` plus the account settings and
managed switches). It holds and releases a reservation by hand and calls no model; nothing in it runs a task. It is
covered by `apps/desktop/tests/managedCode*.test.ts` and `tests/desktopManagedCodeSwitch.test.mjs`.

## Decisions the operator needs to make

1. Where to run the runner (Railway service or a VM that allows user namespaces), how many, and the monthly spend
   ceiling for it. This is paid infrastructure; nothing here creates it.
2. A compute-time price and credit weight, or keeping compute free while the feature is small. Pricing and credits.
3. Whether seven days is the right retention for cloud task records and patches.
4. Whether commands in a cloud task may reach package registries (today: no network at all, so `npm install` fails).
5. Whether the 8 MiB bundle limit (raising it means a chunked upload or a larger proxy body buffer) and the one-hour
   run limit fit the first users.

## Verification that ran locally (2026-11-28)

- `tests/integration/code-cloud-execution.db.test.mjs` on a migrated throwaway PostgreSQL: job lifecycle over the real
  managed reservation and credit ledger (provider and catalogue faked), refused reservations, stop, runner lost, the
  per-account limit, retention and account deletion.
- `services/code-runner/tests/runner.integration.test.mjs`: the runner with a fake server and a scripted model, a real
  git bundle and the real CLI engine; the patch applies to the original folder; stop during a running command; a
  mismatched bundle. Unsandboxed on Windows; the bubblewrap command is covered by `runner.unit.test.mjs` only.
- `apps/desktop/tests/cloudBundle.test.ts`, `cloudExecution.test.ts`; `tests/codeCloudBoundary.test.mjs`.

Not verified: a runner under bubblewrap on Linux, Railway's support for it, a real model through the managed path,
R2 reads and writes of bundles and patches, and the Desktop screen against a real server.
