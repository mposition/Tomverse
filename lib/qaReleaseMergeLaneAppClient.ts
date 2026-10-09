/**
 * The merge lane service's port to the app (docs/policy/qa-release-agent.md
 * version 4, section 3): the state read and the three calls that write --
 * instruction, consume, report -- each to its one fixed URL, with the lane's
 * secret and the operator control revision.
 *
 * Only an answer the route can give is an answer: 200 with the expected body,
 * or 409 with a refusal. Anything else -- a 5xx, `deadline_passed`, a body of
 * the wrong shape, a network error -- is thrown, and the round reads it as
 * unknown and does not retry (section 3).
 */
import { assertQaReleaseMergeLaneEndpoint, qaReleaseMergeLaneEndpoint, type QaReleaseMergeLaneCall } from "./qaReleaseDigestEndpointCore.ts";
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";
import type { QaReleaseMergeLanePorts, QaReleaseLaneState } from "./qaReleaseMergeLaneServiceCore.ts";
import { QA_RELEASE_CONTROL_REVISION_HEADER } from "./qaReleaseRouteAuthCore.ts";

type Json = Record<string, unknown>;
const SHA = /^[0-9a-f]{40}$/;
const OPEN_STATES = new Set(["issued", "consumed", "awaiting_deploy"]);

const record = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("app_shape");
  return value as Json;
};
const finite = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("app_shape");
  return value;
};

function stateOf(body: Json): QaReleaseLaneState {
  if (typeof body.latched !== "boolean") throw new Error("app_shape");
  const open = body.openAttempt;
  if (open === null) return { dbNowMs: finite(body.dbNowMs), latched: body.latched, openAttempt: null };
  const attempt = record(open);
  const state = attempt.state;
  const number = attempt.pullRequestNumber;
  if (typeof attempt.id !== "string" || attempt.id.length === 0 || typeof state !== "string" || !OPEN_STATES.has(state)) throw new Error("app_shape");
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error("app_shape");
  if (typeof attempt.headSha !== "string" || !SHA.test(attempt.headSha)) throw new Error("app_shape");
  const merge = attempt.mergeCommitSha;
  if (merge !== null && (typeof merge !== "string" || !SHA.test(merge))) throw new Error("app_shape");
  // An attempt awaiting deploy always carries its merge commit (the DB sets it on that move).
  if (state === "awaiting_deploy" && merge === null) throw new Error("app_shape");
  return {
    dbNowMs: finite(body.dbNowMs),
    latched: body.latched,
    openAttempt: {
      id: attempt.id,
      state: state as "issued" | "consumed" | "awaiting_deploy",
      pullRequestNumber: number,
      headSha: attempt.headSha,
      mergeCommitSha: merge,
      issuedAtMs: finite(attempt.issuedAtMs),
      mergeNotBeforeMs: finite(attempt.mergeNotBeforeMs),
    },
  };
}

export function createQaReleaseMergeLaneAppPorts(input: {
  http: QaReleaseHttp;
  env: Readonly<Record<string, string | undefined>>;
}): QaReleaseMergeLanePorts["app"] {
  const call = async (name: QaReleaseMergeLaneCall, body: Json) => {
    const url = qaReleaseMergeLaneEndpoint({ ...input.env }, name);
    assertQaReleaseMergeLaneEndpoint(url, name);
    const response = await input.http({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.env.QA_RELEASE_MERGE_LANE_SECRET ?? ""}`,
        [QA_RELEASE_CONTROL_REVISION_HEADER]: (input.env.QA_RELEASE_CONTROL_REVISION ?? "").trim(),
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200 && response.status !== 409) throw new Error(`app_${response.status}`);
    let parsed: Json;
    try {
      parsed = record(JSON.parse(response.text));
    } catch {
      throw new Error("app_shape");
    }
    return { status: response.status, body: parsed };
  };
  const reason = (body: Json) => (typeof body.reason === "string" ? body.reason : "unknown");

  return {
    async readState() {
      const answer = await call("state", {});
      if (answer.status !== 200) throw new Error("app_409");
      return stateOf(answer.body);
    },
    async issue(pullRequest) {
      const answer = await call("instruction", { pullRequestNumber: pullRequest.pullRequestNumber, headSha: pullRequest.headSha });
      if (answer.status === 409 && answer.body.issued === false) return { issued: false, reason: reason(answer.body) };
      if (answer.status === 200 && answer.body.issued === true && typeof answer.body.attemptId === "string" && answer.body.attemptId.length > 0) {
        return { issued: true, attemptId: answer.body.attemptId };
      }
      throw new Error("app_shape");
    },
    async consume(request) {
      const answer = await call("consume", { ...request });
      if (answer.status === 200 && answer.body.consumed === true) return { consumed: true };
      if (answer.status === 409 && answer.body.consumed === false) return { consumed: false, reason: reason(answer.body) };
      throw new Error("app_shape");
    },
    async report(attemptId, report) {
      const answer = await call("report", { attemptId, report });
      if (answer.status === 200 && answer.body.recorded === true) return { recorded: true };
      if (answer.status === 409 && answer.body.recorded === false) return { recorded: false, reason: reason(answer.body) };
      throw new Error("app_shape");
    },
  };
}
