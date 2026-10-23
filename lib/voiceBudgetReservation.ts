import "server-only";
import type { Prisma } from "@prisma/client";

import {
  releaseVoiceSeconds,
  reserveVoiceSeconds,
  settleVoiceSeconds,
  type VoiceSecondsReservation,
} from "@/lib/voiceInputBudget";
import type { VoiceSettlementBasis } from "@/lib/voiceInputGuardrails";
import {
  reserveVoiceProviderSeconds,
  settleVoiceProviderSeconds,
  type VoiceProviderReservation,
} from "@/lib/voiceProviderBudgetLedger";

/**
 * The two bookings one request holds.
 *
 * Contract: docs/policy/voice-input.md §6.1-4.
 *
 * Separate from both ledgers on purpose. The composition is the part worth
 * testing without a database -- that the subject is booked first, that a
 * refused provider booking gives the subject's back, that every exit closes
 * both -- and it can only be tested that way if the modules it composes are
 * the ones a test replaces. Putting this beside the SQL made the two
 * inseparable: a test could stub the database half only by stubbing this
 * logic with it.
 */

/**
 * The two bookings a request holds, so no exit path can close one and forget
 * the other.
 *
 * They were separate locals in the route at first, which meant four call sites
 * had to remember both and a fifth exit path added later would have remembered
 * neither. A handle that closes both is the difference between a rule and a
 * habit.
 */
export type VoiceBudgetReservation = {
  subject: VoiceSecondsReservation;
  provider: VoiceProviderReservation;
};

export const reserveVoiceBudgets = async (input: {
  /** `identifyChatCaller`'s `subjectKey`: a user or a guest. */
  subjectKey: string;
  seconds: number;
  client?: Prisma.TransactionClient;
}): Promise<VoiceBudgetReservation> => {
  // The subject's budget first: refusing one person for their own use is the
  // more specific answer, and it does not consume the shared budget to say so.
  //
  // The order matters more since guests were admitted (2026-09-10). A cleared
  // cookie is a new subject, so the subject budget cannot bound the day on its
  // own; the provider reservation below is what does, and it is reserved for
  // every caller alike.
  const subject = await reserveVoiceSeconds({
    subjectKey: input.subjectKey,
    seconds: input.seconds,
    ...(input.client ? { client: input.client } : {}),
  });
  try {
    const provider = await reserveVoiceProviderSeconds({
      seconds: input.seconds,
      ...(input.client ? { client: input.client } : {}),
    });
    return { subject, provider };
  } catch (error) {
    if (!input.client) await releaseVoiceSeconds(subject).catch(() => undefined);
    throw error;
  }
};

export const settleVoiceBudgets = async (input: {
  reservation: VoiceBudgetReservation;
  basis: VoiceSettlementBasis;
  client?: Prisma.TransactionClient;
}): Promise<{ releasedSeconds: number }> => {
  const subject = await settleVoiceSeconds({
    reservation: input.reservation.subject,
    basis: input.basis,
    ...(input.client ? { client: input.client } : {}),
  });
  await settleVoiceProviderSeconds({
    reservation: input.reservation.provider,
    basis: input.basis,
    ...(input.client ? { client: input.client } : {}),
  });
  // The subject's number is what the caller reports: it is the one a user
  // could notice. Both moved by the same arithmetic.
  return subject;
};

export const releaseVoiceBudgets = (reservation: VoiceBudgetReservation) =>
  settleVoiceBudgets({ reservation, basis: { kind: "not_billed" } });
