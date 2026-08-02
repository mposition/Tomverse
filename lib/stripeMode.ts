/**
 * Live/test mode implied by a Stripe secret key.
 *
 * Unknown key shapes return null so security boundaries can fail closed while
 * callers that only report configuration can distinguish them from test mode.
 */
export const stripeKeyLiveMode = (
  secretKey: string | undefined | null
): boolean | null => {
  const normalized = secretKey?.trim();
  if (!normalized) return null;
  if (/^(sk|rk)_live_/.test(normalized)) return true;
  if (/^(sk|rk)_test_/.test(normalized)) return false;
  return null;
};

export const stripeEventMatchesKeyMode = (
  eventLiveMode: boolean,
  secretKey: string | undefined | null
) => {
  const configuredLiveMode = stripeKeyLiveMode(secretKey);
  return configuredLiveMode !== null && eventLiveMode === configuredLiveMode;
};
