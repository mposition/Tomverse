/**
 * The publisher's last look before the push (docs/policy/engineering-agent.md
 * §11). Read-only: it can refuse, and it has no way to allow -- nothing after
 * the claim can grant a push. The decision is `decideLastLook` in
 * lib/engineeringAgentCapability.ts; this module only reads what it needs.
 *
 * Two checks sit beside that decision here, because they need the stored
 * rows: the claim's lease must still be live, and the commit object the
 * publisher built must hash to the digest the capability was issued with.
 *
 * The halt is read from what the database holds -- an open state mismatch, or
 * a halt recorded on the latest ended run. The unbound pull request and ref
 * checks are made by the observer, which records its reading on runs; until a
 * reading exists, only these are consulted.
 */

import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { AMUX_INCIDENT_SETTING_KEY, parseAmuxIncidentSetting } from "@/lib/amux/incidentCore";
import { decideLastLook, type LastLookVerdict } from "@/lib/engineeringAgentCapability";
import {
  ENGINEERING_AGENT_KILL_SWITCH_ENV,
  killSwitchEngaged,
} from "@/lib/engineeringAgentCore";
import { readEngineeringAgentSwitches } from "@/lib/engineeringAgentStore";

export type EngineeringAgentLastLookVerdict =
  | LastLookVerdict
  | { verdict: "refuse"; reason: "lease_passed" | "commit_digest_mismatch" };

const SHA256 = /^[0-9a-f]{64}$/;

export async function readEngineeringAgentLastLook(
  db: PrismaClient | Prisma.TransactionClient,
  input: { workItemId: string; fencingToken: bigint; commitDigest: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EngineeringAgentLastLookVerdict> {
  const switches = await readEngineeringAgentSwitches(db, env);
  const [incident, item, consumed, openMismatch, latestEnded, clock] = await Promise.all([
    db.appSetting.findUnique({ where: { key: AMUX_INCIDENT_SETTING_KEY }, select: { value: true } }),
    db.engineeringAgentWorkItem.findUnique({
      where: { id: input.workItemId },
      select: { kind: true, state: true, claimMode: true, fencingToken: true, leaseExpiresAt: true },
    }),
    db.engineeringAgentCapability.findFirst({
      where: { workItemId: input.workItemId, claimFencingToken: input.fencingToken, consumedAt: { not: null } },
      select: { commitDigest: true },
    }),
    db.engineeringAgentWorkItem.count({ where: { kind: "state_mismatch", state: "open" } }),
    db.engineeringAgentRun.findFirst({
      where: { status: { in: ["finished", "abandoned"] } },
      orderBy: [{ endedAt: "desc" }, { id: "desc" }],
      select: { halt: true },
    }),
    db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`,
  ]);

  const writeClaim = item !== null && item.kind === "publish" && item.state === "claimed" && item.claimMode === "write";
  const verdict = decideLastLook({
    mode: switches.mode,
    frozen: switches.frozen,
    killSwitch: killSwitchEngaged(env[ENGINEERING_AGENT_KILL_SWITCH_ENV]),
    // A missing or unreadable incident setting blocks, as it blocks AMUX admission.
    amuxIncidentFrozen: parseAmuxIncidentSetting(incident?.value).blocks_admission,
    halted: openMismatch > 0 || (latestEnded !== null && latestEnded.halt !== "none"),
    currentFencingToken: writeClaim ? item.fencingToken.toString() : null,
    presentedFencingToken: input.fencingToken.toString(),
    consumed: consumed ? { workItemId: input.workItemId, claimFencingToken: input.fencingToken.toString() } : null,
    workItemId: input.workItemId,
  });
  if (verdict.verdict === "refuse") return verdict;
  if (!item?.leaseExpiresAt || item.leaseExpiresAt.getTime() <= clock[0].now.getTime()) {
    return { verdict: "refuse", reason: "lease_passed" };
  }
  if (!SHA256.test(input.commitDigest) || consumed?.commitDigest !== input.commitDigest) {
    return { verdict: "refuse", reason: "commit_digest_mismatch" };
  }
  return verdict;
}
