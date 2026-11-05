/**
 * Reading the DSR rows the stage 1 observer counts
 * (docs/policy/trust-safety-compliance-agent.md §1-1, §5.6).
 *
 * One read, one `select`, no writes. Both named entry points use this: E1 (the
 * observer's internal route) and E2 (the agent's section of the shared Agent
 * digest area, which §5.6 fixes at **zero writes**). Keeping the read here is
 * what lets E2 stay read-only without a second copy of the field list drifting
 * from this one.
 *
 * The `select` is an allowlist and §1-1 names its seven fields. It is written
 * out rather than derived, because a derived or spread selection is how a
 * column the policy did not allow — `email`, `note`, `handledByEmail` — arrives
 * later without anyone choosing it.
 *
 * Nothing here decides anything. The counting is
 * `lib/trustSafetyDsrCountsCore.ts`, which is pure; this module is the one line
 * of I/O in front of it, and it stores nothing: §1-2 says the digest section
 * recomputes on open and does not persist the counts.
 */
import type { DsrDeadlineCounts, DsrObservationRow } from "@/lib/trustSafetyDsrCountsCore";
import { countDsrDeadlines } from "@/lib/trustSafetyDsrCountsCore";

/**
 * The seven fields of §1-1, and only those.
 *
 * `status` is selected because §1-1 lists it; the counting deliberately does
 * not branch on it. Reading it without using it is the policy's choice, so the
 * observed row keeps the shape the policy describes.
 */
export const DSR_OBSERVATION_SELECT = {
  id: true,
  requestType: true,
  status: true,
  dueAt: true,
  legalHold: true,
  createdAt: true,
  completedAt: true,
} as const;

/** The only Prisma surface this module needs: one `findMany` over one model. */
export type DsrObservationReader = {
  readonly privacyRequest: {
    findMany: (args: {
      readonly select: typeof DSR_OBSERVATION_SELECT;
    }) => Promise<readonly DsrObservationRow[]>;
  };
};

/**
 * Reads every `PrivacyRequest` through the allowlist and counts the deadlines.
 *
 * No `where`: §1-1 counts "status와 무관하게" and keeps legal hold in the
 * denominator, so filtering in SQL would remove rows the counts are defined
 * over. The buckets are decided in the pure core, where they are tested.
 */
export const observeDsrDeadlines = async ({
  prisma,
  now,
  imminentWithinDays,
}: {
  readonly prisma: DsrObservationReader;
  readonly now: Date;
  readonly imminentWithinDays: number;
}): Promise<DsrDeadlineCounts> => {
  const rows = await prisma.privacyRequest.findMany({ select: DSR_OBSERVATION_SELECT });
  return countDsrDeadlines({ rows, now, imminentWithinDays });
};
