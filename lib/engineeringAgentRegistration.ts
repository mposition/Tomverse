/**
 * The engineering agent's registration path (docs/policy/engineering-agent.md
 * §2.2; docs/policy/amux-intake.md version 2, "에이전트 등록 원천"). The app
 * pins the source, re-reads it itself, pre-filters deterministically, runs the
 * guard, and registers a `backlog` card through the AMUX agent intake writer,
 * with this agent's registration record in the same transaction. The drafting
 * service's proposal is a signal: nothing it claims about the source is taken
 * without the app reading the source again at the same pinned revision.
 *
 * Nothing here runs while the AMUX agent intake's latch or environment value
 * says no, while the registration switch is off, or while anything halts.
 */

import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  applyAmuxAgentIntakeCard,
  amuxAgentIntakeSourceKey,
  isAmuxAgentIntakeOpen,
  readAmuxAgentIntakeCard,
} from "@/lib/amux/agentIntake";
import { BOARD_IMPORT_SCANNER_VERSION } from "@/lib/amux/boardImportCore";
import { AMUX_INTAKE_SOURCE_KEY_SECRET_ENV } from "@/lib/amux/intakeRegistrationCore";
import {
  readEngineeringAgentBacklogAt,
  readEngineeringAgentBacklogHead,
  readEngineeringAgentCheckRunsAt,
  readEngineeringAgentDependabotFailures,
  readEngineeringAgentDevelopChecks,
} from "@/lib/engineeringAgentGitHubRead";
import {
  ciFailureItem,
  dependabotFailureItem,
  guardRegistrationProposal,
  parseBacklogItems,
  prefilterItems,
  registrationSourceIdentity,
  type RegistrationItem,
  type RegistrationRefusal,
  type RegistrationSource,
} from "@/lib/engineeringAgentRegistrationGuard";
import {
  EngineeringAgentStoreRefusedError,
  engineeringAgentTransactionInAmux,
  recordEngineeringAgentRegistration,
  readEngineeringAgentSwitches,
  recordEngineeringAgentRegistrationReadBack,
  runEngineeringAgentTransaction,
  type EngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

/** The closed AMUX source system of each registration source (intake version 2). */
export const ENGINEERING_AGENT_REGISTRATION_SOURCE_SYSTEMS = {
  S1: "engineering-product-backlog",
  S2: "engineering-develop-ci",
  S3: "engineering-dependabot-ci",
} as const satisfies Record<RegistrationSource, string>;

/** A pre-filtered item, with the revision it was read at and its canonical identity (intake version 2). */
export type RegistrationCandidate = RegistrationItem & {
  pinnedCommit: string;
  /** The ordered, fixed-separator tuple the card's source key is the HMAC of. */
  canonicalIdentity: string;
};

type Deps = { env?: Readonly<Record<string, string | undefined>>; fetchImpl?: typeof fetch };

const secretFrom = (env: Readonly<Record<string, string | undefined>>) => {
  const secret = env[AMUX_INTAKE_SOURCE_KEY_SECRET_ENV] ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) throw new EngineeringAgentStoreRefusedError("source_key_unconfigured");
  return secret;
};

/** Every item the source holds at the pin, before any filter. */
async function sourceItems(source: RegistrationSource, pinnedCommit: string | null, deps: Deps) {
  if (source === "S1") {
    const pin = pinnedCommit ?? (await readEngineeringAgentBacklogHead(deps));
    const parsed = parseBacklogItems(await readEngineeringAgentBacklogAt(pin, deps));
    return {
      candidates: parsed.items.map((item) => ({
        ...item,
        pinnedCommit: pin,
        canonicalIdentity: `${ENGINEERING_AGENT_REGISTRATION_SOURCE_SYSTEMS.S1}|${item.key}`,
      })),
      ambiguousKeys: parsed.ambiguousKeys,
    };
  }
  if (source === "S2") {
    const read =
      pinnedCommit === null
        ? await readEngineeringAgentDevelopChecks(deps)
        : { headSha: pinnedCommit, checkRuns: await readEngineeringAgentCheckRunsAt(pinnedCommit, deps) };
    const candidates: RegistrationCandidate[] = [];
    for (const run of read.checkRuns) {
      if (run.conclusion === null) continue;
      const item = ciFailureItem({ checkName: run.name, headSha: read.headSha, conclusion: run.conclusion });
      if (item === null) continue;
      candidates.push({
        ...item,
        pinnedCommit: read.headSha,
        canonicalIdentity: `${ENGINEERING_AGENT_REGISTRATION_SOURCE_SYSTEMS.S2}|${read.headSha}|${run.id}`,
      });
    }
    return { candidates, ambiguousKeys: [] as string[] };
  }
  const pulls = await readEngineeringAgentDependabotFailures(deps);
  const candidates: RegistrationCandidate[] = [];
  for (const pull of pulls) {
    if (pinnedCommit !== null && pull.headSha !== pinnedCommit) continue;
    const item = dependabotFailureItem(pull);
    if (item === null) continue;
    candidates.push({
      ...item,
      pinnedCommit: pull.headSha,
      canonicalIdentity: `${ENGINEERING_AGENT_REGISTRATION_SOURCE_SYSTEMS.S3}|${pull.prNumber}|${pull.headSha}`,
    });
  }
  return { candidates, ambiguousKeys: [] as string[] };
}

/**
 * The items the drafting service may analyse (§2.2 step 1): the source read
 * by the app at one pinned revision, less anything done, held, ambiguous,
 * already a card or already proposed and waiting.
 */
export async function readEngineeringAgentRegistrationCandidates(
  input: { source: RegistrationSource; pinnedCommit?: string | null },
  deps: Deps = {},
): Promise<{ eligible: RegistrationCandidate[]; excluded: Array<{ key: string; reason: string }> }> {
  const env = deps.env ?? process.env;
  const secret = secretFrom(env);
  const { candidates, ambiguousKeys } = await sourceItems(input.source, input.pinnedCommit ?? null, deps);
  const sourceSystem = ENGINEERING_AGENT_REGISTRATION_SOURCE_SYSTEMS[input.source];
  const keyOf = new Map(candidates.map((candidate) => [amuxAgentIntakeSourceKey(secret, candidate.canonicalIdentity), candidate]));
  const cards = await prisma.amuxWorkItem.findMany({
    where: { sourceSystem, sourceKey: { in: [...keyOf.keys()].filter((key): key is string => key !== null) } },
    select: { sourceKey: true },
  });
  const existing = new Set(
    cards
      .map((card) => (card.sourceKey === null ? undefined : keyOf.get(card.sourceKey)))
      .filter((candidate): candidate is RegistrationCandidate => candidate !== undefined)
      .map((candidate) => registrationSourceIdentity(candidate.source, candidate.key)),
  );
  const waiting = await prisma.engineeringAgentRegistration.findMany({
    where: { source: input.source, result: { in: ["pending", "partial"] } },
    select: { source: true, itemKey: true },
  });
  const pending = new Set(
    waiting.map((row) => registrationSourceIdentity(row.source as RegistrationSource, row.itemKey)),
  );
  const { eligible, excluded } = prefilterItems({
    items: candidates,
    ambiguousKeys,
    existingSourceIdentities: existing,
    pendingSourceIdentities: pending,
  });
  return { eligible: eligible as RegistrationCandidate[], excluded };
}

/** The cap counts, as the registration trigger counts them. */
async function registrationCounts(roundId: string) {
  const rows = await prisma.$queryRaw<Array<{ thisRound: bigint; todayUtc: bigint; unpromoted: bigint }>>`
    SELECT
      (SELECT count(*) FROM "EngineeringAgentRegistration" r
        WHERE r."roundId" = ${roundId} AND r."result" NOT IN ('registration_refused', 'absent')) AS "thisRound",
      (SELECT count(*) FROM "EngineeringAgentRegistration" r
        WHERE r."createdAt" >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
          AND r."result" NOT IN ('registration_refused', 'absent')) AS "todayUtc",
      (SELECT count(*) FROM "EngineeringAgentRegistration" r
        LEFT JOIN "AmuxWorkItem" c ON c."id" = r."amuxCardId"
        WHERE r."result" IN ('pending', 'partial')
           OR (r."result" = 'registered' AND c."status" = 'backlog' AND c."archivedAt" IS NULL)) AS "unpromoted"
  `;
  const row = rows[0];
  return { thisRound: Number(row.thisRound), todayUtc: Number(row.todayUtc), unpromoted: Number(row.unpromoted) };
}

const CAP_REFUSALS: ReadonlySet<RegistrationRefusal> = new Set([
  "round_cap_reached",
  "daily_cap_reached",
  "unpromoted_cap_reached",
]);

const ITEM_KEY = /^[!-~]{1,120}$/;

/** The guard's own digest of a proposal, for a refusal that is recorded; null if its fields are not all text. */
const proposalDigestOf = (proposal: Record<string, unknown>): string | null => {
  const { completion, itemDigest, itemKey, scope, source, title } = proposal;
  if ([completion, itemDigest, itemKey, scope, source, title].some((field) => typeof field !== "string")) return null;
  return createHash("sha256")
    .update(JSON.stringify({ completion, itemDigest, itemKey, scope, source, title }), "utf8")
    .digest("hex");
};
const SHA256 = /^[0-9a-f]{64}$/;

type MarkCommitted = (tx: EngineeringAgentTransaction, resultRef?: string) => Promise<void>;

// The registration attachment: the writer's audit-chain lock, the switch
// read, the halt lock (two) and state (four), the row's insert and move, its
// audit entry (four) and the request's move -- fifteen, and one to spare.
const REGISTRATION_PRISMA_CALLS = 16;

export type RegistrationOutcome =
  /** `created` is null when a read-back, not the answer, established the card. */
  | { registered: true; registrationId: string; cardId: string; created: boolean | null }
  | { registered: false; reason: string; registrationId: string | null };

/**
 * One proposal, judged and -- if the guard allows it -- registered (§2.2
 * steps 3 and 4). A refusal is recorded when the proposal names a source item
 * well enough to record and no cap refused it (a capped proposal cannot be
 * inserted, which is the cap). An answer lost after the AMUX commit is read
 * back once and recorded as found; it is never retried.
 */
export async function proposeEngineeringAgentRegistration(
  input: {
    roundId: string;
    source: RegistrationSource;
    pinnedCommit: string;
    proposal: unknown;
    markCommitted?: MarkCommitted;
  },
  deps: Deps = {},
): Promise<RegistrationOutcome> {
  const env = deps.env ?? process.env;
  // The cheap refusals first: nothing is read from GitHub for a closed path.
  if (!isAmuxAgentIntakeOpen(env)) return { registered: false, reason: "agent_intake_closed", registrationId: null };
  if (!(await readEngineeringAgentSwitches(prisma, env)).registrationAllowed) {
    return { registered: false, reason: "registration_switched_off", registrationId: null };
  }
  const secret = secretFrom(env);
  const { eligible } = await readEngineeringAgentRegistrationCandidates(
    { source: input.source, pinnedCommit: input.pinnedCommit },
    deps,
  );
  const verdict = guardRegistrationProposal({
    proposal: input.proposal,
    eligible,
    counts: await registrationCounts(input.roundId),
  });
  const proposal = (input.proposal ?? {}) as Record<string, unknown>;
  const registrationId = randomUUID();
  const base = {
    id: registrationId,
    source: input.source,
    pinnedCommit: input.pinnedCommit,
    itemKey: typeof proposal.itemKey === "string" ? proposal.itemKey : "",
    itemDigest: typeof proposal.itemDigest === "string" ? proposal.itemDigest : "",
    roundId: input.roundId,
  };

  if (verdict.outcome === "refuse") {
    const digest = proposalDigestOf(proposal);
    const recordable =
      digest !== null && !CAP_REFUSALS.has(verdict.reason) && ITEM_KEY.test(base.itemKey) && SHA256.test(base.itemDigest);
    if (!recordable) {
      return { registered: false, reason: verdict.reason, registrationId: null };
    }
    await runEngineeringAgentTransaction(prisma, async (tx) => {
      await recordEngineeringAgentRegistration(tx, {
        ...base,
        proposalDigest: digest,
        guardResult: verdict.reason,
        result: "registration_refused",
        amuxCardId: null,
      });
      await input.markCommitted?.(tx, registrationId);
    });
    return { registered: false, reason: verdict.reason, registrationId };
  }

  const candidate = eligible.find((item) => item.source === input.source && item.key === base.itemKey);
  if (candidate === undefined) throw new EngineeringAgentStoreRefusedError("candidate_missing");
  const sourceKey = amuxAgentIntakeSourceKey(secret, candidate.canonicalIdentity);
  if (sourceKey === null) throw new EngineeringAgentStoreRefusedError("source_key_unconfigured");
  const card = {
    agentId: "engineering-agent" as const,
    sourceSystem: ENGINEERING_AGENT_REGISTRATION_SOURCE_SYSTEMS[input.source],
    sourceKey,
    sourceVersion: candidate.pinnedCommit,
    sourceDigest: verdict.card.itemDigest,
    title: verdict.card.title,
    priority: verdict.card.priority,
    proposalDigest: verdict.card.proposalDigest,
    scannerVersion: BOARD_IMPORT_SCANNER_VERSION,
  };
  const record = { ...base, proposalDigest: verdict.card.proposalDigest, guardResult: "allowed" };

  let applied: Awaited<ReturnType<typeof applyAmuxAgentIntakeCard>>;
  try {
    applied = await applyAmuxAgentIntakeCard(
      { card, actor: "engineering-agent-registrar" },
      {
        prismaCalls: REGISTRATION_PRISMA_CALLS,
        work: async (lent, fact) => {
          const tx = engineeringAgentTransactionInAmux(lent);
          await recordEngineeringAgentRegistration(tx, { ...record, result: "registered", amuxCardId: fact.cardId });
          await input.markCommitted?.(tx, registrationId);
        },
      },
    );
  } catch (error) {
    if (error instanceof EngineeringAgentStoreRefusedError) throw error;
    // The answer was lost: read the three facts once (intake version 2).
    const [found, row] = await Promise.all([
      readAmuxAgentIntakeCard(prisma, { sourceSystem: card.sourceSystem, sourceKey, sourceDigest: card.sourceDigest }),
      prisma.engineeringAgentRegistration.findUnique({ where: { id: registrationId }, select: { amuxCardId: true } }),
    ]);
    if (found.cardId !== null && found.auditFound && row?.amuxCardId === found.cardId) {
      return { registered: true, registrationId, cardId: found.cardId, created: null };
    }
    if (row !== null) throw error;
    const outcome = found.cardId === null && !found.auditFound ? "absent" : "partial";
    await runEngineeringAgentTransaction(prisma, (tx) =>
      recordEngineeringAgentRegistrationReadBack(tx, { ...record, found: outcome }),
    );
    return { registered: false, reason: `outcome_${outcome}`, registrationId };
  }
  if (applied.registered) {
    return { registered: true, registrationId, cardId: applied.cardId, created: applied.created };
  }
  if (applied.reason === "apply_disabled") {
    return { registered: false, reason: "agent_intake_closed", registrationId: null };
  }
  // The identity already holds a card with another digest.
  await runEngineeringAgentTransaction(prisma, async (tx) => {
    await recordEngineeringAgentRegistration(tx, {
      ...record,
      guardResult: "source_conflict",
      result: "registration_refused",
      amuxCardId: null,
    });
    await input.markCommitted?.(tx, registrationId);
  });
  return { registered: false, reason: "source_conflict", registrationId };
}

