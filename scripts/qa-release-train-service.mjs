// The QA-release train service's entry point (docs/policy/qa-release-agent.md
// section 8 item 12). Railway runs it on cron `*/10 * * * *` UTC with
// `node --experimental-strip-types scripts/qa-release-train-service.mjs`
// (never through npm, which adds variables the start check refuses). It is its
// own service since 2026-10-22, so a train failure never stops the develop
// lane.
//
// It holds the lane's app secret, the GitHub App id and key, the operator
// control revision, its enable flag, its departure hours and, for the model
// conflict resolver (off unless QA_RELEASE_TRAIN_MODEL_RESOLVE is "true"), its
// own Anthropic key -- nothing else.
// All decisions are in lib/qaReleaseTrainService.ts; this file only connects
// the ports. The output is the outcome and a short failure code -- never a
// header, a token, a key or a body.

import { qaReleaseInstallationToken } from "../lib/qaReleaseMergeLaneGithub.ts";
import { createQaReleaseTrainAppPorts, createQaReleaseTrainGitPorts, createQaReleaseTrainGithubPorts } from "../lib/qaReleaseTrainPorts.ts";
import { createQaReleaseTrainResolver } from "../lib/qaReleaseTrainResolve.ts";
import { runQaReleaseTrainRound } from "../lib/qaReleaseTrainService.ts";

// The app routes budget each call at 50 s; this side waits a little longer.
const APP_TIMEOUT_MS = 55_000;
const READ_TIMEOUT_MS = 30_000;
// One model call resolving one pick's conflict hunks.
const MODEL_TIMEOUT_MS = 4 * 60 * 1000;

// Railway's cron does not stop a run on its own: the service stops itself,
// inside the 30-minute cron interval (model calls can take minutes each).
const HARD_TIMEOUT_MS = 25 * 60 * 1000;
const supervisor = setTimeout(() => {
  console.log(JSON.stringify({ exitCode: 1, train: "hard_timeout" }));
  process.exit(1);
}, HARD_TIMEOUT_MS);

const httpWith = (timeoutMs) => async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
};

const env = process.env;
// A PEM pasted into a single-line variable arrives with literal "\n".
const privateKey = (env.QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY ?? "").includes("\n")
  ? env.QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY ?? ""
  : (env.QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY ?? "").replaceAll("\\n", "\n");

const readHttp = httpWith(READ_TIMEOUT_MS);
const token = qaReleaseInstallationToken(readHttp, (env.QA_RELEASE_MERGE_LANE_APP_ID ?? "").trim(), privateKey, Date.now);
const apiKey = (env.QA_RELEASE_TRAIN_ANTHROPIC_API_KEY ?? "").trim();
const resolve =
  (env.QA_RELEASE_TRAIN_MODEL_RESOLVE ?? "").trim() === "true" && apiKey !== ""
    ? createQaReleaseTrainResolver({ http: httpWith(MODEL_TIMEOUT_MS), apiKey })
    : undefined;
const git = createQaReleaseTrainGitPorts({ token, resolve });
const train = await runQaReleaseTrainRound(
  env,
  {
    github: createQaReleaseTrainGithubPorts({ http: readHttp, token }),
    git,
    app: createQaReleaseTrainAppPorts({ http: httpWith(APP_TIMEOUT_MS), env }),
  },
  Date.now(),
).finally(() => git.cleanup().catch(() => {}));

clearTimeout(supervisor);
console.log(JSON.stringify(train));
process.exitCode = train.exitCode;
