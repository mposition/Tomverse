import "server-only";

import { Prisma } from "@prisma/client";

import type { TeamBoardExtras } from "@/lib/adminAgentTeamBoardCore";
import { readAgentOfficeLiveRooms } from "@/lib/agentOfficeLiveRead";
import type { AgentOfficeLiveRooms } from "@/lib/agentOffice/live";
import { parseMarketingLlmMonthlyCap } from "@/lib/marketingLlmBudgetCore";
import { MARKETING_LLM_COUNTED_MICRO_USD_SQL } from "@/lib/marketingLlmBudgetStore";
import { readMarketingLlmSettings } from "@/lib/marketingLlmSettingsStore";
import { prisma } from "@/lib/prisma";
import { nextScoutRunAt } from "@/lib/productResearchScoutCore";
import { suggestionCounts } from "@/lib/productResearchScoutStore";

export type TeamBoardRead = {
  /** Null when the office's live read as a whole could not run. */
  rooms: AgentOfficeLiveRooms | null;
  extras: TeamBoardExtras;
  readAt: string;
};

const settle = async <T>(read: string, run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch {
    // The error text is not logged: a database error can carry query text.
    console.warn({ event: "admin_agent_team_board_read_failed", read });
    return null;
  }
};

/**
 * Everything the Team board draws, read-only: the office's own live read of
 * each team, plus the three figures the office does not carry. No part writes,
 * calls a team's service or reaches an outside system; a part that fails is
 * null and the board says so rather than showing zero.
 */
export async function readTeamBoard(now: Date = new Date()): Promise<TeamBoardRead> {
  const [rooms, researchCounts, marketingCost] = await Promise.all([
    settle("rooms", () => readAgentOfficeLiveRooms(now)),
    settle("research_open", () => suggestionCounts()),
    settle("marketing_cost", async () => {
      const [spent, settings] = await Promise.all([
        prisma.$queryRaw<Array<{ counted: bigint }>>(Prisma.sql`
          SELECT COALESCE(sum(${MARKETING_LLM_COUNTED_MICRO_USD_SQL}), 0)::bigint AS "counted"
          FROM "MarketingLlmCall"
          WHERE "monthStart" = date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')
        `),
        readMarketingLlmSettings(prisma),
      ]);
      const cap = settings.settings?.monthlyUsdCap ?? null;
      const capMicro = cap === null ? null : parseMarketingLlmMonthlyCap(cap);
      return { spentMicroUsd: Number(spent[0]?.counted ?? 0), capMicroUsd: capMicro };
    }),
  ]);
  return {
    rooms,
    extras: {
      researchOpen: researchCounts?.open ?? null,
      marketingCost,
      researchNextAt: nextScoutRunAt(now).toISOString(),
    },
    readAt: now.toISOString(),
  };
}
