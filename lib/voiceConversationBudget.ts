import type { VoiceBudgetReservation } from "@/lib/voiceBudgetReservation";

export type VoiceBudgetSnapshot = {
  subject: { subjectKey: string; reservedSeconds: number; periodStart: string };
  provider: { reservedSeconds: number; bookings: Array<{ period: string; periodStart: string; seconds: number }> };
};

export function snapshotVoiceBudgets(value: VoiceBudgetReservation): VoiceBudgetSnapshot {
  return {
    subject: { subjectKey: value.subject.subjectKey, reservedSeconds: value.subject.reservedSeconds, periodStart: value.subject.periodStart.toISOString() },
    provider: { reservedSeconds: value.provider.reservedSeconds, bookings: value.provider.bookings.map(b => ({ ...b, periodStart: b.periodStart.toISOString() })) },
  };
}

export function restoreVoiceBudgets(value: VoiceBudgetSnapshot): VoiceBudgetReservation {
  const date = (s: string) => { const d = new Date(s); if (!Number.isFinite(d.getTime())) throw new Error("Invalid voice budget date."); return d; };
  if (!value?.subject?.subjectKey || !Number.isSafeInteger(value.subject.reservedSeconds) || value.subject.reservedSeconds < 1 ||
      value.provider?.reservedSeconds !== value.subject.reservedSeconds || !Array.isArray(value.provider.bookings) || value.provider.bookings.length !== 2) {
    throw new Error("Invalid voice budget snapshot.");
  }
  return {
    subject: { ...value.subject, periodStart: date(value.subject.periodStart), settled: false },
    provider: { reservedSeconds: value.provider.reservedSeconds, settled: false, bookings: value.provider.bookings.map(b => {
      if (typeof b.period !== "string" || b.seconds !== value.subject.reservedSeconds) throw new Error("Invalid voice booking.");
      return { ...b, periodStart: date(b.periodStart) };
    }) },
  };
}
