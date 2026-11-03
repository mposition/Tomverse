import type { GeolocationPlugin } from "@capacitor/geolocation";
import type { createChatLocationSession } from "@tomverse/chat-core";

const CONSENT_KEY = "tomverse-native-location-consent-v1";
type LocationSession = ReturnType<typeof createChatLocationSession>;
type Consent = { offered: boolean; unclaimedGrant: boolean; accounts: Record<string, boolean> };

/** Persist choices only. Coordinates remain in the existing foreground session. */
export function createNativeLocationConsent(
  session: LocationSession,
  permissions: Pick<GeolocationPlugin, "checkPermissions" | "requestPermissions">,
  native: boolean,
  storage: Pick<Storage, "getItem" | "setItem">,
) {
  let consent: Consent = { offered: false, unclaimedGrant: false, accounts: {} };
  try {
    const saved = JSON.parse(storage.getItem(CONSENT_KEY) ?? "null");
    if (saved?.offered === true) consent = {
      offered: true, unclaimedGrant: saved.unclaimedGrant === true,
      accounts: Object.fromEntries(Object.entries(saved.accounts ?? {}).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>,
    };
  } catch { /* An unreadable choice requires fresh consent. */ }
  let identity: string | null = null;
  let revision = 0;
  let accepting: Promise<void> | null = null;
  const save = () => {
    try { storage.setItem(CONSENT_KEY, JSON.stringify(consent)); }
    catch { /* Keep the current-session choice when device storage is unavailable. */ }
  };
  const restore = async () => {
    const scope = identity;
    const ticket = revision;
    if (!native || !scope || (!consent.accounts[scope] && !consent.unclaimedGrant)) return;
    try {
      const permission = await permissions.checkPermissions();
      if (ticket !== revision || scope !== identity) return;
      if (consent.unclaimedGrant) {
        consent.unclaimedGrant = false;
        if (consent.accounts[scope] === undefined) consent.accounts[scope] = permission.coarseLocation === "granted";
        save();
      }
      if (permission.coarseLocation !== "granted" || !consent.accounts[scope]) return;
      // Permission is already granted; restore must never show an OS prompt.
      await session.enable(scope, false);
    } catch { /* A disabled location service must not block sign-in. */ }
  };
  const location: LocationSession = {
    ...session,
    setIdentity: next => {
      if (identity === next) return;
      identity = next; revision++;
      session.setIdentity(next);
      if (native) session.disable();
      void restore();
    },
    disable: () => {
      revision++;
      if (native && identity) { consent.accounts[identity] = false; save(); }
      session.disable();
    },
    enable: async scope => {
      identity = scope;
      const ticket = ++revision;
      await session.enable(scope);
      if (native && scope && ticket === revision && session.isEnabled(scope)) {
        consent.accounts[scope] = true; consent.offered = true;
        consent.unclaimedGrant = false; save();
      }
    },
  };
  return {
    location,
    needsPrompt: () => native && !consent.offered,
    skip: () => {
      consent.offered = true; consent.unclaimedGrant = false; save();
    },
    accept: () => {
      if (!native) return Promise.resolve();
      if (accepting) return accepting;
      const acceptedFor = identity;
      const ticket = revision;
      // Record an offered prompt before native dispatch, including unknown outcomes.
      consent.offered = true; save();
      accepting = (async () => {
        let permission = await permissions.checkPermissions();
        if (permission.coarseLocation === "prompt" || permission.coarseLocation === "prompt-with-rationale") {
          permission = await permissions.requestPermissions({ permissions: ["coarseLocation"] });
        }
        const granted = permission.coarseLocation === "granted";
        if (acceptedFor) {
          if (ticket === revision || acceptedFor !== identity) consent.accounts[acceptedFor] = granted;
          consent.unclaimedGrant = false;
        } else consent.unclaimedGrant = granted;
        save();
        if (permission.coarseLocation !== "granted") throw new Error("denied");
        await restore();
      })().finally(() => { accepting = null; });
      return accepting;
    },
  };
}
