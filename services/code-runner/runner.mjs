// The Tomverse cloud Code runner (docs/ops/desktop-cloud-execution.md). A worker service with no inbound port: it
// asks the Tomverse server for queued cloud jobs, runs up to CODE_RUNNER_SLOTS of them at once, and reports each
// back. Its only credential is CODE_CLOUD_RUNNER_SECRET; a claim adds a token for that one job. Neither is ever given
// to a job's sandbox.
//
// Environment:
//   TOMVERSE_ORIGIN               the Tomverse server, e.g. https://tomverse.app (http only for a loopback host)
//   CODE_CLOUD_RUNNER_SECRET      the shared secret, the same value as on the server (at least 32 characters)
//   CODE_RUNNER_ID                a name for this runner in the job rows (default: runner-<random>)
//   CODE_RUNNER_SLOTS             jobs at once, 1 to 8 (default 1)
//   CODE_RUNNER_CLI_RUNTIME       the CLI engine module (default: the image's /cli/dist/runtime.js)
//   CODE_RUNNER_READONLY_PATHS    extra read-only folders for the sandbox, ":"-separated (the engine's dependencies)
//   CODE_RUNNER_WORK_ROOT         where job folders are made (default: the system temporary folder)
//   CODE_RUNNER_ALLOW_UNISOLATED  "true" only for local tests: run without a sandbox where none is available
import { randomUUID } from "node:crypto";
import { dirname, delimiter, join, resolve } from "node:path";
import { detectIsolation } from "./isolation.mjs";
import { runJob } from "./job.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function createServerClient({ origin, secret, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error("TOMVERSE_ORIGIN must be https (http only for a loopback host).");
  const headers = (token) => ({ authorization: `Bearer ${secret}`, ...(token ? { "x-tomverse-job-token": token } : {}) });
  const failure = (response, body) => Object.assign(new Error(body?.error ?? `HTTP ${response.status}`),
    { status: response.status, code: body?.error, dispatchState: body?.dispatchState });
  return {
    async post(body, token) {
      const response = await fetchImpl(new URL("/api/code/cloud/runner", url), {
        method: "POST", headers: { ...headers(token), "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.timeout(body.action === "model" ? 150_000 : 60_000),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw failure(response, json);
      return json;
    },
    async bundle(jobId, token) {
      const response = await fetchImpl(new URL(`/api/code/cloud/runner/bundle?job=${encodeURIComponent(jobId)}`, url), {
        headers: headers(token), redirect: "error", signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw failure(response, await response.json().catch(() => null));
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

const sleep = (ms, signal) => new Promise((done) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

/** The polling loop. Resolves when `signal` aborts and every running job has been reported. */
export async function serve({ env = process.env, signal, log = (line) => console.log(JSON.stringify({ event: "code_runner", line })), fetchImpl } = {}) {
  const secret = env.CODE_CLOUD_RUNNER_SECRET?.trim() ?? "";
  if (!env.TOMVERSE_ORIGIN || secret.length < 32) throw new Error("TOMVERSE_ORIGIN and CODE_CLOUD_RUNNER_SECRET (32+ characters) are required.");
  const isolation = env.CODE_RUNNER_FORCE_UNISOLATED === "true" ? { kind: "none", prlimit: false } : detectIsolation();
  if (isolation.kind === "none" && env.CODE_RUNNER_ALLOW_UNISOLATED !== "true")
    throw new Error("No sandbox is available on this machine (bubblewrap with user namespaces). Refusing to run jobs.");
  const here = import.meta.dirname;
  const cliRuntime = resolve(env.CODE_RUNNER_CLI_RUNTIME ?? "/cli/dist/runtime.js");
  const config = {
    isolation, cliRuntime, workerScript: join(here, "worker.mjs"), workRoot: env.CODE_RUNNER_WORK_ROOT,
    readOnlyPaths: [here, dirname(cliRuntime), ...(env.CODE_RUNNER_READONLY_PATHS ?? "").split(delimiter).filter(Boolean)],
  };
  const server = createServerClient({ origin: env.TOMVERSE_ORIGIN, secret, fetchImpl });
  const runnerId = (env.CODE_RUNNER_ID ?? `runner-${randomUUID().slice(0, 8)}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  const slots = Math.min(8, Math.max(1, Number.parseInt(env.CODE_RUNNER_SLOTS ?? "1", 10) || 1));
  const running = new Set();
  log(`runner ${runnerId} started: ${slots} slot(s), isolation ${isolation.kind}${isolation.prlimit ? " with prlimit" : ""}`);
  while (!signal?.aborted) {
    if (running.size >= slots) {
      await sleep(1_000, signal);
      continue;
    }
    let job = null;
    try {
      ({ job } = await server.post({ action: "claim", runnerId }));
    } catch (error) {
      log(`claim failed: ${error.code ?? error.message}`);
      await sleep(15_000, signal);
      continue;
    }
    if (!job) {
      await sleep(5_000, signal);
      continue;
    }
    log(`job ${job.jobId} claimed`);
    const task = runJob(job, { server, config: { ...config, signal }, log: (line) => log(`job ${job.jobId}: ${line}`) })
      .finally(() => { running.delete(task); log(`job ${job.jobId} reported`); });
    running.add(task);
  }
  await Promise.allSettled([...running]);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => controller.abort());
  serve({ signal: controller.signal }).catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
