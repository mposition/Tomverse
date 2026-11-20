export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { recordEngineeringAgentMismatchReviewPullRequest } from "@/lib/engineeringAgentAmuxAdapter";
import { readEngineeringAgentPullMerge } from "@/lib/engineeringAgentGitHubRead";
import { mergedPrMismatchBindingId } from "@/lib/engineeringAgentStateMismatch";
import {
  ENGINEERING_AGENT_MISMATCH_CONSOLE_ACTIONS,
  type EngineeringAgentObservedMerge,
  lockEngineeringAgentMismatchAmuxRows,
  resolveEngineeringAgentStateMismatch,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// A person's action on a state mismatch (docs/policy/engineering-agent.md
// §11): both sides locked -- AMUX's rows first, in AMUX's order, then the
// engineering rows -- and read again before the action runs. Neither side is
// corrected to match the other. Recording the bound number on the card is a
// person's action too, but its AMUX write is the review pull request writer's:
// that writer's transaction carries the action (owner decision 2026-11-11).

const schema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    action: z.enum(ENGINEERING_AGENT_MISMATCH_CONSOLE_ACTIONS),
  })
  .strict();

/**
 * The pull request a C mismatch (`review_pr:<publish item>`) concerns: its
 * run's one current binding. The action reads the binding again under its
 * locks, so this read only chooses which pull request to ask GitHub about.
 */
async function mismatchPullNumber(workItemId: string): Promise<number | null> {
  const item = await prisma.engineeringAgentWorkItem.findUnique({
    where: { id: workItemId },
    select: { kind: true, causeKey: true },
  });
  if (!item || item.kind !== "state_mismatch") return null;
  // A merged pull request mismatch names its binding: that pull request.
  const bindingId = mergedPrMismatchBindingId(item.causeKey);
  if (bindingId !== null) {
    const binding = await prisma.engineeringAgentBinding.findUnique({
      where: { id: bindingId }, select: { prNumber: true, supersededAt: true } });
    return binding && binding.supersededAt === null ? binding.prNumber : null;
  }
  if (!item.causeKey.startsWith("review_pr:")) return null;
  const publish = await prisma.engineeringAgentWorkItem.findUnique({
    where: { id: item.causeKey.slice("review_pr:".length) },
    select: { runId: true },
  });
  if (!publish?.runId) return null;
  const bindings = await prisma.engineeringAgentBinding.findMany({
    where: { runId: publish.runId, supersededAt: null },
    select: { prNumber: true },
  });
  return bindings.length === 1 ? bindings[0]!.prNumber : null;
}

/**
 * Closing on an observed merge reads GitHub with the app's read-only token
 * outside the transaction; the action then checks, under its locks, that the
 * merge is of the item's own current pull request. A read that fails decides
 * nothing: the action is refused as not observed.
 */
async function observeMerge(workItemId: string): Promise<EngineeringAgentObservedMerge | null> {
  const prNumber = await mismatchPullNumber(workItemId);
  if (prNumber === null) return null;
  try {
    const pull = await readEngineeringAgentPullMerge(prNumber);
    return {
      prNumber,
      merged: pull.merged,
      mergedAt: pull.mergedAt,
      mergeCommitSha: pull.mergeCommitSha,
      mergedByKind: pull.mergedByKind,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let observedMerge: EngineeringAgentObservedMerge | null = null;
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-mismatch",
    schema,
    beforeAuditLock: (tx, body) => lockEngineeringAgentMismatchAmuxRows(tx, body.workItemId),
    beforeTransaction: async (body) => {
      if (body.action === "close_after_observed_merge") observedMerge = await observeMerge(body.workItemId);
    },
    runInOwnWriter: ({ body, session }) =>
      body.action === "record_bound_review_pr"
        ? recordEngineeringAgentMismatchReviewPullRequest({ session, request, workItemId: body.workItemId })
        : null,
    run: (tx, { body, session }) =>
      resolveEngineeringAgentStateMismatch(tx, {
        session,
        request,
        workItemId: body.workItemId,
        action: body.action,
        observedMerge,
      }),
  });
}
