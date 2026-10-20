// The QA-release merge lane service's entry point (docs/policy/qa-release-agent.md
// version 4, sections 3 and 8). Railway runs it on cron `*/10 * * * *` UTC with
// `node --experimental-strip-types scripts/qa-release-merge-lane-service.mjs`
// (never through npm, which adds variables the start check refuses) and
// force-stops it at the 10-minute hard timeout.
//
// It holds the lane's secret, the GitHub App id and key, the Railway read token
// for dev (the environment that deploys develop), the operator control revision, the enable flag and the kill
// switch -- nothing else. All decisions are in
// lib/qaReleaseMergeLaneServiceCore.ts; this file only connects the ports.
// Every request follows no redirect and times out. The output is the outcome
// code -- never a header, a token, a key or a body.

import { createQaReleaseMergeLaneAppPorts } from "../lib/qaReleaseMergeLaneAppClient.ts";
import { createQaReleaseGithubPorts, qaReleaseInstallationToken } from "../lib/qaReleaseMergeLaneGithub.ts";
import { createQaReleaseRailwayPorts } from "../lib/qaReleaseMergeLaneRailway.ts";
import { runQaReleaseMergeLaneRound } from "../lib/qaReleaseMergeLaneServiceCore.ts";
import { createQaReleaseTrainAppPorts, createQaReleaseTrainGitPorts, createQaReleaseTrainGithubPorts } from "../lib/qaReleaseTrainPorts.ts";
import { runQaReleaseTrainRound } from "../lib/qaReleaseTrainService.ts";
import { createQaReleaseCiAdmissionGithubPorts } from "../lib/qaReleaseCiAdmissionPorts.ts";
import { runQaReleaseCiAdmissionRound } from "../lib/qaReleaseCiAdmissionService.ts";

// The app routes budget each call at 50 s (lib/qaReleaseMergeLaneRoutes.ts);
// this side waits a little longer so it never aborts a call the route still
// considers in budget. GitHub and Railway reads get the digest's 30 s.
const APP_TIMEOUT_MS = 55_000;
const READ_TIMEOUT_MS = 30_000;

// Policy section 10: the whole round is bounded at 10 minutes. Railway's cron
// does not stop a run on its own, so the service stops itself: the twelve-
// minute silence rule (section 8 item 5) is safe only because no round lives
// past this. A round stopped mid-call leaves its attempt to that rule.
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const STARTED_AT_MS = Date.now();
// CI admission (section 8 item 13) polls until this point, well inside the
// hard timeout, so its last poll never races the supervisor.
const ADMISSION_DEADLINE_MS = STARTED_AT_MS + 8.5 * 60 * 1000;
const supervisor = setTimeout(() => {
  console.log(JSON.stringify({ exitCode: 1, outcome: "hard_timeout" }));
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
const result = await runQaReleaseMergeLaneRound(env, {
  app: createQaReleaseMergeLaneAppPorts({ http: httpWith(APP_TIMEOUT_MS), env }),
  github: createQaReleaseGithubPorts({ http: readHttp, token }),
  railway: createQaReleaseRailwayPorts({ http: readHttp, token: env.QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN ?? "" }),
});
console.log(JSON.stringify(result));

// The release train (policy section 8 item 12) runs after the develop round,
// on its own switch, so it can run while the develop lane is off.
const git = createQaReleaseTrainGitPorts({ token });
const train = await runQaReleaseTrainRound(
  env,
  {
    github: createQaReleaseTrainGithubPorts({ http: readHttp, token }),
    git,
    app: createQaReleaseTrainAppPorts({ http: httpWith(APP_TIMEOUT_MS), env }),
  },
  Date.now(),
).finally(() => git.cleanup().catch(() => {}));

console.log(JSON.stringify(train));

// CI admission (policy section 8 item 13) runs last, on its own mode, for the
// rest of this run: it polls once a minute and, in `on` mode, marks the head
// of the `ci:queued` line ready for review when runners have room.
const admission = await runQaReleaseCiAdmissionRound(
  env,
  {
    github: createQaReleaseCiAdmissionGithubPorts({ http: readHttp, token }),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (entry) => console.log(JSON.stringify(entry)),
  },
  ADMISSION_DEADLINE_MS,
);

clearTimeout(supervisor);
console.log(JSON.stringify(admission));
process.exitCode = Math.max(result.exitCode, train.exitCode, admission.exitCode);
