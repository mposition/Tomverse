/**
 * What the Admin Console shows of the product-research agent
 * (docs/policy/product-research-agent.md §4). Read only, and there is nothing
 * on this screen to decide: the agent records observations and makes no
 * proposal, so the section has no approve or reject control.
 *
 * Every judgement here is computed by the pure functions in
 * `productResearchObservationCore.mjs` and reported, never applied. The phase
 * transitions the windows describe are an operator's to sign; a screen that
 * flipped a phase because its own arithmetic said so would be the agent
 * deciding its own graduation.
 */

import "server-only";

import {
  OBSERVATION_HEADING,
  OBSERVATION_RETENTION_DAYS,
  OBSERVATION_SILENCE_HOURS,
  P1_WINDOW_SLOTS,
  P2_WINDOW_SLOTS,
  displayableObservationSlot,
  observationLabel,
  observationSilenceVerdict,
  observationSlotSeries,
  p1WindowJudgement,
  p2WindowJudgement,
  observationSummaryView,
} from "@/lib/productResearchObservationCore.mjs";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import { prisma } from "@/lib/prisma";
import {
  latestProductResearchSuccess,
  readProductResearchEnabledSince,
} from "@/lib/productResearchObservationStore";
import { slotForInstant } from "@/lib/productResearchObservationRunnerCore.mjs";

/** How many slots the screen lists, and says it lists. */
export const PRODUCT_RESEARCH_CONSOLE_LIMIT = 30;

export type ProductResearchIssueView = {
  id: string;
  title: string;
  verdict: string;
  verdictLabel: string | null;
  resolvedOn: string[];
  missingFrom: string[];
  blockedOnPresent: boolean;
  signals: unknown;
};

export type ProductResearchSlotView = {
  slot: string;
  state: "ok" | "failed" | "missing" | "duplicate";
  /** The state in words. `missing` is the one that needs saying. */
  stateLabel: string | null;
  failureStage: string | null;
  failureStageLabel: string | null;
  issueCount: number | null;
  developSha: string | null;
  mainSha: string | null;
  payloadDigest: string | null;
  submittedAt: string | null;
};

export type ProductResearchConsoleView = {
  /** Whether the app side is switched on. Off means this agent stores nothing. */
  enabled: boolean;
  /** The heading the policy fixes, so the screen cannot be read as advice. */
  heading: string;
  limit: number;
  retentionDays: number;
  silenceHours: number;
  silence: { state: string; sinceHours: number | null; measuredFrom: string | null };
  lastSuccessAt: string | null;
  /** When the app side was first seen switched on, or null. */
  enabledSince: string | null;
  slots: ProductResearchSlotView[];
  /**
   * The rows of the slot that just passed, and only when it succeeded.
   * `null` when it failed, has no row, or when none was ever recorded --
   * `latestOmitted` says which.
   */
  latest: {
    slot: string;
    developSha: string;
    mainSha: string;
    payloadDigest: string;
    issues: ProductResearchIssueView[];
    /**
     * The slot's own distribution, recomputed from the rows beside it.
     *
     * Counting a column by eye is the operator's job only until the column is
     * long: the row limit is 200, and the P2 gate
     * (docs/policy/product-research-agent.md §9) is a comparison of exactly this
     * distribution against a local run. `null` when the stored payload does not
     * have the shape to say -- an unknown count is not a zero.
     */
    summary: ProductResearchSummaryView | null;
    counts: unknown;
    blindSpots: unknown;
  } | null;
  /** Why `latest` is null: never recorded, or the current slot did not succeed. */
  latestOmitted: "none" | "never_recorded" | "current_slot_not_recorded";
  windows: {
    p1: ReturnType<typeof p1WindowJudgement>;
    p2: ReturnType<typeof p2WindowJudgement>;
  };
};

type StoredPayload = {
  issues: {
    id: string;
    title: string;
    verdict: string;
    resolvedOn: string[];
    missingFrom: string[];
    blockedOnPresent: boolean;
    signals: unknown;
  }[];
  counts: unknown;
  blindSpots: unknown;
};

/**
 * What the newest slot adds up to.
 *
 * Every verdict the vocabulary has, in the policy's own order and including
 * the zeroes: a distribution with the zeroes dropped cannot be compared
 * against another one, because "this verdict did not occur" and "this verdict
 * is not in that build" would look the same.
 *
 * The vocabulary is read from the label table rather than from a second list,
 * so the screen can only count verdicts it is also able to name.
 */
export type ProductResearchSummaryView = {
  issueCount: number;
  verdicts: { verdict: string; label: string | null; count: number }[];
  blindSpots: { noSignalIssues: number; oneBranchOnly: number };
  /** False when the stored counts disagree with the rows stored beside them. */
  storedCountsAgree: boolean;
};

export async function readProductResearchConsole(
  now: Date = new Date(),
): Promise<ProductResearchConsoleView> {
  const enabled = isProductResearchRouteEnabled();

  // The P2 window is the longest thing the screen judges, so one read serves
  // the list and both windows. Ordered by slot rather than by submittedAt: the
  // slot is what the series is indexed by, and the two agree except for a row
  // whose submission was late, which the window is the thing that notices.
  const rows = enabled
    ? await prisma.productResearchObservation.findMany({
        select: {
          slot: true,
          outcome: true,
          failureStage: true,
          issueCount: true,
          developSha: true,
          mainSha: true,
          payloadDigest: true,
          submittedAt: true,
        },
        orderBy: { slot: "desc" },
        take: Math.max(PRODUCT_RESEARCH_CONSOLE_LIMIT, P2_WINDOW_SLOTS),
      })
    : [];

  // The series runs back from the slot a run of this moment answers for, not
  // from the newest stored row: a table whose newest row is a week old would
  // otherwise show a full clean window, because the week nothing ran would not
  // be in it.
  const endSlot = slotForInstant(now.getTime());
  const series = observationSlotSeries(rows, {
    endSlot,
    count: Math.max(PRODUCT_RESEARCH_CONSOLE_LIMIT, P2_WINDOW_SLOTS),
  });

  const bySlot = new Map(rows.map((row) => [row.slot.toISOString(), row]));
  const slots: ProductResearchSlotView[] = series
    .slice(0, PRODUCT_RESEARCH_CONSOLE_LIMIT)
    .map((entry) => {
      const row = bySlot.get(entry.slot);
      return {
        slot: entry.slot,
        state: entry.state,
        stateLabel: observationLabel("slotState", entry.state),
        failureStage: row?.failureStage ?? null,
        failureStageLabel: row?.failureStage
          ? observationLabel("failureStage", row.failureStage)
          : null,
        issueCount: row?.issueCount ?? null,
        developSha: row?.developSha ?? null,
        mainSha: row?.mainSha ?? null,
        payloadDigest: row?.payloadDigest ?? null,
        submittedAt: row?.submittedAt.toISOString() ?? null,
      };
    });

  // Two different questions, and they must not share an answer.
  //
  // The silence check asks when this agent last worked, so it looks back for
  // the newest success however old. The screen's "newest recorded slot" asks
  // what the current state of the backlog is, and only the slot that just
  // passed can answer that: showing yesterday's rows under today's failed or
  // missing slot would put an earlier success's content on a screen reporting
  // no update, which the policy forbids
  // (docs/policy/product-research-agent.md §2, condition 8). Yesterday's
  // observation is not wrong, but it is not the answer to the question the
  // heading asks.
  //
  // So the first question gets its own query. Answered from the rows above it
  // would be bounded by them: thirty failures would hide a success still well
  // inside the ninety-day retention, and the screen would report a silence the
  // maintenance incident -- which asks unbounded -- does not. Two readings of
  // one fact, disagreeing, is worse than either.
  const newestSuccess = enabled ? await latestProductResearchSuccess() : null;
  const displayable = displayableObservationSlot(series, {
    // Any row, not just a successful one. Keyed on successes, a table holding
    // nothing but failures would be captioned "nothing was ever recorded" --
    // which contradicts the failures printed above it, and the two absences
    // exist precisely so the screen can tell them apart.
    everRecorded: rows.length > 0,
  });

  // Reads the anchor, and writes it the first time the switch is seen on.
  const enabledSince = enabled ? await readProductResearchEnabledSince(now) : null;

  // The payload is read in its own query, for the one slot being displayed: it
  // is the only large column, and loading thirty of them to show one would put
  // thirty observations into the HTML.
  const latestRow =
    displayable.slot === null
      ? null
      : await prisma.productResearchObservation.findUnique({
          where: { slot: new Date(displayable.slot) },
          select: {
            slot: true,
            developSha: true,
            mainSha: true,
            payloadDigest: true,
            payload: true,
          },
        });

  const payload = (latestRow?.payload ?? null) as StoredPayload | null;

  return {
    enabled,
    // Fixed copy from the policy, so the table cannot be presented as a
    // recommendation by whoever lays out the section.
    heading: OBSERVATION_HEADING,
    limit: PRODUCT_RESEARCH_CONSOLE_LIMIT,
    retentionDays: OBSERVATION_RETENTION_DAYS,
    silenceHours: OBSERVATION_SILENCE_HOURS,
    silence: observationSilenceVerdict({
      enabled,
      lastSuccessAt: newestSuccess?.getTime() ?? null,
      // The anchor outlives the rows, so the screen keeps saying how long it has
      // been after the retention sweep has removed every row there was.
      enabledSince: enabledSince?.getTime() ?? null,
      now: now.getTime(),
    }),
    lastSuccessAt: newestSuccess?.toISOString() ?? null,
    enabledSince: enabledSince?.toISOString() ?? null,
    slots,
    latest:
      latestRow === null || payload === null
        ? null
        : {
            slot: latestRow.slot.toISOString(),
            developSha: latestRow.developSha ?? "",
            mainSha: latestRow.mainSha ?? "",
            payloadDigest: latestRow.payloadDigest ?? "",
            issues: payload.issues.map((issue) => ({
              id: issue.id,
              title: issue.title,
              verdict: issue.verdict,
              verdictLabel: observationLabel("verdict", issue.verdict),
              resolvedOn: issue.resolvedOn,
              missingFrom: issue.missingFrom,
              blockedOnPresent: issue.blockedOnPresent,
              signals: issue.signals,
            })),
            summary: observationSummaryView(payload),
            counts: payload.counts,
            blindSpots: payload.blindSpots,
          },
    latestOmitted: displayable.omitted,
    windows: {
      p1: p1WindowJudgement(series, { windowSlots: P1_WINDOW_SLOTS }),
      p2: p2WindowJudgement(series, { windowSlots: P2_WINDOW_SLOTS }),
    },
  };
}
