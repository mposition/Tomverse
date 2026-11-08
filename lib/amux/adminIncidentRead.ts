import "server-only";

import { prisma } from "@/lib/prisma";
import { AMUX_INCIDENT_SETTING_KEY, parseAmuxIncidentSetting } from "./incidentCore.ts";

/**
 * What the incident band at the top of the Execution board says: whether
 * incident mode is stopping admission, read from the same setting and parsed by
 * the same function the routing report and the admission gate use. A setting
 * that is missing or damaged parses as stopped (fail-closed), so the band says
 * so rather than showing a calm board.
 *
 * Read only. `null` means the read itself failed; the band then says it could
 * not check, and never that all is well.
 */
export type AmuxIncidentBandState = {
  blocksAdmission: boolean;
  /** The setting parsed cleanly; false when it is missing or damaged (admission is stopped fail-closed). */
  valid: boolean;
  ticket: string;
};

export async function readAmuxIncidentBandState(): Promise<AmuxIncidentBandState | null> {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      select: { value: true },
    });
    const reading = parseAmuxIncidentSetting(row?.value);
    return { blocksAdmission: reading.blocks_admission, valid: reading.valid, ticket: reading.state.ticket };
  } catch {
    return null;
  }
}
