import { createHash } from "node:crypto";

/**
 * Pure credit arithmetic for Guest Chat Smart Adaptive.
 *
 * The caller owns registry eligibility and freezes the candidate set before
 * calling this module. No price, token or provider-budget value is inferred
 * here: this is only the existing Guest request/day/month credit allowance.
 */

export type GuestAutoCreditCandidate = Readonly<{
  modelId: string;
  provider: string;
  usageCredits: number;
  guestEligible: true;
}>;

/** Content-free identity of the exact runtime candidate prices this turn froze. */
export function guestAutoCreditCandidateDigest(
  candidates: readonly GuestAutoCreditCandidate[],
): string {
  const normalized = candidates.map(normalizeCandidate);
  const seen = new Set<string>();
  for (const candidate of normalized) {
    if (seen.has(candidate.modelId)) {
      throw new GuestAutoQuotaError("duplicate_candidate");
    }
    seen.add(candidate.modelId);
  }
  return createHash("sha256").update(JSON.stringify({
    version: "guest-auto-credit-candidates-v1",
    candidates: normalized.map((candidate) => ({
      modelId: candidate.modelId,
      provider: candidate.provider,
      usageCredits: candidate.usageCredits,
    })),
  }), "utf8").digest("hex");
}

export type GuestAutoCreditPrehold = Readonly<{
  basisModelId: string;
  basisProvider: string;
  minuteAmount: 1;
  dayAmount: number;
  monthAmount: number;
  reachableCandidates: readonly GuestAutoCreditCandidate[];
}>;

export class GuestAutoQuotaError extends Error {
  constructor(readonly code:
    | "invalid_allowance"
    | "invalid_candidate"
    | "duplicate_candidate"
    | "no_reachable_candidate"
    | "selected_candidate_unreachable"
    | "prehold_mismatch"
  ) {
    super(code);
    this.name = "GuestAutoQuotaError";
  }
}

const validText = (value: string, max: number) =>
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

const validAllowance = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;

const normalizeCandidate = (
  candidate: GuestAutoCreditCandidate
): GuestAutoCreditCandidate => {
  if (
    !candidate ||
    candidate.guestEligible !== true ||
    !validText(candidate.modelId, 160) ||
    !validText(candidate.provider, 80) ||
    !Number.isSafeInteger(candidate.usageCredits) ||
    candidate.usageCredits <= 0
  ) {
    throw new GuestAutoQuotaError("invalid_candidate");
  }
  return Object.freeze({ ...candidate });
};

/**
 * Filter first, then take the greatest reachable weight.
 *
 * Filtering first is load-bearing: taking the maximum over every eligible
 * model would make one expensive, unreachable model hide a cheaper model the
 * Guest is still entitled to use.
 */
export function planGuestAutoCreditPrehold(input: Readonly<{
  candidates: readonly GuestAutoCreditCandidate[];
  remainingDayCredits: number;
  remainingMonthCredits: number;
}>): GuestAutoCreditPrehold {
  if (
    !validAllowance(input.remainingDayCredits) ||
    !validAllowance(input.remainingMonthCredits)
  ) {
    throw new GuestAutoQuotaError("invalid_allowance");
  }

  const seen = new Set<string>();
  const normalized = input.candidates.map((candidate) => {
    const value = normalizeCandidate(candidate);
    if (seen.has(value.modelId)) {
      throw new GuestAutoQuotaError("duplicate_candidate");
    }
    seen.add(value.modelId);
    return value;
  });
  const reachableCandidates = normalized.filter(
    (candidate) =>
      candidate.usageCredits <= input.remainingDayCredits &&
      candidate.usageCredits <= input.remainingMonthCredits
  );
  if (reachableCandidates.length === 0) {
    throw new GuestAutoQuotaError("no_reachable_candidate");
  }

  // Keep the frozen candidate order for equal weights. The Router consumes
  // that order independently; sorting here would silently create a second
  // candidate policy merely to name the accounting basis.
  const basis = reachableCandidates.reduce((current, candidate) =>
    candidate.usageCredits > current.usageCredits ? candidate : current
  );
  const held = basis.usageCredits;
  return Object.freeze({
    basisModelId: basis.modelId,
    basisProvider: basis.provider,
    minuteAmount: 1 as const,
    dayAmount: held,
    monthAmount: held,
    reachableCandidates: Object.freeze([...reachableCandidates]),
  });
}

export type GuestAutoCreditConversion = Readonly<{
  selected: GuestAutoCreditCandidate;
  heldDayCredits: number;
  heldMonthCredits: number;
  exactDayCredits: number;
  exactMonthCredits: number;
  refundDayCredits: number;
  refundMonthCredits: number;
}>;

/** Convert one maximum credit hold to one exact selected model, at most once. */
export function planGuestAutoCreditConversion(input: Readonly<{
  prehold: GuestAutoCreditPrehold;
  selectedModelId: string;
  selectedProvider: string;
  selectedUsageCredits: number;
}>): GuestAutoCreditConversion {
  const { prehold } = input;
  if (
    prehold.minuteAmount !== 1 ||
    !validAllowance(prehold.dayAmount) ||
    !validAllowance(prehold.monthAmount) ||
    prehold.dayAmount !== prehold.monthAmount ||
    prehold.dayAmount <= 0
  ) {
    throw new GuestAutoQuotaError("prehold_mismatch");
  }
  const selected = prehold.reachableCandidates.find(
    (candidate) => candidate.modelId === input.selectedModelId
  );
  if (
    !selected ||
    selected.provider !== input.selectedProvider ||
    selected.usageCredits !== input.selectedUsageCredits
  ) {
    throw new GuestAutoQuotaError("selected_candidate_unreachable");
  }
  if (selected.usageCredits > prehold.dayAmount) {
    throw new GuestAutoQuotaError("prehold_mismatch");
  }

  return Object.freeze({
    selected,
    heldDayCredits: prehold.dayAmount,
    heldMonthCredits: prehold.monthAmount,
    exactDayCredits: selected.usageCredits,
    exactMonthCredits: selected.usageCredits,
    refundDayCredits: prehold.dayAmount - selected.usageCredits,
    refundMonthCredits: prehold.monthAmount - selected.usageCredits,
  });
}
