# Tomverse cloud Code runner

Runs Desktop cloud Code tasks (docs/ops/desktop-cloud-execution.md). A worker with no inbound port: it asks the
Tomverse server for queued jobs over `POST /api/code/cloud/runner`, runs each one with the Tomverse CLI engine
(`apps/tomverse-cli/src/runtime.ts`) in a sandbox, and reports the outcome and a patch. It never pushes, never holds a
person's credentials, and never chooses a model or a price: every model call is one managed Code call the server makes
for the job's credit reservation.

## Files

| File | What it does |
| --- | --- |
| `runner.mjs` | Entry. Polls for jobs, runs up to `CODE_RUNNER_SLOTS` at once, stops claiming on SIGTERM and reports running jobs as stopped. |
| `job.mjs` | One job: bundle, checkout, model adapter, sandboxed worker, heartbeats, patch, report. |
| `worker.mjs` | Runs inside the sandbox: the CLI engine on the working copy, talking only to the adapter socket. |
| `model-adapter.mjs` | Answers the CLI's Chat Completions requests on a local socket by turning each into one structured managed call. |
| `isolation.mjs` | The bubblewrap and prlimit command for a job. |

Only Node built-ins; the CLI engine brings its own pinned dependencies (`Dockerfile`).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `TOMVERSE_ORIGIN` | yes | The Tomverse server, for example `https://tomverse.app`. https only, except a loopback host. |
| `CODE_CLOUD_RUNNER_SECRET` | yes | The same value as the server's `CODE_CLOUD_RUNNER_SECRET`, at least 32 characters. |
| `CODE_RUNNER_ID` | no | Name of this runner in job rows. |
| `CODE_RUNNER_SLOTS` | no | Jobs at once, 1 to 8 (default 1). |
| `CODE_RUNNER_WORK_ROOT` | no | Where job folders are made. |
| `CODE_RUNNER_ALLOW_UNISOLATED` | tests only | Lets the runner start where no sandbox is available. Never set in the image. |

## Isolation, as built

Under bubblewrap each job has its own user, PID, mount, IPC, UTS and network namespaces. The environment is empty
(`--clearenv`; the runner secret and job token stay in the supervisor), there is no network interface but loopback
(the model adapter is a Unix socket bound into the sandbox), system folders and the engine are read-only, and only the
job's working copy, home and io folder are writable. The pristine repository the patch is computed from is never
mounted. prlimit bounds CPU seconds, file size, open files and processes per process; the supervisor bounds wall-clock
time (one hour) and the engine's heap.

Not bounded per job: memory of commands the agent runs and total disk use. Those need cgroups, which an unprivileged
container does not get; the container's own memory and disk limits bound all jobs together. Commands have no network,
so `npm install` and similar fail unless the dependencies are in the repository.

## Local test

```
cd services/code-runner
node --import tsx --test --test-concurrency=1 tests/runner.unit.test.mjs tests/runner.integration.test.mjs
```

The integration test starts a fake Tomverse server with a scripted model, a real git bundle and the real CLI engine,
and checks the patch applies to the original folder. Without bubblewrap (Windows, macOS) it runs the worker
unsandboxed; the sandbox command itself is covered by the unit test, and running under bubblewrap needs a Linux host.
