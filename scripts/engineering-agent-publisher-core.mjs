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
// approved it for that item (§10): never a push. After the claim's work, it
// closes the review drafts the claim names -- its own drafts a newer pull
// request of the same card replaced -- each only after reading it again.
//
// Imports: node builtins and the dependency-free core only (§8).

import { createHash, randomUUID } from "node:crypto";

import {
  ENGINEERING_AGENT_CHANGE_DIGEST_V2_FEATURE,
  ENGINEERING_AGENT_COMMIT_IDENTITY,
  ENGINEERING_PUBLISHER_PATCH_CHUNKS_FEATURE,
  engineeringBranchName,
  expectedCommitObject,
  isRunId,
  prBodyCarriesMarker,
  prBodyMarker,
  reportedHalt,
} from "../lib/engineeringAgentCore.ts";
import { detectSecrets } from "../lib/engineeringAgentSecretPatterns.ts";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
 * The patch a write claim applies (docs/policy/amux-v22-result-transfer.md §4).
 * A claim that carries it as text -- an app before `patch_chunks` -- is used as
 * it is. Otherwise, from an app that names `patch_chunks`, its chunks are read
 * from `publish/patch` in order and joined; the whole is checked for the
 * claimed length and digest, and only then decoded as UTF-8, failing on any
 * byte that is not. `{ text }`, or `{ refused }` for bytes that are not the
 * patch the claim names, or `{ unavailable }` when they could not be read.
 */
export const readClaimedPatch = async (app, work, appFeatures) => {
  if (typeof work.patchBody === "string") return { text: work.patchBody };
  const total = work.patchBytes;
  const count = work.patchChunkCount;
  if (!Array.isArray(appFeatures) || !appFeatures.includes(ENGINEERING_PUBLISHER_PATCH_CHUNKS_FEATURE) ||
      !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(count) || count < 0) {
    return { unavailable: true };
  }
  const chunks = [];
  let received = 0;
  for (let index = 0; index < count; index += 1) {
    const answer = await app("publish/patch", {
      workItemId: work.workItemId,
      fencingToken: String(work.fencingToken),
      index,
    });
    const chunk = answer.json;
    if (answer.status !== 200 || chunk?.workItemId !== work.workItemId || chunk?.index !== index ||
        chunk?.totalBytes !== total || chunk?.chunkCount !== count || typeof chunk?.bytesBase64 !== "string") {
      return { unavailable: true };
    }
    const bytes = Buffer.from(chunk.bytesBase64, "base64");
    // Only canonical base64: anything else is not what the app wrote.
    if (bytes.byteLength === 0 || bytes.toString("base64") !== chunk.bytesBase64) return { unavailable: true };
    received += bytes.byteLength;
    if (received > total) return { refused: true };
    chunks.push(bytes);
  }
  const whole = Buffer.concat(chunks, received);
  if (whole.byteLength !== total || sha256Bytes(whole) !== work.patchDigest) return { refused: true };
  try {
    // ignoreBOM keeps a leading BOM, so the text is these bytes exactly.
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(whole) };
  } catch {
    return { refused: true };
  }
};

/**
 * One cycle. `ports`:
 *   app(path, body) -> { status, json }            the engineering routes
 *   mintToken() -> { token, revoke() }             a GitHub App installation token, only after a claim
 *   github(token) -> {
 *     branchOid(branch) -> sha | null,
 *     pullsForHead(branch) -> [{ number, state, baseRef, baseSha, headRef, headSha, body }]  (complete, or throws)
 *     pullChangeDigest({ base, headSha }) -> { digest, headTreeSha } | null   (v2, lib/pullDiffDigestCore.ts; null: not read)
 *     pullDiffDigest(number) -> { digest } | { refused: true } | null   (v1, for an app without change_digest_v2 only;
 *                                                                        null: not read; refused: not a diff AMUX would bind)
 *     createPull({ title, body, head, draft }) ->{ status: "created", number } | { status: "rejected" } | { status: "unknown" },
 *     pullByNumber(number) -> { number, state, draft, baseRef, headRef, headRepo, authorType, authorLogin, body } | null
 *                                                    (null: no such pull request)
 *     pullReviewed(number) -> boolean                 (true: anyone reviewed it, or the list was not read whole)
 *     closePull(number) -> boolean                   (true: GitHub answered the close)
 *   }
 *   selfLogin() -> "<app slug>[bot]" | null          the publisher App's own login, the author of its pull requests
 *   workspace(baseSha) -> {
 *     baseCommitterDate,
 *     build({ patch, identity, date, message }) -> { treeId, commitSha, commitObject } | { refused } | null,
 *     push(commitSha, branch, token) -> boolean,
 *     commitObjectAt(sha) -> string | null,
 *     dispose(),
 *   }
 *   pause(ms)                                       optional; between reads that wait for our own write
 * Returns { finishedNormally, halt, reason } for the dead-man signal, and
 * `closedReviewDrafts` when the claim named review drafts to close.
 */
export async function runPublisherCycle(ports) {
  const claimed = await ports.app("publish/claim", { requestKey: requestKey() });
  const result = await publishClaimed(ports, claimed);
  // After the claim's own work: the review drafts a newer pull request of
  // the same card replaced (owner decision 2026-11-23). Nothing here changes
  // the round's result.
  const drafts = claimed.status === 200 ? closeableReviewDrafts(claimed.json?.closeReviewDrafts) : [];
  if (drafts.length === 0) return result;
  return { ...result, closedReviewDrafts: await closeSupersededReviewDrafts(ports, drafts) };
}

/** The repository every pull request the publisher opens lives in. */
export const PUBLISHER_REPOSITORY = "mposition/Tomverse";

/**
 * The claim's list of review drafts to close, as the app sent it: each a pull
 * request number and a run id, its branch the one that run's publish item
 * pushed, and the pull request that replaced it (null: its card is done).
 * Anything else is dropped; a number named twice is closed once.
 */
export const closeableReviewDrafts = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const drafts = [];
  for (const entry of list) {
    const prNumber = entry?.prNumber;
    const runId = entry?.runId;
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || typeof runId !== "string" || !isRunId(runId)) continue;
    if (entry.branch !== engineeringBranchName(runId) || seen.has(prNumber)) continue;
    const replacedBy = entry.replacedBy ?? null;
    if (replacedBy !== null && (!Number.isSafeInteger(replacedBy) || replacedBy <= 0 || replacedBy === prNumber)) continue;
    seen.add(prNumber);
    drafts.push({ prNumber, runId, branch: entry.branch, replacedBy });
  }
  return drafts;
};

/**
 * Whether the pull request GitHub shows now is one the publisher may close:
 * still open, still a draft (one a person marked ready is theirs), into
 * develop, from this run's branch in this repository, opened by this
 * publisher's own App, and carrying this run's marker. The app named it;
 * this check can only refuse.
 */
export const decideReviewDraftClose = (draft, pull, selfLogin) => {
  if (pull === null) return "not_found";
  if (pull.state !== "open") return "not_open";
  if (pull.draft !== true) return "not_draft";
  if (pull.baseRef !== "develop" || pull.headRef !== draft.branch || pull.headRepo !== PUBLISHER_REPOSITORY ||
      pull.authorType !== "Bot" || typeof selfLogin !== "string" || pull.authorLogin !== selfLogin ||
      !prBodyCarriesMarker(pull.body ?? "", draft.runId)) return "not_ours";
  return "close";
};

/** The shape of a GitHub App's bot login. */
export const APP_BOT_LOGIN = /^[a-z0-9][a-z0-9-]{0,98}\[bot\]$/;

/**
 * Closes each review draft that passes decideReviewDraftClose, once: read it,
 * refuse one anybody reviewed or whose replacement GitHub does not show open
 * now (the app's binding may not have seen a person close it yet), ask the app's last look
 * (`publish/close-look`: the switches, the halt and the list read again just
 * before the write), then one close. A close whose answer is lost is not
 * repeated here; the next round reads the pull request again and finds it
 * closed or still open. Without the publisher's own login nothing is tried.
 */
async function closeSupersededReviewDrafts(ports, drafts) {
  const outcomes = [];
  let token = null;
  try {
    const selfLogin = typeof ports.selfLogin === "function" ? await ports.selfLogin() : null;
    if (typeof selfLogin !== "string" || !APP_BOT_LOGIN.test(selfLogin)) throw new Error("self_login_unknown");
    token = await ports.mintToken();
    const github = ports.github(token.token);
    for (const draft of drafts) {
      let outcome;
      try {
        outcome = decideReviewDraftClose(draft, await github.pullByNumber(draft.prNumber), selfLogin);
        if (outcome === "close" && (await github.pullReviewed(draft.prNumber))) outcome = "reviewed";
        if (outcome === "close" && draft.replacedBy !== null &&
            (await github.pullByNumber(draft.replacedBy))?.state !== "open") outcome = "replacement_not_open";
        if (outcome === "close") {
          // The reason too: the replacing pull request just read open, or none for a done card.
          const look = await ports.app("publish/close-look", { prNumber: draft.prNumber, runId: draft.runId,
            replacedBy: draft.replacedBy });
          if (look.status !== 200 || look.json?.verdict !== "no_objection") outcome = "close_look_refused";
        }
        if (outcome === "close") outcome = (await github.closePull(draft.prNumber)) ? "closed" : "close_unknown";
      } catch {
        outcome = "unreadable";
      }
      outcomes.push({ prNumber: draft.prNumber, outcome });
    }
  } catch {
    return [...outcomes, ...drafts.slice(outcomes.length).map((draft) => ({ prNumber: draft.prNumber, outcome: "not_tried" }))];
  } finally {
    await token?.revoke().catch(() => undefined);
  }
  return outcomes;
}

async function publishClaimed(ports, claimed) {
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
  // What the app says it takes (docs/policy/amux-v22-result-transfer.md §3-5):
  // an app that names change_digest_v2 is given the v2 change digest; one
  // before it, which knows only the diff digest, the v1 one.
  const appFeatures = Array.isArray(claimed.json.appFeatures) ? claimed.json.appFeatures : [];
  const changeDigestV2 = appFeatures.includes(ENGINEERING_AGENT_CHANGE_DIGEST_V2_FEATURE);
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
    // verified commit all the same -- and its change digest (v2: merge base,
    // head and tree, any size, binary files included). One not read now is
    // left for the next lookup (§10). Only an app before v2 is given the v1
    // diff digest, and a diff that can never be bound in v1 goes to a person.
    const changeDigestOf = async (pull, treeId) => {
      const change = await github.pullChangeDigest({ base: pull.baseRef, headSha: pull.headSha });
      if (change === null) return null;
      // The tree GitHub holds for the head is the tree the app judged.
      return change.headTreeSha === treeId ? { digest: change.digest } : { unreadable: "pull_request_head_changed" };
    };
    const snapshotOf = async (pull, treeId, verifiedHeadSha) => {
      if (!SHA1.test(pull.baseSha) || pull.headSha !== verifiedHeadSha) return { unreadable: "pull_request_head_changed" };
      const diff = changeDigestV2 ? await changeDigestOf(pull, treeId) : await github.pullDiffDigest(pull.number);
      if (diff === null) return { unreadable: "snapshot_unreadable" };
      if (diff.unreadable) return { unreadable: diff.unreadable };
      if (diff.refused) return { refused: "diff_not_bindable" };
      // Read again after the digest, as AMUX's review does: a head that moved
      // while it was read means the digest is not this commit's.
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

    // A write claim. Everything before the push can only refuse. A patch the
    // app could not hand over was never applied: the item goes back to the
    // queue, and its next claim is judged again under a new capability (§10).
    const claimedPatch = await readClaimedPatch(ports.app, work, claimed.json.appFeatures);
    if (claimedPatch.unavailable) return await report("refused_before_write", { reason: "patch_read_failed" });
    const patchText = claimedPatch.refused ? null : claimedPatch.text;
    if (patchText === null || sha256(patchText) !== work.patchDigest || detectSecrets(patchText).length > 0 || titleCarriesSecret()) {
      return await report("revalidation_refused", { reason: "content_check_failed" });
    }
    workspace = await ports.workspace(work.baseSha);
    const expected = expectedPublishCommit(work, workspace.baseCommitterDate);
    if (sha256(expected) !== work.commitDigest) {
      return await report("revalidation_refused", { reason: "commit_digest_mismatch" });
    }
    const message = expected.slice(expected.indexOf("\n\n") + 2);
    const built = await workspace.build({
      patch: patchText,
      identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
      date: workspace.baseCommitterDate,
      message,
    });
    if (built === null) return await report("revalidation_refused", { reason: "patch_does_not_apply" });
    // A blob the applied tree adds carried a secret: a binary file's bytes
    // are not in the patch text scanned above.
    if (built.refused) return await report("revalidation_refused", { reason: built.refused });
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
