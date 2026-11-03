import "server-only";

import { prisma } from "@/lib/prisma";
import {
  QA_RELEASE_TRAIN_CANDIDATE_DAYS,
  qaReleaseTrainWithContentVerdicts,
  qaReleaseTrainWithTrainVerdicts,
} from "@/lib/qaReleaseTrainCargoCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { readQaReleaseTrainFoundOnMain, readQaReleaseTrainVerdicts } from "@/lib/qaReleaseTrainStore";
import { amuxIdeaLaneDailyReport, type AmuxIdeaLaneDailyReport } from "./ideaLaneDailyReportCore.ts";

/**
 * The idea lane's daily report (lib/amux/ideaLaneDailyReportCore.ts) for the
 * release train tab. GitHub is the train cargo's shared read, so this report
 * spends no GitHub call of its own; on_main is read the way the cargo list
 * reads it, a train's or the content check's finding included.
 */
export async function readAmuxIdeaLaneDailyReport(nowMs = Date.now()): Promise<AmuxIdeaLaneDailyReport> {
  const since = new Date(nowMs - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000);
  const [attempts, read, foundOnMain, verdicts] = await Promise.all([
    // A pull request opened before it merged, so inside the cargo's window too.
    prisma.amuxIdeaLaneAttempt.findMany({
      where: { outcome: "pr_open", prNumber: { not: null }, claimedAt: { gte: since } },
      orderBy: { claimedAt: "desc" },
      take: 500,
      select: { prNumber: true, idea: { select: { requestId: true } } },
    }),
    readQaReleaseTrainCargoCandidates(nowMs),
    readQaReleaseTrainFoundOnMain(since),
    readQaReleaseTrainVerdicts(),
  ]);
  return amuxIdeaLaneDailyReport({
    attempts: attempts.map((row) => ({ prNumber: row.prNumber as number, ideaRequestId: row.idea.requestId })),
    read:
      read.status === "ok"
        ? {
            ...read,
            candidates: qaReleaseTrainWithContentVerdicts(
              qaReleaseTrainWithTrainVerdicts(read.candidates, foundOnMain),
              verdicts?.verdicts ?? [],
              verdicts?.mainSha ?? null,
            ),
          }
        : read,
    nowMs,
  });
}
