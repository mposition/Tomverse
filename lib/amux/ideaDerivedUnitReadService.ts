import "server-only";

import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { readVerifiedAmuxCardProposal } from
  "./ideaUnitProposalReadService.ts";
import { readAmuxV4Derivation } from "./ideaDerivationService.ts";

export async function readAmuxV4DerivedUnitPage(session: Session, input: {
  ideaId: string; chunkIndex: number; afterId: string | null;
}) {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) ||
      getAdminRole(session) !== "owner" ||
      !/^[A-Za-z0-9:_-]{8,80}$/.test(input.ideaId) ||
      !Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0 ||
      (input.afterId !== null &&
        !/^[A-Za-z0-9_-]{8,80}$/.test(input.afterId))) {
    throw new Error("derived_unit_not_found");
  }
  const rows = await prisma.amuxIdeaDraftUnit.findMany({ where: {
    ideaId: input.ideaId, actorUserId, chunkIndex: input.chunkIndex,
    derivationGroupId: { not: null },
    ...(input.afterId ? { id: { gt: input.afterId } } : {}),
  }, select: { id: true, localRef: true, state: true,
    bodyDigest: true, bodyDigestKeyId: true,
    derivationGroupId: true },
  orderBy: { id: "asc" }, take: 11 });
  const page = rows.slice(0, 10);
  const units = [];
  const verifiedGroups = new Map<string, Set<string>>();
  for (const row of page) {
    if (!row.localRef || !["proposed", "approved", "rejected", "expired"]
        .includes(row.state) || !row.derivationGroupId) {
      throw new Error("derived_unit_integrity_unavailable");
    }
    let targets = verifiedGroups.get(row.derivationGroupId);
    if (!targets) {
      const group = await prisma.amuxIdeaDerivationGroup.findFirst({ where: {
        id: row.derivationGroupId, ideaId: input.ideaId, actorUserId,
      }, select: { requestId: true } });
      if (!group) throw new Error("derived_unit_integrity_unavailable");
      const verified = await readAmuxV4Derivation(session, group.requestId);
      if (verified.state !== "approved") {
        throw new Error("derived_unit_integrity_unavailable");
      }
      targets = new Set(verified.targetUnitIds);
      verifiedGroups.set(row.derivationGroupId, targets);
    }
    if (!targets.has(row.id)) throw new Error("derived_unit_integrity_unavailable");
    const verified = row.state === "proposed"
      ? await readVerifiedAmuxCardProposal(session, input.ideaId, row.id) : null;
    units.push({ id: row.id, localRef: row.localRef,
      bodyDigest: row.bodyDigest, bodyDigestKeyId: row.bodyDigestKeyId,
      decisionState: row.state,
      proposal: verified?.proposal ?? null });
  }
  return { units, nextCursor: rows.length > 10 ? page.at(-1)!.id : null };
}
