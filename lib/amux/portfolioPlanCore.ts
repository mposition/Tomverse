import { createHash } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const isAmuxV4PlanRequestId = (value: string) => UUID.test(value);

/**
 * The request id of one row a score plan writes, derived from the plan's own
 * request id (chosen by the client before it sends) and the row's subject.
 * The same plan sent twice derives the same ids, so the second is refused at
 * its first row and rolls back; and a lost answer is read back by deriving
 * them again. Shaped as a version-4 UUID because the writers' schema asks for
 * one.
 */
export function amuxV4ScorePlanRowRequestId(planRequestId: string,
  row: "assessment" | "score", subjectId: string): string {
  if (!isAmuxV4PlanRequestId(planRequestId)) throw new Error("plan request id is invalid");
  const hex = createHash("sha256").update("amux-v4-score-plan-v1\0").update(planRequestId)
    .update("\0").update(row).update("\0").update(subjectId).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
