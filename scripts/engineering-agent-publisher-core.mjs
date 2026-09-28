// The engineering agent publisher's work cycle (docs/policy/engineering-agent.md
// §7-2, §8-§10), with every side effect behind a port so the cycle can be read
// and tested without GitHub, a clone or a network.
//
// One cycle: claim the next publish item, or stop, having none. A lookup claim
// only reads GitHub and reports what it found. A write claim rebuilds the
// commit the capability describes from a fresh clone, refuses on any
// difference, asks the app's last look, pushes to a branch that must not yet
// exist, opens the PR with the fixed template, and reports the result with
// the binding snapshot. The app decides every tier and every permission; the
// publisher's own checks can only refuse (§9-7).
//
// An answer this service does not know is never guessed: it reports nothing
// and the claim's lease passes into a lookup (§10). It never retries a write,
// never deletes a branch and never merges.
//
// Imports: node builtins and the dependency-free core only (§8).

import { createHash, randomUUID } from "node:crypto";

import {
  ENGINEERING_AGENT_COMMIT_IDENTITY,
  expectedCommitObject,
  prBodyCarriesMarker,
  prBodyMarker,
} from "../lib/engineeringAgentCore.ts";
import { detectSecrets } from "../lib/engineeringAgentSecretPatterns.ts";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const requestKey = () => randomUUID().replace(/-/g, "");
const SHA1 = /^[0-9a-f]{40}$/;

/** The PR's title: computed from the run, nothing free (§9-8). */
export const publisherPrTitle = (runId) => `engineering-agent: run ${runId}`;

/** The PR's body: the marker first (§10), then fixed text and the card reference. */
export const publisherPrBody = (runId, cardRef) =>
  [
    prBodyMarker(runId),
    "",
    "Opened by the Tomverse engineering agent's publisher. A person reviews and merges it; nothing here merges itself.",
    "",
    `Card: ${cardRef}`,
    "",
  ].join("\n");

/** The commit object the capability describes, from its named sources only. */
export const expectedPublishCommit = (work, baseCommitterDate) =>
  expectedCommitObject({
    tree: work.expectedTreeId,
    baseSha: work.baseSha,
    identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
    baseCommitterDate,
    runId: work.runId,
    cardRef: work.cardRef,
  });

/**
 * What a lookup found, as a result outcome (§10). No branch and no pull
 * request, both read completely, is "no prior write"; exactly one open pull
 * request into develop, carrying this run's marker, whose head commit is the
 * one the consumed capability describes, is the result; anything else is for
 * a person.
 */
export const decideLookup = ({ runId, branch, consumed, branchOid, pulls, headCommitObject }) => {
  if (branchOid === null && pulls.length === 0) return { outcome: "lookup_no_prior_write" };
  if (consumed === null) return { outcome: "lookup_impossible", reason: "write_without_capability" };
  if (pulls.length !== 1) return { outcome: "lookup_impossible", reason: "pull_request_count" };
  const [pull] = pulls;
  if (
    pull.state !== "open" ||
    pull.baseRef !== "develop" ||
    pull.headRef !== branch ||
    !prBodyCarriesMarker(pull.body ?? "", runId)
  ) {
    return { outcome: "lookup_impossible", reason: "pull_request_not_ours" };
  }
  if (headCommitObject === null || sha256(headCommitObject) !== consumed.commitDigest) {
    return { outcome: "lookup_impossible", reason: "commit_not_allowed" };
  }
  return { outcome: "lookup_found_result", pull };
};

/**
 * One cycle. `ports`:
 *   app(path, body) -> { status, json }            the engineering routes
 *   mintToken() -> { token, revoke() }             a GitHub App installation token, only after a claim
 *   github(token) -> {
 *     branchOid(branch) -> sha | null,
 *     pullsForHead(branch) -> [{ number, state, baseRef, baseSha, headRef, headSha, body }]  (complete, or throws)
 *     pullDiffDigest(number) -> sha256 | null,
 *     createPull({ title, body, head }) -> { status: "created", number } | { status: "rejected" } | { status: "unknown" },
 *   }
 *   workspace(baseSha) -> {
 *     baseCommitterDate,
 *     build({ patch, identity, date, message }) -> { treeId, commitSha, commitObject } | null,
 *     push(commitSha, branch, token) -> boolean,
 *     commitObjectAt(sha) -> string | null,
 *     dispose(),
 *   }
 * Returns { finishedNormally, halt, reason } for the dead-man signal.
 */
export async function runPublisherCycle(ports) {
  const claimed = await ports.app("publish/claim", { requestKey: requestKey() });
  if (claimed.status === 409 && typeof claimed.json?.refused === "string") {
    // A switch that is off or a halt: nothing to do this round.
    return { finishedNormally: true, halt: "none", reason: claimed.json.refused };
  }
  if (claimed.status !== 200 || claimed.json === null || !("work" in claimed.json)) {
    return { finishedNormally: false, halt: "none", reason: "claim_unknown" };
  }
  const work = claimed.json.work;
  if (work === null) return { finishedNormally: true, halt: "none", reason: "nothing_to_publish" };

  const report = async (outcome, extra = {}) => {
    const answer = await ports.app("publish/result", {
      requestKey: requestKey(),
      workItemId: work.workItemId,
      fencingToken: String(work.fencingToken),
      outcome,
      ...(extra.reason ? { reason: extra.reason } : {}),
      pullRequest: extra.pullRequest ?? null,
    });
    // An unknown answer is not retried (§10): the status route is the way to ask.
    return {
      finishedNormally: answer.status === 200,
      halt: "none",
      reason: answer.status === 200 ? outcome : "result_unknown",
    };
  };
  // No result: the claim's lease passes and the next round looks (§10).
  const leave = (reason) => ({ finishedNormally: false, halt: "none", reason });

  let token = null;
  let workspace = null;
  try {
    token = await ports.mintToken();
    const github = ports.github(token.token);

    const snapshotOf = async (pull, treeId, verifiedHeadSha) => {
      const diffDigest = await github.pullDiffDigest(pull.number);
      if (diffDigest === null || !SHA1.test(pull.baseSha) || !SHA1.test(pull.headSha)) return null;
      return {
        prNumber: pull.number,
        headSha: pull.headSha,
        verifiedHeadSha,
        snapshot: { baseSha: pull.baseSha, diffDigest, treeId, invalidatedReviewIds: [] },
      };
    };

    if (work.mode === "lookup") {
      const branchOid = await github.branchOid(work.branch);
      const pulls = await github.pullsForHead(work.branch);
      let headCommitObject = null;
      if (pulls.length === 1 && SHA1.test(pulls[0].headSha)) {
        workspace = await ports.workspace(null);
        headCommitObject = await workspace.commitObjectAt(pulls[0].headSha);
      }
      const decision = decideLookup({
        runId: work.runId,
        branch: work.branch,
        consumed: work.consumed,
        branchOid,
        pulls,
        headCommitObject,
      });
      if (decision.outcome !== "lookup_found_result") return await report(decision.outcome, decision);
      const pullRequest = await snapshotOf(decision.pull, work.consumed.expectedTreeId, decision.pull.headSha);
      if (pullRequest === null) return leave("snapshot_unreadable");
      return await report("lookup_found_result", { pullRequest });
    }

    // A write claim. Everything before the push can only refuse.
    const titled = { title: publisherPrTitle(work.runId), body: publisherPrBody(work.runId, work.cardRef) };
    if (
      sha256(work.patchBody) !== work.patchDigest ||
      detectSecrets(work.patchBody).length > 0 ||
      detectSecrets(titled.title).length > 0 ||
      detectSecrets(titled.body).length > 0
    ) {
      return await report("revalidation_refused", { reason: "content_check_failed" });
    }
    workspace = await ports.workspace(work.baseSha);
    const expected = expectedPublishCommit(work, workspace.baseCommitterDate);
    if (sha256(expected) !== work.commitDigest) {
      return await report("revalidation_refused", { reason: "commit_digest_mismatch" });
    }
    const message = expected.slice(expected.indexOf("\n\n") + 2);
    const built = await workspace.build({
      patch: work.patchBody,
      identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
      date: workspace.baseCommitterDate,
      message,
    });
    if (built === null) return await report("revalidation_refused", { reason: "patch_does_not_apply" });
    if (built.treeId !== work.expectedTreeId) return await report("revalidation_refused", { reason: "tree_mismatch" });
    if (built.commitObject !== expected) return await report("revalidation_refused", { reason: "commit_mismatch" });

    // The branch must not exist: an existing one, ours or anyone's, is looked at, never overwritten.
    if ((await github.branchOid(work.branch)) !== null) {
      return await report("lookup_impossible", { reason: "branch_exists" });
    }
    const look = await ports.app("publish/last-look", {
      workItemId: work.workItemId,
      fencingToken: String(work.fencingToken),
      commitDigest: sha256(built.commitObject),
    });
    if (look.status !== 200 || look.json?.verdict !== "no_objection") {
      return await report("refused_before_write", { reason: "last_look_refused" });
    }

    // The first public write.
    const pushed = await workspace.push(built.commitSha, work.branch, token.token);
    const remote = await github.branchOid(work.branch);
    if (remote !== built.commitSha) {
      // Pushed and then changed, or not pushed and the answer lost: a person
      // or the next lookup decides, never a second push.
      return leave(pushed ? "branch_changed_after_push" : "push_outcome_unknown");
    }

    const created = await github.createPull({ ...titled, head: work.branch });
    if (created.status === "rejected") return await report("pr_create_rejected");
    let pull = null;
    if (created.status === "created") {
      pull = (await github.pullsForHead(work.branch)).find((candidate) => candidate.number === created.number) ?? null;
    }
    if (pull === null) return leave("pull_request_outcome_unknown");
    const pullRequest = await snapshotOf(pull, work.expectedTreeId, built.commitSha);
    if (pullRequest === null) return leave("snapshot_unreadable");
    return await report("confirmed", { pullRequest });
  } catch (error) {
    return leave(error instanceof Error ? error.message.slice(0, 64) : "cycle_failed");
  } finally {
    await workspace?.dispose().catch(() => undefined);
    await token?.revoke().catch(() => undefined);
  }
}
