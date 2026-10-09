/** Recovery selects an existing claim only. A URL never approves its closure. */
export function amuxAnalysisClaimRecoveryHoldId(value: unknown,
  readSwitch: unknown): string | null {
  return readSwitch === "enabled" && typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}
