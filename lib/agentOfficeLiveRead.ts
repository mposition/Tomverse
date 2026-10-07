/**
 * What the Agent office reads of the agents it can show for real.
 *
 * Read only, and narrower than the agents' own sections: the office shows an
 * agent's operating state, never its content. For product research that
 * means the switch, today's slot and the newest success -- not the payload,
 * not issue titles, not counts (docs/policy/product-research-agent.md §4,
 * §8). Nothing here writes. In particular the silence anchor is looked up and
 * not created: `readProductResearchEnabledSince()` writes it on first sight,
 * which is the agent section's job, and a page that "writes nothing" must not
 * do it as a side effect of being opened.
 *
 * A failed read comes back as `unread` and is reported, never absorbed
 * (docs/ui-contracts/admin-console-ia.md, rules 5 and 8).
 */

import "server-only";

import type {
  AgentOfficeLiveRooms,
  AgentOfficeQaState,
  AgentOfficeResearchState,
} from "@/lib/agentOffice/live";
import { agentOfficeQaState } from "@/lib/agentOfficeQaState";
import { agentOfficeResearchState } from "@/lib/agentOfficeResearchState";
import { prisma } from "@/lib/prisma";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import {
  PRODUCT_RESEARCH_ENABLED_SINCE_SETTING,
  latestProductResearchSuccess,
} from "@/lib/productResearchObservationStore";
import { slotForInstant } from "@/lib/productResearchObservationRunnerCore.mjs";
import { QA_RELEASE_ROUTE_SECRET_ENV } from "@/lib/qaReleaseRouteAuthCore";

const parseInstant = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

async function readResearch(now: Date): Promise<AgentOfficeResearchState> {
  const enabled = isProductResearchRouteEnabled();
  if (!enabled) {
    return agentOfficeResearchState({ enabled, rows: [], lastSuccessAt: null, enabledSince: null, now });
  }
  try {
    const slot = new Date(slotForInstant(now.getTime()));
    const [rows, lastSuccessAt, anchor] = await Promise.all([
      prisma.productResearchObservation.findMany({
        where: { slot },
        select: { slot: true, outcome: true, failureStage: true },
      }),
      latestProductResearchSuccess(),
      prisma.appSetting.findUnique({
        where: { key: PRODUCT_RESEARCH_ENABLED_SINCE_SETTING },
        select: { value: true },
      }),
    ]);
    return agentOfficeResearchState({
      enabled,
      rows,
      lastSuccessAt,
      enabledSince: parseInstant(anchor?.value),
      now,
    });
  } catch {
    // The error itself is not logged: a database error can carry query text,
    // and the read's name is what an operator searches for.
    console.warn({ event: "admin_agent_office_read_failed", read: "product_research" });
    return { kind: "unread" };
  }
}

/**
 * QA and release: the newest control revision's number and switch, when the
 * newest digest was stored, and whether the merge lane is latched. The digest
 * body is not selected -- the office says whether a digest arrived, never
 * what it says.
 */
async function readQa(): Promise<AgentOfficeQaState> {
  try {
    const [control, latest, latch] = await Promise.all([
      prisma.qaReleaseOperatorControl.findFirst({
        orderBy: { revision: "desc" },
        select: { revision: true, digestEnabled: true },
      }),
      prisma.agentDigestItem.findFirst({
        where: { agentKey: "qa-release" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.qaReleaseMergeLaneLatch.findFirst({
        orderBy: { sequence: "desc" },
        select: { latched: true },
      }),
    ]);
    return agentOfficeQaState({
      // Usable means the same 32-character floor the monitor applies; the
      // value is never read beyond its length.
      digestSecretConfigured: (process.env[QA_RELEASE_ROUTE_SECRET_ENV.digest] ?? "").length >= 32,
      control,
      latestDigestAt: latest?.createdAt ?? null,
      mergeLaneLatched: latch?.latched === true,
      // Taken after the reads: a digest stored while they ran must not be
      // dated after the clock it is judged against.
      now: new Date(),
    });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "qa_release" });
    return { kind: "unread" };
  }
}

export async function readAgentOfficeLiveRooms(now: Date = new Date()): Promise<AgentOfficeLiveRooms> {
  const [research, qa] = await Promise.all([readResearch(now), readQa()]);
  return { readAt: now.toISOString(), research, qa };
}
