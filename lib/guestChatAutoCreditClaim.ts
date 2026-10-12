import { createHash } from "node:crypto";

export const CHAT_CREDIT_RESERVATION_PHASES = [
  "exact",
  "guest_auto_prehold",
] as const;

export type GuestAutoCreditClaimRow = Readonly<{
  id: string;
  subjectKey: string;
  clientTurnId: string | null;
  idempotencyKey: string;
  status: string;
}>;

export const guestAutoCreditRequestKeyCore = (
  subjectKey: string,
  authorityId: string,
) => `guest-auto-credit:v1:${createHash("sha256")
  .update(`${subjectKey}\0${authorityId}`, "utf8").digest("hex")}`;

export type GuestAutoCreditClaimDecision =
  | "new"
  | "replay_preheld"
  | "replay_terminal"
  | "conflict";

/** Two independent uniqueness axes: authority+subject and logical turn+subject. */
export function classifyGuestAutoCreditClaim(input: Readonly<{
  subjectKey: string;
  clientTurnId: string;
  requestKey: string;
  byAuthority: GuestAutoCreditClaimRow | null;
  byTurn: GuestAutoCreditClaimRow | null;
}>): GuestAutoCreditClaimDecision {
  const exactBinding = (row: GuestAutoCreditClaimRow) =>
    row.subjectKey === input.subjectKey &&
    row.clientTurnId === input.clientTurnId &&
    row.idempotencyKey === input.requestKey;

  if (input.byAuthority && !exactBinding(input.byAuthority)) return "conflict";
  if (input.byTurn && !exactBinding(input.byTurn)) return "conflict";
  if (input.byAuthority && input.byTurn &&
      input.byAuthority.id !== input.byTurn.id) return "conflict";
  const existing = input.byAuthority ?? input.byTurn;
  if (!existing) return "new";
  return existing.status === "guest_auto_preheld"
    ? "replay_preheld"
    : "replay_terminal";
}
