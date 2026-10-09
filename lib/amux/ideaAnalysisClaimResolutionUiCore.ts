/** A 5xx mutation answer is outcome-unknown unless it is the one deterministic
 * integrity refusal emitted before commit. A gateway/HTML/empty 5xx can be a
 * lost response after COMMIT and therefore stays on read-only recovery.
 * Transport failures are handled separately by the caller's catch boundary. */
export function isAmuxClaimResolutionWriteOutcomeUnknown(
  status: number,
  body: unknown,
): boolean {
  if (status < 500 || status > 599) return false;
  const deterministicIntegrityRefusal = status === 503 && !!body &&
    typeof body === "object" && !Array.isArray(body) &&
    (body as Record<string, unknown>).error === "integrity_unavailable";
  return !deterministicIntegrityRefusal;
}
