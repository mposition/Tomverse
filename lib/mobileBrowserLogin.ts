/** Shared URL contract for the system-browser login handoff. */
export const MOBILE_AUTH_CALLBACK_PATH = "/mobile/auth/callback";

const isSecret = (value: string | null): value is string =>
  value !== null && /^[A-Za-z0-9_-]{43}$/.test(value);

export const mobileAuthReturnPath = (challenge: string, grant: string) => {
  if (!isSecret(challenge) || !isSecret(grant)) throw new Error("Invalid mobile sign-in return.");
  return `${MOBILE_AUTH_CALLBACK_PATH}#${new URLSearchParams({ codeChallenge: challenge, grant })}`;
};

/** Only an exact HTTPS callback for the connection started by this app is accepted. */
export const readMobileAuthReturn = (
  value: string, apiOrigin: string, pendingChallenge: string | null,
): string | null => {
  if (!pendingChallenge || !isSecret(pendingChallenge)) return null;
  try {
    const origin = new URL(apiOrigin);
    const url = new URL(value);
    if (origin.protocol !== "https:" || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash ||
        url.origin !== origin.origin || url.username || url.password ||
        url.pathname !== MOBILE_AUTH_CALLBACK_PATH || url.search) return null;
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.size !== 2 || fragment.getAll("codeChallenge").length !== 1 ||
        fragment.getAll("grant").length !== 1 || fragment.get("codeChallenge") !== pendingChallenge) return null;
    const grant = fragment.get("grant");
    return isSecret(grant) ? grant : null;
  } catch { return null; }
};
