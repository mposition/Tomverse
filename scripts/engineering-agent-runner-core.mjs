// The engineering agent runner's cycle (docs/policy/engineering-agent.md §12),
// with every side effect behind a port so the cycle can be read and tested
// without a network.
//
// The runner no longer writes code: coding is the AMUX v22 workers' and the
// idea lane's, and the Publisher opens their pull requests. What it still does
// is the round only it starts: register the runtime, read GitHub for an
// unbound pull request or branch under the agent's namespace (which halts
// everything), and trigger the app's read of its published pull requests'
// approvals and merges (§9-10). It then reports itself stopped, never ready
// for dispatch, so AMUX assigns it nothing.
//
// Imports: node builtins and the dependency-free core only (§8).

import { randomUUID } from "node:crypto";

import { parseEngineeringBranchName, prBodyCarriesMarker, reportedHalt } from "../lib/engineeringAgentCore.ts";

const requestKey = () => randomUUID().replace(/-/g, "");

/**
 * The halt the app reported, or `unknown` when it reported none it knows:
 * never `none` by default, because `none` is what lets a success signal out
 * (§12: no success signal while halted).
 */
export const haltOf = (json) => reportedHalt(json?.halt);

/**
 * What the runner observes on GitHub (§12): a branch under the agent's
 * namespace, or an open pull request on one or carrying a run marker, that
 * the app's records do not account for by content. `known` is the app's
 * current bindings (with the head each was verified at) and its consumed
 * capabilities (with the commit digest each allowed). A branch or pull request
 * passes only at a bound head, or at a commit whose object is exactly one a
 * consumed capability allowed -- the publisher's own, between its push and its
 * result. `commitDigestAt(sha)` is the sha256 of that commit's object, or null.
 */
export const observeUnbound = async ({ refs, pulls, known, commitDigestAt, refsComplete = true, pullsComplete = true }) => {
  // A list GitHub did not give whole -- no body (null) or a first page of more
  // -- is judged for what it holds; with nothing definite found, the round is
  // undetermined, never "none".
  let undetermined = refs === null || pulls === null || !refsComplete || !pullsComplete;
  refs = refs ?? [];
  pulls = pulls ?? [];
  const byNumber = new Map(known.bindings.map((binding) => [binding.prNumber, binding]));
  const boundRuns = new Set(known.bindings.map((binding) => binding.runId));
  // A commit a consumed capability allowed counts only for a run the app has
  // not bound yet -- the publisher's own write before its result. Once bound,
  // only the bound head is the run's. An object that cannot be read (or a
  // missing sha) is "undetermined" for that entry, never decided either way.
  const allowedCommit = async (runId, sha) => {
    if (boundRuns.has(runId)) return false;
    const digests = new Set(known.consumed.filter((row) => row.runId === runId).map((row) => row.commitDigest));
    if (digests.size === 0) return false;
    if (typeof sha !== "string") return "undetermined";
    const digest = await commitDigestAt(sha);
    if (digest === null) return "undetermined";
    return digests.has(digest);
  };
  // The whole list is read: a definite unbound entry is reported whatever
  // else could not be read; only when nothing definite was found does an
  // unread entry leave the observation undetermined.
  let unboundPr = false;
  let unboundRef = false;
  for (const pull of pulls) {
    const runId = parseEngineeringBranchName(pull.headRef ?? "");
    const binding = byNumber.get(pull.number);
    if (binding !== undefined) {
      // A bound pull request stays at the head it was verified at.
      if (!(binding.runId === runId && pull.headSha === binding.verifiedHeadSha)) unboundPr = true;
      continue;
    }
    const marked = runId !== null && prBodyCarriesMarker(pull.body ?? "", runId);
    const claimsToBeOurs = runId !== null || (pull.body ?? "").startsWith("<!-- engineering-agent");
    if (!claimsToBeOurs) continue;
    const allowed = marked ? await allowedCommit(runId, pull.headSha) : false;
    if (allowed === "undetermined") undetermined = true;
    else if (!allowed) unboundPr = true;
  }
  for (const { ref, sha } of refs) {
    const runId = parseEngineeringBranchName(ref);
    if (runId === null) {
      unboundRef = true;
      continue;
    }
    if (known.bindings.some((binding) => binding.runId === runId && binding.verifiedHeadSha === sha)) continue;
    const allowed = await allowedCommit(runId, sha);
    if (allowed === "undetermined") undetermined = true;
    else if (!allowed) unboundRef = true;
  }
  if (unboundPr) return "unbound_app_pr";
  if (unboundRef) return "unbound_app_ref";
  return undetermined ? "undetermined" : "none";
};

const knownShape = (json) => Array.isArray(json?.bindings) && Array.isArray(json?.consumed);

/**
 * One cycle. `ports`:
 *   app(path, body) -> { status, json }          the engineering routes
 *   namespace() -> { refs: [{ ref, sha }] | null, pulls: [{ number, headRef, headSha, body }] | null,
 *                    refsComplete, pullsComplete }
 *                                                 GitHub, read-only; unread is null, a partial page is incomplete
 *   commitDigestAt(sha) -> sha256 of the commit object, or null
 * Returns { finishedNormally, halt, reason } for the dead-man signal.
 */
export async function runRunnerCycle(ports) {
  const instanceId = randomUUID();
  const registered = await ports.app("worker/register", { requestKey: requestKey(), instanceId });
  if (registered.status !== 200 || registered.json?.registered !== true) {
    return { finishedNormally: registered.json?.refused === "adapter_closed", halt: "none", reason: "not_registered" };
  }
  const lease = { instanceId, generation: registered.json.generation };

  // The observation comes first and every round: an unbound pull request or
  // branch halts everything, and is recorded before anything starts.
  // The app's records are read on both sides of GitHub's, and judged only if
  // they did not move between: a publish that lands in the gap is not taken
  // for an unbound branch.
  const known = await ports.app("observe/known", {});
  if (known.status !== 200 || !knownShape(known.json)) {
    return { finishedNormally: false, halt: "unknown", reason: "observation_unreadable" };
  }
  const namespace = await ports.namespace();
  const knownAfter = await ports.app("observe/known", {});
  if (knownAfter.status !== 200 || JSON.stringify(knownAfter.json) !== JSON.stringify(known.json)) {
    return { finishedNormally: false, halt: "unknown", reason: "observation_raced" };
  }
  const observed = await observeUnbound({ ...namespace, known: known.json, commitDigestAt: ports.commitDigestAt });
  if (observed === "undetermined") {
    // Like a raced reading: nothing is recorded, and the round is not healthy.
    return { finishedNormally: false, halt: "unknown", reason: "observation_undetermined" };
  }
  if (observed !== "none") {
    const recorded = await ports.app("observe/halt", { halt: observed });
    return { finishedNormally: recorded.status === 200, halt: observed, reason: "observed_unbound" };
  }

  // The app reads its published pull requests' approvals and merges itself
  // (§9-10); the runner only triggers the round. A failed round decides
  // nothing and is repeated next cycle, so it does not stop this one.
  await ports.app("observe/pull-requests", {});

  // Never ready for dispatch: the runner takes no work.
  const stopped = await ports.app("worker/heartbeat", { ...lease, status: "stopped", dispatchReady: false });
  if (stopped.status !== 200 || stopped.json?.accepted !== true) {
    return { finishedNormally: false, halt: "unknown", reason: "runtime_lease_lost" };
  }
  return { finishedNormally: true, halt: haltOf(stopped.json), reason: "observed" };
}
