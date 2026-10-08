import "server-only";

import type { Prisma } from "@prisma/client";

import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { AmuxV4UnitDecisionError } from "./ideaUnitDecisionStore.ts";

type CardReference = NonNullable<
  NonNullable<AmuxIdeaUnitConfirmationSnapshot["card"]>["parentStory"]>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const statuses = new Set<CardReference["status"]>([
  "backlog", "todo", "doing", "review", "done", "blocked",
]);

async function resolveReference(tx: Prisma.TransactionClient, input: {
  ideaId: string; actorUserId: string; ref: string;
  expectedType: "story" | "task"; featureNodeId: string;
}): Promise<CardReference> {
  let cardId = input.ref;
  if (!UUID.test(input.ref)) {
    const unit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
      ideaId: input.ideaId, actorUserId: input.actorUserId,
      localRef: input.ref, unitKind: "card", state: "approved",
    }, select: { id: true } });
    const decision = unit ? await tx.amuxIdeaUnitDecision.findFirst({ where: {
      ideaId: input.ideaId, actorUserId: input.actorUserId,
      draftUnitId: unit.id, action: "register_card", state: "consumed",
      registeredWorkItemId: { not: null },
    }, select: { registeredWorkItemId: true } }) : null;
    if (!decision?.registeredWorkItemId) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
    cardId = decision.registeredWorkItemId;
  }
  const card = await tx.amuxWorkItem.findUnique({ where: { id: cardId },
    select: { id: true, cardType: true, sourceSystem: true,
      status: true, archivedAt: true, revision: true,
      parentFeatureNodeId: true, v4TitleDigest: true,
      v4TitleDigestKeyId: true, v4SourceApprovalId: true },
  });
  const decision = card?.v4SourceApprovalId ?
    await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: card.v4SourceApprovalId },
      select: { action: true, state: true, registeredWorkItemId: true },
    }) : null;
  if (!card || card.sourceSystem !== "admin-idea-v4" ||
      card.cardType !== input.expectedType ||
      card.archivedAt !== null || !statuses.has(card.status as CardReference["status"]) ||
      (input.expectedType === "story" &&
        (card.status !== "backlog" ||
          card.parentFeatureNodeId !== input.featureNodeId)) ||
      !card.parentFeatureNodeId || !card.v4TitleDigest ||
      !card.v4TitleDigestKeyId ||
      decision?.action !== "register_card" ||
      decision.state !== "consumed" ||
      decision.registeredWorkItemId !== card.id) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return { id: card.id, cardType: input.expectedType,
    featureNodeId: card.parentFeatureNodeId,
    sourceSystem: "admin-idea-v4", status: card.status as CardReference["status"],
    revision: card.revision,
    content: { digest: card.v4TitleDigest,
      keyId: card.v4TitleDigestKeyId } };
}

/** A Task may attach directly to a Feature, or to one approved Story under
 * that Feature. Dependencies may cross Features but must be approved Tasks. */
export async function resolveAmuxV4TaskReferences(
  tx: Prisma.TransactionClient, input: {
    ideaId: string; actorUserId: string; proposal: AmuxAnalysisCard;
    featureNodeId: string;
  }): Promise<{ parentStory: CardReference | null;
    dependencies: CardReference[] }> {
  const proposal = input.proposal;
  if (proposal.kind !== "card" || proposal.cardType !== "task" ||
      proposal.dependencyRefs.length > 16 ||
      new Set(proposal.dependencyRefs).size !== proposal.dependencyRefs.length) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const parentStory = proposal.parentStoryRef === null ? null :
    await resolveReference(tx, { ...input, ref: proposal.parentStoryRef,
      expectedType: "story" });
  const dependencies: CardReference[] = [];
  for (const ref of proposal.dependencyRefs) {
    dependencies.push(await resolveReference(tx, { ...input, ref,
      expectedType: "task" }));
  }
  if (new Set(dependencies.map((entry) => entry.id)).size !==
      dependencies.length ||
      dependencies.some((entry) => entry.id === parentStory?.id)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return { parentStory, dependencies };
}
