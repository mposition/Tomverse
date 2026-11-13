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
// never deletes a branch and never merges. The one write a lookup claim may
// make is the pull request a lost answer left unopened, and only once a person
// approved it for that item (§10): never a push.
//
// Imports: node builtins and the dependency-free core only (§8).

import { createHash, randomUUID } from "node:crypto";

import {
  ENGINEERING_AGENT_COMMIT_IDENTITY,
  expectedCommitObject,
  prBodyCarriesMarker,
  prBodyMarker,
  reportedHalt,
} from "../lib/engineeringAgentCore.ts";
import { detectSecrets } from "../lib/engineeringAgentSecretPatterns.ts";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const requestKey = () => randomUUID().replace(/-/g, "");
const SHA1 = /^[0-9a-f]{40}$/;

/**
 * How often a read that follows our own write is taken again while GitHub has
 * not yet shown that write, and how long apart. Only reads repeat: a ref read
 * right after a push can answer 404 for a moment (AMUX-FILEGEN-003, 2026-11-11),
 * and taking that as a moved branch left a pushed branch without its pull
 * request.
 */
export const READ_AFTER_WRITE_ATTEMPTS = 5;
export const READ_AFTER_WRITE_PAUSE_MS = 2_000;
const realPause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lookup's reason for a branch at the allowed commit with no pull request: what a person may approve resuming. */
export const BRANCH_WITHOUT_PULL_REQUEST_REASON = "branch_without_pull_request";

/**
 * The card code the app sends (AMUX-FILEREQ-005); anything else is left off.
 * The same grammar as AMUX_CARD_DISPLAY_KEY_PATTERN (lib/amux/cardDisplayKeyCore.ts),
 * copied because this core imports nothing; tests/engineeringAgentPublisher.test.mjs
 * holds the two equal.
 */
export const PUBLISHER_CARD_KEY = /^AMUX-[A-Z0-9]{2,16}-(00[1-9]|0[1-9][0-9]|[1-9][0-9]{2,8})$/;

/**
 * The PR's title: computed from the run and, when the app sends one, the
 * card's readable code first, so the owner can tell which card a pull request
 * is (owner request 2026-11-13). Nothing free (§9-8): the code is read from
 * the card row, never the card's title.
 */
export const publisherPrTitle = (runId, cardKey = null) => {
  const card = typeof cardKey === "string" && PUBLISHER_CARD_KEY.test(cardKey) ? `${cardKey} ` : "";
  return `${card}engineering-agent: run ${runId}`;
};

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

/**
 * An owner review item: a T2 patch, opened as a draft for the owner (owner
 * decision 2026-10-30). The title says so, and the body says what marking it
 * ready does -- the one step that runs its code with the repository's secrets.
 */
export const publisherReviewPrTitle = (runId, cardKey = null) => `${publisherPrTitle(runId, cardKey)} (owner review)`;
export const publisherReviewPrBody = (runId, cardRef) =>
  [
    prBodyMarker(runId),
    "",
    "**Owner review (T2).** Opened by the Tomverse engineering agent's publisher as a draft. The change touches files the agent may not publish on its own, so a person reviews it before anything runs it.",
    "",
    "- While it is a draft, no CI workflow runs.",
    "- Marking it ready runs this change's code in CI with the repository's secrets. Read the whole diff first.",
    "- A person reviews and merges it; nothing here merges itself.",
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
 * a person. A branch with no pull request is told apart by its commit
 * (`headCommitObject` is then the branch's): at the allowed commit it is
 * `branch_without_pull_request`, the one case a person may approve resuming.
 */
export const decideLookup = ({ runId, branch, consumed, branchOid, pulls, headCommitObject }) => {
  // (The branch must also be at the pull request's head: a found result binds
  // one commit, and a branch that moved is not that commit.)
  if (branchOid === null && pulls.length === 0) return { outcome: "lookup_no_prior_write" };
  if (consumed === null) return { outcome: "lookup_impossible", reason: "write_without_capability" };
  if (pulls.length === 0) {
    if (headCommitObject === null) return { outcome: "lookup_impossible", reason: "pull_request_count" };
    if (sha256(headCommitObject) !== consumed.commitDigest) return { outcome: "lookup_impossible", reason: "commit_not_allowed" };
    return { outcome: "lookup_impossible", reason: BRANCH_WITHOUT_PULL_REQUEST_REASON, branchOid };
  }
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
  if (branchOid !== pull.headSha) return { outcome: "lookup_impossible", reason: "branch_not_at_head" };
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
 *     pullDiffDigest(number) -> { digest } | { refused: true } | null   (null: not read; refused: not a diff AMUX would bind)
 *     createPull({ title, body, head, draft }) ->{ status: "created", number } | { status: "rejected" } | { status: "unknown" },
 *   }
 *   workspace(baseSha) -> {
 *     baseCommitterDate,
 *     build({ patch, identity, date, message }) -> { treeId, commitSha, commitObject } | null,
 *     push(commitSha, branch, token) -> boolean,
 *     commitObjectAt(sha) -> string | null,
 *     dispose(),
 *   }
 *   pause(ms)                                       optional; between reads that wait for our own write
 * Returns { finishedNormally, halt, reason } for the dead-man signal.
 */
export async function runPublisherCycle(ports) {
  const claimed = await ports.app("publish/claim", { requestKey: requestKey() });
  if (claimed.status === 409 && typeof claimed.json?.refused === "string") {
    // A switch that is off -- the mode, the freeze, the kill switch -- is a
    // quiet round the monitor still hears, but only while nothing halts: the
    // refusal carries the halt too, and no halt named is not none (§12).
    return { finishedNormally: true, halt: reportedHalt(claimed.json.halt), reason: claimed.json.refused };
  }
  if (claimed.status !== 200 || claimed.json === null || !("work" in claimed.json)) {
    return { finishedNormally: false, halt: "unknown", reason: "claim_unknown" };
  }
  const work = claimed.json.work;
  // The halt the app reads beside the claim: while anything halts, a round is
  // not a healthy one whatever it did (§12). Unknown is never taken as none.
  const halt = reportedHalt(claimed.json.halt);
  if (work === null) return { finishedNormally: true, halt, reason: "nothing_to_publish" };

  const report = async (outcome, extra = {}) => {
    const answer = await ports.app("publish/result", {
      requestKey: requestKey(),
      workItemId: work.workItemId,
      fencingToken: String(work.fencingToken),
      outcome,
      ...(typeof extra.reason === "string" ? { reason: extra.reason } : {}),
      pullRequest: extra.pullRequest ?? null,
    });
    // An unknown answer is not retried (§10): the status route is the way to ask.
    return {
      finishedNormally: answer.status === 200,
      halt,
      reason: answer.status === 200 ? outcome : "result_unknown",
    };
  };
  // No result: the claim's lease passes and the next round looks (§10).
  const leave = (reason) => ({ finishedNormally: false, halt, reason });
  // A read taken again, a few times, while it does not yet show our own write.
  const pause = typeof ports.pause === "function" ? ports.pause : realPause;
  const readUntil = async (read, shown) => {
    let value = await read();
    for (let attempt = 1; attempt < READ_AFTER_WRITE_ATTEMPTS && !shown(value); attempt += 1) {
      await pause(READ_AFTER_WRITE_PAUSE_MS);
      value = await read();
    }
    return value;
  };
  // Only `true` is a review item: anything else is the ordinary pull request.
  const review = work.ownerReview === true;
  // Built only on the paths that write, each of which has its card reference.
  const titled = () => review ?
    { title: publisherReviewPrTitle(work.runId, work.cardKey), body: publisherReviewPrBody(work.runId, work.cardRef) } :
    { title: publisherPrTitle(work.runId, work.cardKey), body: publisherPrBody(work.runId, work.cardRef) };
  const titleCarriesSecret = () => {
    const { title, body } = titled();
    return detectSecrets(title).length > 0 || detectSecrets(body).length > 0;
  };

  let token = null;
  let workspace = null;
  try {
    token = await ports.mintToken();
    const github = ports.github(token.token);

    // The binding: one commit -- the pull request's head, the branch and the
    // verified commit all the same -- and the digest of a diff AMUX would bind.
    // A diff that can never be bound goes to a person; one not read now is
    // left for the next lookup (§10).
    const snapshotOf = async (pull, treeId, verifiedHeadSha) => {
      if (!SHA1.test(pull.baseSha) || pull.headSha !== verifiedHeadSha) return { unreadable: "pull_request_head_changed" };
      const diff = await github.pullDiffDigest(pull.number);
      if (diff === null) return { unreadable: "snapshot_unreadable" };
      if (diff.refused) return { refused: "diff_not_bindable" };
      // Read again after the diff, as AMUX's review does: a head that moved
      // while the diff was read means the digest is not this commit's.
      const again = (await github.pullsForHead(work.branch)).find((candidate) => candidate.number === pull.number);
      if (again?.headSha !== verifiedHeadSha || again?.baseSha !== pull.baseSha || (await github.branchOid(work.branch)) !== verifiedHeadSha) {
        return { unreadable: "pull_request_head_changed" };
      }
      return {
        pullRequest: {
          prNumber: pull.number,
          headSha: pull.headSha,
          verifiedHeadSha,
          snapshot: { baseSha: pull.baseSha, diffDigest: diff.digest, treeId, invalidatedReviewIds: [] },
        },
      };
    };
    const reportSnapshot = async (outcome, snapshot) => {
      if (snapshot.refused) return report("lookup_impossible", { reason: snapshot.refused });
      if (snapshot.unreadable) return leave(snapshot.unreadable);
      return report(outcome, { pullRequest: snapshot.pullRequest });
    };
    // The one pull request creation, for the branch at `headSha`: never
    // repeated. A 4xx is a definite refusal; any other answer, or a pull
    // request that does not show, is for the next lookup.
    const openPull = async ({ headSha, outcome, rejected, treeId }) => {
      const created = await github.createPull({ ...titled(), head: work.branch, draft: review });
      if (created.status === "rejected") return await report(rejected.outcome, rejected);
      let pull = null;
      if (created.status === "created") {
        const find = async () =>
          (await github.pullsForHead(work.branch)).find((candidate) => candidate.number === created.number) ?? null;
        pull = await readUntil(find, (found) => found !== null);
      }
      if (pull === null) return leave("pull_request_outcome_unknown");
      // The branch is read again: the pull request, the branch and the pushed
      // commit must be one commit before anything is bound.
      if ((await github.branchOid(work.branch)) !== headSha) return leave("pull_request_head_changed");
      return await reportSnapshot(outcome, await snapshotOf(pull, treeId, headSha));
    };

    if (work.mode === "lookup") {
      const branchOid = await github.branchOid(work.branch);
      const pulls = await github.pullsForHead(work.branch);
      let headCommitObject = null;
      // The commit read is the pull request's head, or with no pull request the branch's.
      const readSha = pulls.length === 1 ? pulls[0].headSha : pulls.length === 0 && work.consumed !== null ? branchOid : null;
      if (typeof readSha === "string" && SHA1.test(readSha)) {
        workspace = await ports.workspace(null);
        headCommitObject = await workspace.commitObjectAt(readSha);
      }
      const decision = decideLookup({
        runId: work.runId,
        branch: work.branch,
        consumed: work.consumed,
        branchOid,
        pulls,
        headCommitObject,
      });
      if (
        decision.outcome === "lookup_impossible" &&
        decision.reason === BRANCH_WITHOUT_PULL_REQUEST_REASON &&
        work.resumePullRequest === true
      ) {
        // A person approved opening the pull request for this branch (§10),
        // and this claim carries that approval once. The branch was just read
        // at the commit the consumed capability allows, with no pull request
        // for it; nothing is pushed.
        if (typeof work.cardRef !== "string" || titleCarriesSecret()) {
          return await report("lookup_impossible", { reason: "content_check_failed" });
        }
        return await openPull({
          headSha: decision.branchOid,
          outcome: "lookup_found_result",
          rejected: { outcome: "lookup_impossible", reason: "pull_request_create_rejected" },
          treeId: work.consumed.expectedTreeId,
        });
      }
      if (decision.outcome !== "lookup_found_result") return await report(decision.outcome, decision);
      return await reportSnapshot(
        "lookup_found_result",
        await snapshotOf(decision.pull, work.consumed.expectedTreeId, decision.pull.headSha),
      );
    }

    // A write claim. Everything before the push can only refuse.
    if (sha256(work.patchBody) !== work.patchDigest || detectSecrets(work.patchBody).length > 0 || titleCarriesSecret()) {
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
    // A branch not shown yet is read again; a branch at another commit is not.
    const remote = await readUntil(() => github.branchOid(work.branch), (oid) => oid !== null);
    if (remote !== built.commitSha) {
      // Pushed and then changed, pushed and still not shown, or not pushed and
      // the answer lost: a person or the next lookup decides, never a second push.
      if (!pushed) return leave("push_outcome_unknown");
      return leave(remote === null ? "push_not_shown" : "branch_changed_after_push");
    }

    return await openPull({
      headSha: built.commitSha,
      outcome: "confirmed",
      rejected: { outcome: "pr_create_rejected" },
      treeId: work.expectedTreeId,
    });
  } catch (error) {
    return leave(error instanceof Error ? error.message.slice(0, 64) : "cycle_failed");
  } finally {
    await workspace?.dispose().catch(() => undefined);
    await token?.revoke().catch(() => undefined);
  }
}
