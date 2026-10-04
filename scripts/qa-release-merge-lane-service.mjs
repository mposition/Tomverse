// The QA-release merge lane service's entry point (docs/policy/qa-release-agent.md
// version 4, sections 3 and 8). Railway runs it on cron `*/10 * * * *` UTC with
// `node --experimental-strip-types scripts/qa-release-merge-lane-service.mjs`
// (never through npm, which adds variables the start check refuses) and
// force-stops it at the 10-minute hard timeout.
//
// It holds the lane's secret, the GitHub App id and key, the Railway read token
// for staging, the operator control revision, the enable flag and the kill
// switch -- nothing else. All decisions are in
// lib/qaReleaseMergeLaneServiceCore.ts; this file only connects the ports.
// Every request follows no redirect and times out. The output is the outcome
// code -- never a header, a token, a key or a body.

import { createQaReleaseMergeLaneAppPorts } from "../lib/qaReleaseMergeLaneAppClient.ts";
import { createQaReleaseGithubPorts, qaReleaseInstallationToken } from "../lib/qaReleaseMergeLaneGithub.ts";
import { createQaReleaseRailwayPorts } from "../lib/qaReleaseMergeLaneRailway.ts";
import { runQaReleaseMergeLaneRound } from "../lib/qaReleaseMergeLaneServiceCore.ts";

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
const result = await runQaReleaseMergeLaneRound(env, {
  app: createQaReleaseMergeLaneAppPorts({ http: httpWith(APP_TIMEOUT_MS), env }),
  github: createQaReleaseGithubPorts({
    http: readHttp,
    token: qaReleaseInstallationToken(readHttp, (env.QA_RELEASE_MERGE_LANE_APP_ID ?? "").trim(), privateKey, Date.now),
  }),
  railway: createQaReleaseRailwayPorts({ http: readHttp, token: env.QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN ?? "" }),
});

clearTimeout(supervisor);
console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
