import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AMUX_CLI_MODEL_LINK_AUDIT_ACTION,
  AMUX_CLI_MODEL_LINK_AUDIT_TARGET_TYPE,
  buildAmuxCliModelCatalogAdminView,
  isAmuxCliModelCli,
  parseAmuxCliModelLinkChange,
  type AmuxCliModelCatalogAdminView,
  type AmuxCliModelLink,
  type AmuxCliModelLinkRefusal,
  type AmuxCliModelRefresh,
} from "@/lib/amux/cliModelCatalogCore";

/**
 * The one module that reads and writes `AmuxCliModel` and
 * `AmuxCliModelLinkEvent` (owner decision 2026-10-27). Every function runs on
 * a transaction its caller owns, with a fixed number of statements, because
 * the AMUX DB boundary budgets them (`AMUX_DB_BOUNDARIES.cliModelCatalogRead`,
 * `.cliModelLinkChange`, `.cliModelRefresh`). The cost catalog reads the links
 * in its own registry statement (lib/amux/v4TaskCostCatalogApprovalService.ts).
 */

type LinkRow = { cli: string; cliModel: string; pricedModelId: string | null };

const links = (rows: readonly LinkRow[]): AmuxCliModelLink[] =>
  rows.flatMap((row) => (isAmuxCliModelCli(row.cli) ? [{ cli: row.cli, cliModel: row.cliModel, pricedModelId: row.pricedModelId }] : []));

/**
 * The catalog for AMUX › Operations settings › Workers: what each CLI lists,
 * the owner's links, and every Admin › Models entry (retired ones too, so a
 * chip can say why). Three statements.
 */
export async function readAmuxCliModelCatalogForAdmin(
  tx: Prisma.TransactionClient,
): Promise<AmuxCliModelCatalogAdminView> {
  const observed = await tx.$queryRaw<Array<{
    cli: string; cliModel: string; displayName: string | null; listed: boolean; lastSeenAtMs: bigint | number;
  }>>`
    SELECT "cli", "cliModel", "displayName", "listed",
      floor(extract(epoch FROM "lastSeenAt") * 1000)::bigint AS "lastSeenAtMs"
    FROM "AmuxCliModel"
  `;
  // The newest link of every name.
  const linkRows = await tx.$queryRaw<LinkRow[]>`
    SELECT DISTINCT ON ("cli", "cliModel") "cli", "cliModel", "pricedModelId"
    FROM "AmuxCliModelLinkEvent"
    ORDER BY "cli", "cliModel", "sequence" DESC
  `;
  const registry = await tx.modelRegistryEntry.findMany({
    select: {
      id: true, name: true, apiModel: true, provider: true, catalogDeleted: true,
      enabled: true, status: true, replacementModelId: true,
    },
  });
  return buildAmuxCliModelCatalogAdminView({
    observed: observed.map((row) => ({
      cli: row.cli, cliModel: row.cliModel, displayName: row.displayName, listed: row.listed,
      lastSeenAt: new Date(Number(row.lastSeenAtMs)).toISOString(),
    })),
    links: links(linkRows),
    registry,
  });
}

export class AmuxCliModelLinkWriteError extends Error {
  readonly code: AmuxCliModelLinkRefusal | "invalid_change" | "no_operator";

  constructor(code: AmuxCliModelLinkWriteError["code"]) {
    super(code);
    this.name = "AmuxCliModelLinkWriteError";
    this.code = code;
  }
}

export type AmuxCliModelLinkRecord = { eventId: string; auditLogId: string; cli: string; cliModel: string; pricedModelId: string | null };

/**
 * The owner links one CLI model name to the Admin › Models entry that prices
 * it, or to nothing (held). In the caller's transaction: the audit chain lock,
 * the name's newest link, the target entry (it must exist and not be
 * retired), the human audit `amux.cli_model.link`, and the event naming it.
 * Statements: 1 lock, 2 reads, the audit writer's 3 (4 with an integrity
 * key), 1 insert. A refusal writes nothing.
 */
export async function recordAmuxCliModelLinkByOwner(
  tx: Prisma.TransactionClient,
  input: { session: Session; request?: Request; cli: unknown; cliModel: unknown; pricedModelId: unknown },
): Promise<AmuxCliModelLinkRecord> {
  const change = parseAmuxCliModelLinkChange(input);
  if (!change) throw new AmuxCliModelLinkWriteError("invalid_change");
  const actorUserId = input.session.user?.id;
  if (typeof actorUserId !== "string" || actorUserId.length === 0) {
    throw new AmuxCliModelLinkWriteError("no_operator");
  }

  await takeAuditChainLock(tx);
  const newest = await tx.$queryRaw<Array<{ pricedModelId: string | null }>>`
    SELECT "pricedModelId" FROM "AmuxCliModelLinkEvent"
    WHERE "cli" = ${change.cli} AND "cliModel" = ${change.cliModel}
    ORDER BY "sequence" DESC
    LIMIT 1
  `;
  if (newest[0] && newest[0].pricedModelId === change.pricedModelId) {
    throw new AmuxCliModelLinkWriteError("no_change");
  }
  if (change.pricedModelId !== null) {
    const target = await tx.modelRegistryEntry.findUnique({
      where: { id: change.pricedModelId },
      select: { catalogDeleted: true },
    });
    if (!target || target.catalogDeleted) throw new AmuxCliModelLinkWriteError("model_not_found");
  }

  const eventId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: AMUX_CLI_MODEL_LINK_AUDIT_ACTION,
    targetType: AMUX_CLI_MODEL_LINK_AUDIT_TARGET_TYPE,
    targetId: eventId,
    summary: change.pricedModelId === null
      ? "Held an AMUX CLI model name from pricing."
      : "Linked an AMUX CLI model name to the model that prices it.",
    metadata: {
      event_id: eventId,
      cli: change.cli,
      cli_model: change.cliModel,
      priced_model_id: change.pricedModelId,
      previous_priced_model_id: newest[0] ? newest[0].pricedModelId : null,
      previous_linked: newest[0] !== undefined,
    },
    tx,
  });
  await tx.$executeRaw`
    INSERT INTO "AmuxCliModelLinkEvent" ("id", "cli", "cliModel", "pricedModelId", "actorUserId", "auditLogId")
    VALUES (${eventId}, ${change.cli}, ${change.cliModel}, ${change.pricedModelId}, ${actorUserId}, ${auditLogId})
  `;
  return { eventId, auditLogId, cli: change.cli, cliModel: change.cliModel, pricedModelId: change.pricedModelId };
}

/**
 * Records what one CLI lists now, as the host read it: every listed name is
 * seen now (added when new), every other name of that CLI is no longer
 * listed. A system observation, so no audit. Two statements.
 */
export async function recordAmuxCliModelRefresh(
  tx: Prisma.TransactionClient,
  refresh: AmuxCliModelRefresh,
): Promise<{ listed: number; unlisted: number }> {
  const ids = refresh.models.map(() => randomUUID());
  const names = refresh.models.map((model) => model.cliModel);
  const displayNames = refresh.models.map((model) => model.displayName);
  const listed = await tx.$executeRaw`
    INSERT INTO "AmuxCliModel" ("id", "cli", "cliModel", "displayName", "listed", "firstSeenAt", "lastSeenAt")
    SELECT incoming."id", ${refresh.cli}, incoming."cliModel", incoming."displayName", true,
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    -- The several-array unnest is FROM-clause syntax, so it is not schema-qualified.
    FROM unnest(${ids}::text[], ${names}::text[], ${displayNames}::text[])
      AS incoming("id", "cliModel", "displayName")
    ON CONFLICT ("cli", "cliModel") DO UPDATE
      SET "displayName" = EXCLUDED."displayName", "listed" = true, "lastSeenAt" = pg_catalog.clock_timestamp()
  `;
  const unlisted = await tx.$executeRaw`
    UPDATE "AmuxCliModel" SET "listed" = false
    WHERE "cli" = ${refresh.cli} AND "listed" AND NOT ("cliModel" = ANY(${names}::text[]))
  `;
  return { listed, unlisted };
}
