import "server-only";

import { ENGINEERING_AGENT_POLICY_VERSION,
  ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX,
  ENGINEERING_AGENT_V22_REVIEW_PR_ENV,
  ENGINEERING_AGENT_V22_TIER_PENDING_REASON,
  engineeringAgentV22ReviewPrEnabled } from "@/lib/engineeringAgentCore";
import { EngineeringAgentStoreRefusedError,
  expireEngineeringAgentV22LapsedPublish,
  readEngineeringAgentOwnerQueues,
  runEngineeringAgentTransaction } from "@/lib/engineeringAgentStore";
import { loadEngineeringAgentV22Candidate } from
  "@/lib/engineeringAgentV22CandidateLoad";
import { reissueEngineeringAgentV22Capability,
  resolveEngineeringAgentV22Product } from
  "@/lib/engineeringAgentV22ProductStore";
import { v22PublishCandidateMatches, v22ReviewCandidateMatches } from
  "@/lib/engineeringAgentV22PublicationDecision";
import { type EngineeringAgentV22StoredCandidateStage,
  loadEngineeringAgentV22StoredCandidate } from
  "@/lib/engineeringAgentV22StoredCandidate";
import { prisma } from "@/lib/prisma";

type Pending = { workItemId: string; runId: string; attemptId: string;
  taskId: string; modeAtStart: string; patchDigest: string; baseSha: string };
type Lapsed = Pending & { expectedTreeId: string; ownerReview: boolean };
type Stored = Awaited<ReturnType<typeof loadEngineeringAgentV22StoredCandidate>>;
type Stage = EngineeringAgentV22StoredCandidateStage;
type Ports = {
  readLapsed: () => Promise<Lapsed | null>;
  /** The oldest pending draft, one not in `behind` first while there is one. */
  readPending: (behind: ReadonlySet<string>) => Promise<Pending | null>;
  prQueueFull: () => Promise<boolean>;
  loadStored: (item: Pending, still: () => Promise<boolean>,
    onStage: (stage: Stage) => void) => Promise<Stored>;
  /** Evidence reads that threw, by pending draft, in this process. */
  failures: Map<string, number>;
  stillLapsed: (item: Lapsed) => Promise<boolean>;
  stillPending: (item: Pending) => Promise<boolean>;
  reissue: (input: Parameters<typeof reissueEngineeringAgentV22Capability>[1]) =>
    Promise<unknown>;
  expireLapsed: (workItemId: string, reason: string) => Promise<unknown>;
  resolve: (input: Parameters<typeof resolveEngineeringAgentV22Product>[1]) =>
    ReturnType<typeof resolveEngineeringAgentV22Product>;
  reviewPrEnabled: () => boolean;
};

const REASON = /^[a-z_]{1,64}$/;
/** Rounds a pending draft's evidence read may throw before the draft is kept
 * private as `tier_evidence_unavailable`. A throw (GitHub or the database
 * unreachable, say) is not a verdict; one that repeats every round is. */
export const ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS = 3;
/** Drafts whose failures are remembered at once; the oldest is forgotten. */
const FAILURES_REMEMBERED = 32;
const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A failed read, by class name, code and step: never its message, which can
 * carry a path, file text or a response body. */
const describeFailure = (error: unknown, stage: Stage) => {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return { stage, error: SAFE.test(name) ? name : "unknown",
    code: typeof code === "string" && SAFE.test(code) ? code :
      Number.isInteger(code) ? String(code) : null };
};

/** One evidence read, the step it reached kept beside a throw. */
const readStored = async (ports: Ports, item: Pending,
  still: () => Promise<boolean>) => {
  let stage: Stage = "authorization";
  return ports.loadStored(item, still, (next) => { stage = next; }).then(
    (stored) => ({ stored, failure: null }),
    (error: unknown) => ({ stored: null, failure: describeFailure(error, stage) }));
};
const runSelect = { select: { id: true, amuxAttemptId: true, cardId: true,
  modeAtStart: true } } as const;
const asPending = (item: { id: string; patchDigest: string | null;
  baseSha: string | null; run: { id: string; amuxAttemptId: string;
    cardId: string; modeAtStart: string } | null }): Pending | null =>
  item.run && item.patchDigest && item.baseSha ? {
    workItemId: item.id, runId: item.run.id,
    attemptId: item.run.amuxAttemptId, taskId: item.run.cardId,
    modeAtStart: item.run.modeAtStart, patchDigest: item.patchDigest,
    baseSha: item.baseSha } : null;

/** A draft whose read just threw goes behind the others, so a failure that
 * repeats holds no other draft back while it uses up its rounds. */
async function readPending(behind: ReadonlySet<string>): Promise<Pending | null> {
  const items = await prisma.engineeringAgentWorkItem.findMany({
    where: { kind: "t2_draft", state: "open",
      reason: ENGINEERING_AGENT_V22_TIER_PENDING_REASON,
      run: { card: { sourceSystem: "admin-idea-v4" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(behind.size, FAILURES_REMEMBERED) + 1,
    select: { id: true, patchDigest: true, baseSha: true, run: runSelect },
  });
  const item = items.find((row) => !behind.has(row.id)) ?? items[0];
  return item ? asPending(item) : null;
}

/** A queued publish item with no live capability, which no claim can take:
 * its capability lapsed before a round claimed it, or a claim spent it and
 * came back proven unwritten (a refusal before the push, or a lookup that
 * found no prior write), which needs a new one. */
export const queuedWithoutCapabilityWhere = () => ({ kind: "publish",
  state: "queued", capabilities: { none: {
    unconsumedWorkItemId: { not: null }, expiresAt: { gt: new Date() } } } });

const lapsedWhere = () => ({ ...queuedWithoutCapabilityWhere(),
  run: { card: { sourceSystem: "admin-idea-v4" } } });

async function readLapsed(): Promise<Lapsed | null> {
  const item = await prisma.engineeringAgentWorkItem.findFirst({
    where: lapsedWhere(),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, causeKey: true, patchDigest: true, baseSha: true,
      expectedTreeId: true, run: runSelect },
  });
  const pending = item ? asPending(item) : null;
  return pending && item?.expectedTreeId ?
    { ...pending, expectedTreeId: item.expectedTreeId,
      ownerReview: item.causeKey.startsWith(
        ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX) } : null;
}

/** The run has ended, so the item still waiting is the snapshot the
 * candidate's reads are repeated against. Develop may have moved since
 * settlement; the base need only be one of its commits. */
const loadStored = (item: Pending, still: () => Promise<boolean>,
  onStage: (stage: Stage) => void) =>
  loadEngineeringAgentV22StoredCandidate(item.attemptId, {
    onStage,
    readSnapshot: async () => await still() ?
      { runId: item.runId, taskId: item.taskId, baseSha: item.baseSha } : null,
    loadCandidate: (input) =>
      loadEngineeringAgentV22Candidate({ ...input, onDevelop: true }),
  });

const livePorts: Ports = {
  readLapsed, readPending, loadStored, failures: new Map(),
  stillLapsed: async (item) => (await prisma.engineeringAgentWorkItem.count({
    where: { id: item.workItemId, ...lapsedWhere() } })) === 1,
  stillPending: async (item) => (await prisma.engineeringAgentWorkItem.count({
    where: { id: item.workItemId, state: "open",
      reason: ENGINEERING_AGENT_V22_TIER_PENDING_REASON } })) === 1,
  prQueueFull: async () =>
    (await readEngineeringAgentOwnerQueues(prisma)).prFull,
  reissue: (input) => runEngineeringAgentTransaction(prisma,
    (tx) => reissueEngineeringAgentV22Capability(tx, input)),
  expireLapsed: (workItemId, reason) => runEngineeringAgentTransaction(prisma,
    (tx) => expireEngineeringAgentV22LapsedPublish(tx, { workItemId, reason })),
  resolve: (input) => runEngineeringAgentTransaction(prisma,
    (tx) => resolveEngineeringAgentV22Product(tx, input)),
  reviewPrEnabled: () => engineeringAgentV22ReviewPrEnabled(
    process.env[ENGINEERING_AGENT_V22_REVIEW_PR_ENV]),
};

/** A database refusal (store or trigger), as opposed to a failure to reach it. */
const refused = (error: unknown) =>
  error instanceof EngineeringAgentStoreRefusedError ||
  /\b23514\b|check_violation/.test(error instanceof Error ? error.message : "");

const t1Candidate = (item: Pending, stored: Stored | null) =>
  v22PublishCandidateMatches({
    policyVersion: ENGINEERING_AGENT_POLICY_VERSION,
    modeAtStart: item.modeAtStart, runId: item.runId,
    taskId: item.taskId, baseSha: item.baseSha,
    patchDigest: item.patchDigest, publication: stored,
  }) && stored?.ok === true ? { expectedTreeId: stored.candidate.expectedTreeId,
    baseCommitterDate: stored.candidate.baseCommitterDate,
    imageProofDigest: stored.imageProofDigest! } : null;

/** A T2 verdict the owner reviews as a draft pull request: the candidate the
 * same, its gate evidence whatever it was. */
const reviewCandidate = (item: Pending, stored: Stored | null) =>
  v22ReviewCandidateMatches({
    policyVersion: ENGINEERING_AGENT_POLICY_VERSION,
    modeAtStart: item.modeAtStart, runId: item.runId,
    taskId: item.taskId, baseSha: item.baseSha,
    patchDigest: item.patchDigest, publication: stored,
  }) && stored?.ok === true ? { expectedTreeId: stored.candidate.expectedTreeId,
    baseCommitterDate: stored.candidate.baseCommitterDate,
    imageProofDigest: stored.imageProofDigest } : null;

/** One round outside any route budget. A v22 publish item left queued
 * without a live capability is judged again first:
 * the same verdict on the same tree gets a new capability, any other closes
 * the item so it neither holds the queue nor comes first again. An owner
 * review item keeps its new capability on T1 or T2 alike, while its switch
 * is on. Otherwise one pending draft's tier: T1 opens the run's publish item
 * with its capability; T2, while the switch is on and the patch qualifies,
 * opens it as an owner review item, which the publisher opens as a draft
 * pull request; anything else leaves an ordinary draft for the owner. While
 * the pull request queue is full no draft's tier is read; a promotion the
 * database still refuses becomes an ordinary draft, so no draft is read
 * again and again. A failure to reach the database leaves it pending. A
 * draft whose evidence read throws stays pending, behind the other drafts,
 * for `ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS` rounds of this process,
 * and is then kept private as `tier_evidence_unavailable`; each round names
 * the failure's class, code and step. */
export async function promoteEngineeringAgentV22Draft(
  ports: Ports = livePorts,
): Promise<{ outcome: "none" | "waiting" | "promoted" | "review_promoted" |
  "kept" | "stale" | "reissued" | "reissue_refused" | "retry";
  reason?: string; workItemId?: string; attempt?: number;
  stage?: Stage; error?: string; code?: string | null }> {
  const lapsed = await ports.readLapsed();
  if (lapsed) {
    const { stored, failure } = await readStored(ports, lapsed,
      () => ports.stillLapsed(lapsed));
    // Unreadable now (GitHub, say) is not a verdict: a later round reads it.
    if (stored === null) return { outcome: "reissue_refused",
      reason: "tier_evidence_unavailable", workItemId: lapsed.workItemId,
      ...failure };
    const reviewOn = lapsed.ownerReview && ports.reviewPrEnabled();
    const candidate = lapsed.ownerReview ?
      (reviewOn ? t1Candidate(lapsed, stored) ?? reviewCandidate(lapsed, stored) : null) :
      t1Candidate(lapsed, stored);
    if (!candidate || candidate.expectedTreeId !== lapsed.expectedTreeId) {
      const why = !stored.ok && REASON.test(stored.reason) ? stored.reason :
        lapsed.ownerReview && !reviewOn ? "review_pr_off" : "tier_changed";
      await ports.expireLapsed(lapsed.workItemId, why);
      return { outcome: "reissue_refused", reason: why };
    }
    await ports.reissue({ workItemId: lapsed.workItemId, runId: lapsed.runId,
      taskId: lapsed.taskId, patchDigest: lapsed.patchDigest,
      baseSha: lapsed.baseSha, candidate });
    return { outcome: "reissued" };
  }
  const pending = await ports.readPending(new Set(ports.failures.keys()));
  if (!pending) return { outcome: "none" };
  if (await ports.prQueueFull()) return { outcome: "waiting" };
  const { stored, failure } = await readStored(ports, pending,
    () => ports.stillPending(pending));
  const attempt = (ports.failures.get(pending.workItemId) ?? 0) + 1;
  ports.failures.delete(pending.workItemId);
  if (failure && attempt < ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS) {
    // Re-set last, so the oldest remembered failure is the one forgotten.
    ports.failures.set(pending.workItemId, attempt);
    for (const id of ports.failures.keys()) {
      if (ports.failures.size <= FAILURES_REMEMBERED) break;
      ports.failures.delete(id);
    }
    return { outcome: "retry", reason: "tier_evidence_unavailable",
      workItemId: pending.workItemId, attempt, ...failure };
  }
  const t1 = t1Candidate(pending, stored);
  const review = t1 || !ports.reviewPrEnabled() ? null :
    reviewCandidate(pending, stored);
  const candidate = t1 ?? review;
  const named = stored === null ? null : !stored.ok ? stored.reason :
    stored.tier.tier !== "T1" ? "tier_two" : null;
  const reason = named && REASON.test(named) &&
    named !== ENGINEERING_AGENT_V22_TIER_PENDING_REASON ? named :
    "tier_evidence_unavailable";
  const draft = { workItemId: pending.workItemId, runId: pending.runId,
    taskId: pending.taskId, patchDigest: pending.patchDigest,
    baseSha: pending.baseSha };
  const keep = async (why: string) => {
    const kept = await ports.resolve({ ...draft, reason: why, candidate: null });
    return "kept" in kept && kept.kept ? { outcome: "kept" as const, reason: why,
      ...(failure ? { workItemId: pending.workItemId, attempt, ...failure } : {}) } :
      { outcome: "stale" as const };
  };
  if (!candidate) return keep(reason);
  let promoted;
  try {
    promoted = await ports.resolve({ ...draft, reason, candidate,
      ownerReview: review !== null });
  } catch (error) {
    // The switch, consent or queue changed since it was read.
    if (refused(error)) return keep("publish_refused");
    throw error;
  }
  return !("publishWorkItemId" in promoted) ? { outcome: "stale" } :
    review ? { outcome: "review_promoted" } : { outcome: "promoted" };
}

let running: Promise<unknown> | null = null;

/** The publisher's claim starts this after answering: one round at a
 * time in this process, and a failure is logged, never retried here. */
export function startEngineeringAgentV22TierPromotion(): Promise<unknown> {
  running ??= promoteEngineeringAgentV22Draft()
    .then((result) => console.info(JSON.stringify({
      subsystem: "engineering_agent", event: "v22_tier_promotion", ...result })))
    .catch((error) => console.warn(JSON.stringify({
      subsystem: "engineering_agent", event: "v22_tier_promotion_failed",
      error: error instanceof Error ? error.name : "unknown",
      code: typeof error?.code === "string" ? error.code : null })))
    .finally(() => { running = null; });
  return running;
}
